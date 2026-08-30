// =============================================================================
// DashboardService — the counts behind the home page's tiles
// =============================================================================
// The dashboard used to fetch four full LISTS to render a handful of numbers:
// /workflows (up to LIST_CAP rows) to count the pending ones, /classes/mine in
// full for a `.length`, /notifications (100 rows) to show six, and /events in
// full to show five. Every tile was a list shipped across the wire and counted in
// Node.
//
// Worse than the waste: the approvals figure was WRONG. listRequests caps at
// LIST_CAP by design ("grows without bound over time — cap to the most-recent
// page"), so counting PENDING_REVIEW within that page under-reports as soon as a
// school passes the cap — and it under-reports silently, which is the failure mode
// that matters for a queue nobody is told to look at.
//
// Everything here is a COUNT in Postgres, with the same relationship scoping the
// list endpoints use, so the tiles agree with the pages they link to.
//
// Deliberately NOT module-gated: the home page must render for every role even when
// the Analytics or LMS modules are off for that school.
// =============================================================================

import { Inject, Injectable } from "@nestjs/common";
import { classIdsTaughtBy } from "../common/teaches";
import type { DashboardSummaryDto } from "@sms/types";
import {
  TENANT_DATABASE,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";

/** Roles that review approvals — mirrors WorkflowService.isReviewer. */
const REVIEWER_ROLES = new Set([
  "principal",
  "school_admin",
  "board",
  "head_teacher",
  "head_admin",
  "hr_manager",
]);
/** Roles that see every class — mirrors LmsService.isRosterWide. */
const ROSTER_WIDE_ROLES = new Set(["principal", "school_admin", "hr_manager", "hr_clerk"]);

@Injectable()
export class DashboardService {
  constructor(@Inject(TENANT_DATABASE) private readonly db: TenantDatabase) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  async summary(p: Principal): Promise<DashboardSummaryDto> {
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      const [pendingApprovals, classes, unreadNotifications] = await Promise.all([
        this.countPendingApprovals(tx, p),
        this.countClasses(tx, p),
        tx.notification.count({ where: { recipientId: p.userId, readAt: null } }) as Promise<number>,
      ]);
      return { pendingApprovals, classes, unreadNotifications };
    });
  }

  /** A real count over the whole queue, not a count within the most-recent page. */
  private async countPendingApprovals(tx: TenantTx, p: Principal): Promise<number> {
    const reviewer = p.roles.some((r) => REVIEWER_ROLES.has(r));
    return tx.workflowRequest.count({
      where: { state: "PENDING_REVIEW", ...(reviewer ? {} : { initiatorId: p.userId }) },
    }) as Promise<number>;
  }

  /**
   * Classes the caller "has", counted the same way listMyClasses lists them —
   * whole-school roles see every class; everyone else gets the union of classes they
   * teach, teach a subject in, or supervise. The union has to be resolved before it
   * can be counted (three sources, overlapping), but only IDS cross the wire, not
   * whole class rows.
   */
  private async countClasses(tx: TenantTx, p: Principal): Promise<number> {
    if (p.roles.some((r) => ROSTER_WIDE_ROLES.has(r))) {
      return tx.class.count() as Promise<number>;
    }
    const [taught, subjectTaught, supervised] = await Promise.all([
      classIdsTaughtBy(tx, p.userId).then((ids: string[]) => ids.map((classId) => ({ classId }))) as Promise<
        Array<{ classId: string }>
      >,
      tx.classSubjectTeacher.findMany({ where: { teacherId: p.userId }, select: { classId: true } }) as Promise<
        Array<{ classId: string }>
      >,
      tx.class.findMany({ where: { supervisorId: p.userId }, select: { id: true } }) as Promise<Array<{ id: string }>>,
    ]);
    const ids = new Set<string>();
    for (const t of taught) ids.add(t.classId);
    for (const t of subjectTaught) ids.add(t.classId);
    for (const c of supervised) ids.add(c.id);
    if (ids.size > 0) return ids.size;

    // A student or parent "has" the classes they are enrolled in / their children are.
    const enrolled = (await tx.enrollment.findMany({
      where: { studentId: p.userId },
      select: { classId: true },
    })) as Array<{ classId: string }>;
    if (enrolled.length > 0) return new Set(enrolled.map((e) => e.classId)).size;

    const kids = (await tx.parentChild.findMany({
      where: { parentId: p.userId },
      select: { studentId: true },
    })) as Array<{ studentId: string }>;
    if (kids.length === 0) return 0;
    const theirs = (await tx.enrollment.findMany({
      where: { studentId: { in: kids.map((k) => k.studentId) } },
      select: { classId: true },
    })) as Array<{ classId: string }>;
    return new Set(theirs.map((e) => e.classId)).size;
  }
}
