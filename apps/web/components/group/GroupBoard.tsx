"use client";

// =============================================================================
// GroupBoard — the cross-campus table a proprietor runs a chain from
// =============================================================================
// Worst campus first, because the reason to open this page is to find the one that
// needs attention, not to read an alphabetical list. Money is printed in EACH
// campus's own currency: the page used to hard-code ₦, so a USD campus had its
// dollars labelled naira.
//
// Every figure carries what it is measured against: registers against the
// registers that were DUE, money owed against what is already LATE, and each
// rate against the same span of the previous period — a number with nothing
// beside it cannot say whether it is good.
//
// Sorting and filtering run in the browser on purpose: the list is a group's
// campuses (tens, not thousands), returned whole and uncapped by the API.
// =============================================================================

import * as React from "react";
import { useFormat } from "@/components/shell/RegionProvider";
import Link from "next/link";
import type { GroupOverviewDto, Serialized } from "@sms/types";
import {
  GROUP_FLAG_LABELS,
  GROUP_LOW_ATTENDANCE_PCT,
  GROUP_LOW_REGISTER_COVERAGE_PCT,
  GROUP_NO_SUBSCRIPTION,
  GROUP_PERIODS,
} from "@sms/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { money } from "@/lib/format";
import {
  coverageText,
  deltaClass,
  moneyDelta,
  overdueShare,
  pointsDelta,
  previousCollected,
  windowNote,
} from "@/components/group/group-format";

type Data = Serialized<GroupOverviewDto>;
type Row = Data["schools"][number];

const SORTS = [
  { key: "worst", label: "Needs attention" },
  { key: "name", label: "Name" },
  { key: "attendance", label: "Attendance" },
  { key: "coverage", label: "Registers" },
  { key: "overdue", label: "Overdue share" },
  { key: "students", label: "Students" },
] as const;
type SortKey = (typeof SORTS)[number]["key"];

/** Nulls last whichever way a column sorts — "no figure" is never the best or worst. */
function byNumber(get: (r: Row) => number | null, dir: 1 | -1) {
  return (a: Row, b: Row) => {
    const x = get(a);
    const y = get(b);
    if (x == null && y == null) return a.name.localeCompare(b.name);
    if (x == null) return 1;
    if (y == null) return -1;
    return (x - y) * dir || a.name.localeCompare(b.name);
  };
}

function Delta({ d, goodWhen = 1 }: { d: { text: string; dir: -1 | 0 | 1 } | null; goodWhen?: 1 | -1 }) {
  if (!d) return null;
  return <div className={`text-xs ${deltaClass(d.dir, goodWhen)}`}>{d.text}</div>;
}

