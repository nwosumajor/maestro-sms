"use client";

// School-wide game settings (game.settings.manage, school_admin). PUT accepts a
// partial; we send the full edited set. The API merges over platform defaults
// and the four game services read these (gamesEnabled gates opening, etc.).

import type { GameSettingsDto, Serialized } from "@sms/types";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { readApiError } from "@/lib/api-error";

type Settings = Serialized<GameSettingsDto>;

export function GameSettingsForm({ initial }: { initial: Settings }) {
  const [s, setS] = React.useState<Settings>(initial);
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => setS((prev) => ({ ...prev, [key]: value }));

  const save = async () => {
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/sms/game-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(s),
    });
    setBusy(false);
    setMsg(res.ok ? "Settings saved." : await readApiError(res));
  };

  return (
    <div className="space-y-4">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={s.gamesEnabled}
          onChange={(e) => set("gamesEnabled", e.target.checked)}
          className="h-4 w-4"
        />
        Games enabled (master switch)
      </label>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="set-diff">Default difficulty</Label>
          <select
            id="set-diff"
            value={s.defaultDifficulty}
            onChange={(e) => set("defaultDifficulty", Number(e.target.value))}
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value={4}>4 digits</option>
            <option value={5}>5 digits</option>
            <option value={6}>6 digits</option>
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="set-rate">Race guess rate-limit (ms)</Label>
          <Input
            id="set-rate"
            type="number"
            value={s.guessRateLimitMs}
            onChange={(e) => set("guessRateLimitMs", Number(e.target.value))}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="set-turn">Ring turn limit (seconds)</Label>
          <Input
            id="set-turn"
            type="number"
            value={s.ringTurnLimitSec}
            onChange={(e) => set("ringTurnLimitSec", Number(e.target.value))}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="set-win">League match window (hours)</Label>
          <Input
            id="set-win"
            type="number"
            value={s.leagueMatchWindowHours}
            onChange={(e) => set("leagueMatchWindowHours", Number(e.target.value))}
          />
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={s.crossSchoolEnabled}
          onChange={(e) => set("crossSchoolEnabled", e.target.checked)}
          className="h-4 w-4"
        />
        Allow cross-school (Ultimate) play
      </label>

      <div className="flex items-center gap-3">
        <Button onClick={save} disabled={busy}>
          {busy ? "Saving…" : "Save settings"}
        </Button>
        {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
      </div>
    </div>
  );
}
