// =============================================================================
// SubjectSyllabus — the scheme of work a subject teacher plans and works to
// =============================================================================
// LmsContent holds individual items — a material, a quiz, a forum thread — but
// nothing said what a TERM is meant to cover. So "are we on schedule in JSS2
// Physics?" could not be answered without reading every item and remembering the
// plan, which means in practice it was never answered at all.
//
// This is that plan: one per (class, subject, term), owned by whoever teaches it,
// with the weeks underneath. Marking a week TAUGHT is what makes it a living
// document rather than a file — and it is the only thing that makes progress
// answerable, for the teacher and for whoever asks them.
//
// SCOPING follows the pattern LmsService established: a coarse permission gates
// the endpoint, a membership join narrows the rows, and RLS backstops. Writing a
// plan is for the person who TEACHES that subject to that class — read is wider,
// because a head of department who cannot see the plan cannot review it.
// =============================================================================

import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";

/** Who may see and review any plan in the school, without teaching it. */
const SYLLABUS_WIDE_ROLES = new Set(["school_admin", "principal", "head_teacher", "board", "junior_admin"]);

const ITEM_STATUSES = ["PLANNED", "TAUGHT"] as const;

interface SyllabusItemInput {
  week: number;
  topic: string;
  objectives?: string | null;
  resources?: string | null;
}

