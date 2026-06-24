"use client";

// Ultimate (cross-school) play surface (spec §7, step 8). A student enters under
// a HANDLE (never their real name), guesses their own per-entry target, and
// appears on the pseudonymous cross-school leaderboard. Entry needs both consent
// tiers + the school's cross-school posture — all enforced server-side; failures
// surface here as a message.

import type {
  Serialized,
  UltimateCompetitionDto,
  UltimateEntryDto,
  UltimateLeaderboardDto,
} from "@sms/types";
import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { GuessForm, ScorePips, StatusLine, postSms, usePolled } from "./play-ui";

type Comp = Serialized<UltimateCompetitionDto>;
type Entry = Serialized<UltimateEntryDto>;
type Board = Serialized<UltimateLeaderboardDto>;

export function UltimatePlay({
  comp,
  initialEntry,
  initialBoard,
  canEnter,
}: {
  comp: Comp;
  initialEntry: Entry | null;
  initialBoard: Board;
  canEnter: boolean;
}) {
  const { data: board, refresh: refreshBoard } = usePolled<Board>(
    `ultimate/competitions/${comp.id}/leaderboard`,
    initialBoard,
    { intervalMs: 4000, stop: () => comp.status !== "ACTIVE" },
  );
  const [entry, setEntry] = React.useState<Entry | null>(initialEntry);
  const [handle, setHandle] = React.useState("");
  const [last, setLast] = React.useState<{ dead: number; wounded: number } | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [err, setErr] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const refreshEntry = async () => {
    const res = await fetch(`/api/sms/ultimate/competitions/${comp.id}/me`, { cache: "no-store" });
    if (res.ok) setEntry((await res.json()) as Entry);
  };

  const enter = async () => {
    setBusy(true);
    setMsg(null);
    setErr(false);
    const r = await postSms<Entry>(`ultimate/competitions/${comp.id}/enter`, { handle });
    setBusy(false);
    if (!r.ok) {
      setErr(true);
      setMsg(r.error ?? `Could not enter (${r.status}).`);
      return;
    }
    setEntry(r.data);
    await refreshBoard();
  };

  const guess = async (value: string) => {
    setMsg(null);
    setErr(false);
    const r = await postSms<{ dead: number; wounded: number }>(`ultimate/competitions/${comp.id}/guess`, { value });
    if (!r.ok) {
      setErr(true);
      setMsg(r.error ?? `Failed (${r.status}).`);
      return;
    }
    if (r.data) setLast(r.data);
    await Promise.all([refreshEntry(), refreshBoard()]);
  };

  const open = comp.status === "ACTIVE";

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">{comp.name}</CardTitle>
          <Badge variant={open ? "default" : "secondary"}>{comp.status}</Badge>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            A cross-school arena of {comp.difficultyLength}-digit targets. You play under a handle —
            never your real name. Fewest guesses (then fastest) tops the board.
          </p>

          {!comp.schoolEnrolled && (
            <p className="text-sm text-muted-foreground">Your school has not enrolled in this competition yet.</p>
          )}

          {canEnter && open && comp.schoolEnrolled && !entry && (
            <div className="space-y-2">
              <Label htmlFor="ult-handle">Choose a handle</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="ult-handle"
                  value={handle}
                  maxLength={24}
                  placeholder="e.g. ace_99"
                  onChange={(e) => setHandle(e.target.value)}
                  className="w-56"
                />
                <Button onClick={enter} disabled={busy || handle.trim().length < 3}>
                  {busy ? "…" : "Enter"}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                3–24 chars: letters, digits, space, _ or -. Requires guardian consent on file.
              </p>
            </div>
          )}

          {entry && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-muted-foreground">Playing as</span>
                <Badge variant="outline">{entry.handle}</Badge>
                <span className="text-muted-foreground">· {entry.guessCount} guesses</span>
                {entry.status === "FINISHED" && entry.rank && (
                  <Badge variant="default">Finished · rank #{entry.rank}</Badge>
                )}
              </div>
              {open && entry.status === "ACTIVE" && <GuessForm length={comp.difficultyLength} onSubmit={guess} />}
              {last && (
                <p className="text-sm">
                  Last guess: <ScorePips dead={last.dead} wounded={last.wounded} />
                </p>
              )}
            </div>
          )}

          {!canEnter && (
            <p className="text-sm text-muted-foreground">You can view the cross-school leaderboard below.</p>
          )}

          <StatusLine msg={msg} error={err} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Cross-school leaderboard</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {board.rows.length === 0 ? (
            <p className="px-4 py-4 text-sm text-muted-foreground">
              No finishers yet — {board.participantCount} entered.
            </p>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {board.rows.map((r) => (
                  <tr
                    key={`${r.handle}-${r.rank}`}
                    className={cn("border-b border-border last:border-0", r.isYou && "bg-primary/5 font-medium")}
                  >
                    <td className="px-4 py-2.5 w-10 text-muted-foreground">
                      {r.rank <= 3 ? ["🥇", "🥈", "🥉"][r.rank - 1] : `#${r.rank}`}
                    </td>
                    <td className="px-4 py-2.5">
                      {r.handle}
                      {r.isYou && <span className="ml-1 text-xs text-primary">(you)</span>}
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground">{r.schoolName}</td>
                    <td className="px-4 py-2.5 text-right text-muted-foreground">
                      {r.guessCount} · {(r.elapsedMs / 1000).toFixed(1)}s
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
