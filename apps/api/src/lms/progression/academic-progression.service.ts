// =============================================================================
// AcademicProgressionService — automatic end-of-term/session roll-over sweep
// =============================================================================
// When a school has DATED its current term (Term.endDate) and that date has
// passed, this cross-tenant sweep advances the "current term" pointer to the
// next term — or, at the end of a session, to the next session's first term.
// It moves ONLY the pointer: every past term/session keeps all its grades,
// attendance and report cards, so nothing is lost and history stays viewable.
//
// Mirrors the fee-ops late-fee sweep: the PRIVILEGED client lists schools
// (cross-tenant read of the global `school` table), but the actual roll-over
// runs TENANT-SCOPED via runAsTenant (app role + RLS), attributed to a real
// management user so the audit-log FK holds. A school with no endDate on its
// current term simply never auto-advances — it uses the manual button instead.
// =============================================================================

import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type TenantDatabase,
  type TenantTx,
} from "../../integrity/integrity.foundation";
import { PrivilegedDatabaseService } from "../../common/privileged-database.service";
import { advanceTermInTx, type AdvanceTermResult } from "../academic.service";

export type ProgressionTrigger = "SCHEDULED" | "MANUAL";

export interface SchoolProgressionResult extends AdvanceTermResult {
  schoolId: string;
}

@Injectable()
export class AcademicProgressionService {
  private readonly logger = new Logger("AcademicProgression");

  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly privileged: PrivilegedDatabaseService,
  ) {}

  /** Advance every school whose current term has ended. Returns the schools
   *  that actually rolled over (skips/blocked schools are omitted). */
  async runSweep(trigger: ProgressionTrigger = "SCHEDULED"): Promise<{
    schools: number;
    advanced: number;
    results: SchoolProgressionResult[];
  }> {
    const client = this.privileged.client;
    if (!client) {
      this.logger.warn("Progression sweep requested but no privileged DB — skipping.");
      return { schools: 0, advanced: 0, results: [] };
    }
    const asOf = new Date();
    const schools = await client.school.findMany({
      where: { isPlatform: false },
      select: { id: true },
    });
    const results: SchoolProgressionResult[] = [];
    for (const s of schools) {
      // Attribute the auto-advance to a real management user (audit_log.actorId
      // is a non-null FK to User; the all-zero SYSTEM id would violate it).
      const actor = await client.userRole.findFirst({
        where: { schoolId: s.id, role: { name: { in: ["principal", "school_admin"] } } },
        select: { userId: true },
      });
      if (!actor) continue; // no one to attribute the roll-over to → skip.
      try {
        const r = await this.db.runAsTenant({ schoolId: s.id, userId: actor.userId }, async (tx) => {
          const res = await advanceTermInTx(tx, {
            schoolId: s.id,
            actorId: actor.userId,
            audit: this.audit,
            asOf,
            onlyIfElapsed: true,
          });
          if (res.advanced) await this.notifyManagement(tx, s.id, res);
          return res;
        });
        if (r.advanced) {
          results.push({ schoolId: s.id, ...r });
          this.logger.log(
            `school=${s.id} auto-advanced to term=${r.termId}${r.newSession ? " (new session)" : ""}`,
          );
        }
      } catch (err) {
        this.logger.warn(`school=${s.id} auto-advance failed: ${(err as Error).message}`);
      }
    }
    this.logger.log(`Progression sweep (${trigger}): ${schools.length} schools, ${results.length} advanced.`);
    return { schools: schools.length, advanced: results.length, results };
  }

  /** In-app heads-up to management that the term rolled over (transparency). */
  private async notifyManagement(tx: TenantTx, schoolId: string, r: AdvanceTermResult): Promise<void> {
    const managers = await tx.userRole.findMany({
      where: { role: { name: { in: ["principal", "school_admin"] } } },
      select: { userId: true },
      distinct: ["userId"],
    });
    if (managers.length === 0) return;
    const title = r.newSession ? "New academic session started" : "Term advanced";
    const body = r.newSession
      ? `The previous session ended, so ${r.sessionName ?? "the next session"} — ${r.termName ?? "its first term"} — is now the current term. Past terms and their records remain viewable.`
      : `The previous term ended, so ${r.termName ?? "the next term"} is now the current term. Past terms and their records remain viewable.`;
    await tx.notification.createMany({
      data: managers.map((m) => ({
        schoolId,
        recipientId: m.userId,
        actorId: null,
        type: "TERM_ADVANCED",
        title,
        body,
        data: { termId: r.termId, sessionId: r.sessionId, newSession: !!r.newSession },
      })),
    });
  }
}
