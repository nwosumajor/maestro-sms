"use client";

import * as React from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Row = {
  classId: string;
  className: string;
  supervisorId: string | null;
  supervisorName: string | null;
  canTake: boolean;
  present: number;
  absent: number;
  late: number;
  excused: number;
  total: number;
  ratePct: number | null;
  registersTaken: number;
};

/**
 * Attendance BY CLASS — the senior-staff view.
 *
 * Senior staff open this to see the school class by class and drill into whichever
 * looks wrong; a school administrator sees the same rows plus a Take register
 * affordance for covering an absent supervisor.
 *
 * `canTake` comes from the SERVER, per row. The UI never re-derives the permission
 * rule, so it cannot offer a button the API will refuse — and when the rule changes,
 * it changes in one place.
 */
export function ClassAttendanceBoard() {
  const [data, setData] = React.useState<{ from: string; to: string; classes: Row[] } | null>(null);
  const [sort, setSort] = React.useState<"name" | "rate">("rate");

  React.useEffect(() => {
    let live = true;
    (async () => {
      const res = await fetch("/api/sms/attendance/by-class");
      if (!live) return;
      setData(res.ok ? await res.json() : { from: "", to: "", classes: [] });
    })();
    return () => {
      live = false;
    };
  }, []);

  const rows = React.useMemo(() => {
    if (!data) return [];
    const r = [...data.classes];
    // Worst attendance first by default: the reason to open this page is to find
    // the class that needs attention, not to read an alphabetical list.
    if (sort === "rate") {
      r.sort((a, b) => (a.ratePct ?? 999) - (b.ratePct ?? 999) || a.className.localeCompare(b.className));
    } else {
      r.sort((a, b) => a.className.localeCompare(b.className));
    }
    return r;
  }, [data, sort]);

  if (!data) return null;
  if (rows.length === 0) return null;

  const untaken = rows.filter((r) => r.registersTaken === 0).length;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base">Attendance by class</CardTitle>
            <CardDescription>
              This term ({data.from} – {data.to}). Open a class to see its register.
              {untaken > 0 ? ` ${untaken} class${untaken === 1 ? " has" : "es have"} no register at all.` : ""}
            </CardDescription>
          </div>
          <div className="flex items-center gap-1 rounded-md border p-1">
            <Button size="sm" variant={sort === "rate" ? "default" : "ghost"} onClick={() => setSort("rate")}>
              Lowest first
            </Button>
            <Button size="sm" variant={sort === "name" ? "default" : "ghost"} onClick={() => setSort("name")}>
              By name
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="border-b border-border text-left text-muted-foreground">
            <tr>
              <th className="px-4 py-2.5 font-medium">Class</th>
              <th className="px-4 py-2.5 font-medium">Supervisor</th>
              <th className="px-4 py-2.5 text-right font-medium">Attendance</th>
              <th className="px-4 py-2.5 text-right font-medium">Absent</th>
              <th className="px-4 py-2.5 text-right font-medium">Registers</th>
              <th className="px-4 py-2.5"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.classId} className="border-b border-border last:border-0 hover:bg-accent/40">
                <td className="px-4 py-2.5 font-medium">
                  <Link href={`/classes/${r.classId}`} className="text-primary hover:underline">
                    {r.className}
                  </Link>
                </td>
                <td className="px-4 py-2.5 text-muted-foreground">
                  {r.supervisorName ?? <Badge variant="outline">none assigned</Badge>}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums">
                  {r.ratePct == null ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    <span className={r.ratePct < 85 ? "font-semibold text-destructive" : ""}>{r.ratePct}%</span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{r.absent}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">
                  {/* No register at all is a different problem from poor attendance,
                      and the one that is still fixable today. */}
                  {r.registersTaken === 0 ? (
                    <Badge variant="destructive">none taken</Badge>
                  ) : (
                    <span className="text-muted-foreground">{r.registersTaken}</span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-right">
                  {r.canTake ? (
                    <Link href={`/classes/${r.classId}`}>
                      <Button size="sm" variant="outline">
                        Take register
                      </Button>
                    </Link>
                  ) : (
                    // Says WHY rather than showing a disabled button with no reason.
                    <span className="text-xs text-muted-foreground">view only</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
