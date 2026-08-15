"use client";

// The cover duties assigned TO ME.
//
// Assigning a reliever already notifies them — "you are covering 2B Chemistry on
// Tuesday" — and that notification was the only place the duty existed. The
// endpoint behind this list (`GET /timetable/cover/mine`, self-scoped, any
// teacher) was built and never called by anything, so a teacher who dismissed
// the notification had no way back to it, and no way to see next week's.
//
// Deliberately NOT gated on timetable.write: that permission is for the person
// who ASSIGNS cover. The whole point is the teacher receiving it, who does not
// have it.

import type { MyCoverDutyDto, Serialized } from "@sms/types";
import * as React from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Duty = Serialized<MyCoverDutyDto>;

const iso = (d: Date) => d.toISOString().slice(0, 10);

export function MyCoverDuties() {
  const [duties, setDuties] = React.useState<Duty[] | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);

  React.useEffect(() => {
    const from = iso(new Date());
    // The window the server already bounds at 62 days; four weeks is what a
    // teacher plans around.
    const to = iso(new Date(Date.now() + 28 * 86_400_000));
    void (async () => {
      const res = await fetch(`/api/sms/timetable/cover/mine?from=${from}&to=${to}`, { cache: "no-store" });
      if (!res.ok) {
        setMsg(`Couldn't load your cover duties (${res.status}).`);
        setDuties([]);
        return;
      }
      setDuties((await res.json()) as Duty[]);
    })();
  }, []);

  // Nothing to cover is the normal case — don't take up the page saying so.
  if (duties !== null && duties.length === 0 && !msg) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Your cover duties</CardTitle>
        <CardDescription>Lessons you have been asked to cover over the next four weeks.</CardDescription>
      </CardHeader>
      <CardContent>
        {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
        {duties === null && !msg && <p className="text-sm text-muted-foreground">Loading…</p>}
        {duties && duties.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="py-1 pr-3 font-medium">Date</th>
                  <th className="py-1 pr-3 font-medium">Period</th>
                  <th className="py-1 pr-3 font-medium">Class</th>
                  <th className="py-1 pr-3 font-medium">Subject</th>
                  <th className="py-1 font-medium">Note</th>
                </tr>
              </thead>
              <tbody>
                {duties.map((d) => (
                  <tr key={d.coverId} className="border-b border-border/50">
                    <td className="py-1 pr-3 whitespace-nowrap">{d.date}</td>
                    <td className="py-1 pr-3">{d.periodName}</td>
                    <td className="py-1 pr-3">{d.className}</td>
                    <td className="py-1 pr-3">{d.subject}</td>
                    <td className="py-1 text-muted-foreground">{d.note ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
