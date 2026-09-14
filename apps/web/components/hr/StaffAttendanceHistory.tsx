"use client";

import * as React from "react";
import type { Serialized, StaffAttendanceHistoryDto } from "@sms/types";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { timeOfDay, shortDate } from "@/lib/format";
import { interpretApiError } from "@/lib/api-error";

type History = Serialized<StaffAttendanceHistoryDto>;

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  PRESENT: "default",
  LATE: "secondary",
  ABSENT: "destructive",
  ON_LEAVE: "outline",
};

/** "6h 45m" — minutes are what the server sends, hours are what a person reads. */
function hoursAndMinutes(mins: number): string {
  const h = Math.floor(mins / 60);
  return h > 0 ? `${h}h ${mins % 60}m` : `${mins}m`;
}

/** "2026-08" → "August 2026". Month names come from the VIEWER's locale. */
function monthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, (m ?? 1) - 1, 1)).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * One member of staff's attendance, compiled per month.
 *
 * The months come from the server already aggregated — this component never
 * counts rows itself, because a figure derived from a fetched page is wrong the
 * moment the page is not the whole set, and that is the defect this repo records
 * most often.
 */
export function StaffAttendanceHistory({ userId, initial }: { userId: string; initial: History | null }) {
  const [data, setData] = React.useState<History | null>(initial);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  async function load(params: { month?: string; page?: number }) {
    setBusy(true);
    setErr(null);
    const q = new URLSearchParams();
    if (params.month) q.set("month", params.month);
    if (params.page) q.set("page", String(params.page));
    const res = await fetch(`/api/sms/hr/attendance/staff/${userId}?${q}`, { cache: "no-store" });
    setBusy(false);
    if (!res.ok) {
      const j = (await res.json().catch(() => null)) as { message?: string } | null;
      setErr(interpretApiError(res.status, j?.message));
      return;
    }
    setData((await res.json()) as History);
  }

  if (!data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Attendance</CardTitle>
          <CardDescription>{err ?? "Could not load this record."}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const shown = data.months.length;
  const from = (data.page - 1) * data.pageSize;
  const more = data.totalMonths > from + shown;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Attendance</CardTitle>
        <CardDescription>
          {/* SAYS WHAT IT IS NOT SHOWING. A page presented as the whole record is
              how a reader concludes somebody has no history. */}
          {data.totalMonths === 0
            ? "No attendance has been recorded for this person yet."
            : `${data.totalMonths} month${data.totalMonths === 1 ? "" : "s"} on record — showing ${
                shown === 0 ? "none" : `${from + 1}–${from + shown}`
              }. Absences are recorded by the evening close; on leave means an approved request covered the day.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {err && <p className="text-sm text-rose-600 dark:text-rose-400">{err}</p>}

        {data.months.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                  <th className="py-1 pr-3 font-medium">Month</th>
                  <th className="py-1 pr-3 font-medium">Present</th>
                  <th className="py-1 pr-3 font-medium">Late</th>
                  <th className="py-1 pr-3 font-medium">Absent</th>
                  <th className="py-1 pr-3 font-medium">On leave</th>
                  <th className="py-1 pr-3 font-medium">On site</th>
                  <th className="py-1 font-medium">Needs a look</th>
                </tr>
              </thead>
              <tbody>
                {data.months.map((m) => (
                  <tr
                    key={m.month}
                    className={`cursor-pointer border-b last:border-0 hover:bg-muted/50 ${
                      m.month === data.month ? "bg-muted/40" : ""
                    }`}
                    onClick={() => void load({ month: m.month, page: data.page })}
                  >
                    <td className="py-1.5 pr-3 font-medium">{monthLabel(m.month)}</td>
                    <td className="py-1.5 pr-3 tabular-nums">{m.present}</td>
                    <td className="py-1.5 pr-3 tabular-nums">{m.late || "—"}</td>
                    <td className="py-1.5 pr-3 tabular-nums">{m.absent || "—"}</td>
                    <td className="py-1.5 pr-3 tabular-nums">{m.onLeave || "—"}</td>
                    {/* NULL is not zero: a month whose days have no clock-out has
                        no hours to report, and "0h" would assert a month nobody
                        worked. */}
                    <td className="py-1.5 pr-3 tabular-nums">
                      {m.minutesOnSite == null ? "—" : hoursAndMinutes(m.minutesOnSite)}
                    </td>
                    <td className="py-1.5">
                      {m.openSpans > 0 && (
                        <Badge variant="outline" className="mr-1 border-amber-500 text-amber-600 dark:text-amber-400">
                          {m.openSpans} not closed
                        </Badge>
                      )}
                      {m.flagged > 0 && <Badge variant="destructive">⚑ {m.flagged}</Badge>}
                      {m.openSpans === 0 && m.flagged === 0 && <span className="text-muted-foreground">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {(data.page > 1 || more) && (
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" disabled={busy || data.page <= 1} onClick={() => void load({ page: data.page - 1 })}>
              Newer
            </Button>
            <Button size="sm" variant="outline" disabled={busy || !more} onClick={() => void load({ page: data.page + 1 })}>
              Older
            </Button>
            <span className="text-xs text-muted-foreground">Page {data.page}</span>
          </div>
        )}

        {data.month && (
          <div>
            <h3 className="mb-2 text-sm font-semibold">{monthLabel(data.month)} day by day</h3>
            {data.days.length === 0 ? (
              <p className="text-sm text-muted-foreground">No days recorded in this month.</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {data.days.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-center gap-2">
                    <span className="w-28 text-muted-foreground">{shortDate(d.date)}</span>
                    <Badge variant={STATUS_VARIANT[d.status] ?? "secondary"}>
                      {d.status.toLowerCase().replace("_", " ")}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {d.clockInAt ? `in ${timeOfDay(d.clockInAt)}` : "no clock-in"}
                      {d.clockOutAt ? ` · out ${timeOfDay(d.clockOutAt)}` : d.clockInAt ? " · not closed" : ""}
                      {d.minutesOnSite != null && ` · ${hoursAndMinutes(d.minutesOnSite)}`}
                      {d.source === "SYSTEM" && " · recorded by the evening close"}
                    </span>
                    {d.flagged && <Badge variant="destructive">⚑ review</Badge>}
                    {d.note && <span className="text-xs text-muted-foreground">{d.note}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
