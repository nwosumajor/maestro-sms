"use client";

import type { AcademicSessionDto, SchoolHolidayDto, Serialized } from "@sms/types";
import { TERM_PRESETS } from "@sms/types";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CalendarTimeline } from "./CalendarTimeline";
import { readApiError } from "@/lib/api-error";

type Session = Serialized<AcademicSessionDto>;
type Holiday = Serialized<SchoolHolidayDto>;

export function AcademicCalendar({ sessions, holidays }: { sessions: Session[]; holidays: Holiday[] }) {
  const router = useRouter();
  const [msg, setMsg] = React.useState<string | null>(null);
  const [name, setName] = React.useState("");
  const [sStart, setSStart] = React.useState("");
  const [sEnd, setSEnd] = React.useState("");
  const [term, setTerm] = React.useState<Record<string, { name: string; sequence: string; startDate: string; endDate: string }>>({});
  // Standard 3-term quick-create.
  const [stdName, setStdName] = React.useState("");
  const [stdStart, setStdStart] = React.useState("");

  const [advancing, setAdvancing] = React.useState(false);
  // Holiday form.
  const [hName, setHName] = React.useState("");
  const [hStart, setHStart] = React.useState("");
  const [hEnd, setHEnd] = React.useState("");

  const send = async (method: "POST" | "PUT" | "DELETE", path: string, body?: unknown, ok?: string) => {
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
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => send("POST", "/academic/sync-current", undefined, "Current term synced to today.")}
              title="Set the current term to whichever term's dates contain today"
            >
              Sync to today
            </Button>
            <Button size="sm" onClick={advance} disabled={advancing || !currentTerm}>
              {advancing ? "Advancing…" : "Advance to next term →"}
            </Button>
          </div>
        </div>

        {/* The year as a shape. Placed ABOVE the editors deliberately: the
            question "is my calendar right?" should be answerable before anyone
            scrolls into a column of date fields. */}
        <CalendarTimeline sessions={sessions} />

        {/* Quick-create: a whole standard 3-term session from one date. */}
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (stdName && stdStart) {
              await send("POST", "/academic/sessions/standard", { name: stdName, yearStart: stdStart, makeCurrent: sessions.length === 0 }, "Standard 3-term session created.");
              setStdName(""); setStdStart("");
            }
          }}
          className="flex flex-wrap items-end gap-2 rounded-md border border-dashed border-border p-3"
        >
          <div className="space-y-1">
            <p className="text-xs font-medium">Quick-create a standard 3-term year</p>
            <div className="flex flex-wrap items-end gap-2">
              <Input aria-label="Session name" value={stdName} onChange={(e) => setStdName(e.target.value)} placeholder="2025/2026" className="w-36" />
              <label className="flex items-center gap-1 text-xs text-muted-foreground">
                starts
                <Input aria-label="Year start" type="date" value={stdStart} onChange={(e) => setStdStart(e.target.value)} className="h-9 w-36" />
              </label>
              <Button type="submit" size="sm" disabled={!stdName || !stdStart}>Generate 3 terms</Button>
            </div>
          </div>
        </form>

        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (name) {
              await send("POST", "/academic/sessions", { name, startDate: sStart || null, endDate: sEnd || null }, "Session created.");
              setName(""); setSStart(""); setSEnd("");
            }
          }}
          className="flex flex-wrap items-end gap-2"
        >
          <Input aria-label="Session name" value={name} onChange={(e) => setName(e.target.value)} placeholder="2025/2026" className="w-40" />
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            starts<Input aria-label="Session start" type="date" value={sStart} onChange={(e) => setSStart(e.target.value)} className="h-9 w-36" />
          </label>
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            ends<Input aria-label="Session end" type="date" value={sEnd} onChange={(e) => setSEnd(e.target.value)} className="h-9 w-36" />
          </label>
          <Button type="submit" size="sm">Add session</Button>
        </form>

        <div className="space-y-3 border-t border-border pt-3">
          {sessions.length === 0 && <p className="text-sm text-muted-foreground">No sessions yet.</p>}
          {sessions.map((s) => {
            const t = term[s.id] ?? { name: "", sequence: "", startDate: "", endDate: "" };
            return (
              <div key={s.id} className="rounded-md border border-border p-3">
                {/* The session header was read-only: a session could be created
                    and never corrected, so a mistyped year was permanent and the
                    only way out was a second session competing with the first.
                    Editing sits here, inline, on the same blur-to-save rule the
                    terms below use — one place to change a date, one behaviour. */}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      aria-label={`Name of session ${s.name}`}
                      defaultValue={s.name}
                      onBlur={(e) => {
                        const v = e.target.value.trim();
                        if (v && v !== s.name) void send("PUT", `/academic/sessions/${s.id}`, { name: v }, "Session renamed.");
                      }}
                      className="h-8 w-36 text-sm font-medium"
                    />
                    {s.isCurrent && <Badge variant="secondary">current</Badge>}
                    <label className="flex items-center gap-1 text-xs text-muted-foreground">
                      runs
                      <Input
                        type="date"
                        aria-label={`Start of session ${s.name}`}
                        defaultValue={s.startDate ? String(s.startDate).slice(0, 10) : ""}
                        onBlur={(e) => {
                          const v = e.target.value || null;
                          if (v !== (s.startDate ? String(s.startDate).slice(0, 10) : null))
                            void send("PUT", `/academic/sessions/${s.id}`, { startDate: v }, "Session start saved.");
                        }}
                        className="h-8 w-36"
                      />
                      to
                      <Input
                        type="date"
                        aria-label={`End of session ${s.name}`}
                        defaultValue={s.endDate ? String(s.endDate).slice(0, 10) : ""}
                        onBlur={(e) => {
                          const v = e.target.value || null;
                          if (v !== (s.endDate ? String(s.endDate).slice(0, 10) : null))
                            void send("PUT", `/academic/sessions/${s.id}`, { endDate: v }, "Session end saved.");
                        }}
                        className="h-8 w-36"
                      />
                    </label>
                  </div>
                  {!s.isCurrent && (
                    <div className="flex items-center gap-1">
                      <Button size="sm" variant="ghost" className="h-7" onClick={() => send("PUT", `/academic/sessions/${s.id}/current`, undefined, "Current session set.")}>
                        Set current
                      </Button>
                      {/* Duplicate years are the easiest mistake to make here —
                          quick-create and manual create both exist — and until
                          now there was no way to undo one. The server refuses a
                          session carrying marks, so this cannot lose a year of
                          grades; the confirm says how many terms go with it. */}
                      <button
                        type="button"
                        title={`Remove the ${s.name} session`}
                        onClick={() => {
                          const n = s.terms.length;
                          if (
                            confirm(
                              `Remove the "${s.name}" session${n ? ` and its ${n} term${n === 1 ? "" : "s"}` : ""}? ` +
                                `This is refused if any term has assessments, results or remarks.`,
                            )
                          )
                            void send("DELETE", `/academic/sessions/${s.id}`, undefined, "Session removed.");
                        }}
                        className="rounded px-1.5 text-xs text-muted-foreground hover:text-destructive focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        Remove
                      </button>
                    </div>
                  )}
                </div>
                <div className="mt-2 space-y-1.5">
                  {s.terms.map((tm) => (
                    <div key={tm.id} className="flex flex-wrap items-center gap-2">
                      {/* The most consequential control here was a bare badge
                          that gave no hint it was a button, and no hint that a
                          dateless term will be refused. Both are now stated. */}
                      <button
                        onClick={() => send("PUT", `/academic/terms/${tm.id}/current`, undefined, "Current term set.")}
                        title={
                          tm.isCurrent
                            ? "This is the current term"
                            : tm.startDate && tm.endDate
                              ? `Make "${tm.name}" the current term`
                              : "Set this term's start and end dates first — a term without both cannot be made current"
                        }
                        className="rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <Badge
                          variant={tm.isCurrent ? "secondary" : "outline"}
                          className={tm.isCurrent ? "" : "cursor-pointer hover:border-primary"}
                        >
                          {tm.sequence}. {tm.name}
                          {tm.isCurrent ? " ✓ current" : ""}
                          {!tm.isCurrent && (!tm.startDate || !tm.endDate) ? " · needs dates" : ""}
                        </Badge>
                      </button>
                      {/* Removing a term added by mistake. Offered only for a term
                          that is not current — the server refuses that anyway, and
                          also refuses one carrying marks, so this is a shortcut to
                          the common case rather than the authority on it. */}
                      {!tm.isCurrent && (
                        <button
                          type="button"
                          title={`Remove "${tm.name}"`}
                          onClick={() => {
                            if (confirm(`Remove "${tm.name}"? This is refused if the term has any assessments, results or remarks.`))
                              void send("DELETE", `/academic/terms/${tm.id}`, undefined, "Term removed.");
                          }}
                          className="ml-auto rounded px-1.5 text-xs text-muted-foreground hover:text-destructive focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          Remove
                        </button>
                      )}
                      {/* Start date drives the term-lock boundary AND term-scoped
                          report-card attendance (which needs BOTH dates); end date
                          drives AUTOMATIC advance once it passes. Saved on blur, not
                          on change — a date input reads "" mid-edit, so per-keystroke
                          saves would fire spurious "clear" writes. */}
                      <label className="flex items-center gap-1 text-xs text-muted-foreground">
                        starts
                        <Input
                          type="date"
                          defaultValue={tm.startDate ? String(tm.startDate).slice(0, 10) : ""}
                          onBlur={(e) => {
                            const next = e.target.value || null;
                            const before = tm.startDate ? String(tm.startDate).slice(0, 10) : null;
                            if (next === before) return;
                            send("PUT", `/academic/terms/${tm.id}`, { startDate: next }, `${tm.name} start date saved.`);
                          }}
                          className="h-7 w-36 py-0"
                        />
                      </label>
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
                {(() => {
                  // The term is CHOSEN from the canonical ordinal slots (name +
                  // fixed order) — never a free-typed number — and slots already
                  // used in this session are hidden, so a sequence can't be
                  // negative, duplicated, or out of range.
                  const used = new Set(s.terms.map((tm) => tm.sequence));
                  const available = TERM_PRESETS.filter((p) => !used.has(p.sequence));
                  if (available.length === 0) return <p className="mt-2 text-xs text-muted-foreground">All terms added for this session.</p>;
                  return (
                    <form
                      onSubmit={async (e) => {
                        e.preventDefault();
                        if (t.name && t.sequence) {
                          await send(
                            "POST",
                            `/academic/sessions/${s.id}/terms`,
                            { name: t.name, sequence: Number(t.sequence), startDate: t.startDate || null, endDate: t.endDate || null },
                            "Term added.",
                          );
                          setTerm({ ...term, [s.id]: { name: "", sequence: "", startDate: "", endDate: "" } });
                        }
                      }}
                      className="mt-2 flex flex-wrap items-end gap-2"
                    >
                      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                        Term
                        <select
                          aria-label="Term"
                          value={t.sequence}
                          onChange={(e) => {
                            const seq = e.target.value;
                            const preset = TERM_PRESETS.find((p) => String(p.sequence) === seq);
                            setTerm({ ...term, [s.id]: { ...t, sequence: seq, name: preset?.name ?? "" } });
                          }}
                          className="h-9 w-40 rounded-md border border-input bg-background px-3 text-sm text-foreground"
                        >
                          <option value="">Select a term…</option>
                          {available.map((p) => (
                            <option key={p.sequence} value={p.sequence}>{p.name}</option>
                          ))}
                        </select>
                      </label>
                      <label className="flex items-center gap-1 text-xs text-muted-foreground">
                        starts<Input aria-label="Term start" type="date" value={t.startDate} onChange={(e) => setTerm({ ...term, [s.id]: { ...t, startDate: e.target.value } })} className="h-9 w-36" />
                      </label>
                      <label className="flex items-center gap-1 text-xs text-muted-foreground">
                        ends<Input aria-label="Term end" type="date" value={t.endDate} onChange={(e) => setTerm({ ...term, [s.id]: { ...t, endDate: e.target.value } })} className="h-9 w-36" />
                      </label>
                      <Button type="submit" size="sm" variant="outline" disabled={!t.sequence}>Add term</Button>
                    </form>
                  );
                })()}
              </div>
            );
          })}
        </div>

        {/* Holidays / non-teaching days. These block register-taking on the day
            and appear on the shared calendar for everyone. */}
        <div className="space-y-2 border-t border-border pt-3">
          <p className="text-sm font-medium">Holidays &amp; non-teaching days</p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (hName && hStart) {
                await send("POST", "/academic/holidays", { name: hName, startDate: hStart, endDate: hEnd || hStart }, "Holiday added.");
                setHName(""); setHStart(""); setHEnd("");
              }
            }}
            className="flex flex-wrap items-end gap-2"
          >
            <Input aria-label="Holiday name" value={hName} onChange={(e) => setHName(e.target.value)} placeholder="Mid-term break" className="w-40" />
            <label className="flex items-center gap-1 text-xs text-muted-foreground">
              from<Input aria-label="Holiday start" type="date" value={hStart} onChange={(e) => setHStart(e.target.value)} className="h-9 w-36" />
            </label>
            <label className="flex items-center gap-1 text-xs text-muted-foreground">
              to<Input aria-label="Holiday end" type="date" value={hEnd} onChange={(e) => setHEnd(e.target.value)} className="h-9 w-36" />
            </label>
            <Button type="submit" size="sm" variant="outline" disabled={!hName || !hStart}>Add holiday</Button>
          </form>
          {holidays.length === 0 ? (
            <p className="text-xs text-muted-foreground">No holidays set. A single day = leave “to” blank.</p>
          ) : (
            <ul className="space-y-1">
              {holidays.map((h) => (
                <li key={h.id} className="flex items-center justify-between rounded-md border border-border px-2.5 py-1.5 text-sm">
                  <span>
                    <span className="font-medium">{h.name}</span>{" "}
                    <span className="text-xs text-muted-foreground">
                      {String(h.startDate).slice(0, 10)}
                      {String(h.startDate).slice(0, 10) !== String(h.endDate).slice(0, 10) ? ` – ${String(h.endDate).slice(0, 10)}` : ""}
                    </span>
                  </span>
                  <button className="text-xs text-destructive" onClick={() => send("DELETE", `/academic/holidays/${h.id}`, undefined, "Holiday removed.")}>
                    remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
      </CardContent>
    </Card>
  );
}
