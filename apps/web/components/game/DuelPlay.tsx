"use client";

// 2-player duel play surface (spec §3). Lobby → set secrets → turn-based guessing
// → result. Server-authoritative throughout; this view watches over the live
// /ws/watch push bridge (with a REST poll fallback) and posts moves.

import type { GameDto, Serialized } from "@sms/types";
import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { GuessForm, LiveDot, ResultBanner, ScorePips, StatusLine, digitsValid, postSms, useCelebratable, useLiveGame } from "./play-ui";
import { Input } from "@/components/ui/input";

type Game = Serialized<GameDto>;

export function DuelPlay({
  initial,
  canPlay = true,
  canModerate = false,
}: {
  initial: Game;
  /** Staff overseers (moderate without game.play) get no join affordance. */
  canPlay?: boolean;
  canModerate?: boolean;
}) {
  const { data: game, refresh, live } = useLiveGame<Game>(initial.id, `games/${initial.id}`, initial, {
    stop: (g) => g.status === "FINISHED" || g.status === "ABANDONED",
  });
  const [msg, setMsg] = React.useState<string | null>(null);
  const [err, setErr] = React.useState(false);
  const celebratable = useCelebratable(initial.status === "FINISHED");

  const me = game.players.find((p) => p.playerId === game.you) ?? null;
  const opponent = game.players.find((p) => p.playerId !== game.you) ?? null;
  const nameOf = (playerId: string) =>
    game.players.find((p) => p.playerId === playerId)?.displayName ?? "Player";

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

  const yourTurn = game.status === "ACTIVE" && game.currentTurnPlayerId === game.you;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">
            {me?.displayName ?? "You"} vs {opponent?.displayName ?? "—"}
          </CardTitle>
          <div className="flex items-center gap-2">
            <LiveDot live={live} />
            <StatusBadge status={game.status} />
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Crack your opponent&apos;s secret of {game.difficultyLength} distinct digits.{" "}
            <span className="font-semibold text-destructive">Dead</span> = right digit, right place;{" "}
            <span className="font-semibold text-amber-600">wounded</span> = right digit, wrong place.
          </p>

          {game.status === "LOBBY" && me && (
            <p className="text-sm text-muted-foreground">Waiting for an opponent to join…</p>
          )}

          {game.status === "LOBBY" && !me && canPlay && (
            <Button onClick={() => act(() => postSms(`games/${game.id}/join`))}>Join this duel</Button>
          )}

          {canModerate && game.status !== "FINISHED" && game.status !== "ABANDONED" && (
            <Button variant="outline" size="sm" onClick={() => act(() => postSms(`games/${game.id}/end`))}>
              Force-end (moderator)
            </Button>
          )}

          {game.status === "SETUP" && me && (
            <SecretSetup
              length={game.difficultyLength}
              ready={!!me.ready}
              onSet={(secret) => act(() => postSms(`games/${game.id}/secret`, { secret }))}
            />
          )}

          {game.status === "SETUP" && !me && (
            <p className="text-sm text-muted-foreground">Both players are setting their secrets…</p>
          )}

          {game.status === "ACTIVE" && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">Turn:</span>
                <Badge variant={yourTurn ? "default" : "secondary"}>
                  {game.currentTurnPlayerId ? nameOf(game.currentTurnPlayerId) : "—"}
                  {yourTurn ? " (you)" : ""}
                </Badge>
              </div>
              {yourTurn ? (
                <GuessForm
                  length={game.difficultyLength}
                  onSubmit={(value) => act(() => postSms(`games/${game.id}/guess`, { value }))}
                />
              ) : (
                <p className="text-sm text-muted-foreground">Waiting for the other player&apos;s move…</p>
              )}
            </div>
          )}

          {game.status === "FINISHED" && (
            <ResultBanner
              won={game.winnerPlayerId === game.you}
              celebrate={celebratable}
              title={
                game.winnerPlayerId === game.you
                  ? "You cracked it — you win!"
                  : game.winnerPlayerId
                    ? `${nameOf(game.winnerPlayerId)} won`
                    : "Game over"
              }
              subtitle="The secrets were cleared from the server."
            />
          )}

          {game.status === "ABANDONED" && (
            <p className="text-sm text-muted-foreground">This game was abandoned.</p>
          )}

          <StatusLine msg={msg} error={err} />

          {me && (game.status === "SETUP" || game.status === "ACTIVE") && (
            <div>
              <Button variant="outline" size="sm" onClick={() => act(() => postSms(`games/${game.id}/forfeit`))}>
                Forfeit
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Move log</CardTitle>
        </CardHeader>
        <CardContent>
          {game.guesses.length === 0 ? (
            <p className="text-sm text-muted-foreground">No guesses yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {[...game.guesses].reverse().map((g) => (
                <li
                  key={g.id}
                  className={cn(
                    "flex items-center justify-between rounded-md border border-border px-3 py-1.5",
                    g.guesserId === game.you && "border-primary/40 bg-primary/5",
                  )}
                >
                  <span className="text-sm">
                    <span className="font-medium">{nameOf(g.guesserId)}</span>{" "}
                    <span className="font-mono tracking-[0.25em] text-muted-foreground">{g.value}</span>
                  </span>
                  <ScorePips dead={g.dead} wounded={g.wounded} />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
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
  if (ready) {
    return <p className="text-sm text-muted-foreground">Secret locked in. Waiting for your opponent…</p>;
  }
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
      <p className="text-xs text-muted-foreground">Your opponent never sees this — the server keeps it.</p>
    </div>
  );
}

function StatusBadge({ status }: { status: Game["status"] }) {
  const variant: Record<Game["status"], "default" | "secondary" | "destructive" | "outline"> = {
    LOBBY: "outline",
    SETUP: "secondary",
    ACTIVE: "default",
    FINISHED: "secondary",
    ABANDONED: "destructive",
  };
  return <Badge variant={variant[status]}>{status}</Badge>;
}
