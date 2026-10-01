// =============================================================================
// GroupService — multi-school console for proprietors (franchise tier)
// =============================================================================
// Directorship in the operator-managed school_group registry IS the
// authorization: the caller's userId must appear in school_group_director.
// Everything here runs on the PRIVILEGED client (the registry and the
// cross-tenant reads are invisible to the app role — rls/74 deny-all), exactly
// like the operator console. 404-not-403 when the caller directs no group.
// The overview carries AGGREGATES ONLY (counts and sums) — never student PII.

import { Inject, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { csvCell } from "../common/csv";
import type {
  GroupAdminDto,
  GroupDirectorCandidatePageDto,
  GroupWriteResultDto,
  GroupOverviewDto,
  GroupPeriodDto,
  GroupPeriodKey,
  GroupRefDto,
  GroupSchoolDetailDto,
  GroupSchoolStatsDto,
  GroupTrendPointDto,
} from "@sms/types";
// VALUE import: Prisma.sql only resolves as a value, not a type (CLAUDE.md).
import { Prisma } from "@sms/db";
import {
  attendanceRatePct,
  currencyDecimals,
  DEFAULT_PLAN,
  MODULES,
  NON_SCHOOL_STAFF_ROLE_NAMES,
  resolveRegion,
  schoolDateString,
  toMajor,
} from "@sms/types";
import { headcountBySchool } from "../operator/operator-people";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantDatabase,
} from "../integrity/integrity.foundation";
import { PrivilegedDatabaseService } from "../common/privileged-database.service";
import { ModuleEntitlementService } from "../foundation/module-entitlement.service";
import {
  campusFigures,
  campusWindow,
  flagsFor,
  loadCampuses,
  periodKeyOf,
  periodLabelOf,
  subscriptionStatusOf,
  type Campus,
  type CampusFigures,
} from "./campus-metrics";

/** How many director candidates one search returns; the total says if there are more. */
const DIRECTOR_CANDIDATE_PAGE = 20;

/** The registry columns every campus read needs: identity, status and region. */
const CAMPUS_SELECT = {
  id: true,
  name: true,
  slug: true,
  status: true,
  country: true,
  timezone: true,
  currency: true,
} as const;

