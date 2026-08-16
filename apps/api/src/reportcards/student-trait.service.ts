// =============================================================================
// StudentTraitService — behavioural / psychomotor ratings per pupil, per term
// =============================================================================
// The affective half of a Nigerian report card: twenty traits in four groups,
// each 1–5, recorded by the class teacher beside the marks.
//
// THESE ARE NOT MARKS, and the difference drives the design:
//   * they are never averaged into an academic total — "obedience 4" and
//     "mathematics 81" are different kinds of statement about a child;
//   * every rating carries WHO gave it. A judgement about a pupil is a person's,
//     never the system's (Golden Rule #8), so the row stores `ratedById` and
//     every write is audited;
//   * they are correction-friendly. A teacher who means 4 and clicks 1 on a
//     child's honesty must be able to put it right, so the row updates in place
//     rather than appending — which is why rls/107 grants UPDATE where the
//     ledgers do not.
//
// Scope mirrors the remark service exactly, because it is the same act by the
// same person about the same child: staff-wide, or a teacher/supervisor of a
// class the pupil is enrolled in, may WRITE; the pupil, their guardians and
// those staff may READ. Anyone else gets 404, never 403.
// =============================================================================

import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { isTraitKey, TRAIT_SCORE_MAX, TRAIT_SCORE_MIN, type StudentTraitsDto } from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";

const STAFF_WIDE = new Set(["school_admin", "principal"]);

type RatingRow = { traitKey: string; score: number; ratedById: string | null; ratedAt: Date };

