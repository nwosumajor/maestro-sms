// =============================================================================
// OperatorProvisioningService — super_admin self-serve school onboarding
// =============================================================================
// Creating a SCHOOL writes the GLOBAL registry (school/role/permission), and
// creating users/roles for an arbitrary tenant crosses the RLS boundary — neither
// is permitted to the least-privilege app role (`major_user` has SELECT-only on
// the global tables). So, exactly like the retention/dunning jobs, provisioning
// connects through a PRIVILEGED client (DATABASE_MIGRATE_URL, else
// DATABASE_RETENTION_URL) that bypasses RLS by design. It is reachable ONLY from
// the platform.operate + step-up-gated operator endpoints, and every action is
// audit-logged in the operator's own tenant.
//
// Least-privilege default: with no privileged URL the client is null and
// provisioning is DISABLED (503) rather than silently escalating.
// =============================================================================

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { Prisma, type PrismaClient } from "@sms/db";
import { DEFAULT_PLAN, SUBSCRIPTION_TRIAL_DAYS, isPlan, isModuleKey, type ModuleOverrides } from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantDatabase,
} from "../integrity/integrity.foundation";
import { PrivilegedDatabaseService } from "../common/privileged-database.service";
import { NotificationService } from "../notifications/notification.service";
import { EmailService } from "../notifications/email.service";
import { mintInviteToken } from "../auth/invite";

// Roles a super_admin may seed into a school via provisioning (the admin tier).
const ADMIN_ROLES = new Set(["school_admin", "principal", "head_admin", "hr_manager"]);

interface AdminInput {
  name: string;
  email: string;
  password?: string;
  role?: string;
}

