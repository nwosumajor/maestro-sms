"use client";

// Host form: open a typing race for one of your classes at a difficulty, with an
// optional custom passage (leave blank for a random one from the bank). Redirects
// into the race to run it.

import type { IdNameDto, Serialized } from "@sms/types";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusLine, postSms } from "./play-ui";

const DIFFICULTIES = ["EASY", "MEDIUM", "HARD"] as const;

export function OpenTypingForm({ classes }: { classes: Serialized<IdNameDto>[] }) {
  const router = useRouter();
  const [classId, setClassId] = React.useState(classes[0]?.id ?? "");
  const [difficulty, setDifficulty] = React.useState<(typeof DIFFICULTIES)[number]>("MEDIUM");
  const [passage, setPassage] = React.useState("");
  const [msg, setMsg] = React.useState<string | null>(null);
  const [err, setErr] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const open = async () => {
    setMsg(null);
    setErr(false);
    if (!classId) {
      setErr(true);
      setMsg("Pick a class.");
      return;
    }
    const p = passage.trim();
    if (p && (p.length < 10 || p.length > 600)) {
      setErr(true);
      setMsg("A custom passage must be 10–600 characters.");
      return;
    }
    setBusy(true);
    const r = await postSms<{ id: string }>("typing-races", { classId, difficulty, ...(p ? { passage: p } : {}) });
    setBusy(false);
    if (!r.ok || !r.data) {
      setErr(true);
      setMsg(r.error ?? `Failed (${r.status}).`);
      return;
    }
    router.push(`/games/typing/${r.data.id}`);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Host a race</CardTitle>
        <CardDescription>
          Open a typing race for a class. Leave the passage blank for a random one, or set your own text.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="ty-class">Class</Label>
            <select
              id="ty-class"
              value={classId}
              onChange={(e) => setClassId(e.target.value)}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            >
              {classes.length === 0 && <option value="">No classes</option>}
              {classes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ty-diff">Difficulty</Label>
            <select
              id="ty-diff"
              value={difficulty}
              onChange={(e) => setDifficulty(e.target.value as (typeof DIFFICULTIES)[number])}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            >
              {DIFFICULTIES.map((d) => (
                <option key={d} value={d}>
                  {d.charAt(0) + d.slice(1).toLowerCase()}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ty-passage">
            Passage <span className="font-normal text-muted-foreground">(optional)</span>
          </Label>
          <textarea
            id="ty-passage"
            value={passage}
            onChange={(e) => setPassage(e.target.value)}
            rows={2}
            placeholder="Leave blank for a random passage…"
            className="w-full rounded-md border border-input bg-background p-2 text-sm outline-none focus:border-primary"
          />
        </div>
        <StatusLine msg={msg} error={err} />
        <Button onClick={open} disabled={busy}>
          {busy ? "Opening…" : "Open race"}
        </Button>
      </CardContent>
    </Card>
  );
}
