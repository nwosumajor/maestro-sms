// =============================================================================
// UltimateService — cross-school Ultimate arena (platform spec §7/§10, step 8)
// =============================================================================
// THE ONE deliberate tenant-boundary crossing. Built as a SEPARATE surface so it
// can never become a hole in the tenant wall. Two halves with OPPOSITE postures:
//
//  (A) CROSS-TENANT ARENA (RLS-exempt): UltimateCompetition / UltimateParticipant.
//      A cross-school leaderboard must read across schools, so these are exempt —
//      safe because they carry NO PII: an OPAQUE participant id, a HANDLE (never a
//      real name), schoolId (grouping only), the SERVER-ONLY per-entry secret, and
//      scores. The secret is NEVER serialized; the opaque id only de-anonymises
//      via the RLS-scoped bridge (B), so only WITHIN its owning school.
//
//  (B) TENANT-SCOPED GOVERNANCE/BRIDGE (RLS): UltimateEnrollment (tier-1 school
//      opt-in), UltimateConsent (tier-2 per-student guardian consent),
//      UltimateEntryLink (the only userId<->participantId map).
//
// Entry requires BOTH consent tiers AND the school's `crossSchoolEnabled` posture
// (step 7). Admin (create/cancel) is super_admin only. Every mutation — including
// every consent change and arena entry — is audit-logged (Golden Rule #5).
//
// What crosses the boundary, and why (documented per spec §7/§10): handle
// (pseudonym), schoolId→school NAME (institution, explicitly allowed for
// grouping), and scores. Nothing else. No userId, student name, class, or other
// tenant data is ever read into a cross-school surface.
// =============================================================================

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomInt, randomUUID } from "node:crypto";
import {
  computeRaceStandings,
  generateSecret,
  isDifficultyLength,
  isValidHandle,
  isWin,
  score,
  validate,
  type RaceFinish,
} from "@sms/game-engine";
import type {
  UltimateCompetitionDto,
  UltimateEntryDto,
  UltimateLeaderboardDto,
  UltimateLeaderboardRowDto,
} from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";
import { effectiveGameSettings } from "./game-settings.util";

const cryptoRng = () => randomInt(0, 1_000_000) / 1_000_000;

