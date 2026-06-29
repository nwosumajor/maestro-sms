// =============================================================================
// AcademicService — academic sessions + terms (the school calendar)
// =============================================================================
// Makes the school year first-class so "third term" is a real entity. CRUD over
// sessions and their ordered terms, plus "set current" (exactly one current
// session and one current term per school — flipped atomically). Tenant-scoped
// (RLS), audited. Reads are broad (class.read); writes are academic.manage.
// =============================================================================

import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { AcademicSessionDto, TermDto } from "@sms/types";
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
  startDate: Date | null;
  endDate: Date | null;
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

  async addTerm(p: Principal, sessionId: string, input: { name: string; sequence: number }) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const session = await tx.academicSession.findFirst({ where: { id: sessionId }, select: { id: true } });
      if (!session) throw new NotFoundException("Session not found");
      const t = await tx.term.create({
        data: { schoolId: p.schoolId, sessionId, name: input.name, sequence: input.sequence },
      });
      await this.log(tx, p, "academic.term.create", "term", t.id, { sessionId, sequence: input.sequence });
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
