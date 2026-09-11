"use client";

import * as React from "react";
import { useRegion } from "@/components/shell/RegionProvider";
import { todayIn } from "@/lib/format";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { sendSms } from "@/components/game/play-ui";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import type { RegisterStatusDto, RegisterStatusRowDto, Serialized } from "@sms/types";

type Row = Serialized<RegisterStatusRowDto>;
type Status = Serialized<RegisterStatusDto>;

/**
 * Why the daily reminder is not chasing this day.
 *
 * Wording lives HERE, keyed by the code the API returns — the same split the
 * sweep buttons use. NO_CURRENT_TERM is the one that matters: such a school is
 * never chased, for ever, and until now the only trace was a `skipped` count in
 * an operator console nobody at the school opens.
 */
const REMINDER_OFF: Record<string, string> = {
  NO_CURRENT_TERM:
    "No term is set as current, so teachers are NOT being reminded about missing registers — on any day. Set the current term on the academic calendar to switch the daily reminder on.",
  OUTSIDE_TERM: "This date falls outside the current term, so no reminder is sent for it.",
  HOLIDAY: "This date is a school holiday, so no reminder is sent for it.",
  NON_SCHOOL_DAY: "Weekends are not chased.",
};

/** The class teacher, or a plain statement that there is not one. */
function Teacher({ r }: { r: Row }) {
  if (r.teacherName && r.teacherActive) return <span className="text-muted-foreground">{r.teacherName}</span>;
  // A register with no ACTIVE teacher will never be chased by the daily
  // reminder, and cannot be. Saying so beats an empty column.
  return (
    <span className="text-amber-700 dark:text-amber-500">
      {r.teacherName ? `${r.teacherName} (left)` : "no class teacher"}
    </span>
  );
}

/**
 * Which registers have NOT been taken for a date.
 *
 * This is the question a school asks every morning and previously could not: you
 * had to open each class in turn to find the one that was never taken. A missing
 * register is the failure mode that matters, because an absence nobody recorded is
 * indistinguishable from a pupil who was present — and once the 7-day window
 * closes, fixing it needs a maker-checker amendment.
 *
 * Scoped by the API: a teacher sees their own classes, whole-school staff see all.
 */
