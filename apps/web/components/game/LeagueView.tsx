"use client";

// League / knockout standings + matches (spec §6). Server-authoritative; this
// view watches the competition over the live /ws/watch bridge (mode "league",
// keyed by the competitionId) with a REST poll fallback. A match resolving in any
// duel nudges the competitionId, so standings + bracket update without a refresh.

import type { CompetitionDetailDto, Serialized } from "@sms/types";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { LiveDot, useLiveGame } from "./play-ui";

type Competition = Serialized<CompetitionDetailDto>;

export function LeagueView({ initial }: { initial: Competition }) {
  const { data: comp, live } = useLiveGame<Competition>(initial.id, `competitions/${initial.id}`, initial, {
    mode: "league",
    // Keep polling even when FINISHED is reachable — a late sweep/cancel can still
    // change it; the socket simply pushes when it does. Stop only when closed out.
    stop: (c) => c.status === "CANCELLED",
  });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Standings</CardTitle>
          <LiveDot live={live} />
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase text-muted-foreground">
                <th className="px-4 py-2 font-medium">#</th>
                <th className="px-4 py-2 font-medium">Player</th>
                <th className="px-4 py-2 font-medium text-right">Pts</th>
                <th className="px-4 py-2 font-medium text-right">W–L</th>
                <th className="px-4 py-2 font-medium text-right">Guesses</th>
              </tr>
            </thead>
            <tbody>
              {comp.standings.map((s) => (
                <tr key={s.userId} className={cn("border-b border-border last:border-0", s.eliminated && "opacity-50")}>
                  <td className="px-4 py-2.5 text-muted-foreground">{s.rank ?? "—"}</td>
                  <td className="px-4 py-2.5 font-medium">
                    {s.displayName}
                    {s.eliminated && <span className="ml-2 text-xs text-destructive">out</span>}
                  </td>
                  <td className="px-4 py-2.5 text-right font-semibold">{s.points}</td>
                  <td className="px-4 py-2.5 text-right text-muted-foreground">
                    {s.wins}–{s.losses}
                  </td>
                  <td className="px-4 py-2.5 text-right text-muted-foreground">{s.totalGuesses}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Matches</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {comp.matches.length === 0 ? (
            <p className="px-4 py-4 text-sm text-muted-foreground">No matches scheduled.</p>
          ) : (
            <ul>
              {comp.matches.map((m) => {
                const [a, b] = m.players;
                return (
                  <li
                    key={m.gameId}
                    className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5 last:border-0"
                  >
                    <span className="text-sm">
                      {m.roundNumber != null && (
                        <span className="mr-2 text-xs text-muted-foreground">R{m.roundNumber}</span>
                      )}
                      <span className={cn(m.winnerUserId === a?.userId && "font-semibold")}>
                        {a?.displayName ?? "—"}
                      </span>{" "}
                      <span className="text-muted-foreground">vs</span>{" "}
                      <span className={cn(m.winnerUserId === b?.userId && "font-semibold")}>
                        {b?.displayName ?? "(bye)"}
                      </span>
                    </span>
                    <div className="flex items-center gap-2">
                      <Badge variant={m.status === "FINISHED" ? "secondary" : m.status === "ACTIVE" ? "default" : "outline"}>
                        {m.status}
                      </Badge>
                      <Link
                        href={`/games/duel/${m.gameId}`}
                        className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
                      >
                        Open
                      </Link>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
