"use client";

import type { AcademicSessionDto, Serialized } from "@sms/types";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { readApiError } from "@/lib/api-error";

type Session = Serialized<AcademicSessionDto>;

export function AcademicCalendar({ sessions }: { sessions: Session[] }) {
  const router = useRouter();
  const [msg, setMsg] = React.useState<string | null>(null);
  const [name, setName] = React.useState("");
  const [term, setTerm] = React.useState<Record<string, { name: string; sequence: string }>>({});

  const [advancing, setAdvancing] = React.useState(false);

  const send = async (method: "POST" | "PUT", path: string, body?: unknown, ok?: string) => {
    const res = await fetch(`/api/sms${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    setMsg(res.ok ? (ok ?? "Saved.") : await readApiError(res));
    if (res.ok) router.refresh();
  };

  const currentSession = sessions.find((s) => s.isCurrent);
  const currentTerm = currentSession?.terms.find((t) => t.isCurrent) ?? sessions.flatMap((s) => s.terms).find((t) => t.isCurrent);

  const advance = async () => {
    if (
      !window.confirm(
        "Advance to the next term? This moves the current-term pointer forward (to the next session's first term at year end). Past terms keep all their grades, attendance and report cards.",
      )
    )
      return;
    setAdvancing(true);
    const res = await fetch("/api/sms/academic/advance-term", { method: "POST" });
    setAdvancing(false);
    if (res.ok) {
      const r = (await res.json()) as { termName?: string; sessionName?: string; newSession?: boolean };
      setMsg(
        r.newSession
          ? `New session started — ${r.sessionName ?? ""} · ${r.termName ?? "first term"} is now current.`
          : `Advanced — ${r.termName ?? "next term"} is now the current term.`,
      );
      router.refresh();
    } else {
      setMsg(await readApiError(res));
    }
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
        {/* Current position + one-click advance. The system also auto-advances a
            school whose current term has a past end date (see term end dates). */}
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/40 p-3">
          <p className="text-sm">
            {currentTerm ? (
              <>
                Currently: <span className="font-medium">{currentSession?.name}</span>
                {" · "}
                <span className="font-medium">{currentTerm.name}</span>
              </>
            ) : (
              <span className="text-muted-foreground">No current term set yet.</span>
            )}
          </p>
          <Button size="sm" onClick={advance} disabled={advancing || !currentTerm}>
            {advancing ? "Advancing…" : "Advance to next term →"}
          </Button>
        </div>

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
                <div className="mt-2 space-y-1.5">
                  {s.terms.map((tm) => (
                    <div key={tm.id} className="flex flex-wrap items-center gap-2">
                      <button
                        onClick={() => send("PUT", `/academic/terms/${tm.id}/current`, undefined, "Current term set.")}
                        title="Set current term"
                      >
                        <Badge variant={tm.isCurrent ? "secondary" : "outline"}>{tm.sequence}. {tm.name}{tm.isCurrent ? " ✓" : ""}</Badge>
                      </button>
                      {/* End date drives AUTOMATIC advance: once it passes, the
                          nightly sweep rolls this school to the next term.
                          Saved on blur, not on change — a date input reads ""
                          until it is complete, so saving per keystroke would
                          fire spurious "clear" writes while typing one. */}
                      <label className="flex items-center gap-1 text-xs text-muted-foreground">
                        ends
                        <Input
                          type="date"
                          defaultValue={tm.endDate ? String(tm.endDate).slice(0, 10) : ""}
                          onBlur={(e) => {
                            const next = e.target.value || null;
                            const before = tm.endDate ? String(tm.endDate).slice(0, 10) : null;
                            if (next === before) return; // nothing actually changed
                            send(
                              "PUT",
                              `/academic/terms/${tm.id}`,
                              { endDate: next },
                              next
                                ? `${tm.name} ends ${next} — it will advance automatically after that date.`
                                : `${tm.name} end date cleared — it will only advance manually.`,
                            );
                          }}
                          className="h-7 w-36 py-0"
                        />
                      </label>
                    </div>
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
