"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { OpenGameDto, Serialized } from "@sms/types";
import { Button } from "@/components/ui/button";
import { readApiError } from "@/lib/api-error";

/**
 * Open duels — the ones you can JOIN, and the one you are WAITING on.
 *
 * The list used to be join-only and excluded the caller's own lobby, so a duel
 * you opened appeared on no screen you could see: not on the hub (filtered out),
 * not anywhere else. A duel opened by mistake, or one nobody ever joined, sat in
 * every other pupil's list indefinitely and its host had no way to withdraw it —
 * a create with no undo, on a list that only grows.
 *
 * Your own now appears first, marked as waiting, with a Cancel. Cancelling is
 * allowed only while nobody has joined; once there is an opponent the game is
 * theirs too and ending it is a teacher's call (`game.match.moderate`), which
 * the server enforces and says so in the refusal.
 */
export function OpenDuels({ games, ctaClass }: { games: Serialized<OpenGameDto>[]; ctaClass: string }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);

  const cancel = async (id: string) => {
    setBusy(id);
    setMsg(null);
    const res = await fetch(`/api/sms/games/${id}/cancel`, { method: "POST" });
    setBusy(null);
    if (res.ok) {
      setMsg("Duel withdrawn.");
      router.refresh();
      return;
    }
    // The server's own reason — it distinguishes "already started" from
    // "somebody joined", and both point at the way out.
    setMsg(await readApiError(res));
  };

  // Mine first: it is the row with something to DO on it.
  const ordered = [...games].sort((a, b) => Number(b.mine) - Number(a.mine));

  return (
    <>
      <ul>
        {ordered.map((g) => (
          <li
            key={g.id}
            className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5 last:border-0"
          >
            <span className="min-w-0 text-sm">
              <span className="font-medium">{g.mine ? "Your duel" : g.hostDisplayName}</span>{" "}
              <span className="text-muted-foreground">
                · {g.difficultyLength} digits{g.mine ? " · waiting for an opponent" : ""}
              </span>
            </span>
            {g.mine ? (
              <span className="flex shrink-0 gap-1.5">
                <Link href={`/games/duel/${g.id}`} className={ctaClass}>
                  Open
                </Link>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7"
                  disabled={busy === g.id}
                  onClick={() => cancel(g.id)}
                >
                  {busy === g.id ? "Cancelling…" : "Cancel"}
                </Button>
              </span>
            ) : (
              <Link href={`/games/duel/${g.id}`} className={`${ctaClass} shrink-0`}>
                Join
              </Link>
            )}
          </li>
        ))}
      </ul>
      {msg && <p className="border-t border-border px-4 py-2 text-sm text-muted-foreground">{msg}</p>}
    </>
  );
}