@Injectable()
export class StudentTraitService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  private staffWide(p: Principal): boolean {
    return p.roles.some((r) => STAFF_WIDE.has(r));
  }

  /** A teacher or supervisor of a class the pupil is enrolled in. */
  private async teachesStudent(tx: TenantTx, p: Principal, studentId: string): Promise<boolean> {
    const enrolments = (await tx.enrollment.findMany({
      where: { studentId, status: "ACTIVE" },
      select: { classId: true },
    })) as Array<{ classId: string }>;
    if (enrolments.length === 0) return false;
    const classIds = enrolments.map((e) => e.classId);
    const [supervises, teaches] = await Promise.all([
      tx.class.findFirst({ where: { id: { in: classIds }, supervisorId: p.userId }, select: { id: true } }),
      tx.classSubjectTeacher.findFirst({ where: { classId: { in: classIds }, teacherId: p.userId }, select: { id: true } }),
    ]);
    return !!supervises || !!teaches;
  }

  private async assertCanRead(tx: TenantTx, p: Principal, studentId: string): Promise<void> {
    if (this.staffWide(p)) return;
    if (p.userId === studentId) return;
    if (await tx.parentChild.findFirst({ where: { parentId: p.userId, studentId }, select: { id: true } })) return;
    if (await this.teachesStudent(tx, p, studentId)) return;
    throw new NotFoundException("Not found");
  }

  async getTraits(p: Principal, studentId: string, termId: string): Promise<StudentTraitsDto> {
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      await this.assertCanRead(tx, p, studentId);
      const rows = (await tx.studentTraitRating.findMany({
        where: { studentId, termId },
        select: { traitKey: true, score: true, ratedById: true, ratedAt: true },
        orderBy: { traitKey: "asc" },
      })) as RatingRow[];
      // The most recent rater speaks for the set: they are all entered together
      // in practice, and a per-trait byline on a report card is noise.
      const latest = rows.reduce<RatingRow | null>((a, r) => (!a || r.ratedAt > a.ratedAt ? r : a), null);
      const rater = latest?.ratedById
        ? ((await tx.user.findFirst({ where: { id: latest.ratedById }, select: { name: true } })) as { name: string } | null)
        : null;
      return {
        studentId,
        termId,
        ratings: rows.map((r) => ({ traitKey: r.traitKey, score: r.score })),
        ratedByName: rater?.name ?? null,
        ratedAt: latest?.ratedAt ?? null,
      };
    });
  }

  /**
   * Record a set of ratings for one pupil and term.
   *
   * Takes the WHOLE set the teacher is submitting rather than one trait at a
   * time: twenty separate requests would be twenty audit rows for one act, and a
   * half-saved set is worse than none — a report card showing four of twenty
   * traits reads as a judgement rather than an interruption.
   *
   * An unknown trait key is REFUSED rather than stored. The catalogue can change,
   * but a rating whose key means nothing prints as a bare key on a child's
   * report card, and nobody would know where it came from.
   */
  async setTraits(
    p: Principal,
    studentId: string,
    termId: string,
    ratings: Array<{ traitKey: string; score: number }>,
  ): Promise<StudentTraitsDto> {
    if (ratings.length === 0) throw new BadRequestException("No ratings supplied");
    for (const r of ratings) {
      if (!isTraitKey(r.traitKey)) throw new BadRequestException(`Unknown trait: ${r.traitKey}`);
      if (!Number.isInteger(r.score) || r.score < TRAIT_SCORE_MIN || r.score > TRAIT_SCORE_MAX) {
        throw new BadRequestException(`${r.traitKey} must be a whole number from ${TRAIT_SCORE_MIN} to ${TRAIT_SCORE_MAX}`);
      }
    }
    const seen = new Set(ratings.map((r) => r.traitKey));
    if (seen.size !== ratings.length) throw new BadRequestException("The same trait appears more than once");

    await this.db.runAsTenant(this.ctx(p), async (tx) => {
      if (!this.staffWide(p) && !(await this.teachesStudent(tx, p, studentId))) {
        throw new ForbiddenException("Only the pupil's class teacher or a school administrator may record these");
      }
      const term = await tx.term.findFirst({ where: { id: termId }, select: { id: true } });
      if (!term) throw new NotFoundException("Term not found");
      const now = new Date();
      for (const r of ratings) {
        await tx.studentTraitRating.upsert({
          where: { studentId_termId_traitKey: { studentId, termId, traitKey: r.traitKey } },
          create: {
            schoolId: p.schoolId,
            studentId,
            termId,
            traitKey: r.traitKey,
            score: r.score,
            ratedById: p.userId,
            ratedAt: now,
          },
          update: { score: r.score, ratedById: p.userId, ratedAt: now },
        });
      }
      // ONE audit row for one act, naming the traits touched but not the scores:
      // the scores are on the record, and an audit line is not the place to
      // restate a judgement about a child.
      await this.audit.record(
        {
          actorId: p.userId,
          action: "reportcard.traits.set",
          entity: "user",
          entityId: studentId,
          schoolId: p.schoolId,
          metadata: { termId, traits: ratings.map((r) => r.traitKey) },
        },
        tx,
      );
    });
    return this.getTraits(p, studentId, termId);
  }

  /**
   * Ratings for a whole class in one read — what the entry grid needs.
   *
   * A teacher rates a class of thirty in one sitting, and thirty separate reads
   * to paint the grid is how a page becomes slow at exactly the moment it is
   * being used. Scoped by the caller's own teaching relationship.
   */
  async classTraits(
    p: Principal,
    classId: string,
    termId: string,
  ): Promise<Array<{ studentId: string; studentName: string; ratings: Array<{ traitKey: string; score: number }> }>> {
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      if (!this.staffWide(p)) {
        const [supervises, teaches] = await Promise.all([
          tx.class.findFirst({ where: { id: classId, supervisorId: p.userId }, select: { id: true } }),
          tx.classSubjectTeacher.findFirst({ where: { classId, teacherId: p.userId }, select: { id: true } }),
        ]);
        if (!supervises && !teaches) throw new NotFoundException("Class not found");
      }
      const enrolments = (await tx.enrollment.findMany({
        where: { classId, status: "ACTIVE" },
        select: { studentId: true },
      })) as Array<{ studentId: string }>;
      const ids = enrolments.map((e) => e.studentId);
      if (ids.length === 0) return [];
      const [users, rows] = await Promise.all([
        tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
        tx.studentTraitRating.findMany({
          where: { studentId: { in: ids }, termId },
          select: { studentId: true, traitKey: true, score: true },
        }),
      ]);
      const byStudent = new Map<string, Array<{ traitKey: string; score: number }>>();
      for (const r of rows as Array<{ studentId: string; traitKey: string; score: number }>) {
        byStudent.set(r.studentId, [...(byStudent.get(r.studentId) ?? []), { traitKey: r.traitKey, score: r.score }]);
      }
      return (users as Array<{ id: string; name: string }>).map((u) => ({
        studentId: u.id,
        studentName: u.name,
        ratings: byStudent.get(u.id) ?? [],
      }));
    });
  }
}
