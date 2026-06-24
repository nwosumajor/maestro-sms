"use client";

// Create a School League or Knockout from a pool of selected students. The
// matches are normal duels played through the duel screen; standings/brackets
// update as they finish. On success we open the competition view.

import type { CompetitionDto, IdNameDto, Serialized } from "@sms/types";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { postSms } from "./play-ui";

type Person = Serialized<IdNameDto>;

function plusDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

export function CreateLeagueForm({ people }: { people: Person[] }) {
  const router = useRouter();
  const [type, setType] = React.useState<"LEAGUE" | "KNOCKOUT">("LEAGUE");
  const [name, setName] = React.useState("");
  const [len, setLen] = React.useState(4);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const canCreate = name.trim().length > 0 && selected.size >= 2 && !busy;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="space-y-1.5">
          <Label htmlFor="lg-type">Format</Label>
          <select
            id="lg-type"
            value={type}
            onChange={(e) => setType(e.target.value as "LEAGUE" | "KNOCKOUT")}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="LEAGUE">League (round-robin)</option>
            <option value="KNOCKOUT">Knockout (bracket)</option>
          </select>
        </div>
        <div className="space-y-1.5 flex-1">
          <Label htmlFor="lg-name">Name</Label>
          <Input id="lg-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Spring Cup" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="lg-diff">Difficulty</Label>
          <select
            id="lg-diff"
            value={len}
            onChange={(e) => setLen(Number(e.target.value))}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value={4}>4</option>
            <option value={5}>5</option>
            <option value={6}>6</option>
          </select>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label>Players ({selected.size} selected, min 2)</Label>
        <div className="max-h-48 overflow-y-auto rounded-md border border-border p-2">
          {people.length === 0 ? (
            <p className="px-1 py-2 text-sm text-muted-foreground">No students available.</p>
          ) : (
            <div className="grid grid-cols-2 gap-1">
              {people.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => toggle(p.id)}
                  className={cn(
                    "rounded px-2 py-1.5 text-left text-sm transition-colors",
                    selected.has(p.id)
                      ? "bg-primary/10 font-medium text-primary"
                      : "text-muted-foreground hover:bg-accent",
                  )}
                >
                  {p.name}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button
          disabled={!canCreate}
          onClick={async () => {
            setBusy(true);
            setMsg(null);
            const r = await postSms<Serialized<CompetitionDto>>("competitions", {
              type,
              name: name.trim(),
              difficultyLength: len,
              startAt: plusDays(0),
              endAt: plusDays(14),
              participantUserIds: [...selected],
            });
            if (r.ok && r.data) router.push(`/games/league/${r.data.id}`);
            else {
              setBusy(false);
              setMsg(r.error ?? `Failed (${r.status}).`);
            }
          }}
        >
          {busy ? "Creating…" : "Create competition"}
        </Button>
        {msg && <p className="text-sm text-destructive">{msg}</p>}
      </div>
    </div>
  );
}
