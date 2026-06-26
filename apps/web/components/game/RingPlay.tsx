"use client";

// Elimination Ring play surface (spec §4, step 6). N players in a ring, each
// targeting the next; a crack eliminates the target and the ring re-closes. One
// guess per turn, 60s (configurable) per turn. The viewer sees only their own
// guesses plus histories inherited from players they eliminated.

import type { RingDto, Serialized } from "@sms/types";
import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { GuessForm, GuessList, LiveDot, StatusLine, digitsValid, postSms, useLiveGame } from "./play-ui";
import { Input } from "@/components/ui/input";

type Ring = Serialized<RingDto>;

export function RingPlay({ initial, canModerate }: { initial: Ring; canModerate: boolean }) {
  const { data: ring, refresh, live } = useLiveGame<Ring>(initial.id, `rings/${initial.id}`, initial, {
    mode: "ring",
    fallbackMs: 2000,
    stop: (r) => r.status === "FINISHED" || r.status === "ABANDONED",
  });
  const [msg, setMsg] = React.useState<string | null>(null);
  const [err, setErr] = React.useState(false);

  const me = ring.players.find((p) => p.playerId === ring.you) ?? null;
  const nameOf = (playerId: string | null) =>
    ring.players.find((p) => p.playerId === playerId)?.displayName ?? "—";

  const act = async (fn: () => ReturnType<typeof postSms>) => {
    setMsg(null);
    setErr(false);
    const r = await fn();
    if (!r.ok) {
      setErr(true);
      setMsg(r.error ?? `Failed (${r.status}).`);
    }
    await refresh();
  };

  const yourTurn = ring.status === "ACTIVE" && ring.currentTurnPlayerId === ring.you;
  const secondsLeft = useCountdown(ring.turnExpiresAt);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Elimination Ring</CardTitle>
          <div className="flex items-center gap-2">
            <LiveDot live={live} />
            <Badge variant={ring.status === "ACTIVE" ? "default" : "secondary"}>{ring.status}</Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Everyone targets the next player. Crack your target to eliminate them — the ring re-closes and
            you inherit their target. Last one standing wins.
          </p>

          {ring.status === "LOBBY" && (
            <div className="flex flex-wrap gap-2">
              {!me && (
                <Button onClick={() => act(() => postSms(`rings/${ring.id}/join`))}>Join ring</Button>
              )}
              {me && (
                <Button onClick={() => act(() => postSms(`rings/${ring.id}/start`))}>Start ring</Button>
              )}
            </div>
          )}

          {ring.status === "SETUP" && (
            <SecretSetup
              length={ring.difficultyLength}
              ready={!!me?.ready}
              onSet={(secret) => act(() => postSms(`rings/${ring.id}/secret`, { secret }))}
            />
          )}

          {ring.status === "ACTIVE" && me && !me.eliminated && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-muted-foreground">Your target:</span>
                <Badge variant="outline">{nameOf(ring.yourTargetPlayerId)}</Badge>
                <span className="text-muted-foreground">· Turn:</span>
                <Badge variant={yourTurn ? "default" : "secondary"}>
                  {nameOf(ring.currentTurnPlayerId)}
                  {yourTurn ? " (you)" : ""}
                </Badge>
                {ring.turnExpiresAt && (
                  <span className={cn("font-mono", secondsLeft <= 15 && "text-destructive")}>
                    {secondsLeft}s
                  </span>
                )}
              </div>
              {yourTurn ? (
                <GuessForm
                  length={ring.difficultyLength}
                  onSubmit={(value) => act(() => postSms(`rings/${ring.id}/guess`, { value }))}
                />
              ) : (
                <p className="text-sm text-muted-foreground">Waiting for the current player&apos;s move…</p>
              )}
            </div>
          )}

          {ring.status === "ACTIVE" && me?.eliminated && (
            <p className="text-sm text-muted-foreground">
              You were eliminated (placed #{me.rank ?? "—"}). Watch how it plays out below.
            </p>
          )}

          {ring.status === "FINISHED" && (
            <div className={cn("rounded-md border p-4", ring.winnerPlayerId === ring.you ? "border-primary/40 bg-primary/5" : "border-border")}>
              <p className="text-lg font-semibold">
                {ring.winnerPlayerId === ring.you ? "🏆 You are the last standing!" : `${nameOf(ring.winnerPlayerId)} wins`}
              </p>
            </div>
          )}

          <StatusLine msg={msg} error={err} />

          {canModerate && ring.status === "ACTIVE" && (
            <Button variant="outline" size="sm" onClick={() => act(() => postSms(`rings/${ring.id}/end`))}>
              Force-end (moderator)
            </Button>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Players</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <tbody>
              {ring.players.map((p) => (
                <tr key={p.playerId} className="border-b border-border last:border-0">
                  <td className="px-4 py-2.5 font-medium">
                    {p.displayName}
                    {p.playerId === ring.you && <span className="ml-1 text-xs text-primary">(you)</span>}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">{p.guessCount} guesses</td>
                  <td className="px-4 py-2.5 text-right">
                    {p.eliminated ? (
                      <Badge variant="destructive">Out · #{p.rank ?? "—"}</Badge>
                    ) : (
                      <Badge variant="secondary">In play</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your guesses</CardTitle>
        </CardHeader>
        <CardContent>
          <GuessList guesses={ring.yourGuesses} />
        </CardContent>
      </Card>

      {ring.inheritedHistories.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Inherited intel</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Guess history from players you eliminated — your reward for the crack.
            </p>
            {ring.inheritedHistories.map((h) => (
              <div key={h.fromPlayerId} className="space-y-2">
                <p className="text-sm font-medium">From {h.fromDisplayName}</p>
                <GuessList guesses={h.guesses} emptyLabel="They made no guesses." />
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function useCountdown(expiresAt: string | null): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!expiresAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [expiresAt]);
  if (!expiresAt) return 0;
  return Math.max(0, Math.round((new Date(expiresAt).getTime() - now) / 1000));
}

function SecretSetup({
  length,
  ready,
  onSet,
}: {
  length: number;
  ready: boolean;
  onSet: (secret: string) => Promise<void> | void;
}) {
  const [secret, setSecret] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const valid = digitsValid(secret, length);
  if (ready) return <p className="text-sm text-muted-foreground">Secret locked in. Waiting for the others…</p>;
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">Choose your secret ({length} distinct digits)</p>
      <div className="flex items-center gap-2">
        <Input
          inputMode="numeric"
          autoComplete="off"
          maxLength={length}
          value={secret}
          onChange={(e) => setSecret(e.target.value.replace(/[^0-9]/g, "").slice(0, length))}
          className="w-44 font-mono tracking-[0.3em]"
          placeholder={`${length} digits`}
          aria-label="Your secret"
        />
        <Button
          disabled={!valid || busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onSet(secret);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "…" : "Lock in"}
        </Button>
      </div>
    </div>
  );
}
