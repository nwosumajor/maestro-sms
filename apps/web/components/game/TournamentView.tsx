"use client";

// =============================================================================
// TournamentView — the combined board, and the per-class boards behind it
// =============================================================================
// Live over the same watch socket the other game screens use, with the REST poll
// as a fallback, so a hall full of people looking at a projector see the same
// thing at the same time.
//
// The COMBINED board leads because that is the question a tournament asks. The
// per-class boards stay underneath because they are the answer to the question
// each class actually cares about — and because a pupil who came third overall
// may have won their own class.
// =============================================================================

import type { RaceStandingDto, RaceTournamentDto, Serialized } from "@sms/types";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LiveDot, useLiveGame } from "./play-ui";

type T = Serialized<RaceTournamentDto>;

/** Guess count decides it; elapsed time only breaks a tie. Shown in that order
 *  so the board explains its own ranking without a legend. */
function Standings({ rows, empty }: { rows: Serialized<RaceStandingDto>[]; empty: string }) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <ol className="divide-y divide-border/70">
      {rows.map((s) => (
        <li key={`${s.classRaceId}-${s.userId}`} className="flex items-center justify-between gap-2 py-1.5 text-sm">
          <span className="flex min-w-0 items-center gap-2">
            <span className="w-6 shrink-0 text-right font-semibold tabular-nums text-muted-foreground">{s.rank}</span>
            <span className="truncate">{s.displayName}</span>
          </span>
          <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
            {s.guessCount} {s.guessCount === 1 ? "guess" : "guesses"} · {(s.elapsedMs / 1000).toFixed(1)}s
          </span>
        </li>
      ))}
    </ol>
  );
}

export function TournamentView({ initial, classNames }: { initial: T; classNames: Record<string, string> }) {
  // Positional signature: (gameId, restPath, initial, opts). Mode "race" so the
  // watch socket re-reads through the race service, exactly as the class-race
  // screen does — the tournament IS a set of races.
  const { data: t, live } = useLiveGame<T>(initial.id, `race-tournaments/${initial.id}`, initial, { mode: "race" });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base">{t.name}</CardTitle>
            <CardDescription>
              {t.perClass.length} classes · {t.difficultyLength} digits · each class races its own secret number
            </CardDescription>
          </div>
          <span className="flex items-center gap-2">
            <Badge variant={t.status === "ACTIVE" ? "secondary" : "outline"}>{t.status.toLowerCase()}</Badge>
            <LiveDot live={live} />
          </span>
        </CardHeader>
        <CardContent>
          <Standings rows={t.combined} empty="Nobody has finished yet." />
        </CardContent>
      </Card>

      <div className="grid gap-3 md:grid-cols-2">
        {t.perClass.map((c) => (
          <Card key={c.classRaceId}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">
                {(c.classId && classNames[c.classId]) || "Class"}
              </CardTitle>
              <CardDescription>
                <Link href={`/games/race/${c.classRaceId}`} className="hover:underline">
                  Open this class&rsquo;s race →
                </Link>
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Standings rows={c.standings} empty="No finishers yet." />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
