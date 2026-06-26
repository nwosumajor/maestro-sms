// =============================================================================
// RaceService — SMS Class Race + cross-class tournament (spec §5, build step 5)
// =============================================================================
// Category 2: a teacher opens a race for ONE class around a single shared target
// secret; every enrolled student races in PARALLEL (no turns) to crack it, and
// the FIRST THREE to score N dead win (1st/2nd/3rd). A principal can schedule a
// cross-class tournament: one race PER class (each its OWN freshly-generated
// target) with combined, time-independent standings (spec §5 resolved rules).
//
// Reuses the duel tables (Game mode RACE / GamePlayer / Guess / GameResult) +
// Competition(type RACE_TOURNAMENT) for grouping — no new tables, so RLS is the
// existing game/competition/standing policies. A RACE never goes through
// GameService (no turns/opponents); this service owns its whole lifecycle.
//
// Security model (CLAUDE.md + spec §9):
//   - Tenant isolation: schoolId from the JWT on every row; RLS backstops.
//   - Relationship scoping: teacher opens/starts/ends only races for THEIR class
//     (ClassTeacher); only ENROLLED students may join/guess; school-wide staff
//     (principal/school_admin/super_admin) may operate school-wide. 404-not-403.
//   - Server authority: the shared target is server-only (Game.targetSecret),
//     NEVER serialized — not even to the host; scoring, finish order and the
//     top-3 are computed here; clients are display-only. A racer sees ONLY their
//     own guesses; others' in-progress guesses are never exposed.
//   - Anti-abuse: guesses are rate-limited per racer (spec §5).
//   - Every mutation is audit-logged (Golden Rule #5 — minors' game telemetry).
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
import {
  computeRaceStandings,
  generateSecret,
  isDifficultyLength,
  isWin,
  score,
  validate,
  type RaceFinish,
} from "@sms/game-engine";
import type {
  RaceDto,
  RaceFinisherDto,
  RaceGuessDto,
  RaceStandingDto,
  RaceSummaryDto,
  RaceTournamentDto,
} from "@sms/types";
import { randomInt } from "node:crypto";
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
import { GameEventsService } from "./game-events.service";

const SCHOOL_WIDE_ROLES = new Set(["school_admin", "principal", "super_admin"]);
/** First N finishers who win (spec §5: 1st/2nd/3rd places). */
const WINNERS = 3;