export function GroupBoard({ data }: { data: Data }) {
  // Dates follow the SCHOOL's timezone, not the platform's.
  const { shortDate } = useFormat();
  const currencies = Object.keys(data.totals.byCurrency).sort();
  const qs = (over: Record<string, string>) =>
    new URLSearchParams({ groupId: data.groupId, period: data.period.key, ...over }).toString();
  // The campus page is asked the SAME period this list was computed over. It
  // used to be linked bare, so a director on "90 days" clicked through to "this
  // month" and the flag they clicked on could vanish on arrival.
  const campusHref = (schoolId: string) => `/group/${schoolId}?${qs({})}`;

  const [sort, setSort] = React.useState<SortKey>("worst");
  const [flaggedOnly, setFlaggedOnly] = React.useState(false);
  const [q, setQ] = React.useState("");

  const rows = React.useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = data.schools.filter(
      (s) => (!flaggedOnly || s.flags.length > 0) && (!needle || s.name.toLowerCase().includes(needle)),
    );
    // "worst" is the server's order; every other key re-sorts a copy.
    if (sort === "name") return [...list].sort((a, b) => a.name.localeCompare(b.name));
    if (sort === "attendance") return [...list].sort(byNumber((r) => r.attendancePct, 1));
    if (sort === "coverage") return [...list].sort(byNumber((r) => r.registerCoveragePct, 1));
    if (sort === "overdue") return [...list].sort(byNumber((r) => overdueShare(r.money), -1));
    if (sort === "students") return [...list].sort(byNumber((r) => r.students, -1));
    return list;
  }, [data.schools, sort, flaggedOnly, q]);

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
            {GROUP_PERIODS.map((p) => (
              <Link key={p.key} href={`/group?${qs({ period: p.key })}`}>
                <Button size="sm" variant={p.key === data.period.key ? "default" : "ghost"}>
                  {p.short}
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
          currencies.map((c) => {
            const t = data.totals.byCurrency[c];
            return (
              <Card key={c}>
                <CardHeader className="pb-2">
                  <CardDescription>
                    Collected {currencies.length > 1 ? `(${c})` : ""} · {data.period.label.toLowerCase()}
                  </CardDescription>
                  <CardTitle className="tnum text-2xl">{money(t.collectedMinor, c)}</CardTitle>
                  <CardDescription className="tnum">
                    {money(t.outstandingMinor, c)} owed now
                    {t.overdueMinor > 0 && (
                      <span className="text-destructive"> · {money(t.overdueMinor, c)} overdue</span>
                    )}
                  </CardDescription>
                </CardHeader>
              </Card>
            );
          })
        )}
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Campuses ({data.schools.length})</CardTitle>
          <CardDescription>
            {data.period.label}, each campus in its own calendar.{" "}
            {data.flagged > 0
              ? `${data.flagged} campus${data.flagged === 1 ? "" : "es"} need${data.flagged === 1 ? "s" : ""} attention.`
              : "Every campus is active, staffed and taking its registers."}{" "}
            Arrows compare with the same span of the previous period.
          </CardDescription>
          <div className="flex flex-wrap items-center gap-2 pt-2">
            <Input
              className="h-8 w-56"
              placeholder="Find a campus"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label="Find a campus"
            />
            <label className="flex items-center gap-1.5 text-sm">
              <input type="checkbox" checked={flaggedOnly} onChange={(e) => setFlaggedOnly(e.target.checked)} />
              Needs attention only
            </label>
            <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
              Sort
              <select
                className="h-8 rounded-md border bg-background px-2 text-sm text-foreground"
                value={sort}
                onChange={(e) => setSort(e.target.value as SortKey)}
              >
                {SORTS.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            {rows.length !== data.schools.length && (
              <span className="text-xs text-muted-foreground">
                Showing {rows.length} of {data.schools.length}
              </span>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="px-4 py-2 font-medium">School</th>
                  <th className="px-4 py-2 text-right font-medium">Students</th>
                  <th className="px-4 py-2 text-right font-medium">Staff</th>
                  <th className="px-4 py-2 text-right font-medium">Registers</th>
                  <th className="px-4 py-2 text-right font-medium">Attendance</th>
                  <th className="px-4 py-2 text-right font-medium">Collected</th>
                  <th className="px-4 py-2 text-right font-medium">Owed now</th>
                  <th className="px-4 py-2 font-medium">Plan</th>
                  <th className="px-4 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={9} className="px-4 py-6 text-center text-muted-foreground">
                      No campus matches. {flaggedOnly ? "Untick “Needs attention only” to see the rest." : ""}
                    </td>
                  </tr>
                )}
                {rows.map((s) => (
                  <tr key={s.schoolId} className="border-b last:border-0 align-top hover:bg-accent/40">
                    <td className="px-4 py-2.5">
                      <Link href={campusHref(s.schoolId)} className="font-medium text-primary hover:underline">
                        {s.name}
                      </Link>
                      {/* Terms do not align across a group, so each campus says
                          which days its figures are. */}
                      {s.window.basis !== "PERIOD" && (
                        <div className="text-xs text-muted-foreground">{windowNote(s.window, shortDate)}</div>
                      )}
                      {s.flags.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {s.flags.map((f) => (
                            <Badge key={f} variant={f === "DISABLED" || f === "BILLING" ? "destructive" : "outline"}>
                              {GROUP_FLAG_LABELS[f]}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="tnum px-4 py-2.5 text-right">{s.students.toLocaleString()}</td>
                    <td className="tnum px-4 py-2.5 text-right">{s.staff.toLocaleString()}</td>
                    <td className="tnum px-4 py-2.5 text-right">
                      {/* Taken against DUE: "12 registers" said nothing about
                          whether 12 or 60 were expected. */}
                      {s.registersExpected == null ? (
                        <span className="text-muted-foreground" title="No dated term, so no day can be called a school day">
                          {s.registersTaken} taken
                        </span>
                      ) : s.registersExpected === 0 ? (
                        <span className="text-muted-foreground">none due</span>
                      ) : (
                        <>
                          <span
                            className={
                              (s.registerCoveragePct ?? 0) < GROUP_LOW_REGISTER_COVERAGE_PCT ? "font-medium text-destructive" : ""
                            }
                          >
                            {coverageText(s.registerCoveragePct, s.registersCovered)}
                          </span>
                          <div className="text-xs text-muted-foreground">
                            {s.registersCovered} of {s.registersExpected}
                          </div>
                        </>
                      )}
                    </td>
                    <td className="tnum px-4 py-2.5 text-right">
                      {s.attendancePct == null ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <>
                          <span className={s.attendancePct < GROUP_LOW_ATTENDANCE_PCT ? "font-medium text-destructive" : ""}>
                            {s.attendancePct}%
                          </span>
                          <Delta d={pointsDelta(s.attendancePct, s.previous.attendancePct)} />
                        </>
                      )}
                    </td>
                    <td className="tnum px-4 py-2.5 text-right">
                      {s.money.length === 0 ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        s.money.map((m) => (
                          <div key={m.currency}>
                            {money(m.collectedMinor, m.currency)}
                            <Delta d={moneyDelta(m.collectedMinor, previousCollected(s.previous, m.currency))} />
                          </div>
                        ))
                      )}
                    </td>
                    <td className="tnum px-4 py-2.5 text-right">
                      {s.money.length === 0 && <span className="text-muted-foreground">—</span>}
                      {s.money.map((m) => (
                        <div key={m.currency}>
                          {money(m.outstandingMinor, m.currency)}
                          {m.overdueMinor > 0 && (
                            <div className="text-xs text-destructive">{money(m.overdueMinor, m.currency)} overdue</div>
                          )}
                        </div>
                      ))}
                    </td>
                    <td className="px-4 py-2.5">
                      {s.plan}
                      {s.subscriptionStatus !== "ACTIVE" && (
                        <Badge variant="destructive" className="ml-1.5">
                          {s.subscriptionStatus === GROUP_NO_SUBSCRIPTION ? "No subscription" : s.subscriptionStatus}
                        </Badge>
                      )}
                      {s.currentPeriodEnd && (
                        <div className="text-xs text-muted-foreground">renews {shortDate(s.currentPeriodEnd)}</div>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <Link href={campusHref(s.schoolId)} className="text-xs text-primary hover:underline">
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