@Injectable()
export class UltimateService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  // =========================================================================
  // Admin — super_admin only (gated by game.ultimate.admin at the controller)
  // =========================================================================
  async createCompetition(
    p: Principal,
    input: { name: string; difficultyLength: number; startAt: string; endAt: string },
  ): Promise<UltimateCompetitionDto> {
    const name = (input.name ?? "").trim();
    if (!name) throw new BadRequestException("name is required");
    if (!isDifficultyLength(input.difficultyLength)) {
      throw new BadRequestException("difficultyLength must be 4, 5, or 6");
    }
    const startAt = new Date(input.startAt);
    const endAt = new Date(input.endAt);
    if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) {
      throw new BadRequestException("startAt/endAt must be valid dates");
    }
    if (endAt <= startAt) throw new BadRequestException("endAt must be after startAt");

    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      // RLS-exempt arena table: the insert is unaffected by the tenant GUC.
      const comp = await tx.ultimateCompetition.create({
        data: {
          name,
          difficultyLength: input.difficultyLength,
          status: "ACTIVE",
          startAt,
          endAt,
          createdById: p.userId,
        },
      });
      await this.log(tx, p, "ultimate.competition.create", comp.id, {
        difficultyLength: input.difficultyLength,
      });
      return this.toCompetitionDto(comp, false, false);
    });
  }

  async cancelCompetition(p: Principal, competitionId: string): Promise<UltimateCompetitionDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const comp = await this.requireCompetition(tx, competitionId);
      if (comp.status === "CANCELLED" || comp.status === "FINISHED") {
        throw new ConflictException("competition is already closed");
      }
      const updated = await tx.ultimateCompetition.update({
        where: { id: competitionId },
        data: { status: "CANCELLED" },
      });
      await this.log(tx, p, "ultimate.competition.cancel", competitionId);
      return this.toCompetitionDto(updated, false, false);
    });
  }

  // =========================================================================
  // Reads
  // =========================================================================
  /** List competitions with this school's enrollment + the caller's entry flags. */
  async list(p: Principal): Promise<UltimateCompetitionDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const comps = await tx.ultimateCompetition.findMany({ orderBy: { createdAt: "desc" }, take: 100 });
      const out: UltimateCompetitionDto[] = [];
      for (const c of comps) {
        const enrolled = await tx.ultimateEnrollment.findFirst({
          where: { competitionId: c.id, schoolId: p.schoolId },
          select: { id: true },
        });
        const entry = await tx.ultimateEntryLink.findFirst({
          where: { competitionId: c.id, userId: p.userId },
          select: { id: true },
        });
        out.push(this.toCompetitionDto(c, !!enrolled, !!entry));
      }
      return out;
    });
  }

  // =========================================================================
  // Tier 1 — school enrollment (principal / school_admin, game.ultimate.enroll)
  // =========================================================================
  async enrollSchool(p: Principal, competitionId: string): Promise<UltimateCompetitionDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const comp = await this.requireCompetition(tx, competitionId);
      if (comp.status !== "ACTIVE") throw new ConflictException("competition is not open");
      // The school must first PERMIT cross-school play at all (step-7 posture).
      const settings = effectiveGameSettings(
        await tx.gameSettings.findFirst({ where: { schoolId: p.schoolId } }),
      );
      if (!settings.crossSchoolEnabled) {
        throw new ForbiddenException(
          "cross-school play is disabled for your school (enable it in game settings first)",
        );
      }
      const existing = await tx.ultimateEnrollment.findFirst({
        where: { competitionId, schoolId: p.schoolId },
      });
      if (!existing) {
        await tx.ultimateEnrollment.create({
          data: { schoolId: p.schoolId, competitionId, enrolledById: p.userId },
        });
      }
      await this.log(tx, p, "ultimate.enroll", competitionId);
      return this.toCompetitionDto(comp, true, false);
    });
  }

  // =========================================================================
  // Tier 2 — per-student guardian consent (school_admin, game.ultimate.consent)
  // =========================================================================
  async setConsent(
    p: Principal,
    input: { studentId: string; granted: boolean },
  ): Promise<{ studentId: string; granted: boolean }> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      // The student must be in the caller's school (RLS scopes the lookup).
      const student = await tx.user.findFirst({
        where: { id: input.studentId },
        select: { id: true },
      });
      if (!student) throw new NotFoundException("Student not found");
      const existing = await tx.ultimateConsent.findFirst({
        where: { schoolId: p.schoolId, studentId: input.studentId },
      });
      if (existing) {
        await tx.ultimateConsent.update({
          where: { id: existing.id },
          data: { granted: input.granted, grantedById: p.userId },
        });
      } else {
        await tx.ultimateConsent.create({
          data: {
            schoolId: p.schoolId,
            studentId: input.studentId,
            granted: input.granted,
            grantedById: p.userId,
          },
        });
      }
      // SECURITY: consent state changes are audit-logged (spec §7).
      await this.log(tx, p, "ultimate.consent.set", input.studentId, { granted: input.granted });
      return { studentId: input.studentId, granted: input.granted };
    });
  }

  // =========================================================================
  // Entry + play — student (game.play). Both consent tiers verified here.
  // =========================================================================
  async enter(p: Principal, competitionId: string, handle: string): Promise<UltimateEntryDto> {
    const trimmed = (handle ?? "").trim();
    if (!isValidHandle(trimmed)) {
      throw new BadRequestException("handle must be 3–24 chars: letters, digits, space, _ or -");
    }
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const comp = await this.requireCompetition(tx, competitionId);
      if (comp.status !== "ACTIVE") throw new ConflictException("competition is not open");

      // Tier-0: the school must permit cross-school play (step-7 posture).
      const settings = effectiveGameSettings(
        await tx.gameSettings.findFirst({ where: { schoolId: p.schoolId } }),
      );
      if (!settings.crossSchoolEnabled) {
        throw new ForbiddenException("cross-school play is disabled for your school");
      }
      // Tier-1: the school enrolled into THIS competition.
      const enrolled = await tx.ultimateEnrollment.findFirst({
        where: { competitionId, schoolId: p.schoolId },
        select: { id: true },
      });
      if (!enrolled) throw new ForbiddenException("your school has not enrolled in this competition");
      // Tier-2: the student carries an explicit granted guardian consent flag.
      const consent = await tx.ultimateConsent.findFirst({
        where: { schoolId: p.schoolId, studentId: p.userId, granted: true },
        select: { id: true },
      });
      if (!consent) {
        throw new ForbiddenException("cross-school consent has not been granted for you");
      }
      // One entry per student per competition.
      const dup = await tx.ultimateEntryLink.findFirst({
        where: { competitionId, userId: p.userId },
        select: { id: true },
      });
      if (dup) throw new ConflictException("you have already entered this competition");

      // SECURITY: opaque participant id (NOT the userId) + a per-entry server-only
      // secret. The arena row carries the handle + schoolId + secret + scores.
      const participantId = randomUUID();
      const secret = generateSecret(comp.difficultyLength, cryptoRng);
      await tx.ultimateParticipant.create({
        data: {
          id: participantId,
          competitionId,
          schoolId: p.schoolId,
          handle: trimmed,
          secret,
          startedAt: new Date(),
        },
      });
      // The ONLY userId <-> participantId map; lives in the RLS-scoped space.
      await tx.ultimateEntryLink.create({
        data: {
          schoolId: p.schoolId,
          competitionId,
          userId: p.userId,
          participantId,
          handle: trimmed,
        },
      });
      await this.log(tx, p, "ultimate.enter", competitionId, { participantId });
      return this.myEntryView(tx, competitionId, participantId, trimmed);
    });
  }

  /** Guess against the caller's OWN per-entry target. Returns only the score. */
  async guess(
    p: Principal,
    competitionId: string,
    value: string,
  ): Promise<{ dead: number; wounded: number }> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const link = await tx.ultimateEntryLink.findFirst({
        where: { competitionId, userId: p.userId },
      });
      if (!link) throw new NotFoundException("You have not entered this competition");
      const participant = await tx.ultimateParticipant.findFirst({
        where: { id: link.participantId },
      });
      if (!participant || participant.secret === null || participant.status !== "ACTIVE") {
        throw new ConflictException("Your entry is not in play");
      }
      const comp = await this.requireCompetition(tx, competitionId);
      if (comp.status !== "ACTIVE") throw new ConflictException("competition is not open");
      if (!validate(value, comp.difficultyLength)) {
        throw new BadRequestException(`guess must be ${comp.difficultyLength} distinct digits 0-9`);
      }
      // Anti-abuse: reuse the school's configured guess rate limit (step 7).
      const rateLimitMs = effectiveGameSettings(
        await tx.gameSettings.findFirst({ where: { schoolId: p.schoolId } }),
      ).guessRateLimitMs;
      if (participant.lastGuessAt && Date.now() - participant.lastGuessAt.getTime() < rateLimitMs) {
        throw new HttpException("Slow down — too many guesses", HttpStatus.TOO_MANY_REQUESTS);
      }

      const result = score(value, participant.secret);
      const guessCount = participant.guessCount + 1;
      if (isWin(result, comp.difficultyLength)) {
        // SECURITY: clear the secret on finish (server-only retention, §10).
        await tx.ultimateParticipant.update({
          where: { id: participant.id },
          data: {
            guessCount,
            lastGuessAt: new Date(),
            status: "FINISHED",
            finishedAt: new Date(),
            elapsedMs: Math.max(0, Date.now() - participant.startedAt.getTime()),
            secret: null,
          },
        });
      } else {
        await tx.ultimateParticipant.update({
          where: { id: participant.id },
          data: { guessCount, lastGuessAt: new Date() },
        });
      }
      await this.log(tx, p, "ultimate.guess", competitionId, {
        dead: result.dead,
        wounded: result.wounded,
      });
      return { dead: result.dead, wounded: result.wounded };
    });
  }

  /** The caller's own entry (never the secret). 404 if not entered. */
  async myEntry(p: Principal, competitionId: string): Promise<UltimateEntryDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const link = await tx.ultimateEntryLink.findFirst({
        where: { competitionId, userId: p.userId },
      });
      if (!link) throw new NotFoundException("You have not entered this competition");
      return this.myEntryView(tx, competitionId, link.participantId, link.handle);
    });
  }

  /**
   * The cross-school leaderboard. CARRIES NO PII: handle + school NAME + scores.
   * Finishers ranked by the §7 metric (fewest guesses → fastest own-start
   * elapsed). The caller's own row is flagged via their private entry link.
   */
  async leaderboard(p: Principal, competitionId: string): Promise<UltimateLeaderboardDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const comp = await this.requireCompetition(tx, competitionId);
      // RLS-exempt arena read — intentionally across all schools.
      const participants = await tx.ultimateParticipant.findMany({ where: { competitionId } });
      const finished = participants.filter((pt) => pt.status === "FINISHED");
      const finishes: RaceFinish[] = finished.map((pt) => ({
        userId: pt.id, // opaque participant id, NOT a userId
        guessCount: pt.guessCount,
        elapsedMs: pt.elapsedMs ?? 0,
      }));
      const ranked = computeRaceStandings(finishes);

      // Resolve school NAMES (institution, allowed for grouping) — the global
      // School registry is RLS-exempt; we read ONLY id+name, never student data.
      const schoolIds = [...new Set(finished.map((pt) => pt.schoolId))];
      const schools = await tx.school.findMany({
        where: { id: { in: schoolIds } },
        select: { id: true, name: true },
      });
      const nameBySchool = new Map(schools.map((s) => [s.id, s.name]));
      const byParticipant = new Map(finished.map((pt) => [pt.id, pt]));

      // The caller's own opaque id (only resolvable within their own school).
      const myLink = await tx.ultimateEntryLink.findFirst({
        where: { competitionId, userId: p.userId },
        select: { participantId: true },
      });
      const myParticipantId = myLink?.participantId ?? null;

      const rows: UltimateLeaderboardRowDto[] = ranked.map((r) => {
        const pt = byParticipant.get(r.userId)!;
        return {
          handle: pt.handle,
          schoolName: nameBySchool.get(pt.schoolId) ?? "School",
          guessCount: r.guessCount,
          elapsedMs: r.elapsedMs,
          rank: r.rank,
          isYou: r.userId === myParticipantId,
        };
      });
      return {
        competitionId: comp.id,
        difficultyLength: comp.difficultyLength,
        participantCount: participants.length,
        rows,
      };
    });
  }

  // =========================================================================
  // internals
  // =========================================================================
  private async requireCompetition(tx: TenantTx, competitionId: string) {
    const comp = await tx.ultimateCompetition.findFirst({ where: { id: competitionId } });
    if (!comp) throw new NotFoundException("Competition not found");
    return comp;
  }

  /** Build the caller's own entry view, computing their leaderboard rank. */
  private async myEntryView(
    tx: TenantTx,
    competitionId: string,
    participantId: string,
    handle: string,
  ): Promise<UltimateEntryDto> {
    const me = await tx.ultimateParticipant.findFirst({ where: { id: participantId } });
    if (!me) throw new NotFoundException("Entry not found");
    let rank: number | null = null;
    if (me.status === "FINISHED") {
      const participants = await tx.ultimateParticipant.findMany({
        where: { competitionId, status: "FINISHED" },
      });
      const ranked = computeRaceStandings(
        participants.map((pt) => ({
          userId: pt.id,
          guessCount: pt.guessCount,
          elapsedMs: pt.elapsedMs ?? 0,
        })),
      );
      rank = ranked.find((r) => r.userId === participantId)?.rank ?? null;
    }
    return {
      competitionId,
      handle,
      status: me.status,
      guessCount: me.guessCount,
      elapsedMs: me.elapsedMs,
      finishedAt: me.finishedAt,
      rank,
    };
  }

  private toCompetitionDto(
    c: {
      id: string;
      name: string;
      difficultyLength: number;
      status: string;
      startAt: Date;
      endAt: Date;
    },
    schoolEnrolled: boolean,
    entered: boolean,
  ): UltimateCompetitionDto {
    return {
      id: c.id,
      name: c.name,
      difficultyLength: c.difficultyLength,
      status: c.status as UltimateCompetitionDto["status"],
      startAt: c.startAt,
      endAt: c.endAt,
      schoolEnrolled,
      entered,
    };
  }

  private async log(
    tx: TenantTx,
    p: Principal,
    action: string,
    entityId: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record(
      { actorId: p.userId, action, entity: "ultimate", entityId, schoolId: p.schoolId, metadata },
      tx,
    );
  }
}