@Injectable()
export class GroupService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly privileged: PrivilegedDatabaseService,
    private readonly entitlements: ModuleEntitlementService,
  ) {}

  private client() {
    const c = this.privileged.client;
    if (!c) throw new ServiceUnavailableException("Group console requires the privileged database configuration");
    return c;
  }

  /** Every group this user directs. Empty = not a director. */
  private async directedGroups(userId: string) {
    return this.client().schoolGroupDirector.findMany({
      where: { userId },
      include: { group: { include: { members: true } } },
      orderBy: { group: { name: "asc" } },
    });
  }

  /** The figures the flags are computed from — one shape for both pages. */
  private flagInputs(
    school: { status: string },
    sub: { status: string } | null | undefined,
    head: { students: number; staff: number },
    fig: CampusFigures,
    campus: Campus,
  ) {
    return {
      active: school.status === "ACTIVE",
      subscriptionStatus: subscriptionStatusOf(sub),
      students: head.students,
      staff: head.staff,
      registersTaken: fig.registersTaken,
      registersExpected: fig.registersExpected,
      registersCovered: fig.registersCovered,
      registerCoveragePct: fig.registerCoveragePct,
      hasCurrentTerm: campus.currentTerm != null,
      attendancePct: fig.attendancePct,
    };
  }

  /**
   * The period as the header states it. Each campus is measured over its OWN
   * calendar, so `from` is the earliest campus start — the envelope — and the
   * label is what every campus shares.
   */
  private periodOf(key: GroupPeriodKey, campuses: Campus[], now: Date): GroupPeriodDto {
    const starts = campuses.map((c) => campusWindow(key, c, now).fromInstant.getTime());
    const utc: Campus = { id: "", timezone: "UTC", schoolDays: [], currentTerm: null, datedTerms: [] };
    const from = starts.length > 0 ? new Date(Math.min(...starts)) : campusWindow(key, utc, now).fromInstant;
    return { from, to: now, label: periodLabelOf(key), key };
  }

  /**
   * The caller's group dashboard.
   *
   * `groupId` selects among the groups they direct; omitted picks the first. Every
   * figure comes from `campusFigures` — one grouped query per metric across all
   * campuses at once, never a query per school, and the SAME definition the
   * campus page and the CSV use.
   */
  async overview(p: Principal, opts: { groupId?: string; period?: string } = {}): Promise<GroupOverviewDto> {
    const client = this.client();
    const directorships = await this.directedGroups(p.userId);
    // 404-not-403: a non-director learns nothing about groups existing.
    if (directorships.length === 0) throw new NotFoundException("Not found");

    const chosen = opts.groupId
      ? directorships.find((d) => d.groupId === opts.groupId)
      : directorships[0];
    // Asking for a group you do not direct is indistinguishable from one that does
    // not exist.
    if (!chosen) throw new NotFoundException("Not found");

    const group = chosen.group;
    const schoolIds = group.members.map((m) => m.schoolId);
    const key = periodKeyOf(opts.period);
    const now = new Date();

    const groups: GroupRefDto[] = directorships.map((d) => ({
      id: d.group.id,
      name: d.group.name,
      schools: d.group.members.length,
    }));
    if (schoolIds.length === 0) {
      return {
        groupId: group.id,
        groupName: group.name,
        groups,
        period: this.periodOf(key, [], now),
        schools: [],
        totals: { students: 0, staff: 0, byCurrency: {} },
        flagged: 0,
      };
    }

    const [schools, subs, headcounts] = await Promise.all([
      client.school.findMany({
        where: { id: { in: schoolIds } },
        select: CAMPUS_SELECT,
        orderBy: { name: "asc" },
      }),
      client.schoolSubscription.findMany({
        where: { schoolId: { in: schoolIds } },
        select: { schoolId: true, plan: true, status: true, currentPeriodEnd: true },
      }),
      // The SHARED headcount: students and staff by the same definition the
      // operator console and the school analytics use.
      headcountBySchool(client, schoolIds),
    ]);
    const campuses = await loadCampuses(client, schools);
    const campusOf = new Map(campuses.map((c) => [c.id, c]));
    const figures = await campusFigures(client, campuses, key, now);

    const subOf = new Map(subs.map((s) => [s.schoolId, s]));
    // Built from `schools`, so a campus with no data at all still appears — an
    // absent school reads as a problem, not as a school with nothing to report.
    const perSchool: GroupSchoolStatsDto[] = schools.map((school) => {
      const sub = subOf.get(school.id);
      const head = headcounts.get(school.id) ?? { students: 0, staff: 0, parents: 0 };
      const fig = figures.get(school.id)!;
      const base = this.flagInputs(school, sub, head, fig, campusOf.get(school.id)!);
      return {
        schoolId: school.id,
        name: school.name,
        slug: school.slug,
        ...base,
        window: fig.window,
        previous: fig.previous,
        money: fig.money,
        plan: sub?.plan ?? DEFAULT_PLAN,
        currentPeriodEnd: sub?.currentPeriodEnd ?? null,
        flags: flagsFor(base),
      };
    });

    // Worst first: the reason to open this page is to find the campus that needs
    // attention, not to read an alphabetical list.
    perSchool.sort(
      (a, b) =>
        b.flags.length - a.flags.length ||
        (a.attendancePct ?? 101) - (b.attendancePct ?? 101) ||
        a.name.localeCompare(b.name),
    );

    const byCurrency: Record<string, { collectedMinor: number; outstandingMinor: number; overdueMinor: number }> = {};
    for (const s of perSchool) {
      for (const m of s.money) {
        const slot = (byCurrency[m.currency] ??= { collectedMinor: 0, outstandingMinor: 0, overdueMinor: 0 });
        slot.collectedMinor += m.collectedMinor;
        slot.outstandingMinor += m.outstandingMinor;
        slot.overdueMinor += m.overdueMinor;
      }
    }

    await this.logRead(p, "group.overview.read", group.id, {
      group: group.name,
      schools: schoolIds.length,
      period: key,
    });

    return {
      groupId: group.id,
      groupName: group.name,
      groups,
      period: this.periodOf(key, campuses, now),
      schools: perSchool,
      totals: {
        students: perSchool.reduce((n, s) => n + s.students, 0),
        staff: perSchool.reduce((n, s) => n + s.staff, 0),
        byCurrency,
      },
      flagged: perSchool.filter((s) => s.flags.length > 0).length,
    };
  }

  /**
   * ONE campus, in depth — why a row on the overview looks wrong.
   *
   * Still aggregates only. A director is not staff at that campus: they see monthly
   * totals, status counts and headcount, never a named pupil, an invoice or a
   * record. Those stay behind that school's own permissions, where they belong.
   *
   * @param opts.period the SAME window the overview used. Its flags and figures
   * come from the same `campusFigures` call the overview makes, asked about one
   * campus — so a flag cannot appear on the list and vanish here, and the money
   * here is the money on the row that was clicked.
   */
  async schoolDetail(
    p: Principal,
    schoolId: string,
    opts: { period?: string } = {},
  ): Promise<GroupSchoolDetailDto> {
    const client = this.client();
    const directorships = await this.directedGroups(p.userId);
    // The campus must be in a group this person directs. Anything else is 404 —
    // never 403, which would confirm the school exists.
    const owning = directorships.find((d) => d.group.members.some((m) => m.schoolId === schoolId));
    if (!owning) throw new NotFoundException("Not found");

    const school = await client.school.findFirst({ where: { id: schoolId }, select: CAMPUS_SELECT });
    if (!school) throw new NotFoundException("Not found");

    const now = new Date();
    const key = periodKeyOf(opts.period);
    const [campus] = await loadCampuses(client, [school]);
    const trendCurrency = resolveRegion(school).currency;

    // The six-month trend, in the CAMPUS's calendar: the months are its months
    // and a payment at 23:30 on the 31st in Lagos belongs to that month, not the
    // next. Months come back as 'YYYY-MM' text so no Date crosses a zone again.
    const today = schoolDateString(campus.timezone, now);
    const thisMonth = new Date(`${today.slice(0, 7)}-01T00:00:00.000Z`);
    const months: string[] = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(thisMonth);
      d.setUTCMonth(d.getUTCMonth() - i);
      months.push(d.toISOString().slice(0, 7));
    }
    const trendFromDay = `${months[0]}-01`;

    const [headcounts, classes, sub, invoiceStatuses, figures, monthlyPaid, monthlyAtt] = await Promise.all([
      headcountBySchool(client, [schoolId]),
      client.class.count({ where: { schoolId } }),
      client.schoolSubscription.findFirst({
        where: { schoolId },
        select: { plan: true, status: true, currentPeriodEnd: true },
      }),
      client.invoice.groupBy({ by: ["status"], where: { schoolId }, _count: { _all: true } }),
      campusFigures(client, [campus], key, now),
      // ONE LINE ON A CHART IS ONE CURRENCY: restricted to the campus's own,
      // which the DTO names; the per-currency figures are on the money block.
      // NET of refunds, the same "collected" as the period figure above it.
      client.$queryRaw<Array<{ month: string; currency: string; total: number }>>(Prisma.sql`
        SELECT to_char(date_trunc('month', (p."paidAt" AT TIME ZONE 'UTC') AT TIME ZONE ${campus.timezone}), 'YYYY-MM') AS month,
               i.currency,
               SUM(CASE WHEN p.kind = 'REFUND' THEN -p."amountMinor"::numeric ELSE p."amountMinor"::numeric END)::float8 AS total
          FROM payment p JOIN invoice i ON i.id = p."invoiceId"
         WHERE p."schoolId" = ${schoolId}::uuid AND p.status = 'POSTED' AND i.currency = ${trendCurrency}
           AND p."paidAt" >= ${trendFromDay}::timestamp - interval '1 day'
         GROUP BY 1, 2
      `),
      // Bounded by date: attendance_record is partitioned by it.
      client.$queryRaw<Array<{ month: string; present: number; late: number; absent: number; excused: number }>>(Prisma.sql`
        SELECT to_char(date_trunc('month', r.date), 'YYYY-MM') AS month,
               count(*) FILTER (WHERE r.status = 'PRESENT')::int AS present,
               count(*) FILTER (WHERE r.status = 'LATE')::int    AS late,
               count(*) FILTER (WHERE r.status = 'ABSENT')::int  AS absent,
               count(*) FILTER (WHERE r.status = 'EXCUSED')::int AS excused
          FROM attendance_record r
         WHERE r."schoolId" = ${schoolId}::uuid AND r.date >= ${trendFromDay}::date AND r.date <= ${today}::date
         GROUP BY 1
      `),
    ]);

    const head = headcounts.get(schoolId) ?? { students: 0, staff: 0, parents: 0 };
    const fig = figures.get(schoolId)!;
    const paidBy = new Map(monthlyPaid.filter((r) => r.currency === trendCurrency).map((r) => [r.month, r.total]));
    const attBy = new Map(monthlyAtt.map((r) => [r.month, r]));
    const trend: GroupTrendPointDto[] = months.map((month) => {
      const a = attBy.get(month);
      return {
        month,
        collectedMinor: Math.round(paidBy.get(month) ?? 0),
        // The platform's ONE rate rule — the same as the period figure.
        attendancePct: a ? attendanceRatePct(a) : null,
      };
    });

    const base = this.flagInputs(school, sub, head, fig, campus);

    await this.logRead(p, "group.school.read", schoolId, {
      group: owning.group.name,
      school: school.name,
      period: key,
    });

    return {
      period: this.periodOf(key, [campus], now),
      schoolId: school.id,
      name: school.name,
      slug: school.slug,
      active: base.active,
      groupName: owning.group.name,
      attendancePct: base.attendancePct,
      registersTaken: base.registersTaken,
      registersExpected: base.registersExpected,
      registersCovered: base.registersCovered,
      registerCoveragePct: base.registerCoveragePct,
      hasCurrentTerm: base.hasCurrentTerm,
      window: fig.window,
      previous: fig.previous,
      students: head.students,
      staff: head.staff,
      parents: head.parents,
      classes,
      trend,
      trendCurrency,
      invoicesByStatus: Object.fromEntries(
        (invoiceStatuses as Array<{ status: string; _count: { _all: number } }>).map((r) => [r.status, r._count._all]),
      ),
      money: fig.money,
      plan: sub?.plan ?? DEFAULT_PLAN,
      subscriptionStatus: base.subscriptionStatus,
      currentPeriodEnd: sub?.currentPeriodEnd ?? null,
      flags: flagsFor(base),
    };
  }

  /**
   * The overview as CSV, for a board pack.
   *
   * Built from the SAME `overview()` call the screen renders, so the export can
   * never disagree with what the director just looked at — and it carries the same
   * audit entry, because an export is a read, not a lesser thing. One row per
   * campus per currency: a single "collected" column would have to add naira to
   * dollars, which is the bug this whole change exists to remove.
   */
  async overviewCsv(p: Principal, opts: { groupId?: string; period?: string } = {}): Promise<string> {
    const data = await this.overview(p, opts);
    // MAJOR units, written with the currency's own decimals: a board pack is read
    // by people, and "450000000" kobo beside "4500" dollars-in-cents was a column
    // nobody could read without a calculator. Each row names its currency.
    const amount = (minor: number, currency: string) =>
      currency ? toMajor(minor, currency).toFixed(currencyDecimals(currency)) : "";
    const header = [
      "School", "Status", "From", "To", "Window", "Students", "Staff",
      "Attendance %", "Previous attendance %", "Registers taken", "Registers expected", "Registers covered",
      "Register coverage %",
      "Currency", "Collected", "Previous collected", "Owed now", "Overdue", "Overdue 60+ days",
      "Plan", "Billing", "Flags",
    ];
    const blank = (n: number | null) => (n == null ? "" : String(n));
    const rows: string[][] = [];
    for (const s of data.schools) {
      // A campus with no money still gets a row — an absent school reads as a
      // problem, not as one with nothing to report.
      const money =
        s.money.length > 0
          ? s.money
          : [{ currency: "", collectedMinor: 0, outstandingMinor: 0, overdueMinor: 0, aging: { currentMinor: 0, d1_30Minor: 0, d31_60Minor: 0, d60plusMinor: 0 } }];
      for (const m of money) {
        const before = s.previous.collected.find((c) => c.currency === m.currency)?.collectedMinor ?? 0;
        rows.push([
          s.name,
          s.active ? "ACTIVE" : "DISABLED",
          s.window.fromDay,
          s.window.toDay,
          s.window.basis,
          String(s.students),
          String(s.staff),
          blank(s.attendancePct),
          blank(s.previous.attendancePct),
          String(s.registersTaken),
          blank(s.registersExpected),
          // The count beside the %, so 2 of 589 is not read as none at all.
          blank(s.registersCovered),
          blank(s.registerCoveragePct),
          m.currency,
          amount(m.collectedMinor, m.currency),
          amount(before, m.currency),
          amount(m.outstandingMinor, m.currency),
          amount(m.overdueMinor, m.currency),
          amount(m.aging.d60plusMinor, m.currency),
          s.plan,
          s.subscriptionStatus,
          s.flags.join(" "),
        ]);
      }
    }
    return [
      `# ${data.groupName} — ${data.period.label}`,
      header.map(csvCell).join(","),
      ...rows.map((r) => r.map(csvCell).join(",")),
    ].join("\n");
  }

  /** Group reads touch every campus — audited in the DIRECTOR's own tenant. */
  private async logRead(p: Principal, action: string, entityId: string, metadata: Record<string, unknown>) {
    await this.db.runAsTenant({ schoolId: p.schoolId, userId: p.userId }, (tx) =>
      this.audit.record(
        { actorId: p.userId, action, entity: "school_group", entityId, schoolId: p.schoolId, metadata },
        tx,
      ),
    );
  }

  // --- operator management (privileged, audited) ------------------------------

  /**
   * Who may be named a director: an ACTIVE member of STAFF at one of the
   * group's member schools — the staff definition the headcount uses.
   *
   * SECURITY: directorship opens a cross-campus read. It used to accept any
   * user whose email matched at a member school — a pupil or a parent included —
   * and a leaver kept it. A director is one of the group's own staff, still here.
   */
  private eligibleDirectorWhere(memberSchoolIds: string[]): Prisma.UserWhereInput {
    return {
      schoolId: { in: memberSchoolIds },
      status: "ACTIVE",
      roles: { some: { role: { name: { notIn: [...NON_SCHOOL_STAFF_ROLE_NAMES] } } } },
    };
  }

  async listGroups(): Promise<GroupAdminDto[]> {
    const client = this.client();
    const groups = await client.schoolGroup.findMany({
      include: { members: true, directors: true },
      orderBy: { name: "asc" },
    });
    const schoolIds = [...new Set(groups.flatMap((g) => g.members.map((m) => m.schoolId)))];
    const userIds = [...new Set(groups.flatMap((g) => g.directors.map((d) => d.userId)))];
    const [schools, users] = await Promise.all([
      client.school.findMany({ where: { id: { in: schoolIds } }, select: { id: true, name: true } }),
      client.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, email: true, name: true, schoolId: true, school: { select: { name: true } } },
      }),
    ]);
    const schoolOf = new Map(schools.map((s) => [s.id, s.name]));
    const userOf = new Map(users.map((u) => [u.id, u]));
    // One entitlement read per DISTINCT director school (cached by the service).
    const directorSchools = [...new Set(users.map((u) => u.schoolId))];
    const enabled = new Map(
      await Promise.all(
        directorSchools.map(async (id) => [id, await this.entitlements.isEnabled(id, MODULES.GROUP)] as const),
      ),
    );
    return groups.map((g) => ({
      id: g.id,
      name: g.name,
      members: g.members
        .map((m) => ({ schoolId: m.schoolId, name: schoolOf.get(m.schoolId) ?? m.schoolId }))
        .sort((x, y) => x.name.localeCompare(y.name)),
      directors: g.directors.map((d) => {
        const u = userOf.get(d.userId);
        return {
          userId: d.userId,
          name: u?.name ?? "",
          email: u?.email ?? d.userId,
          schoolName: u?.school?.name ?? "",
          consoleEnabled: u ? (enabled.get(u.schoolId) ?? false) : false,
        };
      }),
    }));
  }

  async createGroup(p: Principal, name: string) {
    const group = await this.client().schoolGroup.create({ data: { name: name.trim() } });
    await this.opAudit(p, "operator.group.create", group.id, { name: group.name });
    return group;
  }

  /** A group could be created and never renamed — a typo was permanent. */
  async renameGroup(p: Principal, groupId: string, name: string) {
    const client = this.client();
    const group = await client.schoolGroup.findFirst({ where: { id: groupId } });
    if (!group) throw new NotFoundException("Group not found");
    const updated = await client.schoolGroup.update({ where: { id: groupId }, data: { name: name.trim() } });
    await this.opAudit(p, "operator.group.rename", groupId, { from: group.name, to: updated.name });
    return updated;
  }

  /**
   * Remove a group — and with it every director's cross-campus read. Members
   * and directors cascade; no school's own data is touched.
   */
  async deleteGroup(p: Principal, groupId: string) {
    const client = this.client();
    const group = await client.schoolGroup.findFirst({
      where: { id: groupId },
      include: { members: true, directors: true },
    });
    if (!group) throw new NotFoundException("Group not found");
    await client.schoolGroup.delete({ where: { id: groupId } });
    await this.opAudit(p, "operator.group.delete", groupId, {
      name: group.name,
      members: group.members.length,
      directors: group.directors.map((d) => d.userId),
    });
    return { deleted: true };
  }

  /**
   * Replace the member-school set, and say what was NOT applied.
   *
   * A director whose school leaves the group is removed in the SAME transaction:
   * directorship requires belonging to a member school, and it used to outlive
   * the school's membership — a proprietor who sold a campus kept reading the
   * rest of the chain.
   */
  async setMembers(p: Principal, groupId: string, schoolIds: string[]): Promise<GroupWriteResultDto> {
    const client = this.client();
    const group = await client.schoolGroup.findFirst({ where: { id: groupId }, include: { directors: true } });
    if (!group) throw new NotFoundException("Group not found");
    const wanted = [...new Set(schoolIds)];
    const valid = await client.school.findMany({
      where: { id: { in: wanted }, isPlatform: false },
      select: { id: true },
    });
    const validIds = new Set(valid.map((s) => s.id));
    const notApplied = wanted
      .filter((id) => !validIds.has(id))
      .map((value) => ({ value, reason: "No such school (or it is the platform's own organisation)." }));

    // Directors who no longer belong to any member school.
    const directorUsers = await client.user.findMany({
      where: { id: { in: group.directors.map((d) => d.userId) } },
      select: { id: true, name: true, email: true, schoolId: true },
    });
    const orphaned = directorUsers.filter((u) => !validIds.has(u.schoolId));

    await client.$transaction([
      client.schoolGroupMember.deleteMany({ where: { groupId } }),
      client.schoolGroupMember.createMany({ data: valid.map((s) => ({ groupId, schoolId: s.id })) }),
      client.schoolGroupDirector.deleteMany({ where: { groupId, userId: { in: orphaned.map((u) => u.id) } } }),
    ]);
    await this.opAudit(p, "operator.group.members", groupId, {
      schoolIds: [...validIds],
      notApplied: notApplied.map((n) => n.value),
      removedDirectors: orphaned.map((u) => u.id),
    });
    return {
      applied: valid.length,
      notApplied,
      removedDirectors: orphaned.map((u) => ({ name: u.name, email: u.email })),
    };
  }

  /**
   * Replace the director set: users identified by EMAIL, each an ACTIVE member
   * of staff at a member school. Every email that is not applied is returned
   * with the reason, because "Directors saved" over a mistyped address left a
   * proprietor without access and nobody the wiser.
   */
  async setDirectors(p: Principal, groupId: string, emails: string[]): Promise<GroupWriteResultDto> {
    const client = this.client();
    const group = await client.schoolGroup.findFirst({ where: { id: groupId }, include: { members: true } });
    if (!group) throw new NotFoundException("Group not found");
    const memberSchoolIds = group.members.map((m) => m.schoolId);
    const wanted = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];

    const [eligible, known] = await Promise.all([
      client.user.findMany({
        where: { email: { in: wanted }, ...this.eligibleDirectorWhere(memberSchoolIds) },
        select: { id: true, email: true },
      }),
      // Only to EXPLAIN a refusal; never applied.
      client.user.findMany({
        where: { email: { in: wanted } },
        select: { email: true, schoolId: true, status: true },
      }),
    ]);
    const eligibleEmails = new Set(eligible.map((u) => u.email.toLowerCase()));
    const knownBy = new Map(known.map((u) => [u.email.toLowerCase(), u]));
    const members = new Set(memberSchoolIds);
    const notApplied = wanted
      .filter((e) => !eligibleEmails.has(e))
      .map((value) => {
        const u = knownBy.get(value);
        const reason = !u
          ? "No account has this email."
          : !members.has(u.schoolId)
            ? "This person's school is not a member of the group."
            : u.status !== "ACTIVE"
              ? "This account is no longer active."
              : "Only staff may direct a group — this account is a pupil or a parent.";
        return { value, reason };
      });

    await client.$transaction([
      client.schoolGroupDirector.deleteMany({ where: { groupId } }),
      client.schoolGroupDirector.createMany({ data: eligible.map((u) => ({ groupId, userId: u.id })) }),
    ]);
    await this.opAudit(p, "operator.group.directors", groupId, {
      emails: eligible.map((u) => u.email),
      notApplied: notApplied.map((n) => n.value),
    });
    return { applied: eligible.length, notApplied, removedDirectors: [] };
  }

  /**
   * People who may be named a director of this group, searched by name or
   * email — the picker an operator chooses from instead of typing an address
   * from memory. Capped, with the TOTAL, so a short list never reads as all.
   */
  async directorCandidates(groupId: string, q: string | undefined): Promise<GroupDirectorCandidatePageDto> {
    const client = this.client();
    const group = await client.schoolGroup.findFirst({ where: { id: groupId }, include: { members: true } });
    if (!group) throw new NotFoundException("Group not found");
    const term = (q ?? "").trim();
    const where: Prisma.UserWhereInput = {
      ...this.eligibleDirectorWhere(group.members.map((m) => m.schoolId)),
      ...(term
        ? {
            OR: [
              { name: { contains: term, mode: "insensitive" as const } },
              { email: { contains: term, mode: "insensitive" as const } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      client.user.findMany({
        where,
        select: { id: true, name: true, email: true, school: { select: { name: true } } },
        orderBy: [{ name: "asc" }, { id: "asc" }],
        take: DIRECTOR_CANDIDATE_PAGE,
      }),
      client.user.count({ where }),
    ]);
    return {
      rows: rows.map((u) => ({ userId: u.id, name: u.name, email: u.email, schoolName: u.school?.name ?? "" })),
      total,
    };
  }

  private async opAudit(p: Principal, action: string, entityId: string, metadata: Record<string, unknown>) {
    await this.db.runAsTenant({ schoolId: p.schoolId, userId: p.userId }, (tx) =>
      this.audit.record(
        { actorId: p.userId, action, entity: "school_group", entityId, schoolId: p.schoolId, metadata },
        tx,
      ),
    );
  }
}

