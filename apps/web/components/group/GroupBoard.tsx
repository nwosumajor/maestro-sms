"use client";

// =============================================================================
// GroupBoard — the cross-campus table a proprietor runs a chain from
// =============================================================================
// Worst campus first, because the reason to open this page is to find the one that
// needs attention, not to read an alphabetical list. Money is printed in EACH
// campus's own currency: the page used to hard-code ₦, so a USD campus had its
// dollars labelled naira.
// =============================================================================

import * as React from "react";
import Link from "next/link";
import type { GroupFlag, GroupOverviewDto, Serialized } from "@sms/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { money, shortDate } from "@/lib/format";

type Data = Serialized<GroupOverviewDto>;

const FLAG_LABEL: Record<GroupFlag, string> = {
  DISABLED: "Disabled",
  BILLING: "Billing",
  NO_STAFF: "No staff",
  NO_REGISTERS: "No registers",
  LOW_ATTENDANCE: "Low attendance",
};

const PERIODS = [
  { key: "today", label: "Today" },
  { key: "week", label: "7 days" },
  { key: "month", label: "This month" },
  { key: "term", label: "90 days" },
] as const;

export function GroupBoard({ data }: { data: Data }) {
  const currencies = Object.keys(data.totals.byCurrency).sort();
  const qs = (over: Record<string, string>) =>
    new URLSearchParams({ groupId: data.groupId, period: data.period.key, ...over }).toString();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {/* Only shown when there is a choice to make. A proprietor with one chain
              should not be asked which chain. */}
          {data.groups.length > 1 &&
            data.groups.map((g) => (
              <Link key={g.id} href={`/group?${qs({ groupId: g.id })}`}>
                <Button size="sm" variant={g.id === data.groupId ? "default" : "outline"}>
                  {g.name} <span className="ml-1.5 text-xs opacity-70">{g.schools}</span>
                </Button>
              </Link>
            ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 rounded-md border p-1">
            {PERIODS.map((p) => (
              <Link key={p.key} href={`/group?${qs({ period: p.key })}`}>
                <Button size="sm" variant={p.key === data.period.key ? "default" : "ghost"}>
                  {p.label}
                </Button>
              </Link>
            ))}
          </div>
          <a href={`/api/sms/group/overview.csv?${qs({})}`} download>
            <Button size="sm" variant="outline">
              Export CSV
            </Button>
          </a>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Students</CardDescription>
            <CardTitle className="tnum text-2xl">{data.totals.students.toLocaleString()}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Staff</CardDescription>
            <CardTitle className="tnum text-2xl">{data.totals.staff.toLocaleString()}</CardTitle>
          </CardHeader>
        </Card>
        {/* One tile PER CURRENCY. Adding naira to dollars produces a figure that is
            wrong in both, so the console does not offer one. */}
        {currencies.length === 0 ? (
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Collected ({data.period.label.toLowerCase()})</CardDescription>
              <CardTitle className="tnum text-2xl text-muted-foreground">—</CardTitle>
            </CardHeader>
          </Card>
        ) : (
          currencies.map((c) => (
            <Card key={c}>
              <CardHeader className="pb-2">
                <CardDescription>
                  Collected {currencies.length > 1 ? `(${c})` : ""} · {data.period.label.toLowerCase()}
                </CardDescription>
                <CardTitle className="tnum text-2xl">{money(data.totals.byCurrency[c].collectedMinor, c)}</CardTitle>
                <CardDescription className="tnum">
                  {money(data.totals.byCurrency[c].outstandingMinor, c)} outstanding
                </CardDescription>
              </CardHeader>
            </Card>
          ))
        )}
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Campuses ({data.schools.length})</CardTitle>
          <CardDescription>
            {data.period.label}, worst first.{" "}
            {data.flagged > 0
              ? `${data.flagged} campus${data.flagged === 1 ? "" : "es"} need${data.flagged === 1 ? "s" : ""} attention.`
              : "Every campus is active, staffed and taking registers."}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="px-4 py-2 font-medium">School</th>
                  <th className="px-4 py-2 text-right font-medium">Students</th>
                  <th className="px-4 py-2 text-right font-medium">Staff</th>
                  <th className="px-4 py-2 text-right font-medium">Attendance</th>
                  <th className="px-4 py-2 text-right font-medium">Collected</th>
                  <th className="px-4 py-2 text-right font-medium">Outstanding</th>
                  <th className="px-4 py-2 font-medium">Plan</th>
                  <th className="px-4 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {data.schools.map((s) => (
                  <tr key={s.schoolId} className="border-b last:border-0 align-top hover:bg-accent/40">
                    <td className="px-4 py-2.5">
                      <Link href={`/group/${s.schoolId}`} className="font-medium text-primary hover:underline">
                        {s.name}
                      </Link>
                      {s.flags.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {s.flags.map((f) => (
                            <Badge key={f} variant={f === "DISABLED" || f === "BILLING" ? "destructive" : "outline"}>
                              {FLAG_LABEL[f]}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="tnum px-4 py-2.5 text-right">{s.students.toLocaleString()}</td>
                    <td className="tnum px-4 py-2.5 text-right">{s.staff.toLocaleString()}</td>
                    <td className="tnum px-4 py-2.5 text-right">
                      {/* "No register taken" is a different problem from "poor
                          attendance", and the only one still fixable today. */}
                      {s.registersTaken === 0 ? (
                        <span className="text-muted-foreground">none taken</span>
                      ) : s.attendancePct == null ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <span className={s.attendancePct < 85 ? "font-medium text-destructive" : ""}>
                          {s.attendancePct}%
                        </span>
                      )}
                    </td>
                    <td className="tnum px-4 py-2.5 text-right">
                      {s.money.length === 0 ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        s.money.map((m) => (
                          <div key={m.currency}>{money(m.collectedMinor, m.currency)}</div>
                        ))
                      )}
                    </td>
                    <td className="tnum px-4 py-2.5 text-right">
                      {s.money.map((m) => (
                        <div key={m.currency} className={m.outstandingMinor > 0 ? "text-amber-600 dark:text-amber-400" : ""}>
                          {money(m.outstandingMinor, m.currency)}
                        </div>
                      ))}
                    </td>
                    <td className="px-4 py-2.5">
                      {s.plan}
                      {s.subscriptionStatus !== "ACTIVE" && (
                        <Badge variant="destructive" className="ml-1.5">
                          {s.subscriptionStatus}
                        </Badge>
                      )}
                      {s.currentPeriodEnd && (
                        <div className="text-xs text-muted-foreground">renews {shortDate(s.currentPeriodEnd)}</div>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <Link href={`/group/${s.schoolId}`} className="text-xs text-primary hover:underline">
                        Open
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