@Injectable()
export class OperatorProvisioningService {
  private readonly logger = new Logger("OperatorProvisioning");

  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly privileged: PrivilegedDatabaseService,
    private readonly notifications: NotificationService,
    private readonly email: EmailService,
  ) {}

  private client(): PrismaClient {
    const c = this.privileged.client;
    if (!c) throw new ServiceUnavailableException("School provisioning is not configured");
    return c;
  }

  private genPassword(): string {
    return crypto.randomBytes(9).toString("base64url");
  }

  /**
   * Create a school + its subscription + its FOUNDING admin tier. Onboarding seeds
   * at least a school_admin AND (recommended) a principal; those two then staff the
   * rest of the school themselves (POST /admin/users). Returns one-time creds per
   * admin. Accepts a single `admin` (legacy) or an `admins[]`.
   */
  async provisionSchool(
    p: Principal,
    input: {
      name: string;
      slug: string;
      plan?: string;
      overrides?: { enabled?: string[]; disabled?: string[] };
      admin?: AdminInput;
      admins?: AdminInput[];
      /** When provisioning FROM a public onboarding request: link it, so the
       *  request auto-flips to APPROVED with this provision. */
      onboardingRequestId?: string;
    },
  ) {
    const db = this.client();
    const slug = input.slug.trim().toLowerCase();
    if (!/^[a-z0-9-]{2,40}$/.test(slug)) {
      throw new BadRequestException("slug must be 2–40 chars, [a-z0-9-]");
    }
    const plan = input.plan && isPlan(input.plan) ? input.plan : DEFAULT_PLAN;
    // Extra modules beyond the plan — same model the subscription PUT uses. Only
    // real module keys survive (unknown strings dropped).
    const overrides: ModuleOverrides = {
      enabled: (input.overrides?.enabled ?? []).filter(isModuleKey),
      disabled: (input.overrides?.disabled ?? []).filter(isModuleKey),
    };

    // Normalise to a list; default each admin's role to school_admin.
    const rawAdmins = input.admins ?? (input.admin ? [input.admin] : []);
    if (rawAdmins.length === 0) throw new BadRequestException("at least one admin is required");
    const admins = rawAdmins.map((a) => ({ ...a, role: a.role ?? "school_admin" }));
    for (const a of admins) {
      if (!ADMIN_ROLES.has(a.role)) throw new BadRequestException(`admin role ${a.role} not allowed`);
    }
    // A school must have at least one school_admin to own day-to-day administration.
    if (!admins.some((a) => a.role === "school_admin")) {
      throw new BadRequestException("at least one admin must be a school_admin");
    }
    // No duplicate emails within the batch, and none already in use globally.
    const emails = admins.map((a) => a.email.toLowerCase());
    if (new Set(emails).size !== emails.length) {
      throw new BadRequestException("duplicate admin email in the request");
    }
    if (await db.school.findFirst({ where: { slug } })) {
      throw new ConflictException("A school with that slug already exists");
    }
    if (await db.user.findFirst({ where: { email: { in: admins.map((a) => a.email) } } })) {
      throw new ConflictException("One of those admin emails is already in use");
    }

    // Resolve each role row up front (global registry; same for all schools).
    const prepared: Array<AdminInput & { role: string; roleId: string; tempPassword: string; passwordHash: string }> = [];
    for (const a of admins) {
      const roleRow = await db.role.findFirst({ where: { name: a.role } });
      if (!roleRow) throw new BadRequestException(`role ${a.role} is not seeded`);
      const tempPassword = a.password ?? this.genPassword();
      prepared.push({ ...a, role: a.role, roleId: roleRow.id, tempPassword, passwordHash: await bcrypt.hash(tempPassword, 10) });
    }

    const result = await db.$transaction(async (tx) => {
      const school = await tx.school.create({ data: { name: input.name, slug } });
      // Provision on a TRIAL: ACTIVE now, but with a period end so the dunning
      // sweep will flip an unpaid school to PAST_DUE when the trial elapses
      // (then effectivePlan drops to the floor after grace). Without this the
      // subscription had a null currentPeriodEnd, which dunning skips entirely —
      // so the school would run its full plan free forever. super_admin can
      // extend/override the period via the operator subscription PUT.
      const trialEnd = new Date(Date.now() + SUBSCRIPTION_TRIAL_DAYS * 24 * 60 * 60 * 1000);
      await tx.schoolSubscription.create({
        data: { schoolId: school.id, plan, status: "ACTIVE", currentPeriodEnd: trialEnd, overrides: overrides as unknown as Prisma.InputJsonValue },
      });
      const created: Array<{ id: string; email: string; role: string; tempPassword: string }> = [];
      for (const a of prepared) {
        const u = await tx.user.create({
          // passwordChangedAt: null = the forced-first-reset state — it makes the
          // temp password single-session AND arms the emailed set-password invite.
          data: { schoolId: school.id, email: a.email, name: a.name, passwordHash: a.passwordHash, passwordChangedAt: null },
        });
        await tx.userRole.create({ data: { schoolId: school.id, userId: u.id, roleId: a.roleId } });
        created.push({ id: u.id, email: a.email, role: a.role, tempPassword: a.tempPassword });
      }
      return { school, created };
    });

    await this.auditInOperatorTenant(p, "operator.school.provision", "school", result.school.id, {
      slug,
      plan,
      admins: result.created.map((a) => ({ email: a.email, role: a.role })),
      onboardingRequestId: input.onboardingRequestId ?? null,
    });

    // Provisioned from a public onboarding request → the request is now APPROVED
    // (audited via the same review path) and the REQUESTER gets a direct
    // "your school is live" email (they may differ from the created admins).
    // Best-effort: the school exists either way.
    if (input.onboardingRequestId) {
      try {
        await this.setOnboardingRequestStatus(
          p,
          input.onboardingRequestId,
          "APPROVED",
          `Provisioned as ${result.school.slug}`,
        );
        const req = await db.onboardingRequest.findFirst({
          where: { id: input.onboardingRequestId },
          select: { contactName: true, contactEmail: true },
        });
        if (req) {
          await this.email.send(
            req.contactEmail,
            `${result.school.name} is now live on SMS`,
            `Hello ${req.contactName},\n\n` +
              `Great news — ${result.school.name} has been approved and set up on the ${plan} plan. ` +
              `Your school's sign-in page is /login?school=${result.school.slug}. The founding admin ` +
              `accounts have been created; temporary passwords are shared separately by our team, never ` +
              `by email. Your 30-day free trial starts today.\n\n— The SMS Platform team`,
          );
        }
      } catch {
        // Unknown/already-handled request id — never undo a committed provision.
      }
    }

    // Welcome each founding admin: an in-app notification (fans to email async)
    // PLUS a personal one-time SET-PASSWORD invite link by direct email — the
    // client activates their own account without any password changing hands.
    // (The one-time temp password in the console stays as the fallback.)
    // Best-effort, after the commit.
    try {
      for (const a of result.created) {
        await this.sendInviteEmail(a.id, a.email, result.school.id, result.school.name, result.school.slug);
        await this.notifications.enqueue(
          { schoolId: result.school.id, userId: p.userId },
          {
            recipientId: a.id,
            type: "ANNOUNCEMENT",
            title: `Welcome to ${result.school.name}`,
            body:
              `Your school is set up on the ${plan} plan. Use the set-password link emailed to you ` +
              `(valid 7 days) to activate your account, then sign in at /login?school=${result.school.slug}. ` +
              `The in-app Help page has the getting-started guide. Passwords are never sent by email.`,
            data: { schoolSlug: result.school.slug, plan },
            channels: ["EMAIL"],
          },
        );
      }
    } catch {
      // Notification delivery must never fail provisioning.
    }

    return {
      school: { id: result.school.id, name: result.school.name, slug: result.school.slug, plan },
      admins: result.created,
    };
  }

  /** Personal one-time set-password invite (7-day signed link) by direct email.
   *  Best-effort; the console's one-time temp password remains the fallback. */
  private async sendInviteEmail(
    userId: string,
    email: string,
    schoolId: string,
    schoolName: string,
    slug: string,
  ): Promise<void> {
    try {
      const base = process.env.PUBLIC_WEB_URL ?? "http://localhost:3000";
      const link = `${base}/welcome?token=${encodeURIComponent(mintInviteToken(userId, schoolId))}`;
      await this.email.send(
        email,
        `Activate your ${schoolName} account`,
        `Hello,\n\nAn account has been created for you on the SMS platform for ${schoolName}. ` +
          `Set your password using this one-time link (valid for 7 days):\n\n${link}\n\n` +
          `After that, sign in any time at ${base}/login?school=${slug}. If the link has expired, ` +
          `ask your platform contact for the one-time temporary password instead.\n\n— The SMS Platform team`,
      );
    } catch {
      // Invite email is best-effort — the temp-password fallback always exists.
    }
  }

  /** Add another admin user to an EXISTING school. Returns one-time creds. */
  async createAdmin(p: Principal, schoolId: string, input: AdminInput) {
    const db = this.client();
    const role = input.role ?? "school_admin";
    if (!ADMIN_ROLES.has(role)) throw new BadRequestException("admin role not allowed");

    const school = await db.school.findFirst({ where: { id: schoolId } });
    if (!school) throw new NotFoundException("School not found");
    if (await db.user.findFirst({ where: { email: input.email } })) {
      throw new ConflictException("That email is already in use");
    }
    const roleRow = await db.role.findFirst({ where: { name: role } });
    if (!roleRow) throw new BadRequestException(`role ${role} is not seeded`);

    const tempPassword = input.password ?? this.genPassword();
    const passwordHash = await bcrypt.hash(tempPassword, 10);
    const admin = await db.$transaction(async (tx) => {
      const u = await tx.user.create({
        // Same forced-first-reset posture as provisionSchool (arms the invite).
        data: { schoolId, email: input.email, name: input.name, passwordHash, passwordChangedAt: null },
      });
      await tx.userRole.create({ data: { schoolId, userId: u.id, roleId: roleRow.id } });
      return u;
    });

    await this.auditInOperatorTenant(p, "operator.school.admin.create", "user", admin.id, {
      targetSchoolId: schoolId,
      email: input.email,
      role,
    });
    await this.sendInviteEmail(admin.id, input.email, schoolId, school.name, school.slug);
    return { id: admin.id, email: input.email, role, tempPassword };
  }

  // --- public onboarding-request review (global table; privileged client) -----
  /** List prospective-school onboarding requests (super_admin review queue). */
  async listOnboardingRequests(_p: Principal) {
    const db = this.client();
    return db.onboardingRequest.findMany({ orderBy: { createdAt: "desc" }, take: 200 });
  }

  /** Mark an onboarding request REVIEWING / APPROVED / REJECTED (audited). */
  async setOnboardingRequestStatus(
    p: Principal,
    id: string,
    status: "NEW" | "REVIEWING" | "APPROVED" | "REJECTED",
    note?: string,
  ) {
    const db = this.client();
    const existing = await db.onboardingRequest.findFirst({
      where: { id },
      select: { id: true, status: true, schoolName: true, contactName: true, contactEmail: true },
    });
    if (!existing) throw new NotFoundException("Onboarding request not found");
    const updated = await db.onboardingRequest.update({
      where: { id },
      data: { status, reviewedById: p.userId, reviewNote: note ?? null },
    });
    await this.auditInOperatorTenant(p, "operator.onboarding.review", "onboarding_request", id, { status });
    // A REJECTED requester gets a courteous direct email (best-effort; only on
    // the first transition into REJECTED so re-saves don't re-send).
    if (status === "REJECTED" && existing.status !== "REJECTED") {
      await this.email.send(
        existing.contactEmail,
        `Update on your onboarding request for ${existing.schoolName}`,
        `Hello ${existing.contactName},\n\n` +
          `Thank you for your interest in the SMS platform. After review, we are unable to proceed ` +
          `with onboarding ${existing.schoolName} at this time.` +
          `${note ? `\n\nNote from our team: ${note}` : ""}\n\n` +
          `You are welcome to reach out or reapply in the future.\n\n— The SMS Platform team`,
      );
    }
    return updated;
  }

  /** Audit lands in the OPERATOR's own tenant (the actor FK is the operator).
   *  Best-effort: the privileged write above is the source of truth and the action
   *  is also captured by the observability request log, so a logging failure (e.g.
   *  a stale session whose school no longer exists) must NOT 500 a write that has
   *  already committed. */
  private async auditInOperatorTenant(
    p: Principal,
    action: string,
    entity: string,
    entityId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.db.runAsTenant({ schoolId: p.schoolId, userId: p.userId }, (tx) =>
        this.audit.record({ actorId: p.userId, action, entity, entityId, schoolId: p.schoolId, metadata }, tx),
      );
    } catch (err) {
      this.logger.warn(`operator audit '${action}' failed (non-fatal): ${String(err)}`);
    }
  }
}