export function RegisterBoard({ canConfigure = false }: { canConfigure?: boolean }) {
  // The SCHOOL's day — the UTC one prefills yesterday's or tomorrow's board.
  const { timezone } = useRegion();
  const [date, setDate] = React.useState(() => todayIn(timezone));
  const [rows, setRows] = React.useState<Row[] | null>(null);
  const [status, setStatus] = React.useState<Status | null>(null);
  const [failed, setFailed] = React.useState(false);
  // THE SCHOOL'S OWN REMINDER HOUR. A column nothing can write is a setting
  // nobody has, so the people who may change school-wide configuration get the
  // control here, beside the thing it governs.
  const [hour, setHour] = React.useState<{ hour: number | null; effectiveHour: number } | null>(null);
  const [saving, setSaving] = React.useState<string | null>(null);

  React.useEffect(() => {
    let live = true;
    setRows(null);
    setStatus(null);
    (async () => {
      const res = await fetch(`/api/sms/attendance/registers?date=${date}`);
      if (!live) return;
      // A failed read used to become `[]`, and `[]` drives `missing` and
      // `partial` — so this board reported that NO class was missing a register
      // on the one page whose job is naming the classes that are. A false all
      // clear is the worst answer it can give.
      if (res.ok) {
        const body = (await res.json()) as Status;
        setStatus(body);
        setRows(body.classes);
        setFailed(false);
      } else {
        setFailed(true);
      }
    })();
    return () => {
      live = false;
    };
  }, [date]);

  React.useEffect(() => {
    if (!canConfigure) return;
    void (async () => {
      const res = await fetch("/api/sms/attendance/reminder-hour", { cache: "no-store" });
      if (res.ok) setHour((await res.json()) as { hour: number | null; effectiveHour: number });
    })();
  }, [canConfigure]);

  const saveHour = async (next: number | null) => {
    setSaving(null);
    const res = await sendSms("PUT", "attendance/reminder-hour", { hour: next });
    if (res.ok) {
      setHour({ hour: next, effectiveHour: next ?? 14 });
      setSaving("Saved.");
    } else {
      // The SERVER's reason, with the step-up case as a fallback hint only.
      // sendSms already interprets the server's own message; the hint is only
      // a fallback for a status the server said nothing specific about.
      setSaving(res.error ?? "Changing this needs a recent re-authentication.");
    }
  };

  const missing = (rows ?? []).filter((r) => !r.taken);
  const done = (rows ?? []).filter((r) => r.taken);
  // Nobody to chase: a reminder cannot reach these, whoever presses what.
  const unassigned = (rows ?? []).filter((r) => !r.taken && !r.teacherActive);
  // Taken, but for fewer pupils than are enrolled — a register saved mid-way
  // through, which reads as "done" everywhere else.
  const partial = (rows ?? []).filter((r) => r.taken && r.enrolled > 0 && r.marked < r.enrolled);

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <CardTitle className="text-base">Registers</CardTitle>
            <CardDescription>
              Who has taken their register today and who has not. An unrecorded absence looks the same as a pupil who
              was present, so a gap here is worth chasing before the 7-day correction window closes.
            </CardDescription>
          </div>
          <input aria-label="Register date"
            type="date"
            className="rounded-md border bg-background p-1.5 text-sm"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
      </CardHeader>
      <CardContent>
        {failed ? (
          <p className="text-sm text-destructive">
            Couldn&rsquo;t load the registers for this day. Reload to try again — this does not mean
            every register has been taken.
          </p>
        ) : rows === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No classes to show.</p>
        ) : (
          <div className="space-y-3">
            <p className="text-sm">
              {missing.length === 0 ? (
                <span className="font-medium text-emerald-700 dark:text-emerald-400">
                  All {rows.length} register{rows.length === 1 ? "" : "s"} taken.
                </span>
              ) : (
                <span className="font-medium text-destructive">
                  {missing.length} of {rows.length} not taken.
                </span>
              )}
            </p>

            {/* STILL OUTSTANDING — the class, and the person to ask. */}
            {missing.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Still to take</p>
                <table className="w-full text-sm">
                  <tbody>
                    {missing.map((r) => (
                      <tr key={r.classId} className="border-b border-border/40 last:border-0">
                        <td className="py-1 pr-3 font-medium">{r.className}</td>
                        <td className="py-1 pr-3"><Teacher r={r} /></td>
                        <td className="py-1 pr-3 text-right text-xs text-muted-foreground">{r.enrolled} on roll</td>
                        <td className="py-1 text-right">
                          <Link href={`/classes/${r.classId}`}>
                            <Button size="sm" variant="outline">take →</Button>
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* DONE — the half that says the day is under control. It was a
                count and nothing else, so there was no way to confirm that a
                particular teacher had in fact done theirs. */}
            {done.length > 0 && (
              <details className="rounded-md border border-border/60 bg-muted/20 px-3 py-2">
                <summary className="cursor-pointer text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Taken ({done.length})
                </summary>
                <table className="mt-2 w-full text-sm">
                  <tbody>
                    {done.map((r) => (
                      <tr key={r.classId} className="border-b border-border/40 last:border-0">
                        <td className="py-1 pr-3 font-medium">{r.className}</td>
                        <td className="py-1 pr-3"><Teacher r={r} /></td>
                        <td className="py-1 text-right text-xs text-muted-foreground">
                          {r.marked}/{r.enrolled} marked
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            )}

            {/* THE REMINDER IS OFF, and the board says so. A school with no
                current term is skipped every day and the screen used to look
                exactly like one where everything was under control. */}
            {status && !status.remindersActive && status.remindersOffReason && (
              <p
                className={
                  status.remindersOffReason === "NO_CURRENT_TERM"
                    ? "rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300"
                    : "text-xs text-muted-foreground"
                }
              >
                {REMINDER_OFF[status.remindersOffReason]}
              </p>
            )}

            {/* WHEN the reminder goes out, for the people who may change it. */}
            {canConfigure && hour && (
              <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-2 text-xs text-muted-foreground">
                <span>Teachers are reminded at</span>
                <select
                  aria-label="Reminder hour"
                  className="rounded-md border bg-background p-1"
                  value={hour.hour ?? ""}
                  onChange={(e) => void saveHour(e.target.value === "" ? null : Number(e.target.value))}
                >
                  <option value="">{`${String(14).padStart(2, "0")}:00 (default)`}</option>
                  {Array.from({ length: 24 }, (_, h) => (
                    <option key={h} value={h}>{`${String(h).padStart(2, "0")}:00`}</option>
                  ))}
                </select>
                <span>this school&rsquo;s time.</span>
                {saving && <span className="text-foreground">{saving}</span>}
              </div>
            )}

            {unassigned.length > 0 && (
              <p className="text-xs text-amber-700 dark:text-amber-500">
                {unassigned.length} outstanding {unassigned.length === 1 ? "register has" : "registers have"} no class
                teacher to remind — assign one on the class page, or it will keep being missed.
              </p>
            )}

            {partial.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-muted-foreground">Part-marked:</span>
                {partial.map((r) => (
                  <Badge key={r.classId} variant="outline">
                    {r.className} {r.marked}/{r.enrolled}
                  </Badge>
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
