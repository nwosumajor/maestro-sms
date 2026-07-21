"use client";

import * as React from "react";
import type { CoverLessonDto, Serialized } from "@sms/types";
import { sendSms, postSms } from "@/components/game/play-ui";
import { personLabel } from "@/lib/people";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { shortDate } from "@/lib/format";

type Cover = Serialized<CoverLessonDto>;

// Teacher cover: lists lessons whose regular teacher is on approved leave in a
// window, and lets a timetable manager assign a reliever (double-book-checked
// server-side). Defaults to the coming two weeks.
export function CoverPanel({ teachers }: { teachers: { id: string; name: string; roles?: string[] }[] }) {
  const today = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const [from, setFrom] = React.useState(iso(today));
  const [to, setTo] = React.useState(iso(new Date(today.getTime() + 14 * 86_400_000)));
  const [rows, setRows] = React.useState<Cover[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const [picks, setPicks] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  const key = (c: Cover) => `${c.timetableEntryId}|${c.date}`;

  const load = React.useCallback(async () => {
    setBusy(true);
    setMsg(null);
    const r = await fetch(`/api/sms/timetable/cover?from=${from}&to=${to}`, { cache: "no-store" });
    setBusy(false);
    setLoaded(true);
    if (r.ok) setRows((await r.json()) as Cover[]);
    else setMsg("Could not load cover list.");
  }, [from, to]);

  const assign = async (c: Cover) => {
    const coveringTeacherId = picks[key(c)];
    if (!coveringTeacherId) return;
    setBusy(true);
    setMsg(null);
    const res = await postSms(`timetable/cover`, { timetableEntryId: c.timetableEntryId, date: c.date, coveringTeacherId });
    setBusy(false);
    if (res.ok) await load();
    else setMsg(res.error ?? "Failed.");
  };

  const remove = async (c: Cover) => {
    if (!c.coverId) return;
    setBusy(true);
    setMsg(null);
    const res = await sendSms("DELETE", `timetable/cover/${c.coverId}`);
    setBusy(false);
    if (res.ok) await load();
    else setMsg(res.error ?? "Failed.");
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Teacher cover</CardTitle>
        <CardDescription>
          Lessons whose teacher is on approved leave in the window. Assign a reliever — the system blocks
          double-booking and notifies them.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <input type="date" className="rounded-md border bg-background p-1.5 text-sm" value={from} onChange={(e) => setFrom(e.target.value)} />
          <span className="text-sm text-muted-foreground">to</span>
          <input type="date" className="rounded-md border bg-background p-1.5 text-sm" value={to} onChange={(e) => setTo(e.target.value)} />
          <Button size="sm" disabled={busy} onClick={load}>
            Find lessons needing cover
          </Button>
        </div>

        {loaded && rows.length === 0 && (
          <p className="text-sm text-muted-foreground">No teachers on leave with lessons in this window.</p>
        )}

        {rows.length > 0 && (
          <table className="w-full text-sm">
            <tbody>
              {rows.map((c) => (
                <tr key={key(c)} className="border-b border-border last:border-0">
                  <td className="py-2">{shortDate(c.date)}</td>
                  <td className="py-2">
                    {c.className} · {c.subject}{" "}
                    <span className="text-muted-foreground">({c.periodName})</span>
                  </td>
                  <td className="py-2 text-muted-foreground">out: {c.absentTeacherName}</td>
                  <td className="py-2 text-right">
                    {c.coveringTeacherId ? (
                      <span className="inline-flex items-center gap-2">
                        <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                          {c.coveringTeacherName}
                        </span>
                        <button className="text-xs text-muted-foreground hover:text-destructive" onClick={() => remove(c)}>
                          remove
                        </button>
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5">
                        <select
                          className="rounded-md border bg-background p-1 text-xs"
                          value={picks[key(c)] ?? ""}
                          onChange={(e) => setPicks((p) => ({ ...p, [key(c)]: e.target.value }))}
                        >
                          <option value="">Assign reliever…</option>
                          {teachers
                            .filter((t) => t.id !== c.absentTeacherId)
                            .map((t) => (
                              <option key={t.id} value={t.id}>
                                {personLabel(t)}
                              </option>
                            ))}
                        </select>
                        <Button size="sm" disabled={busy || !picks[key(c)]} onClick={() => assign(c)}>
                          Assign
                        </Button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {msg && <p className="text-sm text-destructive">{msg}</p>}
      </CardContent>
    </Card>
  );
}
