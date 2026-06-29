"use client";

import type { AcademicSessionDto, Serialized } from "@sms/types";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Session = Serialized<AcademicSessionDto>;

export function AcademicCalendar({ sessions }: { sessions: Session[] }) {
  const router = useRouter();
  const [msg, setMsg] = React.useState<string | null>(null);
  const [name, setName] = React.useState("");
  const [term, setTerm] = React.useState<Record<string, { name: string; sequence: string }>>({});

  const send = async (method: "POST" | "PUT", path: string, body?: unknown, ok?: string) => {
    const res = await fetch(`/api/sms${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    setMsg(res.ok ? (ok ?? "Saved.") : `Failed (${res.status}).`);
    if (res.ok) router.refresh();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Academic calendar</CardTitle>
        <CardDescription>
          Define sessions and their terms (e.g. First/Second/Third Term). Marking the current term makes
          &quot;end of third term&quot; a real trigger for promotion and reporting.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          onSubmit={async (e) => { e.preventDefault(); if (name) { await send("POST", "/academic/sessions", { name }, "Session created."); setName(""); } }}
          className="flex flex-wrap items-end gap-2"
        >
          <Input aria-label="Session name" value={name} onChange={(e) => setName(e.target.value)} placeholder="2025/2026" className="w-40" />
          <Button type="submit" size="sm">Add session</Button>
        </form>

        <div className="space-y-3 border-t border-border pt-3">
          {sessions.length === 0 && <p className="text-sm text-muted-foreground">No sessions yet.</p>}
          {sessions.map((s) => {
            const t = term[s.id] ?? { name: "", sequence: "" };
            return (
              <div key={s.id} className="rounded-md border border-border p-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium">
                    {s.name} {s.isCurrent && <Badge variant="secondary">current</Badge>}
                  </p>
                  {!s.isCurrent && (
                    <Button size="sm" variant="ghost" className="h-7" onClick={() => send("PUT", `/academic/sessions/${s.id}/current`, undefined, "Current session set.")}>
                      Set current
                    </Button>
                  )}
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {s.terms.map((tm) => (
                    <button
                      key={tm.id}
                      onClick={() => send("PUT", `/academic/terms/${tm.id}/current`, undefined, "Current term set.")}
                      title="Set current term"
                    >
                      <Badge variant={tm.isCurrent ? "secondary" : "outline"}>{tm.sequence}. {tm.name}{tm.isCurrent ? " ✓" : ""}</Badge>
                    </button>
                  ))}
                </div>
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (t.name && t.sequence) {
                      await send("POST", `/academic/sessions/${s.id}/terms`, { name: t.name, sequence: Number(t.sequence) }, "Term added.");
                      setTerm({ ...term, [s.id]: { name: "", sequence: "" } });
                    }
                  }}
                  className="mt-2 flex flex-wrap items-end gap-2"
                >
                  <Input aria-label="Term name" value={t.name} onChange={(e) => setTerm({ ...term, [s.id]: { ...t, name: e.target.value } })} placeholder="First Term" className="w-36" />
                  <Input aria-label="Sequence" type="number" value={t.sequence} onChange={(e) => setTerm({ ...term, [s.id]: { ...t, sequence: e.target.value } })} placeholder="1" className="w-16" />
                  <Button type="submit" size="sm" variant="outline">Add term</Button>
                </form>
              </div>
            );
          })}
        </div>
        {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
      </CardContent>
    </Card>
  );
}
