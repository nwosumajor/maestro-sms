"use client";

// Creates a new chess game at a chosen time control (you play white) and jumps
// into it. Difficulty sets the clock: Classical / Rapid / Blitz.

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { postSms } from "./play-ui";

const OPTIONS: Array<[string, string]> = [["EASY", "Classical (15+10)"], ["MEDIUM", "Rapid (5+5)"], ["HARD", "Blitz (3+2)"]];

export function NewChessButton() {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [difficulty, setDifficulty] = React.useState("MEDIUM");
  const create = async () => {
    setBusy(true);
    const r = await postSms<{ id: string }>("chess", { difficulty });
    setBusy(false);
    if (r.ok && r.data) router.push(`/games/chess/${r.data.id}`);
  };
  return (
    <div className="flex items-center gap-2">
      <select
        value={difficulty}
        onChange={(e) => setDifficulty(e.target.value)}
        className="h-9 rounded-md border border-input bg-background px-2 text-sm"
        aria-label="Time control"
      >
        {OPTIONS.map(([v, label]) => (
          <option key={v} value={v}>{label}</option>
        ))}
      </select>
      <Button onClick={create} disabled={busy}>
        {busy ? "Creating…" : "New game"}
      </Button>
    </div>
  );
}
