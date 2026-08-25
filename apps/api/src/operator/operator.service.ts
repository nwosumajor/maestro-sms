// =============================================================================
// OperatorService — platform (super_admin) cross-tenant console + impersonation
// =============================================================================
// Only reachable with platform.operate (super_admin). Tenant counts are read by
// setting the RLS GUC to each school in turn (the server controls the GUC — never
// the client). Impersonation mints a short-lived token carrying the TARGET user's
// claims plus an `imp.by` field, and is loudly audit-logged. The minted token is
// the same HS256 shape the web BFF issues, so the API accepts it as a Bearer.
// =============================================================================

import { BadRequestException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import jwt from "jsonwebtoken";
import { Prisma } from "@sms/db";
import { ON_ROLL_STUDENT } from "../common/student-scope";
import {
  COMPLIANCE_REGIMES,
  CALENDAR_TEMPLATES,
  COUNTRIES,
  SUBSCRIPTION_GRACE_DAYS,
  SUBSCRIPTION_STATUS,
  resolveRegion,
  isModuleKey,
  isPlan,
  isSubscriptionStatus,
  type ModuleOverrides,
  type OperatorAdminAppointmentDto,
  type OperatorBillingAlertDto,
  type Plan,
  type SubscriptionDto,
  type SubscriptionStatus,
} from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
} from "../integrity/integrity.foundation";
import { PrivilegedDatabaseService } from "../common/privileged-database.service";
import { headcountBySchool, headcountInTenant, type SchoolHeadcount } from "./operator-people";
import { SchoolRegionService } from "../foundation/school-region.service";
import { ModuleEntitlementService } from "../foundation/module-entitlement.service";
import { SchoolStatusService } from "../foundation/school-status.service";

const IMPERSONATION_TTL = 900; // 15 min

@Injectable()
export class OperatorService {
  private readonly logger = new Logger("Operator");

  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly entitlements: ModuleEntitlementService,
    private readonly regions: SchoolRegionService,
    private readonly privileged: PrivilegedDatabaseService,
    private readonly schoolStatus: SchoolStatusService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  /** Audit a cross-tenant operator action under the operator's OWN tenant.
   *  Best-effort: the privileged effect is already committed and the action is
   *  captured by the observability request log, so a logging failure (e.g. a stale
   *  session whose school no longer exists) must not 500 a completed operation. */
  private async auditAsOperator(p: Principal, entry: Parameters<AuditLogService["record"]>[0]): Promise<void> {
    try {
      await this.db.runAsTenant(this.ctx(p), (tx) => this.audit.record(entry, tx));
    } catch (err) {
      this.logger.warn(`operator audit '${entry.action}' failed (non-fatal): ${String(err)}`);
    }
  }

  // --- subscription / module entitlements (super_admin, platform.operate) ----
  /** Read a school's subscription + resolved effective modules + billing posture. */
  async getSubscription(p: Principal, schoolId: string): Promise<SubscriptionDto> {
    return this.db.runAsTenant({ schoolId, userId: p.userId }, async (tx) => {
      const school = await tx.school.findFirst({ where: { id: schoolId }, select: { id: true } });
      if (!school) throw new NotFoundException("School not found");
      const resolved = await this.entitlements.resolve(schoolId);
      return this.entitlements.dtoFrom(schoolId, resolved);
    });
  }