@Injectable()
export class RaceService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    // In-process "game changed" pub/sub — the /ws/watch gateway re-reads the
    // RLS-scoped, viewer-redacted race view on each nudge (§10 live push).
    private readonly events: GameEventsService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }
  private isSchoolWide(p: Principal): boolean {
    return p.roles.some((r) => SCHOOL_WIDE_ROLES.has(r));
  }

  /**
   * Run a mutation, then announce the changed race AFTER the tx commits so a
   * subscriber that re-reads always observes the persisted state. `id` is the
   * race id when known up front; for `openRace` it's derived from the result.
   */
  private async withEmit<T>(
    p: Principal,
    id: string | null,
    fn: (tx: TenantTx) => Promise<T>,
  ): Promise<T> {
    const out = await this.db.runAsTenant(this.ctx(p), fn);
    const raceId = id ?? (out as { id?: string }).id ?? null;
    if (raceId) this.events.emitChanged(raceId);
    return out;
  }

  // --- class race lifecycle ----------------------------------------------
  /** Teacher (own class) / school staff opens a race; target is set server-side. */
  async openRace(
    p: Principal,
    input: { classId: string; difficultyLength?: number; targetSecret?: string },
  ): Promise<RaceDto> {
    return this.withEmit(p, null, async (tx) => {
      const settings = await this.settings(tx, p.schoolId);
      if (!settings.gamesEnabled) {
        throw new ForbiddenException("Games are disabled for your school");
      }
      await this.assertTeacherOfClass(tx, p, input.classId);
      const difficultyLength = input.difficultyLength ?? settings.defaultDifficulty;
      if (!isDifficultyLength(difficultyLength)) {
        throw new BadRequestException("difficultyLength must be 4, 5, or 6");
      }
      // SECURITY: a host-supplied target is validated; otherwise a CSPRNG-backed
      // random secret — never predictable, never echoed back.
      const target = input.targetSecret
        ? input.targetSecret
        : generateSecret(difficultyLength, () => randomInt(0, 1_000_000) / 1_000_000);
      if (!validate(target, difficultyLength)) {
        throw new BadRequestException(`target must be ${difficultyLength} distinct digits 0-9`);
      }
      const race = await tx.game.create({
        data: {
          schoolId: p.schoolId,
          mode: "RACE",
          difficultyLength,
          status: "LOBBY",
          createdById: p.userId,
          classId: input.classId,
          targetSecret: target,
        },
      });
      await this.log(tx, p, "race.open", race.id, { classId: input.classId });
      return this.buildRaceView(tx, race.id, p.userId);
    });
  }

  /** An enrolled student joins the race lobby. */
  async joinRace(p: Principal, raceId: string): Promise<RaceDto> {
    return this.withEmit(p, raceId, async (tx) => {
      const race = await this.requireRace(tx, raceId);
      if (race.status !== "LOBBY") throw new ConflictException("Race is not open to join");
      await this.assertEnrolled(tx, p, race.classId);
      const existing = await tx.gamePlayer.findFirst({ where: { gameId: raceId, userId: p.userId } });
      if (existing) throw new ConflictException("You are already in this race");
      await tx.gamePlayer.create({ data: { schoolId: p.schoolId, gameId: raceId, userId: p.userId } });
      await this.log(tx, p, "race.join", raceId);
      return this.buildRaceView(tx, raceId, p.userId);
    });
  }

  /** Host starts the race: everyone's clock starts now (spec §5 own-start). */
  async startRace(p: Principal, raceId: string): Promise<RaceDto> {
    return this.withEmit(p, raceId, async (tx) => {
      const race = await this.requireRace(tx, raceId);
      await this.assertTeacherOfClass(tx, p, race.classId);
      if (race.status !== "LOBBY") throw new ConflictException("Race is not in the lobby");
      const count = await tx.gamePlayer.count({ where: { gameId: raceId } });
      if (count < 1) throw new BadRequestException("no participants have joined");
      await tx.game.update({
        where: { id: raceId },
        data: { status: "ACTIVE", startedAt: new Date() },
      });
      await this.log(tx, p, "race.start", raceId, { participants: count });
      return this.buildRaceView(tx, raceId, p.userId);
    });
  }

  /**
   * Submit a guess against the shared target. Returns ONLY the caller's own score
   * ({ dead, wounded }). Server-authoritative: validates, rate-limits, scores via
   * the engine, records the guess, and on a crack records the finish + rank.
   */
  async guess(
    p: Principal,
    raceId: string,
    value: string,
  ): Promise<{ dead: number; wounded: number }> {
    return this.withEmit(p, raceId, async (tx) => {
      const race = await this.requireRace(tx, raceId);
      const me = await this.requireParticipant(tx, raceId, p.userId);
      if (race.status !== "ACTIVE") throw new ConflictException("Race is not in play");
      // Already cracked it → no further guesses (their finish is locked in).
      const already = await tx.gameResult.findFirst({ where: { gameId: raceId, userId: p.userId } });
      if (already) throw new ConflictException("You have already finished this race");
      if (!validate(value, race.difficultyLength)) {
        throw new BadRequestException(`guess must be ${race.difficultyLength} distinct digits 0-9`);
      }
      // Anti-abuse: reject scripted rapid-fire (spec §5).
      const last = await tx.guess.findFirst({
        where: { gameId: raceId, guesserId: me.id },
        orderBy: { createdAt: "desc" },
      });
      const rateLimitMs = (await this.settings(tx, p.schoolId)).guessRateLimitMs;
      if (last && Date.now() - last.createdAt.getTime() < rateLimitMs) {
        throw new HttpException("Slow down — too many guesses", HttpStatus.TOO_MANY_REQUESTS);
      }

      const result = score(value, race.targetSecret as string);
      // A race guess has no opponent player; targetId mirrors the guesser (the
      // shared target is the Game, not another GamePlayer). Column is not an FK.
      await tx.guess.create({
        data: {
          schoolId: p.schoolId,
          gameId: raceId,
          guesserId: me.id,
          targetId: me.id,
          value,
          dead: result.dead,
          wounded: result.wounded,
        },
      });
      await this.log(tx, p, "race.guess", raceId, { dead: result.dead, wounded: result.wounded });

      if (isWin(result, race.difficultyLength)) {
        await this.recordFinish(tx, race, me.id, p.userId);
      }
      return { dead: result.dead, wounded: result.wounded };
    });
  }

  /** Host ends the race early; current finishers keep their ranks. */
  async endRace(p: Principal, raceId: string): Promise<RaceDto> {
    return this.withEmit(p, raceId, async (tx) => {
      const race = await this.requireRace(tx, raceId);
      await this.assertTeacherOfClass(tx, p, race.classId);
      if (race.status === "FINISHED" || race.status === "ABANDONED") {
        throw new ConflictException("Race is already over");
      }
      await this.finishRace(tx, race);
      await this.log(tx, p, "race.end", raceId);
      return this.buildRaceView(tx, raceId, p.userId);
    });
  }

  // --- reads --------------------------------------------------------------
  async getRace(p: Principal, raceId: string): Promise<RaceDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const race = await this.requireRace(tx, raceId);
      await this.assertCanViewRace(tx, p, race);
      return this.buildRaceView(tx, raceId, p.userId);
    });
  }

  /**
   * List joinable/active races the caller can see (discover-and-join). Relationship
   * scoped exactly like the per-race view: school-wide staff see every open race;
   * a teacher sees races for classes they teach; a student sees races for classes
   * they're enrolled in (so they can find one to join), plus any they've joined.
   * Only LOBBY/ACTIVE races are listed; no target or guesses ever cross the wire.
   */
  async listRaces(p: Principal): Promise<RaceSummaryDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      let races;
      if (this.isSchoolWide(p)) {
        races = await tx.game.findMany({
          where: { mode: "RACE", status: { in: ["LOBBY", "ACTIVE"] } },
          orderBy: { createdAt: "desc" },
          take: 50,
        });
      } else {
        const [taught, enrolled, seats] = await Promise.all([
          tx.classTeacher.findMany({ where: { teacherId: p.userId }, select: { classId: true } }),
          tx.enrollment.findMany({ where: { studentId: p.userId }, select: { classId: true } }),
          tx.gamePlayer.findMany({ where: { userId: p.userId }, select: { gameId: true } }),
        ]);
        const classIds = [...new Set([...taught.map((t) => t.classId), ...enrolled.map((e) => e.classId)])];
        const gameIds = seats.map((s) => s.gameId);
        races = await tx.game.findMany({
          where: {
            mode: "RACE",
            status: { in: ["LOBBY", "ACTIVE"] },
            OR: [{ classId: { in: classIds } }, { id: { in: gameIds } }],
          },
          orderBy: { createdAt: "desc" },
          take: 50,
        });
      }
      if (races.length === 0) return [];

      const raceIds = races.map((r) => r.id);
      const classIdsForNames = [
        ...new Set(races.map((r) => r.classId).filter((c): c is string => !!c)),
      ];
      const [counts, mySeats, classes] = await Promise.all([
        tx.gamePlayer.groupBy({ by: ["gameId"], where: { gameId: { in: raceIds } }, _count: { _all: true } }),
        tx.gamePlayer.findMany({ where: { gameId: { in: raceIds }, userId: p.userId }, select: { gameId: true } }),
        tx.class.findMany({ where: { id: { in: classIdsForNames } }, select: { id: true, name: true } }),
      ]);
      const countByGame = new Map(counts.map((c) => [c.gameId, c._count._all]));
      const joinedSet = new Set(mySeats.map((s) => s.gameId));
      const nameByClass = new Map(classes.map((c) => [c.id, c.name]));

      return races.map((r) => ({
        id: r.id,
        classId: r.classId,
        className: r.classId ? nameByClass.get(r.classId) ?? null : null,
        difficultyLength: r.difficultyLength,
        status: r.status as RaceSummaryDto["status"],
        startedAt: r.startedAt,
        participantCount: countByGame.get(r.id) ?? 0,
        joined: joinedSet.has(r.id),
        tournamentId: r.competitionId,
        createdAt: r.createdAt,
      }));
    });
  }

  // --- cross-class tournament (principal/school_admin) --------------------
  async openTournament(
    p: Principal,
    input: { name: string; classIds: string[]; difficultyLength?: number; startAt: string; endAt: string },
  ): Promise<RaceTournamentDto> {
    const name = (input.name ?? "").trim();
    if (!name) throw new BadRequestException("name is required");
    const classIds = [...new Set(input.classIds ?? [])];
    if (classIds.length < 1) throw new BadRequestException("at least one class is required");
    const startAt = new Date(input.startAt);
    const endAt = new Date(input.endAt);
    if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) {
      throw new BadRequestException("startAt/endAt must be valid dates");
    }
    if (endAt <= startAt) throw new BadRequestException("endAt must be after startAt");

    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const settings = await this.settings(tx, p.schoolId);
      if (!settings.gamesEnabled) {
        throw new ForbiddenException("Games are disabled for your school");
      }
      const difficultyLength = input.difficultyLength ?? settings.defaultDifficulty;
      if (!isDifficultyLength(difficultyLength)) {
        throw new BadRequestException("difficultyLength must be 4, 5, or 6");
      }
      // Every class must be in the caller's school (RLS filters the lookup).
      const classes = await tx.class.findMany({ where: { id: { in: classIds } }, select: { id: true } });
      if (classes.length !== classIds.length) {
        throw new BadRequestException("all classes must be in your school");
      }
      const comp = await tx.competition.create({
        data: {
          schoolId: p.schoolId,
          type: "RACE_TOURNAMENT",
          name,
          difficultyLength,
          status: "ACTIVE",
          startAt,
          endAt,
          createdById: p.userId,
        },
      });
      // One race PER class, EACH with its own freshly-generated target (spec §5:
      // never a single shared target across classes — unfair and leak-prone).
      for (const classId of classIds) {
        await tx.game.create({
          data: {
            schoolId: p.schoolId,
            mode: "RACE",
            difficultyLength,
            status: "LOBBY",
            createdById: p.userId,
            classId,
            competitionId: comp.id,
            targetSecret: generateSecret(difficultyLength, () => randomInt(0, 1_000_000) / 1_000_000),
          },
        });
      }
      await this.log(tx, p, "race.tournament.open", comp.id, { classes: classIds.length });
      return this.buildTournamentView(tx, comp.id);
    });
  }

  async getTournament(p: Principal, tournamentId: string): Promise<RaceTournamentDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.requireTournament(tx, tournamentId);
      return this.buildTournamentView(tx, tournamentId);
    });
  }

  // =========================================================================
  // internals
  // =========================================================================
  /** Record a racer's crack: rank by finish order, elapsed from race start. */
  private async recordFinish(
    tx: TenantTx,
    race: { id: string; schoolId: string; startedAt: Date | null; competitionId: string | null },
    playerId: string,
    userId: string,
  ): Promise<void> {
    const finishersSoFar = await tx.gameResult.count({ where: { gameId: race.id } });
    const rank = finishersSoFar + 1;
    const guessCount = await tx.guess.count({ where: { gameId: race.id, guesserId: playerId } });
    const elapsedMs = race.startedAt ? Math.max(0, Date.now() - race.startedAt.getTime()) : 0;
    await tx.gameResult.create({
      data: { schoolId: race.schoolId, gameId: race.id, userId, rank, guessCount, elapsedMs, outcome: "WON" },
    });
    // First three decided, or everyone has cracked → the race is over (spec §5).
    const participants = await tx.gamePlayer.count({ where: { gameId: race.id } });
    if (rank >= WINNERS || rank >= participants) {
      await this.finishRace(tx, race);
    }
  }

  private async finishRace(
    tx: TenantTx,
    race: { id: string; competitionId: string | null },
  ): Promise<void> {
    const first = await tx.gameResult.findFirst({ where: { gameId: race.id, rank: 1 } });
    let winnerPlayerId: string | null = null;
    if (first) {
      const pl = await tx.gamePlayer.findFirst({ where: { gameId: race.id, userId: first.userId } });
      winnerPlayerId = pl?.id ?? null;
    }
    // Retention: clear the target once the race is over (server-only, §10).
    await tx.game.update({
      where: { id: race.id },
      data: { status: "FINISHED", finishedAt: new Date(), winnerPlayerId, targetSecret: null },
    });
    if (race.competitionId) await this.maybeFinishTournament(tx, race.competitionId);
  }

  private async maybeFinishTournament(tx: TenantTx, competitionId: string): Promise<void> {
    const races = await tx.game.findMany({ where: { competitionId }, select: { status: true } });
    if (races.every((g) => g.status === "FINISHED" || g.status === "ABANDONED")) {
      await tx.competition.update({ where: { id: competitionId }, data: { status: "FINISHED" } });
    }
  }

  // --- helpers ------------------------------------------------------------
  /** The school's effective game settings (row merged over platform defaults). */
  private async settings(tx: TenantTx, schoolId: string) {
    return effectiveGameSettings(await tx.gameSettings.findFirst({ where: { schoolId } }));
  }

  // --- scoping helpers (mirror AttendanceService; 404 not 403) ------------
  private async assertTeacherOfClass(tx: TenantTx, p: Principal, classId: string | null) {
    if (!classId) throw new NotFoundException("Race not found");
    const cls = await tx.class.findFirst({ where: { id: classId }, select: { id: true } });
    if (!cls) throw new NotFoundException("Class not found");
    if (this.isSchoolWide(p)) return;
    const teaches = await tx.classTeacher.findFirst({
      where: { classId, teacherId: p.userId },
      select: { id: true },
    });
    if (!teaches) throw new NotFoundException("Class not found");
  }

  private async assertEnrolled(tx: TenantTx, p: Principal, classId: string | null) {
    if (!classId) throw new NotFoundException("Race not found");
    if (this.isSchoolWide(p)) return;
    const enrolled = await tx.enrollment.findFirst({
      where: { classId, studentId: p.userId },
      select: { id: true },
    });
    if (!enrolled) throw new NotFoundException("Race not found");
  }

  private async assertCanViewRace(
    tx: TenantTx,
    p: Principal,
    race: { id: string; classId: string | null },
  ) {
    if (this.isSchoolWide(p)) return;
    // A participant can always see their own race.
    const seat = await tx.gamePlayer.findFirst({ where: { gameId: race.id, userId: p.userId } });
    if (seat) return;
    if (race.classId) {
      const teaches = await tx.classTeacher.findFirst({
        where: { classId: race.classId, teacherId: p.userId },
        select: { id: true },
      });
      if (teaches) return;
      const enrolled = await tx.enrollment.findFirst({
        where: { classId: race.classId, studentId: p.userId },
        select: { id: true },
      });
      if (enrolled) return;
    }
    throw new NotFoundException("Race not found");
  }

  private async requireRace(tx: TenantTx, raceId: string) {
    const race = await tx.game.findFirst({ where: { id: raceId, mode: "RACE" } });
    if (!race) throw new NotFoundException("Race not found");
    return race;
  }

  private async requireParticipant(tx: TenantTx, raceId: string, userId: string) {
    const me = await tx.gamePlayer.findFirst({ where: { gameId: raceId, userId } });
    if (!me) throw new NotFoundException("Race not found"); // relationship scope, not 403
    return me;
  }

  private async requireTournament(tx: TenantTx, id: string) {
    const comp = await tx.competition.findFirst({ where: { id, type: "RACE_TOURNAMENT" } });
    if (!comp) throw new NotFoundException("Tournament not found");
    return comp;
  }

  private async displayName(tx: TenantTx, userId: string): Promise<string> {
    const u = await tx.user.findFirst({ where: { id: userId }, select: { name: true } });
    return u?.name ?? "Player";
  }

  /** Build the viewer-redacted race view. SECURITY: target never exposed; only
   *  the viewer's OWN guesses are returned; the leaderboard is finishers only. */
  private async buildRaceView(tx: TenantTx, raceId: string, viewerUserId: string): Promise<RaceDto> {
    const race = await this.requireRace(tx, raceId);
    const players = await tx.gamePlayer.findMany({ where: { gameId: raceId } });
    const results = await tx.gameResult.findMany({ where: { gameId: raceId }, orderBy: { rank: "asc" } });
    const me = players.find((pl) => pl.userId === viewerUserId) ?? null;

    let yourGuesses: RaceGuessDto[] = [];
    if (me) {
      const gs = await tx.guess.findMany({
        where: { gameId: raceId, guesserId: me.id },
        orderBy: { createdAt: "asc" },
      });
      yourGuesses = gs.map((g) => ({ value: g.value, dead: g.dead, wounded: g.wounded, createdAt: g.createdAt }));
    }
    const mine = results.find((r) => r.userId === viewerUserId);
    const yourFinish = mine
      ? { rank: mine.rank, guessCount: mine.guessCount, elapsedMs: mine.elapsedMs ?? 0 }
      : null;

    const leaderboard: RaceFinisherDto[] = [];
    for (const r of results) {
      leaderboard.push({
        userId: r.userId,
        displayName: await this.displayName(tx, r.userId),
        rank: r.rank,
        guessCount: r.guessCount,
        elapsedMs: r.elapsedMs ?? 0,
      });
    }
    const winnerUserId = results.find((r) => r.rank === 1)?.userId ?? null;

    return {
      id: race.id,
      classId: race.classId,
      difficultyLength: race.difficultyLength,
      status: race.status as RaceDto["status"],
      startedAt: race.startedAt,
      finishedAt: race.finishedAt,
      participantCount: players.length,
      you: me?.id ?? null,
      yourGuesses,
      yourFinish,
      leaderboard,
      winnerUserId,
      tournamentId: race.competitionId,
    };
  }

  private async buildTournamentView(tx: TenantTx, competitionId: string): Promise<RaceTournamentDto> {
    const comp = await this.requireTournament(tx, competitionId);
    const races = await tx.game.findMany({
      where: { competitionId },
      orderBy: { createdAt: "asc" },
    });

    const perClass: RaceTournamentDto["perClass"] = [];
    const allFinishes: RaceFinish[] = [];
    const classByUser = new Map<string, string>(); // userId → classRaceId (one each)
    for (const race of races) {
      const results = await tx.gameResult.findMany({ where: { gameId: race.id } });
      const finishes: RaceFinish[] = results.map((r) => ({
        userId: r.userId,
        guessCount: r.guessCount,
        elapsedMs: r.elapsedMs ?? 0,
      }));
      const ranked = computeRaceStandings(finishes);
      const standings: RaceStandingDto[] = [];
      for (const row of ranked) {
        standings.push({
          userId: row.userId,
          displayName: await this.displayName(tx, row.userId),
          classRaceId: race.id,
          guessCount: row.guessCount,
          elapsedMs: row.elapsedMs,
          rank: row.rank,
        });
      }
      perClass.push({ classRaceId: race.id, classId: race.classId, standings });
      for (const f of finishes) {
        allFinishes.push(f);
        classByUser.set(f.userId, race.id);
      }
    }

    const combinedRanked = computeRaceStandings(allFinishes);
    const combined: RaceStandingDto[] = [];
    for (const row of combinedRanked) {
      combined.push({
        userId: row.userId,
        displayName: await this.displayName(tx, row.userId),
        classRaceId: classByUser.get(row.userId) ?? "",
        guessCount: row.guessCount,
        elapsedMs: row.elapsedMs,
        rank: row.rank,
      });
    }

    return {
      id: comp.id,
      name: comp.name,
      difficultyLength: comp.difficultyLength,
      status: comp.status as RaceTournamentDto["status"],
      startAt: comp.startAt,
      endAt: comp.endAt,
      classRaceIds: races.map((r) => r.id),
      combined,
      perClass,
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
      { actorId: p.userId, action, entity: "race", entityId, schoolId: p.schoolId, metadata },
      tx,
    );
  }
}
