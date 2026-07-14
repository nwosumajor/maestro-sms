// =============================================================================
// TypingRaceService — classroom typing game (SMS integration)
// =============================================================================
// A teacher HOSTS a typing race for a class around a passage; enrolled students
// type it in PARALLEL and are ranked by net WPM (speed adjusted for accuracy),
// then accuracy, then finish time. Scoring runs in the pure engine
// (@sms/game-engine typing.ts) — the client sends its typed text, the SERVER
// measures elapsed from the synchronized race start and computes the metrics
// (clients never self-report WPM).
//
// Security posture (standard built-module pattern):
//   - Tenant isolation: schoolId from the JWT on every row; RLS backstops.
//   - Relationship scoping: host = teacher of the class (or school-wide staff);
//     racers = ENROLLED students; a viewer only sees races they host/teach/are
//     enrolled in/joined. 404-not-403.
//   - Server authority: WPM/accuracy/finish are computed here from (passage,
//     typed, server-elapsed). The passage is shown (players type it) so it is not
//     a secret — no redaction needed.
//   - Every mutation is audit-logged (Golden Rule #5). No automated consequence
//     (Golden Rule #8): a race yields WPM/fun, not a grade.
// =============================================================================

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  TYPING_DIFFICULTY_SPECS,
  computeTypingResult,
  isGameDifficulty,
  rankTypingStandings,
  type GameDifficulty,
  type TypingStanding,
} from "@sms/game-engine";
import type {
  TypingDifficultyDto,
  TypingProgressResultDto,
  TypingRaceDto,
  TypingRaceSummaryDto,
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

/** Built-in passages banded by difficulty (length/punctuation profile). A host
 *  may override with their own passage (e.g. a set text). */
const PASSAGE_BANK: Record<GameDifficulty, string[]> = {
  EASY: [
    "the quick brown fox jumps over the lazy dog while the sun rises slowly over the green hills",
    "a small boat sailed across the calm blue lake as birds flew high above the tall old trees",
  ],
  MEDIUM: [
    "Practice makes perfect: the more you type, the faster and more accurate you become. Keep your eyes on the screen, not the keys!",
    "Reading widely builds a strong vocabulary, and a strong vocabulary makes writing clearer, sharper, and far more persuasive.",
  ],
  HARD: [
    "In 1969, Apollo 11 landed on the Moon; roughly 600 million people watched as Neil Armstrong took humanity's first step onto another world.",
    "Water boils at 100 degrees Celsius at sea level, but at higher altitudes — say 2,500 metres — it boils nearer 91 degrees, which changes cooking times.",
  ],
};

@Injectable()
export class TypingRaceService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly events: GameEventsService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }
  private isSchoolWide(p: Principal): boolean {
    return p.roles.some((r) => SCHOOL_WIDE_ROLES.has(r));
  }

  private async withEmit<T extends { id?: string }>(
    p: Principal,
    id: string | null,
    fn: (tx: TenantTx) => Promise<T>,
  ): Promise<T> {
    const out = await this.db.runAsTenant(this.ctx(p), fn);
    const raceId = id ?? out.id ?? null;
    if (raceId) this.events.emitChanged(raceId);
    return out;
  }

  // --- lifecycle ----------------------------------------------------------
  async openRace(
    p: Principal,
    input: { classId: string; difficulty?: string; passage?: string },
  ): Promise<TypingRaceDto> {
    return this.withEmit(p, null, async (tx) => {
      await this.assertGamesEnabled(tx, p.schoolId);
      await this.assertTeacherOfClass(tx, p, input.classId);
      const difficulty = input.difficulty && isGameDifficulty(input.difficulty) ? input.difficulty : "MEDIUM";
      const passage = (input.passage ?? "").trim() || this.randomPassage(difficulty);
      if (passage.length < 10 || passage.length > 600) {
        throw new BadRequestException("passage must be 10–600 characters");
      }
      const race = await tx.typingRace.create({
        data: { schoolId: p.schoolId, classId: input.classId, hostId: p.userId, difficulty, passage, status: "LOBBY" },
      });
      await this.log(tx, p, "typing.open", race.id, { classId: input.classId, difficulty });
      return this.buildView(tx, race.id, p);
    });
  }

  async joinRace(p: Principal, raceId: string): Promise<TypingRaceDto> {
    return this.withEmit(p, raceId, async (tx) => {
      const race = await this.requireRace(tx, raceId);
      if (race.status === "FINISHED") throw new ConflictException("Race is over");
      await this.assertEnrolled(tx, p, race.classId);
      const existing = await tx.typingRacer.findFirst({ where: { raceId, userId: p.userId } });
      if (!existing) {
        await tx.typingRacer.create({ data: { schoolId: p.schoolId, raceId, userId: p.userId } });
        await this.log(tx, p, "typing.join", raceId);
      }
      return this.buildView(tx, raceId, p);
    });
  }

  async startRace(p: Principal, raceId: string): Promise<TypingRaceDto> {
    return this.withEmit(p, raceId, async (tx) => {
      const race = await this.requireRace(tx, raceId);
      await this.assertHost(tx, p, race);
      if (race.status !== "LOBBY") throw new ConflictException("Race is not in the lobby");
      const count = await tx.typingRacer.count({ where: { raceId } });
      if (count < 1) throw new BadRequestException("no racers have joined");
      await tx.typingRace.update({ where: { id: raceId }, data: { status: "ACTIVE", startedAt: new Date() } });
      await this.log(tx, p, "typing.start", raceId, { racers: count });
      return this.buildView(tx, raceId, p);
    });
  }

  /**
   * Report the caller's typed text so far. Server-authoritative: measures elapsed
   * from the race start, scores via the engine, updates the racer's live metrics,
   * and on completion (whole passage typed correctly) records the finish + rank.
   * Idempotent to call repeatedly as the racer types. Returns only the caller's.
   */
  async progress(p: Principal, raceId: string, typed: string): Promise<TypingProgressResultDto> {
    const result = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const race = await this.requireRace(tx, raceId);
      if (race.status !== "ACTIVE" || !race.startedAt) throw new ConflictException("Race is not in play");
      const me = await tx.typingRacer.findFirst({ where: { raceId, userId: p.userId } });
      if (!me) throw new NotFoundException("Race not found"); // relationship scope
      if (me.finished) {
        return { netWpm: me.netWpm, accuracy: me.accuracy, progress: me.progress, finished: true, rank: me.rank };
      }
      if (typeof typed !== "string" || typed.length > race.passage.length + 40) {
        throw new BadRequestException("typed text is invalid");
      }
      const elapsedMs = Math.max(0, Date.now() - race.startedAt.getTime());
      const r = computeTypingResult(race.passage, typed, elapsedMs);
      const justFinished = r.finished;
      let rank = me.rank;
      if (justFinished) rank = await this.recordFinish(tx, race, p.userId);
      const updated = await tx.typingRacer.update({
        where: { id: me.id },
        data: {
          netWpm: r.netWpm,
          accuracy: r.accuracy,
          progress: r.correctChars,
          elapsedMs,
          ...(justFinished ? { finished: true, finishedAt: new Date(), rank } : {}),
        },
      });
      if (justFinished) {
        await this.log(tx, p, "typing.finish", raceId, { netWpm: r.netWpm, rank });
        await this.maybeFinish(tx, race.id);
      }
      return {
        netWpm: updated.netWpm,
        accuracy: updated.accuracy,
        progress: updated.progress,
        finished: updated.finished,
        rank: updated.rank,
      };
    });
    this.events.emitChanged(raceId);
    return result;
  }

  async endRace(p: Principal, raceId: string): Promise<TypingRaceDto> {
    return this.withEmit(p, raceId, async (tx) => {
      const race = await this.requireRace(tx, raceId);
      await this.assertHost(tx, p, race);
      if (race.status === "FINISHED") throw new ConflictException("Race is already over");
      await this.finish(tx, race.id);
      await this.log(tx, p, "typing.end", raceId);
      return this.buildView(tx, raceId, p);
    });
  }

  // --- reads --------------------------------------------------------------
  async getRace(p: Principal, raceId: string): Promise<TypingRaceDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const race = await this.requireRace(tx, raceId);
      await this.assertCanView(tx, p, race);
      return this.buildView(tx, raceId, p);
    });
  }

  async listRaces(p: Principal): Promise<TypingRaceSummaryDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      let races;
      if (this.isSchoolWide(p)) {
        races = await tx.typingRace.findMany({
          where: { status: { in: ["LOBBY", "ACTIVE"] } },
          orderBy: { createdAt: "desc" },
          take: 50,
        });
      } else {
        const [taught, enrolled, joined] = await Promise.all([
          tx.classTeacher.findMany({ where: { teacherId: p.userId }, select: { classId: true } }),
          tx.enrollment.findMany({ where: { studentId: p.userId }, select: { classId: true } }),
          tx.typingRacer.findMany({ where: { userId: p.userId }, select: { raceId: true } }),
        ]);
        const classIds = [...new Set([...taught.map((t) => t.classId), ...enrolled.map((e) => e.classId)])];
        const raceIds = joined.map((j) => j.raceId);
        races = await tx.typingRace.findMany({
          where: {
            status: { in: ["LOBBY", "ACTIVE"] },
            OR: [{ classId: { in: classIds } }, { id: { in: raceIds } }, { hostId: p.userId }],
          },
          orderBy: { createdAt: "desc" },
          take: 50,
        });
      }
      if (races.length === 0) return [];

      const raceIds = races.map((r) => r.id);
      const classIds = [...new Set(races.map((r) => r.classId))];
      const [counts, mine, classes] = await Promise.all([
        tx.typingRacer.groupBy({ by: ["raceId"], where: { raceId: { in: raceIds } }, _count: { _all: true } }),
        tx.typingRacer.findMany({ where: { raceId: { in: raceIds }, userId: p.userId }, select: { raceId: true } }),
        tx.class.findMany({ where: { id: { in: classIds } }, select: { id: true, name: true } }),
      ]);
      const countByRace = new Map(counts.map((c) => [c.raceId, c._count._all]));
      const joinedSet = new Set(mine.map((m) => m.raceId));
      const nameByClass = new Map(classes.map((c) => [c.id, c.name]));
      return races.map((r) => ({
        id: r.id,
        classId: r.classId,
        className: nameByClass.get(r.classId) ?? null,
        difficulty: r.difficulty as TypingDifficultyDto,
        status: r.status as TypingRaceSummaryDto["status"],
        participantCount: countByRace.get(r.id) ?? 0,
        joined: joinedSet.has(r.id),
        isHost: r.hostId === p.userId,
        createdAt: r.createdAt,
      }));
    });
  }

  // =========================================================================
  // internals
  // =========================================================================
  private randomPassage(difficulty: GameDifficulty): string {
    const bank = PASSAGE_BANK[difficulty];
    return bank[randomInt(0, bank.length)]!;
  }

  /** Assign the next podium rank atomically (row-lock the race like class race). */
  private async recordFinish(tx: TenantTx, race: { id: string }, _userId: string): Promise<number> {
    await tx.$executeRaw`SELECT id FROM "typing_race" WHERE id = ${race.id}::uuid FOR UPDATE`;
    const finishedSoFar = await tx.typingRacer.count({ where: { raceId: race.id, finished: true } });
    return finishedSoFar + 1;
  }

  private async maybeFinish(tx: TenantTx, raceId: string): Promise<void> {
    const racers = await tx.typingRacer.findMany({ where: { raceId }, select: { finished: true } });
    if (racers.length > 0 && racers.every((r) => r.finished)) await this.finish(tx, raceId);
  }

  private async finish(tx: TenantTx, raceId: string): Promise<void> {
    const winner = await tx.typingRacer.findFirst({ where: { raceId, rank: 1 }, select: { userId: true } });
    await tx.typingRace.update({
      where: { id: raceId },
      data: { status: "FINISHED", finishedAt: new Date(), winnerUserId: winner?.userId ?? null },
    });
  }

  // --- scoping (mirror HangmanService; 404 not 403) -----------------------
  private async assertGamesEnabled(tx: TenantTx, schoolId: string): Promise<void> {
    const settings = effectiveGameSettings(await tx.gameSettings.findFirst({ where: { schoolId } }));
    if (!settings.gamesEnabled) throw new ForbiddenException("Games are disabled for your school");
  }

  private async assertTeacherOfClass(tx: TenantTx, p: Principal, classId: string): Promise<void> {
    const cls = await tx.class.findFirst({ where: { id: classId }, select: { id: true } });
    if (!cls) throw new NotFoundException("Class not found");
    if (this.isSchoolWide(p)) return;
    const teaches = await tx.classTeacher.findFirst({ where: { classId, teacherId: p.userId }, select: { id: true } });
    if (!teaches) throw new NotFoundException("Class not found");
  }

  private async assertEnrolled(tx: TenantTx, p: Principal, classId: string): Promise<void> {
    if (this.isSchoolWide(p)) return;
    const enrolled = await tx.enrollment.findFirst({ where: { classId, studentId: p.userId }, select: { id: true } });
    if (!enrolled) throw new NotFoundException("Race not found");
  }

  private async assertHost(tx: TenantTx, p: Principal, race: { hostId: string; classId: string }): Promise<void> {
    if (this.isSchoolWide(p) || race.hostId === p.userId) return;
    const teaches = await tx.classTeacher.findFirst({
      where: { classId: race.classId, teacherId: p.userId },
      select: { id: true },
    });
    if (!teaches) throw new NotFoundException("Race not found");
  }

  private async assertCanView(
    tx: TenantTx,
    p: Principal,
    race: { id: string; hostId: string; classId: string },
  ): Promise<void> {
    if (this.isSchoolWide(p) || race.hostId === p.userId) return;
    const seat = await tx.typingRacer.findFirst({ where: { raceId: race.id, userId: p.userId } });
    if (seat) return;
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
    throw new NotFoundException("Race not found");
  }

  private async requireRace(tx: TenantTx, raceId: string) {
    const race = await tx.typingRace.findFirst({ where: { id: raceId } });
    if (!race) throw new NotFoundException("Race not found");
    return race;
  }

  /** Batch-resolve display names in ONE query (leaderboards are polled often). */
  private async displayNames(tx: TenantTx, userIds: string[]): Promise<Map<string, string>> {
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return new Map();
    const users = await tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
    return new Map(users.map((u) => [u.id, u.name ?? "Player"]));
  }

  private async buildView(tx: TenantTx, raceId: string, p: Principal): Promise<TypingRaceDto> {
    const race = await this.requireRace(tx, raceId);
    const difficulty = (isGameDifficulty(race.difficulty) ? race.difficulty : "MEDIUM") as GameDifficulty;
    const targetWpm = TYPING_DIFFICULTY_SPECS[difficulty].targetWpm;
    const isHost = this.isSchoolWide(p) || race.hostId === p.userId;

    const racers = await tx.typingRacer.findMany({ where: { raceId } });
    const me = racers.find((r) => r.userId === p.userId) ?? null;

    const standings: TypingStanding[] = racers.map((r) => ({
      playerId: r.userId,
      netWpm: r.netWpm,
      accuracy: r.accuracy,
      finished: r.finished,
      elapsedMs: r.elapsedMs,
    }));
    const ranked = rankTypingStandings(standings);
    const names = await this.displayNames(tx, ranked.map((r) => r.playerId));
    const progressByUser = new Map(racers.map((r) => [r.userId, r.progress]));
    const leaderboard = ranked.map((row, i) => ({
      userId: row.playerId,
      displayName: names.get(row.playerId) ?? "Player",
      rank: i + 1,
      netWpm: row.netWpm,
      accuracy: row.accuracy,
      finished: row.finished,
      progress: progressByUser.get(row.playerId) ?? 0,
    }));

    return {
      id: race.id,
      classId: race.classId,
      difficulty: race.difficulty as TypingDifficultyDto,
      status: race.status as TypingRaceDto["status"],
      passage: race.passage,
      targetWpm,
      participantCount: racers.length,
      startedAt: race.startedAt,
      finishedAt: race.finishedAt,
      isHost,
      you: me
        ? {
            racerId: me.id,
            netWpm: me.netWpm,
            accuracy: me.accuracy,
            progress: me.progress,
            finished: me.finished,
            rank: me.rank,
          }
        : null,
      leaderboard,
      winnerUserId: race.winnerUserId,
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
      { actorId: p.userId, action, entity: "typing_race", entityId, schoolId: p.schoolId, metadata },
      tx,
    );
  }
}
