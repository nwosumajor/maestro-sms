"use client";

import * as React from "react";
import Link from "next/link";
import type { AttentionQueueDto, AttentionRowDto, Serialized } from "@sms/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Queue = Serialized<AttentionQueueDto>;
type Row = Serialized<AttentionRowDto>;

const LABEL: Record<string, string> = {
  PAST_DUE: "Payment overdue",
  TRIAL_ENDING: "Trial ending",
  SEAT_ARREARS: "Growth unbilled",
  DORMANT: "Not being used",
  REGISTERS_STOPPED: "Registers stopped",
  NO_ADMIN: "No administrator",
};

const naira = (minor: number) =>
  `₦${(minor / 100).toLocaleString("en-NG", { maximumFractionDigits: 0 })}`;

/**
 * The schools that need a DECISION.
 *
 * A console that renders five thousand schools accurately is still a console nobody
 * can act on: the owner cannot review them by scrolling, so the important question
 * is not "what exists" but "what changed, and what does it cost me". Every row here
 * is a condition somebody has to decide about, with the figure behind it, ranked
 * worst-first and then by what is at stake.
 *
 * The data arrives as a PROP from the server component that renders it — this used
 * to fetch on mount, which meant the rows landed a round trip after the page and,
 * worse, ran the fleet-wide scan on every visit to the operator hub whether or not
 * anyone was triaging. Filtering stays here, client-side over rows already in hand:
 * hiding some rows is a visual change and should not cost a request.
 *
 * Aggregates only. School names, counts and money — never a pupil or a staff member.
 */
export function AttentionQueue({ queue: data }: { queue: Queue }) {
  const [kind, setKind] = React.useState<string>("");

  const rows: Row[] = React.useMemo(
    () => (kind ? data.rows.filter((r) => r.signals.some((s) => s.kind === kind)) : data.rows),
    [data, kind],
  );

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Needs a decision</CardTitle>
        <CardDescription>
          {data.total === 0 ? (
            `All ${data.scanned} schools are paying, active and in use.`
          ) : (
            <>
              {data.total} of {data.scanned} school{data.scanned === 1 ? "" : "s"} need attention
              {/* Stated whenever the queue is cut short, so a bounded list never
                  reads as a complete one. */}
              {data.shown < data.total ? ` — showing the ${data.shown} most urgent` : ""}.
            </>
          )}
        </CardDescription>
      </CardHeader>

      {data.total > 0 && (
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" variant={kind === "" ? "default" : "outline"} onClick={() => setKind("")}>
              All ({data.total})
            </Button>
            {Object.entries(data.byKind)
              .sort((a, b) => b[1] - a[1])
              .map(([k, n]) => (
                <Button key={k} size="sm" variant={kind === k ? "default" : "outline"} onClick={() => setKind(k)}>
                  {LABEL[k] ?? k} ({n})
                </Button>
              ))}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4 font-medium">School</th>
                  <th className="py-2 pr-4 font-medium">Why</th>
                  <th className="py-2 pr-4 text-right font-medium">Pupils</th>
                  <th className="py-2 pr-4 text-right font-medium">Staff</th>
                  <th className="py-2 pr-4 text-right font-medium">At stake / mo</th>
                  <th className="py-2"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.schoolId} className="border-b border-border last:border-0 align-top">
                    <td className="py-2.5 pr-4">
                      <span className="font-medium">{r.schoolName}</span>
                      <span className="ml-2 text-xs text-muted-foreground">{r.plan}</span>
                    </td>
                    <td className="py-2.5 pr-4">
                      <div className="flex flex-col gap-1">
                        {r.signals.map((s) => (
                          <div key={s.kind} className="flex flex-wrap items-center gap-1.5">
                            <Badge variant={s.severity === 3 ? "destructive" : "outline"}>{LABEL[s.kind] ?? s.kind}</Badge>
                            {/* The number travels WITH the label, so the row can be
                                acted on without opening anything. */}
                            <span className="text-xs text-muted-foreground">{s.detail}</span>
                          </div>
                        ))}
                      </div>
                    </td>
                    <td className="py-2.5 pr-4 text-right tabular-nums">{r.students.toLocaleString()}</td>
                    <td className="py-2.5 pr-4 text-right tabular-nums">{r.staff.toLocaleString()}</td>
                    <td className="py-2.5 pr-4 text-right tabular-nums">{naira(r.mrrMinor)}</td>
                    <td className="py-2.5 text-right">
                      <Link href={`/operator/schools/${r.schoolId}`} className="text-primary hover:underline">
                        Open
                      </Link>
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="py-6 text-center text-sm text-muted-foreground">
                      No school carries that signal.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      )}
    </Card>
  );
}
