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
import type { MisplacedPlatformRoleDto, OnboardingRequestDto, PlatformStaffDutyDto, PlatformStaffInviteDto } from "@sms/types";
import { MAX_SCHOOL_SLUG_LENGTH, defaultSessionFor, generateCalendar, pickOpeningTerm, countryProfile } from "@sms/types";
import { allocateSchoolSlug } from "../foundation/login-email";
import {
  PLATFORM_TIER_ROLES,
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
import { publicWebUrl } from "../common/public-url";

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
      /** Optional — derived (short, unique) from `name` when omitted. */
      slug?: string;
      /** ISO 3166-1 alpha-2. Decides the privacy regime, the fee currency and —
       *  the reason it is accepted HERE rather than only on the later region PUT —
       *  when the academic year opens, which the provisioned calendar needs. */
      country?: string;
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
    // The slug IS the login domain for every member of this school
    // (firstname.lastname@<slug>.com), so it must be SHORT and unique across all
    // schools. Omit it and one is derived from the school name; allocation runs
    // on the PRIVILEGED client because `school` is global and a tenant-scoped
    // read would happily hand out a slug another school already owns.
    const slug = input.slug?.trim()
      ? input.slug.trim().toLowerCase()
      : await allocateSchoolSlug(db as never, input.name);
    if (!/^[a-z0-9-]{2,40}$/.test(slug)) {
      throw new BadRequestException("slug must be 2–40 chars, [a-z0-9-]");
    }
    if (slug.length > MAX_SCHOOL_SLUG_LENGTH) {
      throw new BadRequestException(
        `slug must be at most ${MAX_SCHOOL_SLUG_LENGTH} characters — it becomes the sign-in domain (name@<slug>.com)`,
      );
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

    // Pure catalogue lookup — the country decides the year's START MONTH, its
    // SHAPE, and the template stamped on the school row. Resolved before the
    // transaction because the school row is written first and needs it.
    const profile = countryProfile(input.country);

    const result = await db.$transaction(async (tx) => {
      const school = await tx.school.create({
        data: { name: input.name, slug, ownerName, ownerPhone, address, ...(input.country ? { country: input.country.toUpperCase(), calendarTemplate: profile.calendarTemplate } : {}) },
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
      // A CALENDAR. Without one the school has no current term, and three
      // protections read that pointer and simply do not engage: the past-term
      // register lock, automatic roll-over, and the term archive sweep. A school
      // provisioned without a calendar therefore runs unprotected from day one,
      // silently, until somebody sets one up by hand.
      //
      // The term marked current is the one CONTAINING TODAY, so a school
      // onboarding in February starts in Second Term rather than being filed
      // against a First Term that closed months ago. Falls back to the opening
      // term when today sits outside the year — a school set up over the summer
      // is preparing for a session that has not begun.
      // The country decides when the academic year OPENS. Assuming September is
      // six months wrong for the whole of southern Africa — a school in
      // Johannesburg, Harare or Lusaka runs January to December — so a September
      // default would have filed its first registers against a session that does
      // not exist yet. Unknown country falls back to the platform's home default,
      // which is what every school already live has.
      const { name: sessionName, yearStart } = defaultSessionFor(new Date(), profile.academicYearStartMonth);
      // The SHAPE of the year is the country's too: three terms in Nigeria and
      // the Commonwealth, two semesters in the US and Canada. This used to call
      // the three-term generator unconditionally, so an American school was
      // provisioned with "First/Second/Third Term".
      const termDates = generateCalendar(profile.calendarTemplate, yearStart);
      const academicSession = await tx.academicSession.create({
        data: {
          schoolId: school.id,
          name: sessionName,
          startDate: new Date(termDates[0].startDate),
          endDate: new Date(termDates[termDates.length - 1].endDate),
          isCurrent: true,
        },
      });
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      const currentIdx = pickOpeningTerm(termDates, today);
      await tx.term.createMany({
        data: termDates.map((t, i) => ({
          schoolId: school.id,
          sessionId: academicSession.id,
          name: t.name,
          sequence: t.sequence,
          startDate: new Date(t.startDate),
          endDate: new Date(t.endDate),
          isCurrent: i === currentIdx,
        })),
      });

      const created: Array<{ id: string; email: string; role: string; tempPassword: string }> = [];
      for (const a of prepared) {
        const u = await tx.user.create({
          // passwordChangedAt: null = the forced-first-reset state — it makes the
          // temp password single-session AND arms the emailed set-password invite.
          // passwordChangedAt: null forces the first-login reset; tempPasswordSetAt
          // makes the temp credential GO STALE in 7 days, matching the invite link
          // these admins are also sent. Without it the password is valid for ever
          // if never used — a standing credential in whatever channel it travelled.
          data: {
            schoolId: school.id,
            email: a.email,
            name: a.name,
            passwordHash: a.passwordHash,
            passwordChangedAt: null,
            tempPasswordSetAt: new Date(),
          },
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
          const base = publicWebUrl();
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
      const base = publicWebUrl();
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

  /**
   * Build the one-time invite link and try to email it, reporting BOTH.
   *
   * `EmailService.send` answers ok:true when it is UNCONFIGURED — it logs an
   * `[email-stub]` line and sends nothing — so "we called send and it did not
   * throw" is no evidence a human received anything. Any caller whose account has
   * NO other activation route (platform staff get no temp password) must be told
   * the difference, and must be handed the link itself.
   */
  private async buildAndSendInvite(
    userId: string,
    email: string,
    schoolId: string,
    schoolName: string,
    slug: string,
  ): Promise<{ link: string; emailDelivered: boolean }> {
    const base = publicWebUrl();
    const link = `${base}/welcome?token=${encodeURIComponent(mintInviteToken(userId, schoolId))}`;
    try {
      const res = await this.email.send(
        email,
        `Activate your ${schoolName} account`,
        `Hello,\n\nAn account has been created for you on the SMS platform for ${schoolName}. ` +
          `Set your password using this one-time link (valid for 7 days):\n\n${link}\n\n` +
          `After that, sign in any time at ${base}/login?school=${slug}.\n\n— The SMS Platform team`,
      );
      // BOTH conditions: a configured provider returning ok is a real send; an
      // unconfigured one returning ok is a stub pretending.
      return { link, emailDelivered: this.email.isConfigured() && res.ok };
    } catch {
      return { link, emailDelivered: false };
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
        data: {
          schoolId,
          email: input.email,
          name: input.name,
          passwordHash,
          passwordChangedAt: null,
          // Bounded like the invite link that accompanies it — see above.
          tempPasswordSetAt: new Date(),
        },
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
  async listOnboardingRequests(_p: Principal): Promise<OnboardingRequestDto[]> {
    const db = this.client();
    // The owner's own funnel, and it grows for ever. A request stays NEW or
    // REVIEWING because nobody has answered the school that applied, so the
    // undecided ones age off the end of a newest-first cap — and the operator
    // screen computes "pending" with a `.filter()` over exactly that slice. All
    // undecided ones first, oldest first (the school that applied earliest has
    // waited longest), then recent history.
    const UNDECIDED = ["NEW", "REVIEWING"] as const;
    const [open, recent] = await Promise.all([
      db.onboardingRequest.findMany({ where: { status: { in: [...UNDECIDED] } }, orderBy: { createdAt: "asc" }, take: 500 }),
      db.onboardingRequest.findMany({ where: { status: { notIn: [...UNDECIDED] } }, orderBy: { createdAt: "desc" }, take: 200 }),
    ]);
    const rows = [...open, ...recent];
    // `desiredModules` is a JSON column, so Prisma types it `JsonValue` while the
    // DTO promises `string[] | null` and the web reads it as one. Narrowing is
    // the stated convention for a JSON read; doing it with a RUNTIME check
    // rather than a blind cast, because a cast would only move the lie — the
    // column can hold anything a past writer put there.
    return rows.map((r) => ({
      ...r,
      desiredModules: Array.isArray(r.desiredModules)
        ? r.desiredModules.filter((m): m is string => typeof m === "string")
        : null,
    }));
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
      select: {
        id: true, email: true, name: true, status: true, mfaEnabled: true,
        passwordChangedAt: true, createdAt: true, disabledAt: true,
        lastLoginAt: true, locked: true,
      },
      orderBy: { createdAt: "desc" },
    });

    // ONE query for every manager's live duties, not one per row. The console is
    // the place you look when something is wrong; it must not be the slowest page
    // on the platform.
    const now = new Date();
    const grants = await db.platformDelegation.findMany({
      where: {
        schoolId: org.id,
        userId: { in: rows.map((u) => u.id) },
        revokedAt: null,
        expiresAt: { gt: now },
      },
      select: { id: true, userId: true, permission: true, reason: true, expiresAt: true },
      orderBy: { expiresAt: "asc" },
    });
    const byUser = new Map<string, PlatformStaffDutyDto[]>();
    for (const g of grants) {
      const list = byUser.get(g.userId) ?? [];
      list.push({
        id: g.id,
        permission: g.permission,
        reason: g.reason,
        expiresAt: g.expiresAt,
        daysLeft: Math.ceil((g.expiresAt.getTime() - now.getTime()) / 86_400_000),
      });
      byUser.set(g.userId, list);
    }

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
      disabledAt: u.disabledAt,
      lastLoginAt: u.lastLoginAt,
      locked: u.locked,
      duties: byUser.get(u.id) ?? [],
    }));
  }

  /**
   * AUDIT: platform-tier roles held OUTSIDE the platform organisation.
   *
   * Such a grant should be impossible — AdminService refuses it and login
   * filters `platform.*` to nothing outside the platform org — but a row can
   * still exist from before those guards, from a hand-edited database, or from
   * a restored backup. The permissions are inert, yet the grant is a real
   * finding: it means someone once had, or tried to obtain, cross-tenant reach.
   * This report makes them findable instead of invisible (the staff console
   * scopes to the platform org, so these accounts never appear there).
   */
  async listMisplacedPlatformRoles(_p: Principal): Promise<MisplacedPlatformRoleDto[]> {
    const db = this.client();
    const rows = await db.user.findMany({
      where: {
        school: { isPlatform: false },
        roles: { some: { role: { name: { in: [...PLATFORM_TIER_ROLES] } } } },
      },
      select: {
        id: true,
        email: true,
        name: true,
        status: true,
        createdAt: true,
        school: { select: { id: true, name: true } },
        roles: { select: { role: { select: { name: true } } } },
      },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((u) => ({
      userId: u.id,
      email: u.email,
      name: u.name,
      status: u.status,
      schoolId: u.school.id,
      schoolName: u.school.name,
      platformRoles: u.roles
        .map((r) => r.role.name)
        .filter((n) => (PLATFORM_TIER_ROLES as readonly string[]).includes(n)),
      grantedAt: u.createdAt,
    }));
  }

  /** Strip a misplaced platform-tier role. Owner-only, step-up, audited. The
   *  ACCOUNT is untouched — only the cross-tenant grant is removed. */
  async revokeMisplacedPlatformRole(p: Principal, userId: string, roleName: string): Promise<{ revoked: boolean }> {
    if (!(PLATFORM_TIER_ROLES as readonly string[]).includes(roleName)) {
      throw new BadRequestException("Not a platform-tier role");
    }
    const db = this.client();
    const target = await db.user.findFirst({
      where: { id: userId, school: { isPlatform: false } },
      select: { id: true, schoolId: true },
    });
    if (!target) throw new NotFoundException("User not found");
    const role = await db.role.findFirst({ where: { name: roleName }, select: { id: true } });
    if (!role) throw new NotFoundException("Role not found");
    const res = await db.userRole.deleteMany({ where: { userId, roleId: role.id } });
    await this.auditInOperatorTenant(p, "operator.platform.role.revoke_misplaced", "user", userId, {
      roleName,
      schoolId: target.schoolId,
      removed: res.count,
    });
    return { revoked: res.count > 0 };
  }

  /**
   * Hire a platform manager. Invite-link only — we never hand out a password.
   *
   * The LINK COMES BACK TO THE OWNER, and so does whether the email genuinely
   * went out. Previously this emailed the link and returned nothing usable, while
   * `EmailService` reports success when unconfigured — so on any deployment
   * without an email provider (the default), hiring created an account that
   * NOBODY could ever sign in as, with every step reporting success and no resend
   * path to recover. The owner is step-up authenticated and is the person meant
   * to hand this over; withholding it from them protected nothing.
   */
  async createPlatformStaff(p: Principal, input: { email: string; name: string }): Promise<PlatformStaffInviteDto> {
    const db = this.client();
    const org = await this.platformOrg(db);
    if (await db.user.findFirst({ where: { email: input.email } })) {
      throw new ConflictException("That email is already in use");
    }
    // SECURITY: hard-pinned. This endpoint mints manager_admin and nothing else —
    // never a role the caller chooses, so it can never produce a second super_admin.
    const roleRow = await db.role.findFirst({ where: { name: PLATFORM_STAFF_ROLE } });
    if (!roleRow) throw new BadRequestException(`role ${PLATFORM_STAFF_ROLE} is not seeded`);

    // A ONE-TIME temp password, returned to the owner as the fallback when the
    // link cannot be used — a link is long, chat clients mangle it, and it is
    // useless if PUBLIC_WEB_URL is wrong. This used to hash 32 random bytes and
    // THROW THEM AWAY, which is why an account with no working email was
    // unreachable by any route at all.
    //
    // It is not a lasting credential: passwordChangedAt stays null so login
    // reports passwordExpired and the web holds them on change-password, and
    // tempPasswordSetAt makes it go stale in 7 days like the link.
    const tempPassword = this.genPassword();
    const passwordHash = await bcrypt.hash(tempPassword, 10);
    const staff = await db.$transaction(async (tx) => {
      const u = await tx.user.create({
        data: {
          schoolId: org.id,
          email: input.email,
          name: input.name,
          passwordHash,
          passwordChangedAt: null,
          tempPasswordSetAt: new Date(),
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
    const invite = await this.buildAndSendInvite(staff.id, input.email, org.id, org.name, org.slug);
    if (!invite.emailDelivered) {
      this.logger.warn(
        `platform staff ${input.email} created but the invite email was NOT delivered — the owner must pass the link on`,
      );
    }
    return {
      staff: {
        id: staff.id,
        email: staff.email,
        name: staff.name,
        status: staff.status,
        mfaEnabled: false,
        activated: false,
        disabledAt: null,
        createdAt: staff.createdAt,
        lastLoginAt: null,
        locked: false,
        duties: [],
      },
      inviteLink: invite.link,
      emailDelivered: invite.emailDelivered,
      tempPassword,
    };
  }

  /**
   * Re-issue a manager's invite: a fresh 7-day single-use link.
   *
   * Without this, a link that expired, went to a mistyped address or was simply
   * lost had NO recovery — email is globally unique, so the owner could not even
   * re-hire the same person. Minting a new token does not invalidate anything
   * else: `acceptInvite` already refuses once a password is set, and refuses a
   * non-ACTIVE account, so a disabled manager cannot be revived through here.
   */
  async reissuePlatformStaffInvite(p: Principal, userId: string): Promise<PlatformStaffInviteDto> {
    const db = this.client();
    const org = await this.platformOrg(db);
    // Scoped to platform-org managers — 404 not 403, exactly like the status route:
    // an unscoped userId here would mint a login link for ANY account, including
    // the owner's. That is the single most dangerous thing this file could do.
    const target = await db.user.findFirst({
      where: { id: userId, schoolId: org.id, roles: { some: { role: { name: PLATFORM_STAFF_ROLE } } } },
      select: {
        id: true, email: true, name: true, status: true, mfaEnabled: true,
        passwordChangedAt: true, createdAt: true, disabledAt: true, lastLoginAt: true, locked: true,
      },
    });
    if (!target) throw new NotFoundException("Platform staff member not found");
    if (target.status !== "ACTIVE") {
      throw new BadRequestException("Reinstate this manager before re-issuing their invite.");
    }

    // A FRESH temp password, and the old one dies with it. Re-issuing only the
    // link would leave the previous password valid on its own older clock —
    // two credentials for one account, expiring at different times, which is
    // exactly the sort of thing nobody remembers when revoking access.
    //
    // passwordChangedAt is reset to null as well: re-issuing is "this person
    // cannot get in", so whatever password they had must stop working, and the
    // web must hold them on change-password after they use the temp one.
    const tempPassword = this.genPassword();
    await db.user.update({
      where: { id: target.id },
      data: {
        passwordHash: await bcrypt.hash(tempPassword, 10),
        passwordChangedAt: null,
        tempPasswordSetAt: new Date(),
        // A re-issue is the recovery path for a locked-out manager, so it clears
        // the lockout too — otherwise the new credential works and login still refuses.
        failedLoginCount: 0,
        locked: false,
        lockedUntil: null,
      },
    });

    const invite = await this.buildAndSendInvite(target.id, target.email, org.id, org.name, org.slug);
    await this.auditInOperatorTenant(p, "operator.platform.staff.invite_reissue", "user", target.id, {
      email: target.email,
      emailDelivered: invite.emailDelivered,
      // Whether they had already activated: re-issuing for an ACTIVATED account is
      // effectively a password reset, and the audit trail should say which it was.
      wasActivated: target.passwordChangedAt !== null,
    });
    return {
      staff: {
        id: target.id,
        email: target.email,
        name: target.name,
        status: target.status,
        mfaEnabled: target.mfaEnabled,
        // FALSE by construction: re-issuing reset passwordChangedAt, so the
        // account is back to "invited, not yet activated" whatever it was before.
        // Reporting the pre-update value here would show a manager as activated
        // while they are actually holding an unused temp password.
        activated: false,
        disabledAt: target.disabledAt,
        createdAt: target.createdAt,
        lastLoginAt: target.lastLoginAt,
        locked: false, // the re-issue cleared it

        duties: [],
      },
      inviteLink: invite.link,
      emailDelivered: invite.emailDelivered,
      tempPassword,
    };
  }

  /**
   * Hand back EVERY duty currently lent to one manager, in one act.
   *
   * The per-grant revoke already exists, but "this person is leaving / their
   * laptop is missing" is a single decision and must be a single click. Revoking
   * duties one at a time under pressure is how one gets missed — and the guard
   * reads this table on every permission miss, so the last one still open is a
   * live permission.
   *
   * Deliberately SEPARATE from disabling the account: a manager can be stripped
   * back to the standing floor without being locked out, and can be locked out
   * without anyone remembering to revoke. Both, in either order, are one click.
   */
  async revokeAllDuties(p: Principal, userId: string): Promise<{ revoked: number }> {
    const db = this.client();
    const org = await this.platformOrg(db);
    const target = await db.user.findFirst({
      where: { id: userId, schoolId: org.id, roles: { some: { role: { name: PLATFORM_STAFF_ROLE } } } },
      select: { id: true, email: true },
    });
    if (!target) throw new NotFoundException("Platform staff member not found");

    const now = new Date();
    const res = await db.platformDelegation.updateMany({
      where: { schoolId: org.id, userId, revokedAt: null, expiresAt: { gt: now } },
      data: { revokedAt: now, revokedById: p.userId },
    });
    await this.auditInOperatorTenant(p, "operator.platform.duties.revoke_all", "user", userId, {
      email: target.email,
      revoked: res.count,
    });
    return { revoked: res.count };
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

    // LEAVER HYGIENE: revoking clears MFA enrolment as well as blocking login.
    // The departing person's authenticator entry lives on a device the company
    // no longer controls, so a later reinstatement must re-enrol rather than
    // silently trusting that old secret. (The unused-invite case needs nothing
    // here: acceptInvite already refuses a non-ACTIVE account, so disabling the
    // account kills any outstanding invite link on its own.)
    const revoking = status === "DISABLED";
    const updated = await db.user.update({
      where: { id: userId },
      data: revoking
        ? { status, mfaEnabled: false, mfaSecret: null, disabledAt: new Date() }
        : { status, disabledAt: null },
      select: {
        id: true, email: true, name: true, status: true, mfaEnabled: true,
        passwordChangedAt: true, createdAt: true, disabledAt: true, lastLoginAt: true, locked: true,
      },
    });
    await this.auditInOperatorTenant(p, "operator.platform.staff.status", "user", userId, {
      status,
      ...(revoking ? { mfaCleared: true } : {}),
    });
    return {
      id: updated.id,
      email: updated.email,
      name: updated.name,
      status: updated.status,
      mfaEnabled: updated.mfaEnabled,
      activated: updated.passwordChangedAt !== null,
      createdAt: updated.createdAt,
      disabledAt: updated.disabledAt,
      lastLoginAt: updated.lastLoginAt,
      locked: updated.locked,
      // Duties are listed by the console's own query; a status change never
      // implies anything about what is lent — revoking those is a SEPARATE,
      // deliberate act (revokeAllDuties).
      duties: [],
    };
  }
}
