// =============================================================================
// ParentService — the consolidated "my children" overview
// =============================================================================
// One read that gathers, for each LINKED child (ParentChild is the ONLY scope —
// Golden Rule: every parent-facing query joins through it): current class,
// attendance counts, PUBLISHED term-grade averages for the current session,
// discipline complaints about the child, their task assignments, and the
// outstanding fee balance. Guardian-appropriate only: no draft grades, no
// integrity telemetry, no other family's rows. The read touches minors' PII,
// so it is audit-logged (Golden Rule #5). Inside a tenant tx (RLS backstop).
// =============================================================================

import { Inject, Injectable } from "@nestjs/common";
import { averageOf } from "@sms/types";
import type {
  ChildOverviewDto,
  ChildGradesSummaryDto,
  FamilyOverviewDto,
} from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
} from "../integrity/integrity.foundation";

const OPEN_INVOICE_STATUSES = ["ISSUED", "PARTIALLY_PAID"] as const;

@Injectable()
export class ParentService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  async getFamilyOverview(p: Principal): Promise<FamilyOverviewDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      // SECURITY: the ParentChild join IS the authorization — nothing else.
      const links = await tx.parentChild.findMany({
        where: { parentId: p.userId },
        select: { studentId: true },
      });
      const childIds = links.map((l) => l.studentId);
      if (childIds.length === 0) return { children: [] };

      const session = await tx.academicSession.findFirst({
        where: { isCurrent: true },
        select: { id: true, name: true },
      });
      const terms = session
        ? await tx.term.findMany({
            where: { sessionId: session.id },
            orderBy: { sequence: "asc" },
            select: { id: true, name: true },
          })
        : [];

      const [children, enrollments, attendance, results, complaints, assignments, invoices] =
        await Promise.all([
          tx.user.findMany({ where: { id: { in: childIds } }, select: { id: true, name: true } }),
          tx.enrollment.findMany({
            where: { studentId: { in: childIds }, status: "ACTIVE" },
            select: { studentId: true, classId: true },
          }),
          tx.attendanceRecord.groupBy({
            by: ["studentId", "status"],
            where: { studentId: { in: childIds } },
            _count: { _all: true },
          }),
          session
            ? tx.subjectResult.findMany({
                where: { studentId: { in: childIds }, sessionId: session.id, status: "PUBLISHED" },
                select: { studentId: true, termId: true, total: true },
              })
            : Promise.resolve([]),
          tx.disciplineComplaint.findMany({
            where: { againstId: { in: childIds }, againstType: "STUDENT" },
            orderBy: { createdAt: "desc" },
            select: { id: true, subject: true, status: true, createdAt: true, againstId: true },
          }),
          tx.taskAssignment.findMany({
            where: { assigneeId: { in: childIds } },
            orderBy: { updatedAt: "desc" },
            take: 100,
            select: {
              id: true,
              assigneeId: true,
              status: true,
              task: { select: { title: true, dueAt: true } },
            },
          }),
          tx.invoice.findMany({
            where: { studentId: { in: childIds }, status: { in: [...OPEN_INVOICE_STATUSES] } },
            select: {
              studentId: true,
              totalMinor: true,
              payments: { where: { status: "POSTED" }, select: { amountMinor: true, kind: true } },
            },
          }),
        ]);

      const classIds = [...new Set(enrollments.map((e) => e.classId))];
      const classes = await tx.class.findMany({
        where: { id: { in: classIds } },
        select: { id: true, name: true },
      });
      const classNameById = new Map(classes.map((c) => [c.id, c.name]));
      const classByStudent = new Map(enrollments.map((e) => [e.studentId, e.classId]));

      const out: ChildOverviewDto[] = children
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((child) => {
          // Attendance counts (all-time register history for this child).
          const count = (status: string) =>
            attendance.find((a) => a.studentId === child.id && a.status === status)?._count._all ?? 0;
          const present = count("PRESENT");
          const absent = count("ABSENT");
          const late = count("LATE");
          const excused = count("EXCUSED");
          const total = present + absent + late + excused;

          // Published grade averages for the current session, term by term.
          let grades: ChildGradesSummaryDto | null = null;
          if (session) {
            const mine = results.filter((r) => r.studentId === child.id);
            const termAverages = terms.map((t) => ({
              termId: t.id,
              termName: t.name,
              average: averageOf(
                mine.filter((r) => r.termId === t.id).map((r) => r.total).filter((v): v is number => v !== null),
              ),
            }));
            const termVals = termAverages.map((t) => t.average).filter((v): v is number => v !== null);
            grades = {
              sessionId: session.id,
              sessionName: session.name,
              termAverages,
              sessionAverage: averageOf(termVals),
            };
          }

          // Outstanding fees: sum of open invoices minus their posted payments
          // (REFUND rows subtract from paid, mirroring FeesService).
          const myInvoices = invoices.filter((i) => i.studentId === child.id);
          const outstandingMinor = myInvoices.reduce((sum, inv) => {
            const paid = inv.payments.reduce(
              (s, pay) => s + (pay.kind === "REFUND" ? -pay.amountMinor : pay.amountMinor),
              0,
            );
            return sum + Math.max(0, inv.totalMinor - paid);
          }, 0);

          return {
            studentId: child.id,
            studentName: child.name,
            className: classNameById.get(classByStudent.get(child.id) ?? "") ?? null,
            attendance: {
              present, absent, late, excused, total,
              pct: total > 0 ? Math.round(((present + late) / total) * 1000) / 10 : null,
            },
            grades,
            discipline: complaints
              .filter((c) => c.againstId === child.id)
              .slice(0, 5)
              .map((c) => ({ id: c.id, subject: c.subject, status: c.status, createdAt: c.createdAt })),
            tasks: assignments
              .filter((a) => a.assigneeId === child.id)
              .slice(0, 5)
              .map((a) => ({
                id: a.id,
                title: a.task.title,
                assignmentStatus: a.status,
                dueAt: a.task.dueAt,
              })),
            fees: { outstandingMinor, unpaidInvoices: myInvoices.length },
          };
        });

      // Guardian read of minors' records — audited (Golden Rule #5).
      await this.audit.record(
        {
          actorId: p.userId,
          action: "family.overview.read",
          entity: "parent_child",
          entityId: p.userId,
          schoolId: p.schoolId,
          metadata: { children: childIds.length },
        },
        tx,
      );
      return { children: out };
    });
  }
}
