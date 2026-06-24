"use client";

// Teacher opens a Class Race for one of their classes around a single shared
// server-chosen target. On success we jump into the race screen.

import type { IdNameDto, RaceDto, Serialized } from "@sms/types";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { postSms } from "./play-ui";

type ClassRow = Serialized<IdNameDto>;

export function OpenRaceForm({ classes }: { classes: ClassRow[] }) {
  const router = useRouter();
  const [classId, setClassId] = React.useState(classes[0]?.id ?? "");
  const [len, setLen] = React.useState(4);
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  if (classes.length === 0) {
    return <p className="text-sm text-muted-foreground">You have no classes to open a race for.</p>;
  }

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
      <div className="space-y-1.5">
        <Label htmlFor="race-class">Class</Label>
        <select
          id="race-class"
          value={classId}
          onChange={(e) => setClassId(e.target.value)}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
        >
          {classes.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="race-diff">Difficulty</Label>
        <select
          id="race-diff"
          value={len}
          onChange={(e) => setLen(Number(e.target.value))}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
        >
          <option value={4}>Easy · 4</option>
          <option value={5}>Medium · 5</option>
          <option value={6}>Hard · 6</option>
        </select>
      </div>
      <Button
        disabled={busy || !classId}
        onClick={async () => {
          setBusy(true);
          setMsg(null);
          const r = await postSms<Serialized<RaceDto>>("races", { classId, difficultyLength: len });
          if (r.ok && r.data) router.push(`/games/race/${r.data.id}`);
          else {
            setBusy(false);
            setMsg(r.error ?? `Failed (${r.status}).`);
          }
        }}
      >
        {busy ? "Opening…" : "Open race"}
      </Button>
      {msg && <p className="text-sm text-destructive">{msg}</p>}
    </div>
  );
}
