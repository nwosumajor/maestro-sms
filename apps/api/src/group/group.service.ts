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
  GroupFlag,
  GroupMoneyDto,
  GroupOverviewDto,
  GroupRefDto,
  GroupSchoolDetailDto,
  GroupSchoolStatsDto,
  GroupTrendPointDto,
} from "@sms/types";
// VALUE import: Prisma.sql only resolves as a value, not a type (CLAUDE.md).
import { Prisma } from "@sms/db";
import { headcountBySchool } from "../operator/operator-people";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantDatabase,
} from "../integrity/integrity.foundation";
import { PrivilegedDatabaseService } from "../common/privileged-database.service";

/** Below this, a campus's attendance is worth the director's attention. */
const LOW_ATTENDANCE_PCT = 85;

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

  /**
   * Resolve the reporting window.
   *
   * The console used to report attendance for TODAY and nothing else, which made it
   * blank on a weekend, on a holiday, and every morning before registers were taken
   * — on the page a proprietor opens first. A period is now chosen, and the label
   * travels with the figures so nobody has to guess what they are looking at.
   */
  private resolvePeriod(key?: string): { from: Date; to: Date; label: string; key: string } {
    const to = new Date();
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    switch (key) {
      case "today":
        return { from, to, label: "Today", key: "today" };
      case "week":
        from.setDate(from.getDate() - 6);
        return { from, to, label: "Last 7 days", key: "week" };
      case "term":
        // A term is per-school and they need not align across campuses, so the
        // group view uses a fixed 90-day window rather than pretending otherwise.
        from.setDate(from.getDate() - 89);
        return { from, to, label: "Last 90 days", key: "term" };
      case "month":
      default:
        from.setDate(1);
        return { from, to, label: "This month", key: "month" };
    }
  }

  /** Money per campus per CURRENCY. Never summed across currencies. */
  private async moneyByCampus(
    schoolIds: string[],
    from: Date,
    to: Date,
  ): Promise<Map<string, GroupMoneyDto[]>> {
    const client = this.client();
    // A payment carries no currency of its own — it inherits its INVOICE's. So the
    // collected figures join through to the invoice rather than assuming NGN, which
    // is precisely the assumption that made the old totals wrong.
    const [paid, invoiced, collected] = await Promise.all([
      client.$queryRaw<Array<{ schoolId: string; currency: string; total: number }>>(Prisma.sql`
        SELECT p."schoolId", i.currency, SUM(p."amountMinor")::float8 AS total
        FROM payment p JOIN invoice i ON i.id = p."invoiceId"
        WHERE p."schoolId" = ANY(ARRAY[${Prisma.join(schoolIds)}]::uuid[])
          AND p.status = 'POSTED' AND p.kind = 'PAYMENT'
          AND p."paidAt" >= ${from} AND p."paidAt" <= ${to}
        GROUP BY 1, 2
      `),
      client.$queryRaw<Array<{ schoolId: string; currency: string; total: number }>>(Prisma.sql`
        SELECT i."schoolId", i.currency, SUM(i."totalMinor")::float8 AS total
        FROM invoice i
        WHERE i."schoolId" = ANY(ARRAY[${Prisma.join(schoolIds)}]::uuid[])
          AND i.status IN ('ISSUED', 'PARTIALLY_PAID')
        GROUP BY 1, 2
      `),
      client.$queryRaw<Array<{ schoolId: string; currency: string; total: number }>>(Prisma.sql`
        SELECT p."schoolId", i.currency, SUM(p."amountMinor")::float8 AS total
        FROM payment p JOIN invoice i ON i.id = p."invoiceId"
        WHERE p."schoolId" = ANY(ARRAY[${Prisma.join(schoolIds)}]::uuid[])
          AND p.status = 'POSTED' AND p.kind = 'PAYMENT'
          AND i.status IN ('ISSUED', 'PARTIALLY_PAID')
        GROUP BY 1, 2
      `),
    ]);

    const out = new Map<string, Map<string, GroupMoneyDto>>();
    const slot = (schoolId: string, currency: string): GroupMoneyDto => {
      let per = out.get(schoolId);
      if (!per) out.set(schoolId, (per = new Map()));
      let row = per.get(currency);
      if (!row) per.set(currency, (row = { currency, collectedMinor: 0, outstandingMinor: 0 }));
      return row;
    };
    // float8 rather than int: a lifetime kobo total overflows int4, and int8 comes
    // back as BigInt which will not serialise to JSON (CLAUDE.md).
    for (const r of paid) slot(r.schoolId, r.currency).collectedMinor += Math.round(r.total);
    for (const r of invoiced) slot(r.schoolId, r.currency).outstandingMinor += Math.round(r.total);
    for (const r of collected) {
      const row = slot(r.schoolId, r.currency);
      row.outstandingMinor = Math.max(0, row.outstandingMinor - Math.round(r.total));
    }
    return new Map([...out].map(([k, v]) => [k, [...v.values()].sort((a, b) => a.currency.localeCompare(b.currency))]));
  }

  /** Conditions a director should act on, worst first. */
  private flagsFor(x: {
    active: boolean;
    subscriptionStatus: string;
    students: number;
    staff: number;
    registersTaken: number;
    attendancePct: number | null;
  }): GroupFlag[] {
    const flags: GroupFlag[] = [];
    if (!x.active) flags.push("DISABLED");
    if (x.subscriptionStatus !== "ACTIVE") flags.push("BILLING");
    if (x.students > 0 && x.staff === 0) flags.push("NO_STAFF");
    // Only meaningful where there are pupils to register.
    if (x.students > 0 && x.registersTaken === 0) flags.push("NO_REGISTERS");
    else if (x.attendancePct != null && x.attendancePct < LOW_ATTENDANCE_PCT) flags.push("LOW_ATTENDANCE");
    return flags;
  }

  /**
   * The caller's group dashboard.
   *
   * `groupId` selects among the groups they direct; omitted picks the first. Every
   * figure is an aggregate, computed as ONE grouped query per metric across all
   * campuses at once — never a query per school.
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
    const period = this.resolvePeriod(opts.period);

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
        period,
        schools: [],
        totals: { students: 0, staff: 0, byCurrency: {} },
        flagged: 0,
      };
    }

    const [schools, subs, headcounts, attTotalGroups, attPresentGroups, registerGroups, money] = await Promise.all([
      client.school.findMany({
        where: { id: { in: schoolIds } },
        select: { id: true, name: true, slug: true, status: true },
        orderBy: { name: "asc" },
      }),
      client.schoolSubscription.findMany({
        where: { schoolId: { in: schoolIds } },
        select: { schoolId: true, plan: true, status: true, currentPeriodEnd: true },
      }),
      // The SHARED headcount: students and staff by the same definition the
      // operator console and the school analytics use. Staff used to be a count of
      // `employee` ROWS, so a campus that had not filled in its HR register showed
      // zero staff while employing forty.
      headcountBySchool(client, schoolIds),
      client.attendanceRecord.groupBy({
        by: ["schoolId"],
        where: { schoolId: { in: schoolIds }, session: { date: { gte: period.from, lte: period.to } } },
        _count: { _all: true },
      }),
      client.attendanceRecord.groupBy({
        by: ["schoolId"],
        where: {
          schoolId: { in: schoolIds },
          // LATE and EXCUSED count as attending — the same rule as the report card,
          // so a campus's figure here matches the one its own staff see.
          status: { in: ["PRESENT", "LATE", "EXCUSED"] },
          session: { date: { gte: period.from, lte: period.to } },
        },
        _count: { _all: true },
      }),
      client.attendanceSession.groupBy({
        by: ["schoolId"],
        where: { schoolId: { in: schoolIds }, date: { gte: period.from, lte: period.to } },
        _count: { _all: true },
      }),
      this.moneyByCampus(schoolIds, period.from, period.to),
    ]);

    const subOf = new Map(subs.map((s) => [s.schoolId, s]));
    const countBy = (rows: Array<{ schoolId: string; _count: { _all: number } }>) =>
      new Map(rows.map((r) => [r.schoolId, r._count._all]));
    const attTotal = countBy(attTotalGroups as never);
    const attPresent = countBy(attPresentGroups as never);
    const registers = countBy(registerGroups as never);

    // Built from `schools`, so a campus with no data at all still appears — an
    // absent school reads as a problem, not as a school with nothing to report.
    const perSchool: GroupSchoolStatsDto[] = schools.map((school) => {
      const sub = subOf.get(school.id);
      const head = headcounts.get(school.id) ?? { students: 0, staff: 0, parents: 0 };
      const total = attTotal.get(school.id) ?? 0;
      const base = {
        active: school.status === "ACTIVE",
        subscriptionStatus: sub?.status ?? "ACTIVE",
        students: head.students,
        staff: head.staff,
        registersTaken: registers.get(school.id) ?? 0,
        attendancePct: total > 0 ? Math.round(((attPresent.get(school.id) ?? 0) / total) * 100) : null,
      };
      return {
        schoolId: school.id,
        name: school.name,
        slug: school.slug,
        ...base,
        money: money.get(school.id) ?? [],
        plan: sub?.plan ?? "STANDARD",
        currentPeriodEnd: sub?.currentPeriodEnd ?? null,
        flags: this.flagsFor(base),
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
      period: period.key,
    });

    return {
      groupId: group.id,
      groupName: group.name,
      groups,
      period,
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
   */
  async schoolDetail(p: Principal, schoolId: string): Promise<GroupSchoolDetailDto> {
    const client = this.client();
    const directorships = await this.directedGroups(p.userId);
    // The campus must be in a group this person directs. Anything else is 404 —
    // never 403, which would confirm the school exists.
    const owning = directorships.find((d) => d.group.members.some((m) => m.schoolId === schoolId));
    if (!owning) throw new NotFoundException("Not found");

    const school = await client.school.findFirst({
      where: { id: schoolId },
      select: { id: true, name: true, slug: true, status: true },
    });
    if (!school) throw new NotFoundException("Not found");

    const now = new Date();
    const trendFrom = new Date(now.getFullYear(), now.getMonth() - 5, 1);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const [headcounts, classes, sub, invoiceStatuses, money, monthlyPaid, monthlyAtt] = await Promise.all([
      headcountBySchool(client, [schoolId]),
      client.class.count({ where: { schoolId } }),
      client.schoolSubscription.findFirst({
        where: { schoolId },
        select: { plan: true, status: true, currentPeriodEnd: true },
      }),
      client.invoice.groupBy({ by: ["status"], where: { schoolId }, _count: { _all: true } }),
      this.moneyByCampus([schoolId], monthStart, now),
      // Monthly collection, grouped in SQL rather than by pulling payments back.
      client.$queryRaw<Array<{ month: Date; total: number }>>(Prisma.sql`
        SELECT date_trunc('month', p."paidAt") AS month, SUM(p."amountMinor")::float8 AS total
        FROM payment p
        WHERE p."schoolId" = ${schoolId}::uuid AND p.status = 'POSTED' AND p.kind = 'PAYMENT'
          AND p."paidAt" >= ${trendFrom}
        GROUP BY 1 ORDER BY 1
      `),
      client.$queryRaw<Array<{ month: Date; present: number; total: number }>>(Prisma.sql`
        SELECT date_trunc('month', s.date) AS month,
               count(*) FILTER (WHERE r.status IN ('PRESENT','LATE','EXCUSED'))::int AS present,
               count(*)::int AS total
        FROM attendance_record r
        JOIN attendance_session s ON s.id = r."sessionId"
        WHERE r."schoolId" = ${schoolId}::uuid AND s.date >= ${trendFrom}
        GROUP BY 1 ORDER BY 1
      `),
    ]);

    const head = headcounts.get(schoolId) ?? { students: 0, staff: 0, parents: 0 };
    const key = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const paidBy = new Map(monthlyPaid.map((r) => [key(new Date(r.month)), r.total]));
    const attBy = new Map(monthlyAtt.map((r) => [key(new Date(r.month)), r]));
    const trend: GroupTrendPointDto[] = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      const a = attBy.get(k);
      trend.push({
        month: k,
        collectedMinor: Math.round(paidBy.get(k) ?? 0),
        attendancePct: a && a.total > 0 ? Math.round((a.present / a.total) * 100) : null,
      });
    }

    const registersTaken = monthlyAtt.reduce((n, r) => n + r.total, 0);
    const latest = trend.at(-1);
    const base = {
      active: school.status === "ACTIVE",
      subscriptionStatus: sub?.status ?? "ACTIVE",
      students: head.students,
      staff: head.staff,
      registersTaken,
      attendancePct: latest?.attendancePct ?? null,
    };

    await this.logRead(p, "group.school.read", schoolId, { group: owning.group.name, school: school.name });

    return {
      schoolId: school.id,
      name: school.name,
      slug: school.slug,
      active: base.active,
      groupName: owning.group.name,
      students: head.students,
      staff: head.staff,
      parents: head.parents,
      classes,
      trend,
      invoicesByStatus: Object.fromEntries(
        (invoiceStatuses as Array<{ status: string; _count: { _all: number } }>).map((r) => [r.status, r._count._all]),
      ),
      money: money.get(schoolId) ?? [],
      plan: sub?.plan ?? "STANDARD",
      subscriptionStatus: base.subscriptionStatus,
      currentPeriodEnd: sub?.currentPeriodEnd ?? null,
      flags: this.flagsFor(base),
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

