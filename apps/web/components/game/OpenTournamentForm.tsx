"use client";

// =============================================================================
// OpenTournamentForm — launch a cross-class race tournament
// =============================================================================
// The mode was built end to end — one race per class, each with its OWN target,
// per-class and combined standings — and had no screen at either end. It sat as
// two unreachable endpoints until someone decided whether to launch it or delete
// it. This is the launch.
//
// Two classes is the minimum enforced here rather than only by the server: a
// "cross-class tournament" with one class is a Class Race with extra steps, and
// letting someone create one produces a board that looks broken.
// =============================================================================

import type { IdNameDto, RaceTournamentDto, Serialized } from "@sms/types";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { postSms } from "./play-ui";

type ClassRow = Serialized<IdNameDto>;

/** Local datetime for an <input type="datetime-local">, offset-corrected. */
function localInput(d: Date): string {
  const off = d.getTimezoneOffset() * 60_000;
  return new Date(d.getTime() - off).toISOString().slice(0, 16);
}

export function OpenTournamentForm({ classes }: { classes: ClassRow[] }) {
  const router = useRouter();
  const [name, setName] = React.useState("");
  const [picked, setPicked] = React.useState<Set<string>>(new Set());
  const [len, setLen] = React.useState(4);
  const now = new Date();
  const [startAt, setStartAt] = React.useState(localInput(now));
  const [endAt, setEndAt] = React.useState(localInput(new Date(now.getTime() + 60 * 60_000)));
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  if (classes.length < 2) {
    return (
      <p className="text-sm text-muted-foreground">
        A tournament needs at least two classes. There {classes.length === 1 ? "is only one" : "are none"} available.
      </p>
    );
  }

  const toggle = (id: string) =>
    setPicked((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  async function open() {
    setBusy(true);
    setMsg(null);
    const res = await postSms<Serialized<RaceTournamentDto>>("race-tournaments", {
      name: name.trim(),
      classIds: [...picked],
      difficultyLength: len,
      // The inputs are local time; the API takes an instant.
      startAt: new Date(startAt).toISOString(),
      endAt: new Date(endAt).toISOString(),
    });
    if (res.ok && res.data) router.push(`/games/tournament/${res.data.id}`);
    else setMsg(res.error ?? "Could not open the tournament.");
    setBusy(false);
  }

  const ready = name.trim().length > 0 && picked.size >= 2 && new Date(endAt) > new Date(startAt);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="tny-name">Tournament name</Label>
          <Input
            id="tny-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Inter-class championship"
            className="h-9 w-56"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="tny-diff">Difficulty</Label>
          <select
            id="tny-diff"
            value={len}
            onChange={(e) => setLen(Number(e.target.value))}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            {[4, 5, 6].map((n) => (
              <option key={n} value={n}>
                {n} digits
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="tny-start">Opens</Label>
          <Input id="tny-start" type="datetime-local" value={startAt} onChange={(e) => setStartAt(e.target.value)} className="h-9" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="tny-end">Closes</Label>
          <Input id="tny-end" type="datetime-local" value={endAt} onChange={(e) => setEndAt(e.target.value)} className="h-9" />
        </div>
      </div>

      <div>
        <Label>Classes ({picked.size} chosen)</Label>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {classes.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => toggle(c.id)}
              aria-pressed={picked.has(c.id)}
              className={`rounded-md border px-2 py-1 text-sm ${
                picked.has(c.id) ? "border-primary bg-primary/10 text-primary" : "border-border"
              }`}
            >
              {c.name}
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">
          Each class races its own secret number, so no class can be helped by another&rsquo;s guesses. Standings are
          ranked on fewest guesses, then fastest — never on who started first.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" disabled={!ready || busy} onClick={() => void open()}>
          {busy ? "Opening…" : "Open tournament"}
        </Button>
        {msg && <span className="text-sm text-destructive">{msg}</span>}
      </div>
    </div>
  );
}
