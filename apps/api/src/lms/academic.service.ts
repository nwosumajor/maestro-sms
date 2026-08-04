// =============================================================================
// AcademicService — academic sessions + terms (the school calendar)
// =============================================================================
// Makes the school year first-class so "third term" is a real entity. CRUD over
// sessions and their ordered terms, plus "set current" (exactly one current
// session and one current term per school — flipped atomically). Tenant-scoped
// (RLS), audited. Reads are broad (class.read); writes are academic.manage.
// =============================================================================

import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { AcademicSessionDto, CalendarSession, CalendarTerm, SchoolHolidayDto, TermDto } from "@sms/types";
import { assessCalendar, currentTermBlocker, dayUtc, pickNextTerm, standardTermDates, termHasElapsed, validateSessionDates, validateTermDates, type CalendarFinding } from "@sms/types";

interface HolidayRow {
  id: string;
  name: string;
  startDate: Date;
  endDate: Date;
  createdAt: Date;
}

/** Row shapes fed to the pure calendar validators. */
type CalendarSessionRow = CalendarSession & { id: string };
type CalendarTermRow = CalendarTerm;
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";

interface SessionRow {
  id: string;
  name: string;
  isCurrent: boolean;
  createdAt: Date;
  startDate: Date | null;
  endDate: Date | null;
}

export interface AdvanceTermResult {
  advanced: boolean;
  reason?: string;
  termId?: string;
  termName?: string;
  sessionId?: string;
  sessionName?: string;
  /** True when the advance crossed into a new session (its first term). */
  newSession?: boolean;
}

/**
 * Move the "current term" pointer forward, on any tenant-scoped tx (the RLS GUC
 * must already be set). Shared by the manual advance action and the automatic
 * end-of-term sweep so both choose the same next term and clear-then-set
 * identically — compatible with the `term_one_current_per_school` /
 * `academic_session_one_current_per_school` partial unique indexes, which reject
 * a second current row at statement boundaries.
 *
 * `onlyIfElapsed` (the sweep) advances only once the current term's endDate has
 * passed `asOf`; the manual action leaves it false to advance on demand. No
 * writes happen when it cannot advance, so a caller may throw on `advanced:false`.
 */
export async function advanceTermInTx(
  tx: TenantTx,
  opts: { schoolId: string; actorId: string; audit: AuditLogService; asOf?: Date; onlyIfElapsed?: boolean },
): Promise<AdvanceTermResult> {
  const asOf = opts.asOf ?? new Date();
  // Every query is filtered by schoolId so this is safe under BOTH the tenant
  // (RLS already scopes) and the privileged sweep (RLS bypassed) clients — the
  // same explicit-schoolId discipline the dunning/retention sweeps use.
  const school = { schoolId: opts.schoolId };
  const terms = (await tx.term.findMany({ where: school, orderBy: { sequence: "asc" } })) as TermRow[];
  const sessions = (await tx.academicSession.findMany({ where: school })) as SessionRow[];
  const current = terms.find((t) => t.isCurrent);
  if (!current) return { advanced: false, reason: "No current term is set. Mark a term current first." };
  if (opts.onlyIfElapsed && !termHasElapsed(current.endDate, asOf)) {
    return { advanced: false, reason: "The current term has not ended yet." };
  }
  const target = pickNextTerm(
    terms.map((t) => ({ id: t.id, sessionId: t.sessionId, sequence: t.sequence, isCurrent: t.isCurrent, endDate: t.endDate })),
    sessions.map((s) => ({ id: s.id, createdAt: s.createdAt, startDate: s.startDate })),
    current.id,
  );
  if (!target) {
    return {
      advanced: false,
      reason:
        "This is the final term of the last session. Create the next session and its terms first, then advance.",
    };
  }
  const nextTerm = terms.find((t) => t.id === target.termId);
  // The automatic path REPORTS rather than throws. A sweep that refuses would
  // leave the school stuck on a term that has already ended, which is worse than
  // the state it is trying to avoid — and nobody is watching a cron job's error.
  const nextBlocker = nextTerm ? currentTermBlocker(nextTerm) : null;
  if (nextBlocker) {
    return { advanced: false, reason: nextBlocker };
  }
  const nextSession = sessions.find((s) => s.id === target.sessionId);
  // Clear-then-set (both statements atomic within the tx; the partial unique
  // index tolerates the momentary gap but never two current rows at commit).
  await tx.term.updateMany({ where: { isCurrent: true, ...school }, data: { isCurrent: false } });
  await tx.term.update({ where: { id: target.termId }, data: { isCurrent: true } });
  if (target.newSession) {
    await tx.academicSession.updateMany({ where: { isCurrent: true, ...school }, data: { isCurrent: false } });
    await tx.academicSession.update({ where: { id: target.sessionId }, data: { isCurrent: true } });
  }
  await opts.audit.record(
    {
      actorId: opts.actorId,
      action: "academic.term.advance",
      entity: "term",
      entityId: target.termId,
      schoolId: opts.schoolId,
      metadata: { from: current.id, to: target.termId, newSession: target.newSession, auto: !!opts.onlyIfElapsed },
    },
    tx,
  );
  return {
    advanced: true,
    termId: target.termId,
    termName: nextTerm?.name,
    sessionId: target.sessionId,
    sessionName: nextSession?.name,
    newSession: target.newSession,
  };
}
interface TermRow {
  id: string;
  sessionId: string;
  name: string;
  sequence: number;
  isCurrent: boolean;
  startDate: Date | null;
  endDate: Date | null;
}

