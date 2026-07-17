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
import {
  DEFAULT_PLAN,
  PLATFORM_STAFF_ROLE,
  SUBSCRIPTION_TRIAL_DAYS,
  isPlan,
  isModuleKey,
  type ModuleOverrides,
  type PlatformStaffDto,
} from "@sms/types";
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
      /** Referral code the new school arrived with (explicit value wins; falls
       *  back to the linked onboarding request's stored code). */
      referralCode?: string;
      /** Agent (reseller) attribution code — same lifecycle as referralCode. */
      agentCode?: string;
      /** Proprietor contact + address for the operator directory (explicit value
       *  wins; falls back to the linked onboarding request). */
      ownerName?: string;
      ownerPhone?: string;
      address?: string;
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

    // Referral: resolve the quoted code (explicit input wins, else the linked
    // onboarding request's stored code) to its owning school. Privileged client
    // — the ONLY place a code is read across tenants; an unknown code resolves
    // to nothing and never blocks provisioning.
    let referralCode =
      input.referralCode
        ?.trim()
        .toUpperCase()
        .replace(/[^A-Z0-9-]/g, "") || null;
    let agentCode = input.agentCode?.trim().toUpperCase().replace(/[^A-Z0-9-]/g, "") || null;
    // Proprietor contact + address: explicit input wins, else the linked
    // onboarding request (owner fields; contact-as-PROPRIETOR as a last resort
    // for pre-owner-field requests).
    let ownerName = input.ownerName?.trim() || null;
    let ownerPhone = input.ownerPhone?.trim() || null;
    let address = input.address?.trim() || null;
    if (input.onboardingRequestId) {
      const req = await db.onboardingRequest.findFirst({
        where: { id: input.onboardingRequestId },
        select: {
          referralCode: true,
          agentCode: true,
          ownerName: true,
          ownerPhone: true,
          contactName: true,
          contactPhone: true,
          contactRole: true,
          address: true,
          city: true,
          state: true,
        },
      });
      referralCode = referralCode ?? req?.referralCode ?? null;
      agentCode = agentCode ?? req?.agentCode ?? null;
      const contactIsOwner = req?.contactRole === "PROPRIETOR";
      ownerName = ownerName ?? req?.ownerName ?? (contactIsOwner ? req?.contactName ?? null : null);
      ownerPhone = ownerPhone ?? req?.ownerPhone ?? (contactIsOwner ? req?.contactPhone ?? null : null);
      address =
        address ?? (req?.address ? [req.address, req.city, req.state].filter(Boolean).join(", ") : null);
    }
    const referrer = referralCode
      ? await db.schoolReferralCode.findFirst({ where: { code: referralCode }, select: { schoolId: true } })
      : null;
    // Agent (reseller) attribution — unknown/inactive codes resolve to nothing.
    const agent = agentCode
      ? await db.agent.findFirst({ where: { code: agentCode, active: true }, select: { id: true } })
      : null;

    // Resolve each role row up front (global registry; same for all schools).
    const prepared: Array<AdminInput & { role: string; roleId: string; tempPassword: string; passwordHash: string }> = [];
    for (const a of admins) {
      const roleRow = await db.role.findFirst({ where: { name: a.role } });
      if (!roleRow) throw new BadRequestException(`role ${a.role} is not seeded`);
      const tempPassword = a.password ?? this.genPassword();
      prepared.push({ ...a, role: a.role, roleId: roleRow.id, tempPassword, passwordHash: await bcrypt.hash(tempPassword, 10) });
    }

    const result = await db.$transaction(async (tx) => {
      const school = await tx.school.create({
        data: { name: input.name, slug, ownerName, ownerPhone, address },
      });
      // Provision on a TRIAL: ACTIVE now, but with a period end so the dunning
      // sweep will flip an unpaid school to PAST_DUE when the trial elapses
      // (then effectivePlan drops to the floor after grace). Without this the
      // subscription had a null currentPeriodEnd, which dunning skips entirely —
      // so the school would run its full plan free forever. super_admin can
      // extend/override the period via the operator subscription PUT.
      const trialEnd = new Date(Date.now() + SUBSCRIPTION_TRIAL_DAYS * 24 * 60 * 60 * 1000);
      await tx.schoolSubscription.create({
        data: {
          schoolId: school.id,
          plan,
          status: "ACTIVE",
          currentPeriodEnd: trialEnd,
          overrides: overrides as unknown as Prisma.InputJsonValue,
          // Arms the referral reward: the billing webhook grants both sides one
          // free term on this school's FIRST paid subscription.
          referredBySchoolId: referrer?.schoolId ?? null,
          // Arms the agent commission (accrues once, on the first paid sub).
          agentId: agent?.id ?? null,
        },
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
      referralCode,
      referredBySchoolId: referrer?.schoolId ?? null,
      agentCode,
      agentId: agent?.id ?? null,
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
          // The requester receives each founding account's LOGIN EMAIL plus its
          // one-time set-password link. SECURITY: the temporary password itself
          // is never emailed — it is shown once in the operator console; the
          // links are single-use (armed by passwordChangedAt=null) and expire.
          const base = process.env.PUBLIC_WEB_URL ?? "http://localhost:3000";
          const accountLines = result.created
            .map(
              (a) =>
                `• ${a.role}\n  Sign-in email: ${a.email}\n  Set your password (one-time link, valid 7 days):\n  ${base}/welcome?token=${encodeURIComponent(mintInviteToken(a.id, result.school.id))}`,
            )
            .join("\n\n");
          await this.email.send(
            req.contactEmail,
            `${result.school.name} is now live on SMS`,
            `Hello ${req.contactName},\n\n` +
              `Great news — ${result.school.name} has been approved and set up on the ${plan} plan. ` +
              `Your 30-day free trial starts today.\n\n` +
              `Your founding accounts:\n\n${accountLines}\n\n` +
              `After setting each password, sign in any time at ${base}/login?school=${result.school.slug}. ` +
              `For security, passwords are never sent by email — each link above works once; if one expires, ` +
              `your platform contact can share a one-time temporary password securely.\n\n— The SMS Platform team`,
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
        // From a public onboarding request the login emails are usually
        // GENERATED identifiers (no real inbox) and the requester email above
        // already carries every set-password link — skip the per-account invite
        // so a real provider never bounces on a synthetic address.
        if (!input.onboardingRequestId) {
          await this.sendInviteEmail(a.id, a.email, result.school.id, result.school.name, result.school.slug);
        }
        await this.notifications.enqueue(
          { schoolId: result.school.id, userId: p.userId },
          {
            recipientId: a.id,
            type: "ANNOUNCEMENT",
            title: `Welcome to ${result.school.name}`,
            body:
              `Your school is set up on the ${plan} plan. Use the set-password link (valid 7 days) sent ` +
              `to ${input.onboardingRequestId ? "your onboarding contact" : "your email"} to activate ` +
              `your account, then sign in at /login?school=${result.school.slug}. ` +
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
  // ===========================================================================
  // PLATFORM STAFF (manager_admin) — the owner hiring help
  // ===========================================================================
  // Deliberately SEPARATE from school provisioning (createAdmin), which allow-lists
  // school roles and is delegable. Hiring platform staff is NOT delegable: if staff
  // could create staff, one manager could mint another and "only the owner has
  // absolute control" quietly dissolves. Hence platform.staff.manage — owner-only,
  // non-elevatable, step-up gated, audited.
  //
  // THE critical constraint is the role allow-list: exactly manager_admin. Without
  // it this endpoint would be a route to minting a second super_admin — a
  // privilege-escalation path built into the console itself.
  // ===========================================================================

  /** The platform org (isPlatform). Staff live here, never in a customer school. */
  private async platformOrg(db: PrismaClient) {
    const org = await db.school.findFirst({ where: { isPlatform: true }, select: { id: true, name: true, slug: true } });
    if (!org) throw new ServiceUnavailableException("Platform organisation is not provisioned");
    return org;
  }

  /** Current platform staff (manager_admin members of the platform org). */
  async listPlatformStaff(_p: Principal): Promise<PlatformStaffDto[]> {
    const db = this.client();
    const org = await this.platformOrg(db);
    const rows = await db.user.findMany({
      where: { schoolId: org.id, roles: { some: { role: { name: PLATFORM_STAFF_ROLE } } } },
      select: { id: true, email: true, name: true, status: true, mfaEnabled: true, passwordChangedAt: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      status: u.status,
      mfaEnabled: u.mfaEnabled,
      // passwordChangedAt is nulled on create and set on first reset — so this is
      // "have they actually activated their invite yet?".
      activated: u.passwordChangedAt !== null,
      createdAt: u.createdAt,
    }));
  }

  /** Hire a platform manager. Invite-link only — we never hand out a password. */
  async createPlatformStaff(p: Principal, input: { email: string; name: string }): Promise<PlatformStaffDto> {
    const db = this.client();
    const org = await this.platformOrg(db);
    if (await db.user.findFirst({ where: { email: input.email } })) {
      throw new ConflictException("That email is already in use");
    }
    // SECURITY: hard-pinned. This endpoint mints manager_admin and nothing else —
    // never a role the caller chooses, so it can never produce a second super_admin.
    const roleRow = await db.role.findFirst({ where: { name: PLATFORM_STAFF_ROLE } });
    if (!roleRow) throw new BadRequestException(`role ${PLATFORM_STAFF_ROLE} is not seeded`);

    // No password is ever returned or emailed (the onboarding posture: send the
    // link, never the secret). An unguessable hash parks the account until the
    // invite is used; passwordChangedAt=null forces a set-password on first login.
    const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 10);
    const staff = await db.$transaction(async (tx) => {
      const u = await tx.user.create({
        data: {
          schoolId: org.id,
          email: input.email,
          name: input.name,
          passwordHash,
          passwordChangedAt: null,
          // Platform staff can onboard schools and read the whole platform audit
          // trail — MFA is mandatory, not a preference.
          mfaRequired: true,
        },
      });
      await tx.userRole.create({ data: { schoolId: org.id, userId: u.id, roleId: roleRow.id } });
      return u;
    });

    await this.auditInOperatorTenant(p, "operator.platform.staff.create", "user", staff.id, {
      email: input.email,
      role: PLATFORM_STAFF_ROLE,
    });
    await this.sendInviteEmail(staff.id, input.email, org.id, org.name, org.slug);
    return {
      id: staff.id,
      email: staff.email,
      name: staff.name,
      status: staff.status,
      mfaEnabled: false,
      activated: false,
      createdAt: staff.createdAt,
    };
  }

  /** Revoke (DISABLED blocks every login) or reinstate a platform manager. */
  async setPlatformStaffStatus(p: Principal, userId: string, status: "ACTIVE" | "DISABLED"): Promise<PlatformStaffDto> {
    const db = this.client();
    const org = await this.platformOrg(db);
    // SECURITY: scope to platform-org manager_admins ONLY. Without this the route
    // would accept ANY userId — including the owner's own, or another super_admin's
    // — turning "revoke a manager" into "disable the platform owner". 404, never
    // 403: don't confirm the existence of an id this route may not touch.
    const target = await db.user.findFirst({
      where: { id: userId, schoolId: org.id, roles: { some: { role: { name: PLATFORM_STAFF_ROLE } } } },
      select: { id: true },
    });
    if (!target) throw new NotFoundException("Platform staff member not found");

    const updated = await db.user.update({
      where: { id: userId },
      data: { status },
      select: { id: true, email: true, name: true, status: true, mfaEnabled: true, passwordChangedAt: true, createdAt: true },
    });
    await this.auditInOperatorTenant(p, "operator.platform.staff.status", "user", userId, { status });
    return {
      id: updated.id,
      email: updated.email,
      name: updated.name,
      status: updated.status,
      mfaEnabled: updated.mfaEnabled,
      activated: updated.passwordChangedAt !== null,
      createdAt: updated.createdAt,
    };
  }
}
