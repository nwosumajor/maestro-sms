"use client";

// Hub action buttons: create a duel / ring and jump straight into it. The new
// game's id comes back from the API, then we navigate to its play screen.

import type { GameDto, RingDto, Serialized } from "@sms/types";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { postSms } from "./play-ui";

const DIFFICULTIES = [
  { len: 4, label: "Easy · 4 digits" },
  { len: 5, label: "Medium · 5 digits" },
  { len: 6, label: "Hard · 6 digits" },
] as const;

function DifficultySelect({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="h-9 rounded-md border border-input bg-background px-3 text-sm"
      aria-label="Difficulty"
    >
      {DIFFICULTIES.map((d) => (
        <option key={d.len} value={d.len}>
          {d.label}
        </option>
      ))}
    </select>
  );
}

export function StartDuelButton() {
  const router = useRouter();
  const [len, setLen] = React.useState(4);
  const [busy, setBusy] = React.useState(false);
  return (
    <div className="flex items-center gap-2">
      <DifficultySelect value={len} onChange={setLen} />
      <Button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          const r = await postSms<Serialized<GameDto>>("games", { difficultyLength: len });
          if (r.ok && r.data) router.push(`/games/duel/${r.data.id}`);
          else setBusy(false);
        }}
      >
        {busy ? "Creating…" : "Start a duel"}
      </Button>
    </div>
  );
}

export function StartRingButton() {
  const router = useRouter();
  const [len, setLen] = React.useState(4);
  const [busy, setBusy] = React.useState(false);
  return (
    <div className="flex items-center gap-2">
      <DifficultySelect value={len} onChange={setLen} />
      <Button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          const r = await postSms<Serialized<RingDto>>("rings", { difficultyLength: len });
          if (r.ok && r.data) router.push(`/games/ring/${r.data.id}`);
          else setBusy(false);
        }}
      >
        {busy ? "Creating…" : "Start a ring"}
      </Button>
    </div>
  );
}
