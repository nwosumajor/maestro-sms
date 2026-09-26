"use client";

import * as React from "react";
import type { AttendanceCompiledDto, AttendanceGrain, Serialized } from "@sms/types";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { interpretApiError } from "@/lib/api-error";

type Compiled = Serialized<AttendanceCompiledDto>;

const GRAINS: Array<{ key: AttendanceGrain; label: string; help: string }> = [
  { key: "month", label: "By month", help: "How a pattern shows itself — a run of Mondays, a bad half-term." },
  { key: "term", label: "By term", help: "What the school reported, and what the report card states." },
  { key: "session", label: "By session", help: "One year against the one before it." },
];

/**
 * A pupil's attendance compiled for audit.
 *
 * Every figure here is computed on the server. This component does no counting
 * of its own — a total derived from a fetched page stops being true the moment
 * the page is not the whole set, and an investigation is exactly where that
 * matters.
 */
export function PupilAttendanceCompiled({ studentId, initial }: { studentId: string; initial: Compiled | null }) {
  const [data, setData] = React.useState<Compiled | null>(initial);
  const [grain, setGrain] = React.useState<AttendanceGrain>(initial?.grain ?? "month");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  // The pupil can change under this component (the page has a picker), so the
  // compiled view must follow rather than keep showing the previous child.
  React.useEffect(() => { setData(initial); setGrain(initial?.grain ?? "month"); }, [initial, studentId]);

  async function load(g: AttendanceGrain, page = 1) {
    setBusy(true); setErr(null);
    const res = await fetch(`/api/sms/students/${studentId}/attendance/compiled?grain=${g}&page=${page}`, { cache: "no-store" });
    setBusy(false);
    if (!res.ok) {
      const j = (await res.json().catch(() => null)) as { message?: string } | null;
      setErr(interpretApiError(res.status, j?.message));
      return;
    }
    setData((await res.json()) as Compiled);
    setGrain(g);
  }

  if (!data) return null;
  const life = data.lifetime;
  const from = (data.page - 1) * data.pageSize;
  const more = data.total > from + data.buckets.length;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Attendance record</CardTitle>
        <CardDescription>
          {/* THE WHOLE HISTORY, stated before any page of it — an audit that
              reports only what fitted on a page is worse than one that says
              nothing. */}
          {life.total === 0
            ? "No registers recorded for this pupil yet."
            : `${life.total} registers on record — ${life.present} present, ${life.late} late, ${life.absent} absent, ${life.excused} excused${
                life.percent == null ? "" : ` (${life.percent}% attendance)`
              }.`}
          {/* Beside the rate, never in it: the rate is over what was recorded. */}
          {life.unrecorded > 0 &&
            ` ${life.unrecorded} more register${life.unrecorded === 1 ? " was" : "s were"} taken for this pupil's class with no mark for them — not recorded, and not in the rate.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {GRAINS.map((g) => (
            <Button key={g.key} size="sm" variant={grain === g.key ? "default" : "outline"} disabled={busy} onClick={() => void load(g.key)} title={g.help}>
              {g.label}
            </Button>
          ))}
        </div>
        {err && <p className="text-sm text-rose-600 dark:text-rose-400">{err}</p>}

        <div className="overflow-x-auto">
          <table className="w-full min-w-[38rem] text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                <th className="py-1 pr-3 font-medium">{grain === "month" ? "Month" : grain === "term" ? "Term" : "Session"}</th>
                <th className="py-1 pr-3 font-medium">Present</th>
                <th className="py-1 pr-3 font-medium">Late</th>
                <th className="py-1 pr-3 font-medium">Absent</th>
                <th className="py-1 pr-3 font-medium">Excused</th>
                <th className="py-1 pr-3 font-medium">Registers</th>
                <th className="py-1 pr-3 font-medium" title="Registers taken for the class with no mark for this pupil — not in the rate">
                  Not recorded
                </th>
                <th className="py-1 pr-3 font-medium">Attendance</th>
                <th className="py-1 font-medium">Figure</th>
              </tr>
            </thead>
            <tbody>
              {data.buckets.map((b) => (
                <tr key={b.key} className="border-b last:border-0">
                  <td className="py-1.5 pr-3 font-medium">
                    {b.label}
                    {b.from && <span className="ml-2 text-xs text-muted-foreground">{b.from}{b.to ? ` – ${b.to}` : ""}</span>}
                  </td>
                  <td className="py-1.5 pr-3 tabular-nums">{b.present}</td>
                  <td className="py-1.5 pr-3 tabular-nums">{b.late || "—"}</td>
                  <td className="py-1.5 pr-3 tabular-nums">{b.absent || "—"}</td>
                  <td className="py-1.5 pr-3 tabular-nums">{b.excused || "—"}</td>
                  <td className="py-1.5 pr-3 tabular-nums">{b.total}</td>
                  <td className={`py-1.5 pr-3 tabular-nums ${b.unrecorded > 0 ? "font-medium text-amber-700 dark:text-amber-400" : ""}`}>
                    {b.unrecorded || "—"}
                  </td>
                  {/* NULL is not 0%: a rate over no registers is unknown, and
                      0% reads as truancy. */}
                  <td className="py-1.5 pr-3 tabular-nums">{b.percent == null ? "—" : `${b.percent}%`}</td>
                  <td className="py-1.5">
                    {b.source === "ROLLUP" ? (
                      <Badge variant="secondary" title="Computed when the term ended and never recomputed — what the school reported at the time.">
                        settled
                      </Badge>
                    ) : (
                      <Badge variant="outline" title="Counted from the registers just now — still moving if the term is open.">
                        live
                      </Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* WHAT THIS GRAIN CANNOT SHOW, said plainly. A reader who adds the
            terms up and gets less than the lifetime total will either mistrust
            the tool or cite the smaller number; both are worse than a sentence.
            It is usually a gap in the CALENDAR rather than in the child's
            attendance, and the wording says so. */}
        {data.outsideAnyBucket > 0 && (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
            {data.outsideAnyBucket} register{data.outsideAnyBucket === 1 ? "" : "s"} fall outside every {grain} the school has
            set up, so {data.outsideAnyBucket === 1 ? "it is" : "they are"} not counted in the rows above. Usually this means
            registers were taken on dates outside the configured {grain} dates — check the academic calendar.
          </p>
        )}

        {(data.page > 1 || more) && (
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" disabled={busy || data.page <= 1} onClick={() => void load(grain, data.page - 1)}>Newer</Button>
            <Button size="sm" variant="outline" disabled={busy || !more} onClick={() => void load(grain, data.page + 1)}>Older</Button>
            <span className="text-xs text-muted-foreground">
              Showing {from + 1}–{from + data.buckets.length} of {data.total}
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
