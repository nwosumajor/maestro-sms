"use client";

// Host form: open a hangman round for one of your classes at a difficulty, with
// an optional custom word (e.g. a spelling-list term); leaving it blank picks a
// random word from the built-in bank. Redirects into the round to run it.

import type { IdNameDto, Serialized } from "@sms/types";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusLine, postSms } from "./play-ui";

const DIFFICULTIES = ["EASY", "MEDIUM", "HARD"] as const;

export function OpenHangmanForm({ classes }: { classes: Serialized<IdNameDto>[] }) {
  const router = useRouter();
  const [classId, setClassId] = React.useState(classes[0]?.id ?? "");
  const [difficulty, setDifficulty] = React.useState<(typeof DIFFICULTIES)[number]>("MEDIUM");
  const [word, setWord] = React.useState("");
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
    if (word && !/^[A-Za-z]+$/.test(word.trim())) {
      setErr(true);
      setMsg("A custom word must be letters only (no spaces or digits).");
      return;
    }
    setBusy(true);
    const r = await postSms<{ id: string }>("hangman", {
      classId,
      difficulty,
      ...(word.trim() ? { word: word.trim() } : {}),
    });
    setBusy(false);
    if (!r.ok || !r.data) {
      setErr(true);
      setMsg(r.error ?? `Failed (${r.status}).`);
      return;
    }
    router.push(`/games/hangman/${r.data.id}`);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Host a round</CardTitle>
        <CardDescription>
          Open a hangman round for a class. Leave the word blank for a random one, or set your own spelling word.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="hm-class">Class</Label>
            <select
              id="hm-class"
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
            <Label htmlFor="hm-diff">Difficulty</Label>
            <select
              id="hm-diff"
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
          <div className="space-y-1.5">
            <Label htmlFor="hm-word">
              Word <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input id="hm-word" value={word} onChange={(e) => setWord(e.target.value)} placeholder="random" className="w-40" />
          </div>
        </div>
        <StatusLine msg={msg} error={err} />
        <Button onClick={open} disabled={busy}>
          {busy ? "Opening…" : "Open round"}
        </Button>
      </CardContent>
    </Card>
  );
}
