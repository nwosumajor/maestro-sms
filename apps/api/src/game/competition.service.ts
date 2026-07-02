// =============================================================================
// CompetitionService — SMS League / Knockout (platform spec §6, build step 4)
// =============================================================================
// "Matchmaking + bracket/standings logic layered on top" of the UNCHANGED
// 2-player engine (spec §6). Each competition match is a normal duel Game (mode
// LEAGUE_MATCH / KNOCKOUT_MATCH) that players play through the existing
// GameService endpoints; this service only arranges those matches and tallies
// the results.
//
// Security model (identical to the rest of the SMS):
//   - Tenant isolation: every row carries schoolId from the verified JWT; RLS
//     backstops. A school only ever sees/creates its own competitions. Cross-
//     tenant access -> 404, never 403 (no existence leak).
//   - Relationship scoping: enrolled participants must belong to the caller's
//     school (verified under the tenant tx); principal/school_admin operate only
//     within their own school (RLS).
//   - Server authority (§9): pairings, brackets, byes, advancement, standings and
//     forfeits are ALL computed here via the pure @sms/game-engine functions —
//     never trusted from a client. Difficulty is fixed per competition (§2).
//   - Every mutation is audit-logged (Golden Rule #5 — minors' game telemetry).
//
// The pure, deterministic logic (round-robin, knockout pairing, standings) lives
// in @sms/game-engine/competition and is unit-tested in isolation; this file is
// the tenancy/persistence/audit shell around it.
// =============================================================================

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomInt } from "node:crypto";
import {
  computeLeagueStandings,
  isDifficultyLength,
  pairKnockoutRound,
  roundRobinRounds,
  shuffle,
  type MatchOutcome,
} from "@sms/game-engine";
import type {
  CompetitionDetailDto,
  CompetitionDto,
  CompetitionMatchDto,
  StandingDto,
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
import { GameEventsService } from "./game-events.service";

/** CSPRNG-backed RNG in [0,1) for unguessable round-1 seeding (server authority). */
function cryptoRng(): () => number {
  // randomInt is uniform; divide by the bound to land in [0, 1).
  return () => randomInt(0, 1_000_000) / 1_000_000;
}

export interface CreateCompetitionInput {
  type: "LEAGUE" | "KNOCKOUT";
  name: string;
  difficultyLength?: number;
  startAt: string | Date;
  endAt: string | Date;
  participantUserIds: string[];
}

@Injectable()
export class CompetitionService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    // In-process "game changed" pub/sub — the /ws/watch league gateway re-reads
    // the RLS-scoped standings/bracket on each nudge (§10 live push). Per-match
    // resolution also nudges this competitionId from GameService.
    private readonly events: GameEventsService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  /**
   * Run a competition mutation, then announce the changed competition AFTER the
   * tx commits so a league/knockout watcher (keyed by competitionId) re-reads the
   * persisted standings/bracket. `id` is known up front except for `create`,
   * where it's derived from the result.
   */
  private async withEmit<T extends { id: string }>(
    p: Principal,
    id: string | null,
    fn: (tx: TenantTx) => Promise<T>,
  ): Promise<T> {
    const out = await this.db.runAsTenant(this.ctx(p), fn);
    this.events.emitChanged(id ?? out.id);
    return out;
  }

  // --- create -------------------------------------------------------------
  /** Create a DRAFT league/knockout and seat its participants (standings@0). */
  async create(p: Principal, input: CreateCompetitionInput): Promise<CompetitionDetailDto> {
    if (input.type !== "LEAGUE" && input.type !== "KNOCKOUT") {
      throw new BadRequestException("type must be LEAGUE or KNOCKOUT");
    }
    const name = (input.name ?? "").trim();
    if (!name) throw new BadRequestException("name is required");
    const startAt = new Date(input.startAt);
    const endAt = new Date(input.endAt);
    if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) {
      throw new BadRequestException("startAt/endAt must be valid dates");
    }
    if (endAt <= startAt) throw new BadRequestException("endAt must be after startAt");

    const ids = [...new Set(input.participantUserIds ?? [])];
    if (ids.length < 2) throw new BadRequestException("a competition needs at least 2 participants");

    return this.withEmit(p, null, async (tx) => {
      const settings = await this.settings(tx, p.schoolId);
      if (!settings.gamesEnabled) {
        throw new ForbiddenException("Games are disabled for your school");
      }
      const difficultyLength = input.difficultyLength ?? settings.defaultDifficulty;
      if (!isDifficultyLength(difficultyLength)) {
        throw new BadRequestException("difficultyLength must be 4, 5, or 6");
      }
      // Relationship scope: every participant must be a user in THIS school. RLS
      // already filters the query to the caller's tenant, so a foreign/unknown id
      // simply won't be found → reject rather than silently enrolling no-one.
      const users = await tx.user.findMany({ where: { id: { in: ids } }, select: { id: true } });
      if (users.length !== ids.length) {
        throw new BadRequestException("all participants must be users in your school");
      }

      const comp = await tx.competition.create({
        data: {
          schoolId: p.schoolId,
          type: input.type,
          name,
          difficultyLength,
          status: "DRAFT",
          startAt,
          endAt,
          createdById: p.userId,
        },
      });
      // One insert for all seed standings instead of a create-per-participant loop.
      await tx.standing.createMany({
        data: ids.map((userId) => ({ schoolId: p.schoolId, competitionId: comp.id, userId })),
      });
      await this.log(tx, p, "competition.create", comp.id, {
        type: input.type,
        difficultyLength,
        participants: ids.length,
      });
      return this.buildDetail(tx, comp.id);
    });
  }

  // --- start / generate matches ------------------------------------------
  /** Transition DRAFT → ACTIVE and generate the first round (knockout) or the
   *  whole round-robin schedule (league). */
  async start(p: Principal, competitionId: string): Promise<CompetitionDetailDto> {
    return this.withEmit(p, competitionId, async (tx) => {
      const comp = await this.requireCompetition(tx, competitionId);
      if (comp.status !== "DRAFT") throw new ConflictException("competition is not in DRAFT");
      const standings = await tx.standing.findMany({ where: { competitionId } });
      const participants = standings.map((s) => s.userId);
      if (participants.length < 2) throw new BadRequestException("not enough participants");

      const windowMs = (await this.settings(tx, comp.schoolId)).leagueMatchWindowHours * 3_600_000;
      if (comp.type === "LEAGUE") {
        const rounds = roundRobinRounds(participants);
        for (let r = 0; r < rounds.length; r++) {
          const deadline = new Date(comp.startAt.getTime() + (r + 1) * windowMs);
          for (const [a, b] of rounds[r] ?? []) {
            await this.createMatch(tx, comp, r + 1, a, b, deadline);
          }
        }
        await tx.competition.update({
          where: { id: competitionId },
          data: { status: "ACTIVE", currentRound: rounds.length },
        });
      } else {
        // KNOCKOUT: round-1 random seeding via CSPRNG (server authority).
        const ordered = shuffle(participants, cryptoRng());
        await this.generateKnockoutRound(tx, comp, 1, ordered, []);
        await tx.competition.update({
          where: { id: competitionId },
          data: { status: "ACTIVE", currentRound: 1 },
        });
      }
      await this.log(tx, p, "competition.start", competitionId, { type: comp.type });
      return this.buildDetail(tx, competitionId);
    });
  }

  // --- sweep overdue matches (no-show forfeits, spec §6) ------------------
  /** Forfeit every competition match whose play window has closed unfinished. */
  async sweep(p: Principal, competitionId: string): Promise<CompetitionDetailDto> {
    return this.withEmit(p, competitionId, async (tx) => {
      const comp = await this.requireCompetition(tx, competitionId);
      if (comp.status !== "ACTIVE") throw new ConflictException("competition is not active");
      const now = new Date();
      const overdue = await tx.game.findMany({
        where: {
          competitionId,
          deadlineAt: { lt: now },
          status: { in: ["LOBBY", "SETUP", "ACTIVE"] },
        },
      });
      for (const game of overdue) {
        const players = await tx.gamePlayer.findMany({ where: { gameId: game.id } });
        const showed = players.filter((pl) => pl.secret !== null);
        let winnerPlayerId: string | null;
        if (showed.length === 1) {
          // Exactly one player showed up → the other forfeits (both modes).
          winnerPlayerId = (showed[0] as { id: string }).id;
        } else if (comp.type === "KNOCKOUT") {
          // Both/neither showed: knockout needs a winner → higher standing advances.
          winnerPlayerId = await this.higherStanding(tx, competitionId, players);
        } else {
          // League both-fail → voided match, no winner, no points (spec §6).
          winnerPlayerId = null;
        }
        await this.finishMatchByForfeit(tx, game.id, winnerPlayerId);
        await this.afterMatchFinished(tx, game.id);
        await this.log(tx, p, "game.forfeit.sweep", game.id, { competitionId });
      }
      await this.log(tx, p, "competition.sweep", competitionId, { forfeited: overdue.length });
      return this.buildDetail(tx, competitionId);
    });
  }

  /** Cancel a competition (DRAFT or ACTIVE). No hard-delete — durable record. */
  async cancel(p: Principal, competitionId: string): Promise<CompetitionDetailDto> {
    return this.withEmit(p, competitionId, async (tx) => {
      const comp = await this.requireCompetition(tx, competitionId);
      if (comp.status === "FINISHED" || comp.status === "CANCELLED") {
        throw new ConflictException("competition is already closed");
      }
      await tx.competition.update({ where: { id: competitionId }, data: { status: "CANCELLED" } });
      await this.log(tx, p, "competition.cancel", competitionId);
      return this.buildDetail(tx, competitionId);
    });
  }

  // --- reads --------------------------------------------------------------
  async list(p: Principal): Promise<CompetitionDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const comps = await tx.competition.findMany({ orderBy: { createdAt: "desc" }, take: 100 });
      if (comps.length === 0) return [];
      // One grouped count for all listed competitions instead of a count-per-row loop.
      const counts = await tx.standing.groupBy({
        by: ["competitionId"],
        where: { competitionId: { in: comps.map((c) => c.id) } },
        _count: { _all: true },
      });
      const countByComp = new Map(counts.map((c) => [c.competitionId, c._count._all]));
      return comps.map((c) => this.toSummary(c, countByComp.get(c.id) ?? 0));
    });
  }

  async get(p: Principal, competitionId: string): Promise<CompetitionDetailDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.requireCompetition(tx, competitionId);
      return this.buildDetail(tx, competitionId);
    });
  }

  // =========================================================================
  // Post-match hook — called by GameService.finish when a match resolves.
  // =========================================================================
  /** Reflect a just-finished competition match into standings / brackets. */
  async afterMatchFinished(tx: TenantTx, gameId: string): Promise<void> {
    const game = await tx.game.findFirst({ where: { id: gameId } });
    if (!game?.competitionId) return;
    const comp = await tx.competition.findFirst({ where: { id: game.competitionId } });
    if (!comp || comp.status !== "ACTIVE") return;

    if (comp.type === "LEAGUE") {
      await this.recomputeLeague(tx, comp.id);
    } else {
      await this.advanceKnockout(tx, comp.id, game);
    }
  }

  // --- league standings ---------------------------------------------------
  private async recomputeLeague(tx: TenantTx, competitionId: string): Promise<void> {
    const games = await tx.game.findMany({ where: { competitionId } });
    const finished = games.filter((g) => g.status === "FINISHED" && g.winnerPlayerId);
    // One read for ALL finished matches' results instead of a query per game.
    const allResults = finished.length
      ? await tx.gameResult.findMany({ where: { gameId: { in: finished.map((g) => g.id) } } })
      : [];
    const resultsByGame = new Map<string, typeof allResults>();
    for (const r of allResults) {
      const arr = resultsByGame.get(r.gameId);
      if (arr) arr.push(r);
      else resultsByGame.set(r.gameId, [r]);
    }
    const matches: MatchOutcome[] = [];
    for (const g of finished) {
      const results = resultsByGame.get(g.id) ?? [];
      if (results.length !== 2) continue;
      const [a, b] = results as [(typeof results)[number], (typeof results)[number]];
      const winnerId = results.find((r) => r.outcome === "WON")?.userId ?? a.userId;
      matches.push({
        aId: a.userId,
        bId: b.userId,
        winnerId,
        aGuesses: a.guessCount,
        bGuesses: b.guessCount,
      });
    }
    const standings = await tx.standing.findMany({ where: { competitionId } });
    const rows = computeLeagueStandings(
      standings.map((s) => s.userId),
      matches,
    );
    const byUser = new Map(standings.map((s) => [s.userId, s]));
    for (const row of rows) {
      const existing = byUser.get(row.userId);
      if (!existing) continue;
      await tx.standing.update({
        where: { id: existing.id },
        data: {
          points: row.points,
          wins: row.wins,
          losses: row.losses,
          totalGuesses: row.totalGuesses,
          rank: row.rank,
        },
      });
    }
    // Whole schedule played out (every match finished or voided) → close it.
    const open = games.some((g) => g.status !== "FINISHED" && g.status !== "ABANDONED");
    if (!open) {
      await tx.competition.update({ where: { id: competitionId }, data: { status: "FINISHED" } });
    }
  }

  // --- knockout advancement -----------------------------------------------
  private async advanceKnockout(
    tx: TenantTx,
    competitionId: string,
    finishedGame: { id: string; roundNumber: number | null; winnerPlayerId: string | null },
  ): Promise<void> {
    const r = finishedGame.roundNumber ?? 0;
    // Reflect THIS match into the two players' standings.
    const results = await tx.gameResult.findMany({ where: { gameId: finishedGame.id } });
    for (const res of results) {
      const won = res.outcome === "WON";
      const st = await tx.standing.findFirst({ where: { competitionId, userId: res.userId } });
      if (!st) continue;
      await tx.standing.update({
        where: { id: st.id },
        data: {
          roundNumber: r,
          wins: won ? st.wins + 1 : st.wins,
          losses: won ? st.losses : st.losses + 1,
          eliminated: won ? st.eliminated : true,
        },
      });
    }

    // Has the whole round resolved? (idempotency: only advance once, when
    // currentRound still points at the round that just completed.)
    const comp = await tx.competition.findFirst({ where: { id: competitionId } });
    if (!comp || comp.currentRound !== r) return;
    const roundGames = await tx.game.findMany({ where: { competitionId, roundNumber: r } });
    const stillOpen = roundGames.some((g) => g.status !== "FINISHED" && g.status !== "ABANDONED");
    if (stillOpen) return;

    // Advancers = the winner of every game in the round (bye games carry a winner).
    const advancers: string[] = [];
    for (const g of roundGames) {
      if (!g.winnerPlayerId) continue;
      const pl = await tx.gamePlayer.findFirst({ where: { id: g.winnerPlayerId } });
      if (pl) advancers.push(pl.userId);
    }

    if (advancers.length <= 1) {
      await this.finalizeKnockout(tx, competitionId, advancers[0]);
      return;
    }

    // Seed the next round by current standing (deeper round / more wins first).
    const standings = await tx.standing.findMany({ where: { competitionId } });
    const stByUser = new Map(standings.map((s) => [s.userId, s]));
    const ordered = [...advancers].sort((x, y) => {
      const sx = stByUser.get(x);
      const sy = stByUser.get(y);
      const wx = sx?.wins ?? 0;
      const wy = sy?.wins ?? 0;
      if (wx !== wy) return wy - wx;
      return x < y ? -1 : x > y ? 1 : 0;
    });
    const byeHistory = standings.filter((s) => s.byes > 0).map((s) => s.userId);
    await this.generateKnockoutRound(tx, comp, r + 1, ordered, byeHistory);
    await tx.competition.update({ where: { id: competitionId }, data: { currentRound: r + 1 } });
  }

  /** Final ranking once a champion is known: deepest survivor first. */
  private async finalizeKnockout(
    tx: TenantTx,
    competitionId: string,
    championUserId: string | undefined,
  ): Promise<void> {
    const standings = await tx.standing.findMany({ where: { competitionId } });
    const ranked = [...standings].sort((a, b) => {
      if (a.userId === championUserId) return -1;
      if (b.userId === championUserId) return 1;
      if (a.eliminated !== b.eliminated) return a.eliminated ? 1 : -1; // survivors first
      const ar = a.roundNumber ?? 0;
      const br = b.roundNumber ?? 0;
      if (ar !== br) return br - ar; // deeper round first
      return a.userId < b.userId ? -1 : 1;
    });
    for (let i = 0; i < ranked.length; i++) {
      const s = ranked[i] as (typeof ranked)[number];
      await tx.standing.update({
        where: { id: s.id },
        data: { rank: i + 1, eliminated: s.userId === championUserId ? false : s.eliminated },
      });
    }
    await tx.competition.update({ where: { id: competitionId }, data: { status: "FINISHED" } });
  }

  // --- match construction -------------------------------------------------
  /** Create one 2-player competition match: a SETUP duel with both seats filled. */
  private async createMatch(
    tx: TenantTx,
    comp: { id: string; schoolId: string; type: string; difficultyLength: number },
    round: number,
    aUserId: string,
    bUserId: string,
    deadline: Date,
  ): Promise<void> {
    const mode = comp.type === "LEAGUE" ? "LEAGUE_MATCH" : "KNOCKOUT_MATCH";
    const game = await tx.game.create({
      data: {
        schoolId: comp.schoolId,
        mode,
        difficultyLength: comp.difficultyLength,
        status: "SETUP",
        createdById: aUserId,
        competitionId: comp.id,
        roundNumber: round,
        deadlineAt: deadline,
      },
    });
    await tx.gamePlayer.create({ data: { schoolId: comp.schoolId, gameId: game.id, userId: aUserId } });
    await tx.gamePlayer.create({ data: { schoolId: comp.schoolId, gameId: game.id, userId: bUserId } });
  }

  private async generateKnockoutRound(
    tx: TenantTx,
    comp: { id: string; schoolId: string; type: string; difficultyLength: number },
    round: number,
    ordered: string[],
    byeHistory: string[],
  ): Promise<void> {
    const { pairs, bye } = pairKnockoutRound(ordered, byeHistory);
    const windowMs = (await this.settings(tx, comp.schoolId)).leagueMatchWindowHours * 3_600_000;
    const deadline = new Date(Date.now() + windowMs);
    for (const [a, b] of pairs) {
      await this.createMatch(tx, comp, round, a, b, deadline);
    }
    if (bye) {
      // A bye is a pre-finished single-seat game so advancement is uniform
      // ("winner of every game in the round"); the player advances without play.
      const game = await tx.game.create({
        data: {
          schoolId: comp.schoolId,
          mode: "KNOCKOUT_MATCH",
          difficultyLength: comp.difficultyLength,
          status: "FINISHED",
          createdById: bye,
          competitionId: comp.id,
          roundNumber: round,
          finishedAt: new Date(),
        },
      });
      const player = await tx.gamePlayer.create({
        data: { schoolId: comp.schoolId, gameId: game.id, userId: bye },
      });
      await tx.game.update({ where: { id: game.id }, data: { winnerPlayerId: player.id } });
      await tx.gameResult.create({
        data: {
          schoolId: comp.schoolId,
          gameId: game.id,
          userId: bye,
          rank: 1,
          guessCount: 0,
          outcome: "WON",
        },
      });
      const st = await tx.standing.findFirst({ where: { competitionId: comp.id, userId: bye } });
      if (st) {
        await tx.standing.update({
          where: { id: st.id },
          data: { byes: st.byes + 1, roundNumber: round },
        });
      }
    }
  }

  /** Write the forfeit outcome of an overdue match (mirrors GameService.finish). */
  private async finishMatchByForfeit(
    tx: TenantTx,
    gameId: string,
    winnerPlayerId: string | null,
  ): Promise<void> {
    const players = await tx.gamePlayer.findMany({ where: { gameId } });
    for (const pl of players) {
      const guessCount = await tx.guess.count({ where: { gameId, guesserId: pl.id } });
      const won = pl.id === winnerPlayerId;
      await tx.gameResult.create({
        data: {
          schoolId: pl.schoolId,
          gameId,
          userId: pl.userId,
          rank: won ? 1 : 2,
          guessCount,
          outcome: won ? "WON" : "FORFEIT",
        },
      });
    }
    // Retention: clear secrets once the match is over (§10).
    await tx.gamePlayer.updateMany({ where: { gameId }, data: { secret: null } });
    await tx.game.update({
      where: { id: gameId },
      data: {
        status: winnerPlayerId ? "FINISHED" : "ABANDONED",
        winnerPlayerId,
        currentTurnPlayerId: null,
        finishedAt: new Date(),
      },
    });
  }

  // --- helpers ------------------------------------------------------------
  /** The school's effective game settings (row merged over platform defaults). */
  private async settings(tx: TenantTx, schoolId: string) {
    return effectiveGameSettings(await tx.gameSettings.findFirst({ where: { schoolId } }));
  }

  /** The higher-standing of a match's players (knockout no-show tiebreak). */
  private async higherStanding(
    tx: TenantTx,
    competitionId: string,
    players: Array<{ id: string; userId: string }>,
  ): Promise<string> {
    const standings = await tx.standing.findMany({
      where: { competitionId, userId: { in: players.map((p) => p.userId) } },
    });
    const stByUser = new Map(standings.map((s) => [s.userId, s]));
    const sorted = [...players].sort((a, b) => {
      const sa = stByUser.get(a.userId);
      const sb = stByUser.get(b.userId);
      const ra = sa?.rank ?? Number.MAX_SAFE_INTEGER;
      const rb = sb?.rank ?? Number.MAX_SAFE_INTEGER;
      if (ra !== rb) return ra - rb; // better (lower) rank first
      const wa = sa?.wins ?? 0;
      const wb = sb?.wins ?? 0;
      if (wa !== wb) return wb - wa;
      return a.userId < b.userId ? -1 : 1;
    });
    return (sorted[0] as { id: string }).id;
  }

  private async requireCompetition(tx: TenantTx, competitionId: string) {
    // RLS scopes to the caller's school; a miss → 404, never a cross-tenant leak.
    const comp = await tx.competition.findFirst({ where: { id: competitionId } });
    if (!comp) throw new NotFoundException("Competition not found");
    return comp;
  }

  private async displayName(tx: TenantTx, userId: string): Promise<string> {
    const u = await tx.user.findFirst({ where: { id: userId }, select: { name: true } });
    return u?.name ?? "Player";
  }

  private toSummary(
    c: {
      id: string;
      type: string;
      name: string;
      difficultyLength: number;
      status: string;
      startAt: Date;
      endAt: Date;
      currentRound: number;
      createdAt: Date;
    },
    participantCount: number,
  ): CompetitionDto {
    return {
      id: c.id,
      type: c.type as CompetitionDto["type"],
      name: c.name,
      difficultyLength: c.difficultyLength,
      status: c.status as CompetitionDto["status"],
      startAt: c.startAt,
      endAt: c.endAt,
      currentRound: c.currentRound,
      participantCount,
      createdAt: c.createdAt,
    };
  }

  private async buildDetail(tx: TenantTx, competitionId: string): Promise<CompetitionDetailDto> {
    const comp = await this.requireCompetition(tx, competitionId);
    const standingRows = await tx.standing.findMany({ where: { competitionId } });
    const games = await tx.game.findMany({
      where: { competitionId },
      orderBy: [{ roundNumber: "asc" }, { createdAt: "asc" }],
    });

    const standings: StandingDto[] = [];
    for (const s of standingRows) {
      standings.push({
        userId: s.userId,
        displayName: await this.displayName(tx, s.userId),
        points: s.points,
        wins: s.wins,
        losses: s.losses,
        totalGuesses: s.totalGuesses,
        rank: s.rank,
        roundNumber: s.roundNumber,
        eliminated: s.eliminated,
      });
    }
    standings.sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || b.points - a.points);

    const matches: CompetitionMatchDto[] = [];
    for (const g of games) {
      const gps = await tx.gamePlayer.findMany({
        where: { gameId: g.id },
        orderBy: { joinedAt: "asc" },
      });
      const playerViews = [];
      let winnerUserId: string | null = null;
      for (const gp of gps) {
        const displayName = await this.displayName(tx, gp.userId);
        playerViews.push({ userId: gp.userId, displayName });
        if (g.winnerPlayerId === gp.id) winnerUserId = gp.userId;
      }
      matches.push({
        gameId: g.id,
        roundNumber: g.roundNumber,
        status: g.status as CompetitionMatchDto["status"],
        deadlineAt: g.deadlineAt,
        finishedAt: g.finishedAt,
        players: playerViews,
        winnerUserId,
      });
    }

    const participantCount = standingRows.length;
    return { ...this.toSummary(comp, participantCount), standings, matches };
  }

  private async log(
    tx: TenantTx,
    p: Principal,
    action: string,
    entityId: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record(
      { actorId: p.userId, action, entity: "competition", entityId, schoolId: p.schoolId, metadata },
      tx,
    );
  }
}