  /** Set a school's plan + overrides; optionally comp/grant status + period. Audited. */
  async setSubscription(
    p: Principal,
    schoolId: string,
    input: {
      plan: string;
      overrides?: { enabled?: string[]; disabled?: string[] };
      status?: string;
      currentPeriodEnd?: string | Date | null;
    },
  ): Promise<SubscriptionDto> {
    if (!isPlan(input.plan)) throw new BadRequestException("plan must be one of STANDARD, PREMIUM, ULTIMATE, ENTERPRISE");
    const plan: Plan = input.plan;
    // OMITTED MEANS UNCHANGED, exactly as `status` and `currentPeriodEnd` do
    // fifteen lines below.
    //
    // This defaulted to `{enabled: [], disabled: []}` and wrote it every time,
    // so a PUT that changed only the tier — or only the status, since `plan` is
    // required on every call — SILENTLY DELETED every add-on the school had
    // bought and every module the operator had comped. Proved live: a school on
    // ULTIMATE with a purchased hostel add-on, saved as `{plan: "PREMIUM"}`,
    // came back with `overrides.enabled: []`. The console always sends the
    // toggles it last read, so the UI path never showed it — but that is also
    // a lost update: an add-on bought while the operator has the page open is
    // erased by their next save.
    const requested: ModuleOverrides | undefined =
      input.overrides === undefined
        ? undefined
        : {
            enabled: (input.overrides.enabled ?? []).filter(isModuleKey),
            disabled: (input.overrides.disabled ?? []).filter(isModuleKey),
          };

    let status: SubscriptionStatus | undefined;
    if (input.status !== undefined) {
      if (!isSubscriptionStatus(input.status)) throw new BadRequestException("invalid status");
      status = input.status;
    }
    const currentPeriodEnd =
      input.currentPeriodEnd === undefined
        ? undefined
        : input.currentPeriodEnd === null
          ? null
          : new Date(input.currentPeriodEnd);

    await this.db.runAsTenant({ schoolId, userId: p.userId }, async (tx) => {
      const school = await tx.school.findFirst({ where: { id: schoolId }, select: { id: true } });
      if (!school) throw new NotFoundException("School not found");
      const existing = await tx.schoolSubscription.findFirst({ where: { schoolId }, select: { id: true, overrides: true } });
      // WHICH OF THESE WERE BOUGHT IS NOT THE OPERATOR'S TO SAY.
      //
      // The console sends `enabled` and `disabled`; it has no notion of a
      // PURCHASE, so a write that rebuilt the object from those two fields alone
      // erased the `purchased` marker and quietly turned every paid add-on into
      // a comp — which then survives delinquency for ever, the exact hole
      // `overridesUnderDelinquency` exists to close. The marker is carried
      // through for whatever the operator left enabled, and dropped only for a
      // module they actually removed. Same for a pending cancellation.
      const prior = ((existing?.overrides ?? {}) as ModuleOverrides) ?? {};
      const overrides: ModuleOverrides | undefined =
        requested === undefined
          ? undefined
          : {
              ...requested,
              purchased: (prior.purchased ?? []).filter((m) => (requested.enabled ?? []).includes(m)),
              cancelling: (prior.cancelling ?? []).filter((m) => (requested.enabled ?? []).includes(m)),
            };
      const data: Prisma.SchoolSubscriptionUncheckedUpdateInput = {
        plan,
        ...(overrides !== undefined ? { overrides: overrides as unknown as Prisma.InputJsonValue } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(currentPeriodEnd !== undefined ? { currentPeriodEnd } : {}),
      };
      if (existing) {
        await tx.schoolSubscription.update({ where: { id: existing.id }, data });
      } else {
        // A NEW row has no overrides to preserve, so an omitted field is an
        // empty set here rather than "leave it alone".
        await tx.schoolSubscription.create({
          data: {
            schoolId,
            plan,
            overrides: (requested ?? { enabled: [], disabled: [] }) as unknown as Prisma.InputJsonValue,
            ...(status !== undefined ? { status } : {}),
            ...(currentPeriodEnd !== undefined ? { currentPeriodEnd } : {}),
          },
        });
      }
    });
    // Audit under the OPERATOR's own tenant (a separate tx), mirroring
    // listSchoolStudents / impersonate. The write above runs with the GUC set to
    // the TARGET school, so an audit_log row carrying the operator's own schoolId
    // can't be written there (RLS WITH CHECK would reject it — schoolId ≠ GUC).
    // The affected school is preserved in metadata.targetSchoolId.
    await this.auditAsOperator(p, {
      actorId: p.userId,
      action: "operator.subscription.set",
      entity: "school_subscription",
      entityId: schoolId,
      schoolId: p.schoolId,
      // `requested` — what the operator ASKED for. The stored object also carries
      // the purchase and cancellation markers, which are carried through rather
      // than decided here, and recording them as though the operator set them
      // would misattribute them.
      metadata: { targetSchoolId: schoolId, plan, overrides: requested, status, currentPeriodEnd },
    });
    // Drop the cached entitlements so the new posture takes effect immediately.
    this.entitlements.invalidate(schoolId);
    const resolved = await this.entitlements.resolve(schoolId);
    return this.entitlements.dtoFrom(schoolId, resolved);
  }

  /** Every tenant + a user count each. School registry is global/RLS-exempt. */
  async listTenants(
    p: Principal,
    f: { q?: string; plan?: string; billing?: string; page?: number; pageSize?: number } = {},
  ) {
    // Server-side search/filter/PAGINATION: at 500+ schools the old
    // list-everything shape was unusable AND ran 2 enrichment queries per
    // school per view. The where pushes q/plan/billing into SQL; enrichment
    // (user count + entitlement resolve) now costs pageSize, not fleet-size.
    const page = Math.max(1, Math.floor(f.page ?? 1));
    const pageSize = Math.min(Math.max(Math.floor(f.pageSize ?? 10), 1), 50);
    const sub: Record<string, string> = {};
    if (f.plan) sub.plan = f.plan;
    if (f.billing) sub.status = f.billing;
    const where = {
      isPlatform: false,
      ...(f.q
        ? {
            OR: [
              { name: { contains: f.q, mode: "insensitive" as const } },
              { slug: { contains: f.q, mode: "insensitive" as const } },
            ],
          }
        : {}),
      ...(Object.keys(sub).length ? { subscription: { is: sub } } : {}),
    };
    // The subscription relation is TENANT-scoped: under the operator's own GUC,
    // RLS hides every other school's subscription row, so an app-role relation
    // filter silently matches nothing. Cross-tenant registry queries therefore
    // run on the PRIVILEGED client (like the analytics/audit consoles); without
    // it, the plain list still works but plan/billing filters 503.
    const client = this.privileged.client;
    if (Object.keys(sub).length > 0 && !client) {
      throw new ServiceUnavailableException("Plan/billing filters require the privileged database configuration");
    }
    const query = {
      where,
      select: { id: true, name: true, slug: true, status: true, createdAt: true },
      orderBy: { name: "asc" as const },
      skip: (page - 1) * pageSize,
      take: pageSize,
    };
    const { schools, total } = client
      ? { total: await client.school.count({ where }), schools: await client.school.findMany(query) }
      : await this.db.runAsTenant(this.ctx(p), async (tx) => ({
          total: await tx.school.count({ where }),
          schools: await tx.school.findMany(query),
        }));
    const rows = schools as Array<{ id: string; name: string; slug: string; status: string; createdAt: Date }>;

    // Headcount for the WHOLE page in one grouped query, replacing a per-school
    // `user.count()` inside the loop. It also splits what used to be a single
    // lumped `users` figure: students, staff and guardians added together told you
    // nothing — a 900-pupil school and one with 900 guardian accounts read the same.
    // Aggregates only; no name or id of any person crosses a tenant boundary.
    const headcounts = await headcountBySchool(
      this.privileged.client ?? (undefined as never),
      this.privileged.client ? rows.map((s) => s.id) : [],
    ).catch(() => new Map<string, SchoolHeadcount>());

    const out = [];
    for (const s of rows) {
      const ent = await this.entitlements.resolve(s.id); // cached per school (30s)
      const head =
        headcounts.get(s.id) ??
        // No privileged client (or the grouped read failed): fall back to counting
        // under the school's own GUC. Slower, never wrong, never zero — a headcount
        // that silently reported 0 would read as "this school has no pupils".
        (await this.db.runAsTenant({ schoolId: s.id, userId: p.userId }, (tx) => headcountInTenant(tx, s.id)));
      out.push({
        ...s,
        users: head.students + head.staff + head.parents,
        students: head.students,
        staff: head.staff,
        parents: head.parents,
        plan: ent.plan,
        moduleCount: ent.modules.length,
        graceDays: ent.graceDays,
        subscriptionStatus: ent.status,
      });
    }
    return { tenants: out, total, page, pageSize };
  }

  /**
   * Set a school's REGION — country, and optional overrides for timezone, locale,
   * fee currency and compliance regime.
   *
   * Operator-owned rather than school-owned, deliberately: country decides the
   * privacy regime, whether statutory payroll may run at all, and what currency a
   * school bills in. Those are commercial and legal facts about the account, not
   * a preference its own staff should be able to flip.
   *
   * The registry is GLOBAL and the app role is SELECT-only on it, so this writes
   * through the privileged client (503 when unconfigured, like provisioning).
   */
  async setSchoolRegion(
    p: Principal,
    schoolId: string,
    input: { country?: string; timezone?: string; locale?: string; currency?: string; complianceRegime?: string; calendarTemplate?: string },
  ) {
    const client = this.privileged.client;
    if (!client) throw new ServiceUnavailableException("Region administration requires the privileged database configuration");
    const school = await client.school.findFirst({ where: { id: schoolId, isPlatform: false }, select: { id: true, name: true } });
    if (!school) throw new NotFoundException("School not found");

    const country = input.country?.toUpperCase();
    if (country && !COUNTRIES[country]) {
      throw new BadRequestException(`Unsupported country "${country}". Supported: ${Object.keys(COUNTRIES).join(", ")}`);
    }
    // An invalid IANA zone would make every date at that school unformattable, so
    // it is rejected here rather than discovered by a teacher taking a register.
    if (input.timezone) {
      try {
        new Intl.DateTimeFormat("en-CA", { timeZone: input.timezone }).format(new Date());
      } catch {
        throw new BadRequestException(`"${input.timezone}" is not a valid IANA timezone`);
      }
    }
    if (input.complianceRegime && !(COMPLIANCE_REGIMES as readonly string[]).includes(input.complianceRegime)) {
      throw new BadRequestException(`Compliance regime must be one of ${COMPLIANCE_REGIMES.join(", ")}`);
    }
    // The year's SHAPE. Validated against the catalogue rather than stored as
    // typed, because an unknown key silently falls back to three terms — a school
    // would set "SEMESTER", see nothing change, and have no way to tell why.
    if (input.calendarTemplate && !Object.keys(CALENDAR_TEMPLATES).includes(input.calendarTemplate)) {
      throw new BadRequestException(`Calendar template must be one of ${Object.keys(CALENDAR_TEMPLATES).join(", ")}`);
    }

    await client.school.update({
      where: { id: schoolId },
      data: {
        ...(country ? { country } : {}),
        // An empty string clears an override back to the country default.
        ...(input.timezone !== undefined ? { timezone: input.timezone || null } : {}),
        ...(input.locale !== undefined ? { locale: input.locale || null } : {}),
        ...(input.currency !== undefined ? { currency: input.currency ? input.currency.toUpperCase() : null } : {}),
        ...(input.complianceRegime !== undefined ? { complianceRegime: input.complianceRegime || null } : {}),
        // Changing the shape does NOT rewrite an existing calendar — terms already
        // hold marks. It decides what the NEXT quick-created year looks like.
        ...(input.calendarTemplate !== undefined ? { calendarTemplate: input.calendarTemplate || null } : {}),
      },
    });
    // The region is cached on the hot path of every register write; a stale entry
    // would keep filing against the old zone for up to a minute.
    this.regions.invalidate(schoolId);

    await this.db.runAsTenant(this.ctx(p), (tx) =>
      this.audit.record(
        {
          actorId: p.userId,
          action: "operator.school.region",
          entity: "school",
          entityId: schoolId,
          schoolId: p.schoolId,
          metadata: { school: school.name, ...input },
        },
        tx,
      ),
    );
    const region = resolveRegion({ ...input, country: country ?? null });
    return { schoolId, ...region };
  }

  /** Lightweight id+name list for pickers (single query; no per-school work). */
  async listTenantNames(p: Principal) {
    return this.db.runAsTenant(this.ctx(p), (tx) =>
      tx.school.findMany({ where: { isPlatform: false }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    );
  }

  /** Enable/disable a SCHOOL (the hard deactivation lever). DISABLED blocks
   *  every member login (checked in AuthService after password verification) and
   *  hides the school from the public directory; nothing is deleted, so
   *  re-enabling restores everything instantly. The school registry is global —
   *  the app role is SELECT-only on it, so the write uses the PRIVILEGED client
   *  (503 when unconfigured, like provisioning). Audited. */
  async setSchoolStatus(p: Principal, schoolId: string, status: "ACTIVE" | "DISABLED") {
    const client = this.privileged.client;
    if (!client) throw new ServiceUnavailableException("School administration requires the privileged database configuration");
    const school = await client.school.findFirst({ where: { id: schoolId, isPlatform: false }, select: { id: true, name: true } });
    if (!school) throw new NotFoundException("School not found");
    await client.school.update({ where: { id: schoolId }, data: { status } });
    // Take effect NOW, on every instance, rather than when a 15-second cache
    // happens to expire. The switch is the whole point of the lever.
    this.schoolStatus.invalidate(schoolId);
    await this.db.runAsTenant(this.ctx(p), (tx) =>
      this.audit.record(
        {
          actorId: p.userId,
          action: "operator.school.status",
          entity: "school",
          entityId: schoolId,
          schoolId: p.schoolId,
          metadata: { targetSchoolId: schoolId, name: school.name, status },
        },
        tx,
      ),
    );
    return { id: schoolId, status };
  }

  /** Every tenant currently past its paid period — feeds the operator console's
   *  red billing banner. Subscription rows are tenant-scoped, so this runs on
   *  the PRIVILEGED client (like the registry); [] without a privileged URL. */
  async listBillingAlerts(): Promise<OperatorBillingAlertDto[]> {
    const client = this.privileged.client;
    if (!client) return [];
    const now = new Date();
    const lapsed = await client.schoolSubscription.findMany({
      where: { status: SUBSCRIPTION_STATUS.PAST_DUE },
      select: { schoolId: true, plan: true, currentPeriodEnd: true, graceDays: true },
    });
    if (lapsed.length === 0) return [];
    const schools = await client.school.findMany({
      // ACTIVE only, matching the attention queue exactly. A school the operator
      // has themselves DISABLED needs no payment chased, and previously it appeared
      // here but not in the queue — so the console's count disagreed with the list
      // it linked to, which reads as one of them being broken.
      where: { id: { in: lapsed.map((s) => s.schoolId) }, isPlatform: false, status: "ACTIVE" },
      select: { id: true, name: true, slug: true },
    });
    const byId = new Map(schools.map((s) => [s.id, s]));
    return lapsed
      .flatMap((s) => {
        const school = byId.get(s.schoolId);
        if (!school) return [];
        const end = s.currentPeriodEnd ? new Date(s.currentPeriodEnd) : null;
        const daysPastDue = end ? Math.max(0, Math.floor((now.getTime() - end.getTime()) / 86_400_000)) : 0;
        return [
          {
            schoolId: s.schoolId,
            name: school.name,
            slug: school.slug,
            plan: s.plan,
            currentPeriodEnd: s.currentPeriodEnd,
            daysPastDue,
            downgraded: daysPastDue > (s.graceDays ?? SUBSCRIPTION_GRACE_DAYS), // per-school grace wins
          },
        ];
      })
      .sort((a, b) => b.daysPastDue - a.daysPastDue);
  }

  /** Cross-tenant oversight of the junior-admin maker-checker: every tenant's
   *  ADMIN_APPOINTMENT workflow requests (who is appointing whom into the admin
   *  tier, and whether the school's second senior has decided). Read via the
   *  PRIVILEGED client like the registry; staff names only — never student data.
   *  [] without a privileged URL (mirrors billing alerts). */
  async listAdminAppointments(state?: string): Promise<OperatorAdminAppointmentDto[]> {
    const client = this.privileged.client;
    if (!client) return [];
    const requests = await client.workflowRequest.findMany({
      where: { type: "ADMIN_APPOINTMENT", ...(state ? { state } : {}) },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true,
        schoolId: true,
        state: true,
        payload: true,
        initiatorId: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (requests.length === 0) return [];
    const payloads = requests.map((r) => (r.payload ?? {}) as { userId?: string; roleName?: string });
    const userIds = [
      ...new Set([...requests.map((r) => r.initiatorId), ...payloads.map((pl) => pl.userId).filter((x): x is string => Boolean(x))]),
    ];
    const [schools, users] = await Promise.all([
      client.school.findMany({
        where: { id: { in: [...new Set(requests.map((r) => r.schoolId))] } },
        select: { id: true, name: true },
      }),
      client.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } }),
    ]);
    const schoolById = new Map(schools.map((s) => [s.id, s.name]));
    const userById = new Map(users.map((u) => [u.id, u]));
    return requests.map((r, i) => ({
      requestId: r.id,
      schoolId: r.schoolId,
      schoolName: schoolById.get(r.schoolId) ?? "(unknown)",
      state: r.state,
      roleName: payloads[i].roleName ?? "(unknown)",
      targetUserName: (payloads[i].userId && userById.get(payloads[i].userId as string)?.name) || null,
      targetUserEmail: (payloads[i].userId && userById.get(payloads[i].userId as string)?.email) || null,
      initiatorName: userById.get(r.initiatorId)?.name ?? null,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  }

  /** Set a school's PER-SCHOOL grace window (days past due before the STANDARD
   *  floor). null resets to the platform default. Bounded 0..GRACE_DAYS_MAX at the
   *  controller — the cap is what makes this DELEGABLE (manager_admin): bounded
   *  goodwill for a late-paying school, never an unbounded comp. Audited. */
  async setGraceDays(p: Principal, schoolId: string, graceDays: number | null): Promise<SubscriptionDto> {
    await this.db.runAsTenant({ schoolId, userId: p.userId }, async (tx) => {
      const school = await tx.school.findFirst({ where: { id: schoolId }, select: { id: true } });
      if (!school) throw new NotFoundException("School not found");
      const existing = await tx.schoolSubscription.findFirst({ where: { schoolId }, select: { id: true } });
      if (existing) {
        await tx.schoolSubscription.update({ where: { id: existing.id }, data: { graceDays } });
      } else {
        // No row yet (pre-billing tenant): create one on the fail-closed default
        // plan carrying only the grace override.
        await tx.schoolSubscription.create({ data: { schoolId, graceDays } });
      }
    });
    await this.auditAsOperator(p, {
      actorId: p.userId,
      action: "operator.subscription.grace.set",
      entity: "school_subscription",
      entityId: schoolId,
      schoolId: p.schoolId,
      metadata: { targetSchoolId: schoolId, graceDays },
    });
    // Grace feeds effectivePlan, so the cached entitlement is stale on every task.
    this.entitlements.invalidate(schoolId);
    const resolved = await this.entitlements.resolve(schoolId);
    return this.entitlements.dtoFrom(schoolId, resolved);
  }

  /** Every enrolled student of a given school (cross-tenant; the operator sets the
   *  GUC to the target school, then RLS scopes the reads). Audited — student PII on
   *  minors (Golden Rule #5). */
  async listSchoolStudents(p: Principal, schoolId: string) {
    const result = await this.db.runAsTenant({ schoolId, userId: p.userId }, async (tx) => {
      const school = await tx.school.findFirst({ where: { id: schoolId }, select: { id: true } });
      if (!school) throw new NotFoundException("School not found");
      // By ROLE and ON ROLL, not by enrollment — enrollment-derived listing hid
      // every not-yet-enrolled student from the operator (while the school's own
      // /students page, already role-based, showed them), while an unfiltered
      // role listing showed pupils who had LEFT. This is a cross-tenant read of
      // minors' data, so it is exactly where the narrower answer belongs.
      const students = await tx.user.findMany({
        where: ON_ROLL_STUDENT,
        select: { id: true, uniqueId: true, name: true, email: true },
        orderBy: { name: "asc" },
      });
      const ids = students.map((st) => st.id);
      const enrollments = ids.length
        ? await tx.enrollment.findMany({
            where: { status: "ACTIVE", studentId: { in: ids } },
            include: { class: { select: { name: true } } },
          })
        : [];
      const classesBy = new Map<string, string[]>();
      for (const e of enrollments as Array<{ studentId: string; class: { name: string } }>) {
        const arr = classesBy.get(e.studentId);
        if (arr) arr.push(e.class.name);
        else classesBy.set(e.studentId, [e.class.name]);
      }
      const profiles = ids.length
        ? await tx.studentProfile.findMany({ where: { studentId: { in: ids } }, select: { studentId: true, admissionNumber: true } })
        : [];
      const admNo = new Map(profiles.map((pr: { studentId: string; admissionNumber: string | null }) => [pr.studentId, pr.admissionNumber]));
      return students.map((st) => ({
        ...st,
        classes: classesBy.get(st.id) ?? [],
        admissionNumber: admNo.get(st.id) ?? null,
      }));
    });
    // Audit the cross-tenant PII view in the operator's own tenant.
    await this.auditAsOperator(p, { actorId: p.userId, action: "operator.students.view", entity: "school", entityId: schoolId, schoolId: p.schoolId, metadata: { targetSchoolId: schoolId, count: result.length } });
    return result;
  }

  /** Mint an audited impersonation token for a user in a (possibly other) tenant. */
  async impersonate(p: Principal, schoolId: string, userId: string) {
    const target = await this.db.runAsTenant({ schoolId, userId: p.userId }, async (tx) => {
      const u = await tx.user.findFirst({ where: { id: userId }, select: { id: true, name: true } });
      if (!u) throw new NotFoundException("Target user not found");
      const school = await tx.school.findFirst({ where: { id: schoolId }, select: { name: true } });
      const userRoles = await tx.userRole.findMany({
        where: { userId },
        include: { role: { include: { permissions: { include: { permission: true } } } } },
      });
      const roles = (userRoles as Array<{ role: { name: string } }>).map((ur) => ur.role.name);
      const permissions = [
        ...new Set(
          (userRoles as Array<{ role: { permissions: { permission: { key: string } }[] } }>).flatMap((ur) =>
            ur.role.permissions.map((rp) => rp.permission.key),
          ),
        ),
      ];
      return { name: u.name, schoolName: school?.name ?? "", roles, permissions };
    });

    const secret = process.env.AUTH_SECRET;
    if (!secret) throw new NotFoundException("Auth not configured");
    // The target school's effective modules — the web nav is module-gated, so an
    // impersonated session without them renders an empty app.
    const modules = await this.entitlements.effectiveModules(schoolId);
    const token = jwt.sign(
      {
        userId,
        school_id: schoolId,
        roles: target.roles,
        permissions: target.permissions,
        // Everything the web session needs rides INSIDE the signed token: the
        // browser must not be able to hand itself a different school or module set.
        // (The API ignores these; it re-derives entitlements server-side anyway.)
        name: target.name,
        schoolName: target.schoolName,
        modules,
        imp: { by: p.userId },
      },
      secret,
      { algorithm: "HS256", expiresIn: IMPERSONATION_TTL },
    );

    // Audit in the OPERATOR's own tenant (actor FK is the operator).
    await this.auditAsOperator(p, { actorId: p.userId, action: "operator.impersonate", entity: "user", entityId: userId, schoolId: p.schoolId, metadata: { targetSchoolId: schoolId, targetName: target.name } });
    return { token, expiresIn: IMPERSONATION_TTL, target: { userId, name: target.name, roles: target.roles } };
  }
}
