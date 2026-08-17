"use client";

import * as React from "react";
import { useRegion } from "@/components/shell/RegionProvider";
import { todayIn } from "@/lib/format";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Row = { classId: string; className: string; taken: boolean; marked: number; enrolled: number };

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
export function RegisterBoard() {
  // The SCHOOL's day — the UTC one prefills yesterday's or tomorrow's board.
  const { timezone } = useRegion();
  const [date, setDate] = React.useState(() => todayIn(timezone));
  const [rows, setRows] = React.useState<Row[] | null>(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    let live = true;
    setRows(null);
    (async () => {
      const res = await fetch(`/api/sms/attendance/registers?date=${date}`);
      if (!live) return;
      // A failed read used to become `[]`, and `[]` drives `missing` and
      // `partial` — so this board reported that NO class was missing a register
      // on the one page whose job is naming the classes that are. A false all
      // clear is the worst answer it can give.
      if (res.ok) {
        setRows(((await res.json()) as { classes: Row[] }).classes);
        setFailed(false);
      } else {
        setFailed(true);
      }
    })();
    return () => {
      live = false;
    };
  }, [date]);

  const missing = (rows ?? []).filter((r) => !r.taken);
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
              Which classes still have no register for the day. An unrecorded absence looks the same as a pupil who was
              present, so a gap here is worth chasing before the 7-day correction window closes.
            </CardDescription>
          </div>
          <input
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

            {missing.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {missing.map((r) => (
                  <Link key={r.classId} href={`/classes/${r.classId}`}>
                    <Button size="sm" variant="outline">
                      {r.className} <span className="ml-1 text-muted-foreground">take →</span>
                    </Button>
                  </Link>
                ))}
              </div>
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
