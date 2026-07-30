"use client";

import * as React from "react";
import type { ExamAttendanceDto, Serialized } from "@sms/types";
import { postSms } from "@/components/game/play-ui";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

type Register = Serialized<ExamAttendanceDto>;
type Mark = "PRESENT" | "ABSENT";

/**
 * Take a SITTING's register — who actually turned up to this exam.
 *
 * Deliberately not the daily class register: a pupil can be in school and miss one
 * exam, so this never writes that day's attendance. It closes the loop the printed
 * sheet used to leave open, where an invigilator ticked a paper Absent column that
 * never re-entered the system.
 *
 * Unmarked is shown as its own state, never folded into absent — "we have not taken
 * it" and "they did not come" are different problems.
 */
export function SittingRegister({ sittingId, onSaved }: { sittingId: string; onSaved?: () => void }) {
  const [reg, setReg] = React.useState<Register | null>(null);
  const [marks, setMarks] = React.useState<Record<string, Mark>>({});
  const [notes, setNotes] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    const res = await fetch(`/api/sms/exams/${sittingId}/attendance`);
    if (!res.ok) {
      setMsg("Could not load the register.");
      return;
    }
    const data = (await res.json()) as Register;
    setReg(data);
    // Seed from what is already recorded. An UNMARKED row seeds to PRESENT, because
    // the overwhelming majority turn up and marking the exceptions is the fast path
    // — the same convention the daily register already uses.
    setMarks(Object.fromEntries(data.rows.map((r) => [r.studentId, (r.status as Mark) ?? "PRESENT"])));
    setNotes(Object.fromEntries(data.rows.filter((r) => r.note).map((r) => [r.studentId, r.note as string])));
  }, [sittingId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!reg) return;
    setBusy(true);
    setMsg(null);
    const res = await postSms(`exams/${sittingId}/attendance`, {
      entries: reg.rows.map((r) => ({
        studentId: r.studentId,
        status: marks[r.studentId] ?? "PRESENT",
        note: notes[r.studentId]?.trim() || null,
      })),
    });
    setBusy(false);
    if (res.ok) {
      setMsg("Register saved.");
      await load();
      onSaved?.();
    } else setMsg(res.error ?? "Failed.");
  };

  if (!reg) return <p className="text-xs text-muted-foreground">{msg ?? "Loading…"}</p>;
  if (reg.rows.length === 0) {
    return <p className="text-xs text-muted-foreground">Nobody is seated yet — seat the class first, then take its register.</p>;
  }

  const tally = reg.rows.reduce(
    (a, r) => {
      const m = marks[r.studentId] ?? "PRESENT";
      if (m === "PRESENT") a.present += 1;
      else a.absent += 1;
      return a;
    },
    { present: 0, absent: 0 },
  );

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Exam register</p>
        <div className="flex items-center gap-1.5 text-xs">
          <span className="rounded bg-emerald-100 px-2 py-0.5 font-medium text-emerald-800 tabular-nums dark:bg-emerald-950 dark:text-emerald-200">
            {tally.present} present
          </span>
          <span className="rounded bg-destructive/15 px-2 py-0.5 font-medium text-destructive tabular-nums">{tally.absent} absent</span>
          {reg.unmarked > 0 && <Badge variant="outline">{reg.unmarked} not yet recorded</Badge>}
        </div>
      </div>

      <div className="max-h-64 overflow-y-auto rounded-md border">
        <table className="w-full text-xs">
          <tbody>
            {reg.rows.map((r) => {
              const m = marks[r.studentId] ?? "PRESENT";
              return (
                <tr key={r.studentId} className="border-b border-border last:border-0">
                  <td className="w-10 px-2 py-1.5 text-muted-foreground tabular-nums">#{r.seatNo}</td>
                  <td className="px-2 py-1.5">
                    <span className="block truncate">{r.studentName}</span>
                    {r.markedByName && (
                      <span className="block text-[11px] text-muted-foreground">
                        recorded {r.status?.toLowerCase()} by {r.markedByName}
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-1.5">
                    <div className="flex gap-1">
                      {(["PRESENT", "ABSENT"] as const).map((st) => (
                        <button
                          key={st}
                          type="button"
                          onClick={() => setMarks((p) => ({ ...p, [r.studentId]: st }))}
                          className={`rounded px-2 py-0.5 ${
                            m === st
                              ? st === "PRESENT"
                                ? "bg-emerald-600 text-white"
                                : "bg-destructive text-destructive-foreground"
                              : "border text-muted-foreground hover:bg-accent"
                          }`}
                        >
                          {st === "PRESENT" ? "P" : "A"}
                        </button>
                      ))}
                    </div>
                  </td>
                  <td className="px-2 py-1.5">
                    {/* Only offered for an absence — a note against a present pupil
                        is noise, and the field invites one. */}
                    {m === "ABSENT" && (
                      <input
                        placeholder="reason (optional)"
                        className="w-full rounded border bg-background px-1.5 py-0.5"
                        value={notes[r.studentId] ?? ""}
                        onChange={(e) => setNotes((p) => ({ ...p, [r.studentId]: e.target.value }))}
                      />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={busy} onClick={save}>
          Save register
        </Button>
        <a className="text-xs text-muted-foreground underline hover:text-foreground" href={`/api/sms/exams/${sittingId}/attendance.pdf`}>
          print sheet
        </a>
        {/* Corrections append rather than overwrite, so the earlier mark stays in the
            record. Saying so here stops staff hesitating to fix a mistake. */}
        <span className="text-[11px] text-muted-foreground">
          Saving again records a correction — the earlier mark is kept in the audit history.
        </span>
      </div>
      {msg && <p className="text-xs text-muted-foreground">{msg}</p>}
    </div>
  );
}