@Injectable()
export class AcademicService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  /**
   * What is wrong with this school's calendar, and what it has switched off.
   *
   * Reads the SAME shape listSessions returns, so the panel can never disagree
   * with the screen it sits on. Pure assessment: it refuses nothing, because a
   * school mid-setup is legitimately incomplete — it only removes the silence.
   */
  async calendarHealth(p: Principal): Promise<CalendarFinding[]> {
    const sessions = await this.listSessions(p);
    return assessCalendar(
      sessions.map((s) => ({
        id: s.id,
        name: s.name,
        isCurrent: s.isCurrent,
        startDate: s.startDate as string | Date | null,
        endDate: s.endDate as string | Date | null,
        terms: s.terms.map((t) => ({
          id: t.id,
          name: t.name,
          sequence: t.sequence,
          isCurrent: t.isCurrent,
          startDate: t.startDate as string | Date | null,
          endDate: t.endDate as string | Date | null,
        })),
      })),
    );
  }

  async listSessions(p: Principal): Promise<AcademicSessionDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const sessions = (await tx.academicSession.findMany({ orderBy: { createdAt: "desc" } })) as SessionRow[];
      const terms = (await tx.term.findMany({ orderBy: { sequence: "asc" } })) as TermRow[];
      return sessions.map((s) => ({
        id: s.id,
        name: s.name,
        isCurrent: s.isCurrent,
        startDate: s.startDate,
        endDate: s.endDate,
        terms: terms.filter((t) => t.sessionId === s.id).map(this.termDto),
      }));
    });
  }

  /**
   * Refuse a name already in use among its siblings.
   *
   * Nothing stopped this, which is how a school ended up with TWO terms called
   * "First Term" in one session. Duplicates here are not cosmetic: every term
   * picker, report-card header and calendar finding names a term by its name, so
   * two identical ones make it impossible to tell which register or which set of
   * marks you are looking at — and only one of them is ever the right answer.
   *
   * Case-insensitive, because "first term" and "First Term" are the same term to
   * everyone except a byte comparison.
   */
  private assertNameFree(
    existing: Array<{ id: string; name: string }>,
    name: string,
    kind: "term" | "session",
    ignoreId?: string,
  ) {
    const wanted = name.trim().toLowerCase();
    const clash = existing.find((x) => x.id !== ignoreId && x.name.trim().toLowerCase() === wanted);
    if (clash) {
      throw new ConflictException(
        `A ${kind} called "${clash.name}" already exists${kind === "term" ? " in this session" : ""}. ` +
          `Two with the same name cannot be told apart on a report card or in a term picker — rename one, or edit the existing ${kind}.`,
      );
    }
  }

  async createSession(p: Principal, input: { name: string; startDate?: string | null; endDate?: string | null }) {
    const bad = validateSessionDates(input);
    if (bad) throw new BadRequestException(bad);
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const existing = (await tx.academicSession.findMany({ select: { id: true, name: true } })) as Array<{ id: string; name: string }>;
      this.assertNameFree(existing, input.name, "session");
      const s = await tx.academicSession.create({
        data: {
          schoolId: p.schoolId,
          name: input.name,
          startDate: input.startDate ? new Date(input.startDate) : null,
          endDate: input.endDate ? new Date(input.endDate) : null,
        },
      });
      await this.log(tx, p, "academic.session.create", "academic_session", s.id, { name: input.name });
      return { id: s.id, name: s.name, isCurrent: s.isCurrent, startDate: s.startDate, endDate: s.endDate, terms: [] };
    });
  }

  async addTerm(
    p: Principal,
    sessionId: string,
    input: { name: string; sequence: number; startDate?: string | null; endDate?: string | null },
  ) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const session = (await tx.academicSession.findFirst({
        where: { id: sessionId },
        select: { id: true, startDate: true, endDate: true },
      })) as CalendarSessionRow | null;
      if (!session) throw new NotFoundException("Session not found");
      const siblings = (await tx.term.findMany({
        where: { sessionId },
        select: { id: true, sessionId: true, name: true, sequence: true, startDate: true, endDate: true },
      })) as CalendarTermRow[];
      const bad = validateTermDates(input, session, siblings);
      if (bad) throw new BadRequestException(bad);
      // NOTE: duplicate SEQUENCE is already refused by validateTermDates above —
      // checking it again here would be unreachable. Only the NAME was unguarded.
      this.assertNameFree(siblings, input.name, "term");
      const t = await tx.term.create({
        data: {
          schoolId: p.schoolId,
          sessionId,
          name: input.name,
          sequence: input.sequence,
          startDate: input.startDate ? new Date(input.startDate) : null,
          endDate: input.endDate ? new Date(input.endDate) : null,
        },
      });
      await this.log(tx, p, "academic.term.create", "term", t.id, { sessionId, sequence: input.sequence });
      return this.termDto(t as TermRow);
    });
  }

  /**
   * Remove a session created by mistake.
   *
   * Sessions could be created two ways and removed by neither, so a duplicate
   * year — the easiest mistake to make, since quick-create and manual create both
   * exist — was permanent. It then sat in every session picker and every
   * cumulative report next to the real one.
   *
   * Refused when it is the CURRENT session, and when any of its terms carries
   * marks. A session's terms are deleted with it, which is safe ONLY because
   * that second check has already proved they are empty — a cascade past marks
   * would destroy a year of grades to tidy up a typo.
   */
  async deleteSession(p: Principal, sessionId: string) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const session = (await tx.academicSession.findFirst({
        where: { id: sessionId },
        select: { id: true, name: true, isCurrent: true },
      })) as { id: string; name: string; isCurrent: boolean } | null;
      if (!session) throw new NotFoundException("Session not found");
      if (session.isCurrent) {
        throw new BadRequestException(
          `"${session.name}" is the current session. Make another session current first — everything that asks "which year is this?" reads that pointer.`,
        );
      }

      const terms = (await tx.term.findMany({ where: { sessionId }, select: { id: true } })) as Array<{ id: string }>;
      const termIds = terms.map((t) => t.id);
      if (termIds.length > 0) {
        const [assessments, results, remarks] = await Promise.all([
          tx.assessment.count({ where: { termId: { in: termIds } } }),
          tx.subjectResult.count({ where: { termId: { in: termIds } } }),
          tx.reportCardRemark.count({ where: { termId: { in: termIds } } }),
        ]);
        const blockers: string[] = [];
        if (assessments > 0) blockers.push(`${assessments} assessment${assessments === 1 ? "" : "s"}`);
        if (results > 0) blockers.push(`${results} recorded result${results === 1 ? "" : "s"}`);
        if (remarks > 0) blockers.push(`${remarks} report-card remark${remarks === 1 ? "" : "s"}`);
        if (blockers.length > 0) {
          throw new ConflictException(
            `"${session.name}" still has ${blockers.join(", ")} across its terms. A whole year of records cannot be removed to correct a name — rename it instead.`,
          );
        }
      }

      // Terms first: they reference the session, and nothing here has marks.
      if (termIds.length > 0) await tx.term.deleteMany({ where: { sessionId } });
      await tx.academicSession.delete({ where: { id: sessionId } });
      await this.log(tx, p, "academic.session.delete", "academic_session", sessionId, {
        name: session.name,
        termsRemoved: termIds.length,
      });
      return { id: sessionId, termsRemoved: termIds.length };
    });
  }

  /**
   * Remove a term created by mistake.
   *
   * There was no way to do this: terms could be added and never removed, so a
   * mis-click left a permanent phantom in every term picker and in the calendar
   * check. Deleting one that carries marks would be far worse than the phantom,
   * though — the grades would survive with no term to belong to — so this
   * refuses when anything references it, and says WHAT references it, in the
   * same shape as the class/subject/hostel delete guards.
   *
   * The CURRENT term is never deletable. Removing the pointer everything reads
   * would switch off the register lock as a side effect of tidying up.
   */
  async deleteTerm(p: Principal, termId: string) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const term = (await tx.term.findFirst({
        where: { id: termId },
        select: { id: true, name: true, isCurrent: true },
      })) as { id: string; name: string; isCurrent: boolean } | null;
      if (!term) throw new NotFoundException("Term not found");
      if (term.isCurrent) {
        throw new BadRequestException(
          `"${term.name}" is the current term. Make another term current first — deleting the one everything reads would switch off the past-term register lock.`,
        );
      }

      const [assessments, results, remarks] = await Promise.all([
        tx.assessment.count({ where: { termId } }),
        tx.subjectResult.count({ where: { termId } }),
        tx.reportCardRemark.count({ where: { termId } }),
      ]);
      const blockers: string[] = [];
      if (assessments > 0) blockers.push(`${assessments} assessment${assessments === 1 ? "" : "s"}`);
      if (results > 0) blockers.push(`${results} recorded result${results === 1 ? "" : "s"}`);
      if (remarks > 0) blockers.push(`${remarks} report-card remark${remarks === 1 ? "" : "s"}`);
      if (blockers.length > 0) {
        throw new ConflictException(
          `"${term.name}" still has ${blockers.join(", ")}. A term is the scope those records belong to, so it cannot be removed while any exist.`,
        );
      }

      await tx.term.delete({ where: { id: termId } });
      await this.log(tx, p, "academic.term.delete", "term", termId, { name: term.name });
      return { id: termId };
    });
  }

  /**
   * Edit a session's name and window.
   *
   * There was no way to do this at all: sessions could be created and made
   * current, never corrected. A school that mistyped a year's dates — or, far
   * more commonly, created a session before knowing them — had no route back.
   *
   * The window must still CONTAIN every term in it. Narrowing a session under
   * its own terms would leave terms outside their session, which every date rule
   * here validates against and none would notice afterwards.
   */
  async updateSession(
    p: Principal,
    sessionId: string,
    input: { name?: string; startDate?: string | null; endDate?: string | null },
  ) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const session = (await tx.academicSession.findFirst({
        where: { id: sessionId },
        select: { id: true, name: true, startDate: true, endDate: true },
      })) as { id: string; name: string; startDate: Date | null; endDate: Date | null } | null;
      if (!session) throw new NotFoundException("Session not found");

      if (input.name !== undefined) {
        const siblings = (await tx.academicSession.findMany({ select: { id: true, name: true } })) as Array<{ id: string; name: string }>;
        this.assertNameFree(siblings, input.name, "session", sessionId);
      }

      const merged = {
        startDate: input.startDate === undefined ? session.startDate : input.startDate,
        endDate: input.endDate === undefined ? session.endDate : input.endDate,
      };
      const bad = validateSessionDates(merged);
      if (bad) throw new BadRequestException(bad);

      const terms = (await tx.term.findMany({
        where: { sessionId },
        select: { name: true, startDate: true, endDate: true },
      })) as Array<{ name: string; startDate: Date | null; endDate: Date | null }>;
      const sStart = merged.startDate ? dayUtc(merged.startDate) : null;
      const sEnd = merged.endDate ? dayUtc(merged.endDate) : null;
      for (const t of terms) {
        const ts = t.startDate ? dayUtc(t.startDate) : null;
        const te = t.endDate ? dayUtc(t.endDate) : null;
        if (sStart !== null && ts !== null && ts < sStart) {
          throw new BadRequestException(
            `"${t.name}" starts before this window. Move the term first, or widen the session.`,
          );
        }
        if (sEnd !== null && te !== null && te > sEnd) {
          throw new BadRequestException(
            `"${t.name}" ends after this window. Move the term first, or widen the session.`,
          );
        }
      }

      await tx.academicSession.update({
        where: { id: sessionId },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.startDate !== undefined ? { startDate: input.startDate ? new Date(input.startDate) : null } : {}),
          ...(input.endDate !== undefined ? { endDate: input.endDate ? new Date(input.endDate) : null } : {}),
        },
      });
      await this.log(tx, p, "academic.session.update", "academic_session", sessionId, { name: input.name });
      return { id: sessionId };
    });
  }

  /** Edit a term. Absent fields are unchanged; a null date clears it. Setting
   *  endDate is what enables the automatic end-of-term progression sweep. */
  async updateTerm(
    p: Principal,
    termId: string,
    input: { name?: string; sequence?: number; startDate?: string | null; endDate?: string | null },
  ) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const term = (await tx.term.findFirst({
        where: { id: termId },
        select: { id: true, sessionId: true, sequence: true, startDate: true, endDate: true, name: true, isCurrent: true },
      })) as CalendarTermRow | null;
      if (!term) throw new NotFoundException("Term not found");
      // Clearing a date on the CURRENT term is the same act as making a dateless
      // term current, arrived at from the other direction — so it is refused the
      // same way rather than leaving a back door into the unguarded state.
      const isCurrentTerm = (term as { isCurrent?: boolean }).isCurrent === true;
      if (isCurrentTerm) {
        const merged = {
          name: (term as unknown as { name?: string }).name ?? "This term",
          startDate: input.startDate === undefined ? term.startDate : input.startDate,
          endDate: input.endDate === undefined ? term.endDate : input.endDate,
        };
        const blocker = currentTermBlocker(merged);
        if (blocker) throw new BadRequestException(blocker);
      }
      // Validate the EFFECTIVE (merged) dates/sequence against the session window
      // and the OTHER terms in the same session — a half-edit can't slip past.
      const session = (await tx.academicSession.findFirst({
        where: { id: term.sessionId },
        select: { id: true, startDate: true, endDate: true },
      })) as CalendarSessionRow | null;
      const siblings = (await tx.term.findMany({
        where: { sessionId: term.sessionId, id: { not: termId } },
        select: { id: true, sessionId: true, name: true, sequence: true, startDate: true, endDate: true },
      })) as CalendarTermRow[];
      const bad = validateTermDates(
        {
          sequence: input.sequence ?? term.sequence,
          startDate: input.startDate !== undefined ? input.startDate : term.startDate,
          endDate: input.endDate !== undefined ? input.endDate : term.endDate,
        },
        session,
        siblings,
      );
      if (bad) throw new BadRequestException(bad);
      const data: Record<string, unknown> = {};
      if (input.name !== undefined) data.name = input.name;
      if (input.sequence !== undefined) data.sequence = input.sequence;
      if (input.startDate !== undefined) data.startDate = input.startDate ? new Date(input.startDate) : null;
      if (input.endDate !== undefined) data.endDate = input.endDate ? new Date(input.endDate) : null;
      const t = await tx.term.update({ where: { id: termId }, data });
      await this.log(tx, p, "academic.term.update", "term", termId, {
        fields: Object.keys(data),
        endDate: input.endDate ?? undefined,
      });
      return this.termDto(t as TermRow);
    });
  }

  /** Mark a session current (and clear the others). */
  async setCurrentSession(p: Principal, sessionId: string) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const session = await tx.academicSession.findFirst({ where: { id: sessionId }, select: { id: true } });
      if (!session) throw new NotFoundException("Session not found");
      await tx.academicSession.updateMany({ where: { isCurrent: true }, data: { isCurrent: false } });
      await tx.academicSession.update({ where: { id: sessionId }, data: { isCurrent: true } });
      await this.log(tx, p, "academic.session.set_current", "academic_session", sessionId, {});
      return { id: sessionId, isCurrent: true };
    });
  }

  /** Mark a term current (and clear the others). The term's SESSION is made
   *  current too, so the pointer can never land on a term outside the current
   *  session (an inconsistency the rest of the app reads from). */
  async setCurrentTerm(p: Principal, termId: string) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const term = await tx.term.findFirst({
        where: { id: termId },
        select: { id: true, sessionId: true, name: true, startDate: true, endDate: true },
      });
      if (!term) throw new NotFoundException("Term not found");
      // REFUSED, not warned about: this is the one state where failing open
      // costs the past-term register lock.
      const blocker = currentTermBlocker(term as { name: string; startDate: Date | null; endDate: Date | null });
      if (blocker) throw new BadRequestException(blocker);
      await tx.term.updateMany({ where: { isCurrent: true }, data: { isCurrent: false } });
      await tx.term.update({ where: { id: termId }, data: { isCurrent: true } });
      // Keep the current-session pointer in lock-step with the current term.
      await tx.academicSession.updateMany({ where: { isCurrent: true }, data: { isCurrent: false } });
      await tx.academicSession.update({ where: { id: term.sessionId }, data: { isCurrent: true } });
      await this.log(tx, p, "academic.term.set_current", "term", termId, { sessionId: term.sessionId });
      return { id: termId, isCurrent: true };
    });
  }

  /**
   * Tier-2 quick-create: a whole standard Nigerian three-term session in one
   * action. Generates three ~13-week terms (with breaks) from `yearStart` —
   * editable afterwards. Optionally makes the new session + its first term
   * current straight away.
   */
  async createStandardSession(
    p: Principal,
    input: { name: string; yearStart: string; makeCurrent?: boolean },
  ): Promise<AcademicSessionDto> {
    const terms = standardTermDates(input.yearStart);
    const sessionStart = terms[0].startDate;
    const sessionEnd = terms[terms.length - 1].endDate;
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const s = await tx.academicSession.create({
        data: { schoolId: p.schoolId, name: input.name, startDate: new Date(sessionStart), endDate: new Date(sessionEnd) },
      });
      await tx.term.createMany({
        data: terms.map((t) => ({
          schoolId: p.schoolId,
          sessionId: s.id,
          name: t.name,
          sequence: t.sequence,
          startDate: new Date(t.startDate),
          endDate: new Date(t.endDate),
        })),
      });
      if (input.makeCurrent) {
        // MID-YEAR ONBOARDING. This used to take the FIRST term unconditionally,
        // which is right only for a school that joins in September. A school
        // onboarding in February got "First Term" marked current, and everything
        // downstream believed it: the past-term register lock read Term 1's start
        // date, so registers from a term that had already closed stayed editable;
        // every register and mark taken filed against Term 1; and report cards
        // were headed with the wrong term. Nothing announced any of it.
        //
        // The term CONTAINING TODAY is the correct answer in both cases — it
        // gives a September school Term 1 exactly as before — so the mid-year
        // case needs no extra step and cannot be forgotten.
        const today = new Date();
        today.setUTCHours(0, 0, 0, 0);
        const containing = await tx.term.findFirst({
          where: { sessionId: s.id, startDate: { lte: today }, endDate: { gte: today } },
          orderBy: { sequence: "asc" },
          select: { id: true },
        });
        // Falls back to the first term when today is outside the whole session —
        // a school setting NEXT year up over the holidays asked for it explicitly.
        const first =
          containing ??
          (await tx.term.findFirst({ where: { sessionId: s.id }, orderBy: { sequence: "asc" }, select: { id: true } }));
        await tx.term.updateMany({ where: { isCurrent: true }, data: { isCurrent: false } });
        await tx.academicSession.updateMany({ where: { isCurrent: true }, data: { isCurrent: false } });
        await tx.academicSession.update({ where: { id: s.id }, data: { isCurrent: true } });
        if (first) await tx.term.update({ where: { id: first.id }, data: { isCurrent: true } });
      }
      await this.log(tx, p, "academic.session.create_standard", "academic_session", s.id, { name: input.name, terms: terms.length, makeCurrent: !!input.makeCurrent });
      const created = (await tx.academicSession.findFirstOrThrow({ where: { id: s.id } })) as SessionRow;
      const rows = (await tx.term.findMany({ where: { sessionId: s.id }, orderBy: { sequence: "asc" } })) as TermRow[];
      return { id: created.id, name: created.name, isCurrent: created.isCurrent, startDate: created.startDate, endDate: created.endDate, terms: rows.map(this.termDto) };
    });
  }

  /**
   * Tier-2 "sync current to today": set the current term (and its session) to the
   * one whose [startDate,endDate] window contains today, so the pointer reflects
   * reality without a manual advance. 400 when no dated term contains today.
   */
  async setCurrentToToday(p: Principal): Promise<AdvanceTermResult> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      const containing = (await tx.term.findFirst({
        where: { startDate: { lte: today }, endDate: { gte: today } },
        orderBy: { startDate: "desc" },
      })) as TermRow | null;
      if (!containing) {
        throw new BadRequestException("No term's dates contain today. Set term start/end dates first, or mark a term current manually.");
      }
      if (containing.isCurrent) {
        return { advanced: false, reason: "Today's term is already current.", termId: containing.id, termName: containing.name, sessionId: containing.sessionId };
      }
      await tx.term.updateMany({ where: { isCurrent: true }, data: { isCurrent: false } });
      await tx.term.update({ where: { id: containing.id }, data: { isCurrent: true } });
      await tx.academicSession.updateMany({ where: { isCurrent: true }, data: { isCurrent: false } });
      await tx.academicSession.update({ where: { id: containing.sessionId }, data: { isCurrent: true } });
      await this.log(tx, p, "academic.term.set_current", "term", containing.id, { via: "today", sessionId: containing.sessionId });
      return { advanced: true, termId: containing.id, termName: containing.name, sessionId: containing.sessionId };
    });
  }

  /**
   * One-click "advance to next term": moves the current-term pointer to the next
   * term in sequence, or — when the current term is the session's last — to the
   * first term of the next session (also flipping the current session). Past
   * terms/sessions keep all their grades, attendance and report cards; only the
   * "current" pointer moves, so nothing is lost. 400 when there is no next term.
   */
  async advanceToNextTerm(p: Principal): Promise<AdvanceTermResult> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const r = await advanceTermInTx(tx, { schoolId: p.schoolId, actorId: p.userId, audit: this.audit });
      if (!r.advanced) throw new BadRequestException(r.reason ?? "Cannot advance to the next term.");
      return r;
    });
  }

  // --- holidays / non-teaching days (Tier 3) --------------------------------

  /** Holidays for the school, soonest span first. Broad read (class.read) so the
   *  shared calendar and the attendance guard can both see them. */
  async listHolidays(p: Principal): Promise<SchoolHolidayDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const rows = (await tx.schoolHoliday.findMany({ orderBy: { startDate: "asc" } })) as HolidayRow[];
      return rows.map((h) => ({ id: h.id, name: h.name, startDate: h.startDate, endDate: h.endDate, createdAt: h.createdAt }));
    });
  }

  async createHoliday(p: Principal, input: { name: string; startDate: string; endDate: string }): Promise<SchoolHolidayDto> {
    if (dayUtc(input.endDate) < dayUtc(input.startDate)) {
      throw new BadRequestException("A holiday's end date cannot be before its start date.");
    }
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const h = (await tx.schoolHoliday.create({
        data: { schoolId: p.schoolId, name: input.name, startDate: new Date(input.startDate), endDate: new Date(input.endDate), createdById: p.userId },
      })) as HolidayRow;
      await this.log(tx, p, "academic.holiday.create", "school_holiday", h.id, { name: input.name });
      return { id: h.id, name: h.name, startDate: h.startDate, endDate: h.endDate, createdAt: h.createdAt };
    });
  }

  async deleteHoliday(p: Principal, id: string): Promise<{ id: string; deleted: true }> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const h = await tx.schoolHoliday.findFirst({ where: { id }, select: { id: true } });
      if (!h) throw new NotFoundException("Holiday not found");
      await tx.schoolHoliday.delete({ where: { id } });
      await this.log(tx, p, "academic.holiday.delete", "school_holiday", id, {});
      return { id, deleted: true as const };
    });
  }

  private termDto(t: TermRow): TermDto {
    return {
      id: t.id,
      sessionId: t.sessionId,
      name: t.name,
      sequence: t.sequence,
      isCurrent: t.isCurrent,
      startDate: t.startDate,
      endDate: t.endDate,
    };
  }

  private async log(tx: TenantTx, p: Principal, action: string, entity: string, entityId: string, metadata: Record<string, unknown>) {
    await this.audit.record({ actorId: p.userId, action, entity, entityId, schoolId: p.schoolId, metadata }, tx);
  }
}
