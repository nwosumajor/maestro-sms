// =============================================================================
// AcademicService — academic sessions + terms (the school calendar)
// =============================================================================
// Makes the school year first-class so "third term" is a real entity. CRUD over
// sessions and their ordered terms, plus "set current" (exactly one current
// session and one current term per school — flipped atomically). Tenant-scoped
// (RLS), audited. Reads are broad (class.read); writes are academic.manage.
// =============================================================================

import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { AcademicSessionDto, TermDto } from "@sms/types";
import { pickNextTerm, termHasElapsed } from "@sms/types";
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

  async createSession(p: Principal, input: { name: string; startDate?: string | null; endDate?: string | null }) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
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
      const session = await tx.academicSession.findFirst({ where: { id: sessionId }, select: { id: true } });
      if (!session) throw new NotFoundException("Session not found");
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

  /** Edit a term. Absent fields are unchanged; a null date clears it. Setting
   *  endDate is what enables the automatic end-of-term progression sweep. */
  async updateTerm(
    p: Principal,
    termId: string,
    input: { name?: string; sequence?: number; startDate?: string | null; endDate?: string | null },
  ) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const term = await tx.term.findFirst({ where: { id: termId }, select: { id: true } });
      if (!term) throw new NotFoundException("Term not found");
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

  /** Mark a term current (and clear the others). */
  async setCurrentTerm(p: Principal, termId: string) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const term = await tx.term.findFirst({ where: { id: termId }, select: { id: true } });
      if (!term) throw new NotFoundException("Term not found");
      await tx.term.updateMany({ where: { isCurrent: true }, data: { isCurrent: false } });
      await tx.term.update({ where: { id: termId }, data: { isCurrent: true } });
      await this.log(tx, p, "academic.term.set_current", "term", termId, {});
      return { id: termId, isCurrent: true };
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
