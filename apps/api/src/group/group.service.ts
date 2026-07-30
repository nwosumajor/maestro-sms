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
import type { GroupOverviewDto, GroupSchoolStatsDto } from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantDatabase,
} from "../integrity/integrity.foundation";
import { PrivilegedDatabaseService } from "../common/privileged-database.service";

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

  /** The caller's group dashboard (their FIRST directed group in v1). */
  async overview(p: Principal): Promise<GroupOverviewDto> {
    const client = this.client();
    const directorship = await client.schoolGroupDirector.findFirst({
      where: { userId: p.userId },
      include: { group: { include: { members: true } } },
    });
    // 404-not-403: a non-director learns nothing about groups existing.
    if (!directorship) throw new NotFoundException("Not found");

    const group = directorship.group;
    const schoolIds = group.members.map((m) => m.schoolId);
    const schools = await client.school.findMany({
      where: { id: { in: schoolIds } },
      select: { id: true, name: true, slug: true, status: true },
      orderBy: { name: "asc" },
    });
    const subs = await client.schoolSubscription.findMany({
      where: { schoolId: { in: schoolIds } },
      select: { schoolId: true, plan: true, status: true, currentPeriodEnd: true },
    });
    const subOf = new Map(subs.map((s) => [s.schoolId, s]));

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const startOfMonth = new Date(startOfDay);
    startOfMonth.setDate(1);

    // ONE grouped query per METRIC across every campus, instead of seven queries
    // per school inside a sequential loop. A 20-school group was 140 round trips
    // taken one school at a time — the group console is the page a director opens
    // first, and it got slower with every campus they added.
    //
    // Every one of these is still an aggregate: nothing loads rows to count them in
    // Node, which the student tally previously did (findMany + distinct, then
    // `.length`).
    const [studentGroups, staffGroups, attTotalGroups, attPresentGroups, paidGroups, invoicedGroups, collectedGroups] =
      await Promise.all([
        client.userRole.groupBy({
          by: ["schoolId"],
          where: { schoolId: { in: schoolIds }, role: { name: "student" } },
          _count: { userId: true },
        }),
        client.employee.groupBy({ by: ["schoolId"], where: { schoolId: { in: schoolIds } }, _count: { _all: true } }),
        client.attendanceRecord.groupBy({
          by: ["schoolId"],
          where: { schoolId: { in: schoolIds }, session: { date: { gte: startOfDay } } },
          _count: { _all: true },
        }),
        client.attendanceRecord.groupBy({
          by: ["schoolId"],
          where: { schoolId: { in: schoolIds }, status: "PRESENT", session: { date: { gte: startOfDay } } },
          _count: { _all: true },
        }),
        client.payment.groupBy({
          by: ["schoolId"],
          where: { schoolId: { in: schoolIds }, status: "POSTED", kind: "PAYMENT", paidAt: { gte: startOfMonth } },
          _sum: { amountMinor: true },
        }),
        client.invoice.groupBy({
          by: ["schoolId"],
          where: { schoolId: { in: schoolIds }, status: { in: ["ISSUED", "PARTIALLY_PAID"] } },
          _sum: { totalMinor: true },
        }),
        client.payment.groupBy({
          by: ["schoolId"],
          where: {
            schoolId: { in: schoolIds },
            status: "POSTED",
            kind: "PAYMENT",
            invoice: { status: { in: ["ISSUED", "PARTIALLY_PAID"] } },
          },
          _sum: { amountMinor: true },
        }),
      ]);

    const countBy = (rows: Array<{ schoolId: string; _count: { _all?: number; userId?: number } }>): Map<string, number> =>
      new Map(rows.map((r) => [r.schoolId, r._count._all ?? r._count.userId ?? 0]));
    const sumBy = (
      rows: Array<{ schoolId: string; _sum: { amountMinor?: number | null; totalMinor?: number | null } }>,
    ): Map<string, number> =>
      new Map(rows.map((r) => [r.schoolId, r._sum.amountMinor ?? r._sum.totalMinor ?? 0]));

    const students = countBy(studentGroups as never);
    const staff = countBy(staffGroups as never);
    const attTotal = countBy(attTotalGroups as never);
    const attPresent = countBy(attPresentGroups as never);
    const paid = sumBy(paidGroups as never);
    const invoiced = sumBy(invoicedGroups as never);
    const collected = sumBy(collectedGroups as never);

    // Built from `schools`, so a campus with no data at all still appears — an
    // absent school reads as a problem, not as a school with nothing to report.
    const perSchool: GroupSchoolStatsDto[] = schools.map((school) => {
      const sub = subOf.get(school.id);
      const total = attTotal.get(school.id) ?? 0;
      return {
        schoolId: school.id,
        name: school.name,
        slug: school.slug,
        active: school.status === "ACTIVE",
        students: students.get(school.id) ?? 0,
        staff: staff.get(school.id) ?? 0,
        attendanceTodayPct: total > 0 ? Math.round(((attPresent.get(school.id) ?? 0) / total) * 100) : null,
        collectedThisMonthMinor: paid.get(school.id) ?? 0,
        outstandingFeesMinor: Math.max(0, (invoiced.get(school.id) ?? 0) - (collected.get(school.id) ?? 0)),
        plan: sub?.plan ?? "STANDARD",
        subscriptionStatus: sub?.status ?? "ACTIVE",
        currentPeriodEnd: sub?.currentPeriodEnd ?? null,
      };
    });

    // Group reads touch every campus — audited in the DIRECTOR's own tenant.
    await this.db.runAsTenant({ schoolId: p.schoolId, userId: p.userId }, (tx) =>
      this.audit.record(
        {
          actorId: p.userId,
          action: "group.overview.read",
          entity: "school_group",
          entityId: group.id,
          schoolId: p.schoolId,
          metadata: { group: group.name, schools: schoolIds.length },
        },
        tx,
      ),
    );

    return {
      groupId: group.id,
      groupName: group.name,
      schools: perSchool,
      totals: {
        students: perSchool.reduce((n, s) => n + s.students, 0),
        staff: perSchool.reduce((n, s) => n + s.staff, 0),
        collectedThisMonthMinor: perSchool.reduce((n, s) => n + s.collectedThisMonthMinor, 0),
        outstandingFeesMinor: perSchool.reduce((n, s) => n + s.outstandingFeesMinor, 0),
      },
    };
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
