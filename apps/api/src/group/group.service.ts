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
import { attendanceRatePct, DEFAULT_PLAN, resolveRegion, schoolDateString } from "@sms/types";
import { headcountBySchool } from "../operator/operator-people";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantDatabase,
} from "../integrity/integrity.foundation";
import { PrivilegedDatabaseService } from "../common/privileged-database.service";
import {
  campusFigures,
  campusWindow,
  flagsFor,
  periodKeyOf,
  periodLabelOf,
  subscriptionStatusOf,
  type Campus,
} from "./campus-metrics";

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

  /** The campus in its OWN zone — `resolveRegion` falls back to the country's. */
  private campusOf(school: { id: string; country: string | null; timezone: string | null; currency: string | null }): Campus {
    return { id: school.id, timezone: resolveRegion(school).timezone };
  }

  /**
   * The period as the header states it. Each campus is measured over its OWN
   * calendar, so `from` is the earliest campus start — the envelope — and the
   * label is what every campus shares.
   */
  private periodOf(key: GroupPeriodKey, campuses: Campus[], now: Date): GroupPeriodDto {
    const starts = campuses.map((c) => campusWindow(key, c.timezone, now).fromInstant.getTime());
    const from = starts.length > 0 ? new Date(Math.min(...starts)) : campusWindow(key, "UTC", now).fromInstant;
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
    const campuses = schools.map((s) => this.campusOf(s));
    const figures = await campusFigures(client, campuses, key, now);

    const subOf = new Map(subs.map((s) => [s.schoolId, s]));
    // Built from `schools`, so a campus with no data at all still appears — an
    // absent school reads as a problem, not as a school with nothing to report.
    const perSchool: GroupSchoolStatsDto[] = schools.map((school) => {
      const sub = subOf.get(school.id);
      const head = headcounts.get(school.id) ?? { students: 0, staff: 0, parents: 0 };
      const fig = figures.get(school.id)!;
      const base = {
        active: school.status === "ACTIVE",
        subscriptionStatus: subscriptionStatusOf(sub),
        students: head.students,
        staff: head.staff,
        registersTaken: fig.registersTaken,
        attendancePct: fig.attendancePct,
      };
      return {
        schoolId: school.id,
        name: school.name,
        slug: school.slug,
        ...base,
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

    const byCurrency: Record<string, { collectedMinor: number; outstandingMinor: number }> = {};
    for (const s of perSchool) {
      for (const m of s.money) {
        const slot = (byCurrency[m.currency] ??= { collectedMinor: 0, outstandingMinor: 0 });
        slot.collectedMinor += m.collectedMinor;
        slot.outstandingMinor += m.outstandingMinor;
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
    const campus = this.campusOf(school);
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

    const base = {
      active: school.status === "ACTIVE",
      subscriptionStatus: subscriptionStatusOf(sub),
      students: head.students,
      staff: head.staff,
      registersTaken: fig.registersTaken,
      attendancePct: fig.attendancePct,
    };

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
    const header = [
      "School", "Status", "Students", "Staff", "Attendance %", "Registers taken",
      "Currency", "Collected (minor)", "Outstanding (minor)", "Plan", "Billing", "Flags",
    ];
    const rows: string[][] = [];
    for (const s of data.schools) {
      // A campus with no invoices still gets a row — an absent school reads as a
      // problem, not as one with nothing to report.
      const money = s.money.length > 0 ? s.money : [{ currency: "", collectedMinor: 0, outstandingMinor: 0 }];
      for (const m of money) {
        rows.push([
          s.name,
          s.active ? "ACTIVE" : "DISABLED",
          String(s.students),
          String(s.staff),
          s.attendancePct == null ? "" : String(s.attendancePct),
          String(s.registersTaken),
          m.currency,
          String(m.collectedMinor),
          String(m.outstandingMinor),
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

  async listGroups() {
    const client = this.client();
    const groups = await client.schoolGroup.findMany({
      include: { members: true, directors: true },
      orderBy: { name: "asc" },
    });
    const schoolIds = [...new Set(groups.flatMap((g) => g.members.map((m) => m.schoolId)))];
    const userIds = [...new Set(groups.flatMap((g) => g.directors.map((d) => d.userId)))];
    const [schools, users] = await Promise.all([
      client.school.findMany({ where: { id: { in: schoolIds } }, select: { id: true, name: true } }),
      client.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true, name: true } }),
    ]);
    const schoolOf = new Map(schools.map((s) => [s.id, s.name]));
    const userOf = new Map(users.map((u) => [u.id, `${u.name} <${u.email}>`]));
    return groups.map((g) => ({
      id: g.id,
      name: g.name,
      members: g.members.map((m) => ({ schoolId: m.schoolId, name: schoolOf.get(m.schoolId) ?? m.schoolId })),
      directors: g.directors.map((d) => ({ userId: d.userId, label: userOf.get(d.userId) ?? d.userId })),
    }));
  }

  async createGroup(p: Principal, name: string) {
    const group = await this.client().schoolGroup.create({ data: { name: name.trim() } });
    await this.opAudit(p, "operator.group.create", group.id, { name: group.name });
    return group;
  }

  /** Replace the member-school set (ids validated against real schools). */
  async setMembers(p: Principal, groupId: string, schoolIds: string[]) {
    const client = this.client();
    const group = await client.schoolGroup.findFirst({ where: { id: groupId } });
    if (!group) throw new NotFoundException("Group not found");
    const valid = await client.school.findMany({
      where: { id: { in: schoolIds }, isPlatform: false },
      select: { id: true },
    });
    await client.$transaction([
      client.schoolGroupMember.deleteMany({ where: { groupId } }),
      client.schoolGroupMember.createMany({ data: valid.map((s) => ({ groupId, schoolId: s.id })) }),
    ]);
    await this.opAudit(p, "operator.group.members", groupId, { schoolIds: valid.map((s) => s.id) });
    return { members: valid.length };
  }

  /** Replace the director set: users identified by EMAIL (must exist, and must
   *  belong to one of the group's member schools — a director is always one of
   *  the group's own people, never an outsider). */
  async setDirectors(p: Principal, groupId: string, emails: string[]) {
    const client = this.client();
    const group = await client.schoolGroup.findFirst({ where: { id: groupId }, include: { members: true } });
    if (!group) throw new NotFoundException("Group not found");
    const memberSchoolIds = group.members.map((m) => m.schoolId);
    const users = await client.user.findMany({
      where: { email: { in: emails.map((e) => e.trim().toLowerCase()) }, schoolId: { in: memberSchoolIds } },
      select: { id: true, email: true },
    });
    await client.$transaction([
      client.schoolGroupDirector.deleteMany({ where: { groupId } }),
      client.schoolGroupDirector.createMany({ data: users.map((u) => ({ groupId, userId: u.id })) }),
    ]);
    await this.opAudit(p, "operator.group.directors", groupId, { emails: users.map((u) => u.email) });
    return { directors: users.length };
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