@Injectable()
export class SyllabusService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }
  private isWide(p: Principal): boolean {
    return p.roles.some((r) => SYLLABUS_WIDE_ROLES.has(r));
  }

  /**
   * May this caller WRITE the plan for (class, subject)?
   *
   * The teacher of that offering, or school-wide leadership. Checked against
   * `class_subject_teacher`, which is the same row that decides who may enter
   * marks for it — so the person who teaches the subject is the person who plans
   * it, and the two can never drift apart.
   */
  private async assertCanWrite(tx: TenantTx, p: Principal, classId: string, subjectId: string) {
    if (this.isWide(p)) return;
    const offering = await tx.classSubjectTeacher.findFirst({
      where: { classId, subjectId, teacherId: p.userId },
      select: { id: true },
    });
    // 404, not 403: a teacher probing another class's plan learns nothing about
    // whether it exists.
    if (!offering) throw new NotFoundException("Not found");
  }

  /** Read scope: leadership sees all; a teacher sees the subjects they teach. */
  private async visibleClassSubjects(tx: TenantTx, p: Principal): Promise<Set<string> | null> {
    if (this.isWide(p)) return null; // null = unrestricted
    const rows = (await tx.classSubjectTeacher.findMany({
      where: { teacherId: p.userId },
      select: { classId: true, subjectId: true },
    })) as Array<{ classId: string; subjectId: string }>;
    return new Set(rows.map((r) => `${r.classId}:${r.subjectId}`));
  }

  /**
   * The plan for one offering in one term, with its weeks and a progress count.
   *
   * Returns null rather than 404 when none exists yet: "this subject has no plan
   * for this term" is the normal state at the start of a term and the thing the
   * screen most needs to say, not an error.
   */
  async get(p: Principal, args: { classId: string; subjectId: string; termId: string }) {
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      const visible = await this.visibleClassSubjects(tx, p);
      if (visible && !visible.has(`${args.classId}:${args.subjectId}`)) throw new NotFoundException("Not found");
      const row = (await tx.subjectSyllabus.findFirst({
        where: { classId: args.classId, subjectId: args.subjectId, termId: args.termId },
      })) as { id: string; overview: string | null; ownerId: string; updatedAt: Date } | null;
      if (!row) return null;
      const items = (await tx.subjectSyllabusItem.findMany({
        where: { syllabusId: row.id },
        orderBy: [{ week: "asc" }, { createdAt: "asc" }],
      })) as Array<{ id: string; week: number; topic: string; objectives: string | null; resources: string | null; status: string; taughtAt: Date | null }>;
      const taught = items.filter((i) => i.status === "TAUGHT").length;
      return {
        id: row.id,
        overview: row.overview,
        ownerId: row.ownerId,
        updatedAt: row.updatedAt,
        items,
        // Computed, never stored: a stored count is one more thing that can
        // disagree with the rows it counts.
        progress: { taught, total: items.length, percent: items.length ? Math.round((taught / items.length) * 100) : null },
      };
    });
  }

  /** Every plan the caller may see for a term — the review view. */
  async listForTerm(p: Principal, termId: string) {
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      const visible = await this.visibleClassSubjects(tx, p);
      // WHICH OFFERINGS THIS TEACHER TEACHES IS PART OF THE QUERY. This read the
      // 500 most recently updated syllabuses in the whole school and then kept
      // the caller's own — so a teacher whose plan had not been touched lately
      // saw NOTHING, and the more active the school the emptier their screen.
      // The cap has to bound the caller's own rows, not the school's.
      const mine = (await tx.subjectSyllabus.findMany({
        where: {
          termId,
          ...(visible
            ? {
                OR: [...visible].map((k) => {
                  const [classId, subjectId] = k.split(":");
                  return { classId, subjectId };
                }),
              }
            : {}),
        },
        orderBy: { updatedAt: "desc" },
        take: 500,
      })) as Array<{ id: string; classId: string; subjectId: string; ownerId: string; updatedAt: Date }>;
      if (mine.length === 0) return [];
      const counts = (await tx.subjectSyllabusItem.groupBy({
        by: ["syllabusId", "status"],
        where: { syllabusId: { in: mine.map((m) => m.id) } },
        _count: { _all: true },
      } as never)) as unknown as Array<{ syllabusId: string; status: string; _count: { _all: number } }>;
      const tally = new Map<string, { taught: number; total: number }>();
      for (const c of counts) {
        const t = tally.get(c.syllabusId) ?? { taught: 0, total: 0 };
        t.total += c._count._all;
        if (c.status === "TAUGHT") t.taught += c._count._all;
        tally.set(c.syllabusId, t);
      }
      return mine.map((r) => {
        const t = tally.get(r.id) ?? { taught: 0, total: 0 };
        return {
          id: r.id,
          classId: r.classId,
          subjectId: r.subjectId,
          ownerId: r.ownerId,
          updatedAt: r.updatedAt,
          progress: { ...t, percent: t.total ? Math.round((t.taught / t.total) * 100) : null },
        };
      });
    });
  }

  /**
   * Create or replace the plan for one offering in one term.
   *
   * The weeks are replaced wholesale rather than diffed. A scheme of work is
   * edited as a document — rows reordered, merged, renumbered — and diffing that
   * by index reliably attaches the wrong topic to the wrong week. Replacing is
   * the honest operation, and the TAUGHT flags are carried across by (week,
   * topic) so a teacher who fixes a typo in week 9 does not lose the record of
   * having taught weeks 1-8.
   */
  async upsert(
    p: Principal,
    args: { classId: string; subjectId: string; termId: string },
    input: { overview?: string | null; items: SyllabusItemInput[] },
  ) {
    if (input.items.length > 60) {
      throw new BadRequestException("A term plan cannot have more than 60 entries.");
    }
    for (const it of input.items) {
      if (!Number.isInteger(it.week) || it.week < 1 || it.week > 60) {
        throw new BadRequestException(`Week must be a whole number between 1 and 60 (got ${it.week}).`);
      }
      if (!it.topic?.trim()) throw new BadRequestException("Every entry needs a topic.");
    }
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.assertCanWrite(tx, p, args.classId, args.subjectId);
      const existing = (await tx.subjectSyllabus.findFirst({
        where: { classId: args.classId, subjectId: args.subjectId, termId: args.termId },
        select: { id: true },
      })) as { id: string } | null;

      let syllabusId: string;
      const taughtBefore = new Map<string, Date | null>();
      if (existing) {
        syllabusId = existing.id;
        const prior = (await tx.subjectSyllabusItem.findMany({
          where: { syllabusId, status: "TAUGHT" },
          select: { week: true, topic: true, taughtAt: true },
        })) as Array<{ week: number; topic: string; taughtAt: Date | null }>;
        for (const t of prior) taughtBefore.set(`${t.week}:${t.topic.trim().toLowerCase()}`, t.taughtAt);
        await tx.subjectSyllabus.update({
          where: { id: syllabusId },
          data: { overview: input.overview ?? null },
        });
        await tx.subjectSyllabusItem.deleteMany({ where: { syllabusId } });
      } else {
        const created = await tx.subjectSyllabus.create({
          data: {
            schoolId: p.schoolId,
            classId: args.classId,
            subjectId: args.subjectId,
            termId: args.termId,
            overview: input.overview ?? null,
            ownerId: p.userId,
          },
        });
        syllabusId = created.id;
      }

      if (input.items.length > 0) {
        await tx.subjectSyllabusItem.createMany({
          data: input.items.map((it) => {
            const carried = taughtBefore.get(`${it.week}:${it.topic.trim().toLowerCase()}`);
            return {
              schoolId: p.schoolId,
              syllabusId,
              week: it.week,
              topic: it.topic.trim(),
              objectives: it.objectives?.trim() || null,
              resources: it.resources?.trim() || null,
              status: carried !== undefined ? "TAUGHT" : "PLANNED",
              taughtAt: carried ?? null,
            };
          }),
        });
      }
      await this.log(tx, p, "lms.syllabus.upsert", syllabusId, {
        classId: args.classId,
        subjectId: args.subjectId,
        termId: args.termId,
        items: input.items.length,
        carriedTaught: taughtBefore.size,
      });
      return { id: syllabusId, items: input.items.length };
    });
  }

  /** Mark one week taught, or put it back to planned. */
  async setItemStatus(p: Principal, itemId: string, status: string) {
    if (!(ITEM_STATUSES as readonly string[]).includes(status)) {
      throw new BadRequestException(`Status must be one of ${ITEM_STATUSES.join(", ")}`);
    }
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const item = (await tx.subjectSyllabusItem.findFirst({
        where: { id: itemId },
        select: { id: true, syllabusId: true },
      })) as { id: string; syllabusId: string } | null;
      if (!item) throw new NotFoundException("Not found");
      const syl = (await tx.subjectSyllabus.findFirst({
        where: { id: item.syllabusId },
        select: { classId: true, subjectId: true },
      })) as { classId: string; subjectId: string } | null;
      if (!syl) throw new NotFoundException("Not found");
      await this.assertCanWrite(tx, p, syl.classId, syl.subjectId);
      await tx.subjectSyllabusItem.update({
        where: { id: itemId },
        data: { status, taughtAt: status === "TAUGHT" ? new Date() : null },
      });
      await this.log(tx, p, "lms.syllabus.item_status", itemId, { status });
      return { id: itemId, status };
    });
  }

  /** Remove a plan. Its weeks cascade — an item has no meaning without one. */
  async remove(p: Principal, syllabusId: string) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const syl = (await tx.subjectSyllabus.findFirst({
        where: { id: syllabusId },
        select: { classId: true, subjectId: true },
      })) as { classId: string; subjectId: string } | null;
      if (!syl) throw new NotFoundException("Not found");
      await this.assertCanWrite(tx, p, syl.classId, syl.subjectId);
      await tx.subjectSyllabus.delete({ where: { id: syllabusId } });
      await this.log(tx, p, "lms.syllabus.delete", syllabusId, {});
      return { id: syllabusId };
    });
  }

  private async log(tx: TenantTx, p: Principal, action: string, entityId: string, metadata: Record<string, unknown>) {
    await this.audit.record(
      { actorId: p.userId, action, entity: "subject_syllabus", entityId, schoolId: p.schoolId, metadata },
      tx,
    );
  }
}
