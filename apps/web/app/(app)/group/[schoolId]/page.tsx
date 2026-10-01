// One campus in depth, for a director who wants to know WHY a row looks wrong.
// Aggregates only — monthly totals, status counts, headcount. A director is not
// staff at this campus and never reaches a pupil, an invoice or a record here;
// those stay behind that school's own permissions. 404 unless the campus is in a
// group they direct.

import type { GroupSchoolDetailDto, Serialized } from "@sms/types";
import {
  GROUP_FLAG_LABELS,
  GROUP_LOW_ATTENDANCE_PCT,
  GROUP_LOW_REGISTER_COVERAGE_PCT,
  GROUP_NO_SUBSCRIPTION,
} from "@sms/types";
import {
  coverageText,
  deltaClass,
  moneyDelta,
  pointsDelta,
  previousCollected,
  windowNote,
} from "@/components/group/group-format";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { money, shortDate } from "@/lib/format";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

/** "2026-05" as "May 2026". The key is a calendar MONTH, so it is read in UTC
 *  and never shifted by a zone. */
function monthLabel(key: string): string {
  const d = new Date(`${key}-01T00:00:00.000Z`);
  return Number.isNaN(d.getTime())
    ? key
    : new Intl.DateTimeFormat("en-GB", { month: "short", year: "numeric", timeZone: "UTC" }).format(d);
}

/** A change against the previous period, coloured by whether it is good news. */
function Change({ d }: { d: { text: string; dir: -1 | 0 | 1 } | null }) {
  if (!d) return null;
  return <p className={`text-xs ${deltaClass(d.dir)}`}>{d.text} on the period before</p>;
}

export default async function GroupSchoolPage({
  params,
  searchParams,
}: {
  params: { schoolId: string };
  searchParams: { groupId?: string; period?: string };
}) {
  const session = await auth();
  const user = session!.user;
  // The period the overview row was computed over. The API has accepted it all
  // along; this page never sent it, so its flags were computed over "this month"
  // whatever the director had been looking at.
  const q = new URLSearchParams();
  if (searchParams.period) q.set("period", searchParams.period);
  // A plain `?${q}` — an empty query is harmless, and a nested template here
  // hides the call from the wire-shape gate, which then cannot check it.
  const s = await apiGet<Serialized<GroupSchoolDetailDto>>(`/group/schools/${params.schoolId}?${q.toString()}`);
  // Back to the SAME view: the same group and the same period.
  const back = new URLSearchParams();
  if (searchParams.groupId) back.set("groupId", searchParams.groupId);
  if (searchParams.period) back.set("period", searchParams.period);
  const backHref = `/group${back.toString() ? `?${back.toString()}` : ""}`;

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="group" permissions={user.permissions}>
      <div className="space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <PageHeader
            title={<>{s ? s.name : "Campus"}</>}
            subtitle={
              s ? (
                <>
                  {s.groupName} · {s.period.label.toLowerCase()} ({windowNote(s.window, (d) => shortDate(d))}) ·
                  figures only, never pupil records.
                </>
              ) : (
                <>Not available.</>
              )
            }
          />
          <Link href={backHref} className={buttonVariants({ variant: "outline", size: "sm" })}>
            ← All campuses
          </Link>
        </div>

        {!s ? (
          <Alert variant="info">
            <AlertTitle>Not available</AlertTitle>
            <AlertDescription>
              This campus is not in a group you direct, or the group console is not enabled.
            </AlertDescription>
          </Alert>
        ) : (
          <>
            {s.flags.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {s.flags.map((f) => (
                  <Badge key={f} variant={f === "DISABLED" || f === "BILLING" ? "destructive" : "outline"}>
                    {GROUP_FLAG_LABELS[f]}
                  </Badge>
                ))}
              </div>
            )}

            {!s.hasCurrentTerm && (
              <Alert variant="destructive">
                <AlertTitle>No current term is set at this campus</AlertTitle>
                <AlertDescription>
                  Until one is, the daily register reminder does not run there and its figures cannot be measured
                  against a term. The campus&apos;s administrators set it under the academic calendar.
                </AlertDescription>
              </Alert>
            )}

            {/* The figures the flags above were computed from, over the stated
                period, each beside the same span of the previous period — a
                flag with nothing to judge it by is half an answer. */}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Card>
                <CardHeader className="pb-2">
                  <CardDescription>Registers taken · {s.period.label.toLowerCase()}</CardDescription>
                  <CardTitle className="tnum text-2xl">
                    {s.registersExpected == null ? (
                      <span className="text-muted-foreground">{s.registersTaken}</span>
                    ) : s.registersExpected === 0 ? (
                      <span className="text-muted-foreground">none due</span>
                    ) : (
                      <span
                        className={(s.registerCoveragePct ?? 0) < GROUP_LOW_REGISTER_COVERAGE_PCT ? "text-destructive" : ""}
                      >
                        {coverageText(s.registerCoveragePct, s.registersCovered)}
                      </span>
                    )}
                  </CardTitle>
                  <CardDescription className="tnum">
                    {s.registersExpected == null
                      ? "taken — no dated term, so none can be called due"
                      : `${s.registersCovered} of ${s.registersExpected} due`}
                  </CardDescription>
                  <Change d={pointsDelta(s.registerCoveragePct, s.previous.registerCoveragePct)} />
                </CardHeader>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardDescription>Attendance · {s.period.label.toLowerCase()}</CardDescription>
                  <CardTitle className="tnum text-2xl">
                    {s.attendancePct == null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <span className={s.attendancePct < GROUP_LOW_ATTENDANCE_PCT ? "text-destructive" : ""}>
                        {s.attendancePct}%
                      </span>
                    )}
                  </CardTitle>
                  <CardDescription>present or late; an excused absence is an absence</CardDescription>
                  <Change d={pointsDelta(s.attendancePct, s.previous.attendancePct)} />
                </CardHeader>
              </Card>
              {s.money.map((m) => (
                <Card key={m.currency}>
                  <CardHeader className="pb-2">
                    <CardDescription>
                      Collected {s.money.length > 1 ? `(${m.currency}) ` : ""}· {s.period.label.toLowerCase()}
                    </CardDescription>
                    <CardTitle className="tnum text-2xl">{money(m.collectedMinor, m.currency)}</CardTitle>
                    <CardDescription className="tnum">
                      {money(previousCollected(s.previous, m.currency), m.currency)} the period before
                    </CardDescription>
                    <Change d={moneyDelta(m.collectedMinor, previousCollected(s.previous, m.currency))} />
                  </CardHeader>
                </Card>
              ))}
            </div>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {(
                [
                  ["Students", s.students.toLocaleString()],
                  ["Staff", s.staff.toLocaleString()],
                  ["Guardians", s.parents.toLocaleString()],
                  ["Classes", s.classes.toLocaleString()],
                ] as const
              ).map(([label, value]) => (
                <Card key={label}>
                  <CardHeader className="pb-2">
                    <CardDescription>{label}</CardDescription>
                    <CardTitle className="tnum text-2xl">{value}</CardTitle>
                  </CardHeader>
                </Card>
              ))}
            </div>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Last six months</CardTitle>
                <CardDescription>
                  Collections and attendance, month by month. Collections are the campus&apos;s own currency
                  ({s.trendCurrency}) — one line cannot be two currencies, and anything billed in another is on the
                  money figures above.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="px-4 py-2 font-medium">Month</th>
                      <th className="px-4 py-2 text-right font-medium">Collected</th>
                      <th className="px-4 py-2 text-right font-medium">Attendance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.trend.map((t) => (
                      <tr key={t.month} className="border-b last:border-0">
                        <td className="px-4 py-2.5">{monthLabel(t.month)}</td>
                        <td className="tnum px-4 py-2.5 text-right">
                          {/* The currency the API restricted the trend TO, not
                              whichever money block happened to sort first. */}
                          {money(t.collectedMinor, s.trendCurrency)}
                        </td>
                        <td className="tnum px-4 py-2.5 text-right">
                          {t.attendancePct == null ? (
                            <span className="text-muted-foreground">—</span>
                          ) : (
                            <span className={t.attendancePct < GROUP_LOW_ATTENDANCE_PCT ? "font-medium text-destructive" : ""}>
                              {t.attendancePct}%
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>

            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Where the money is</CardTitle>
                  <CardDescription>
                    Invoices by status. Owed now is each open invoice&apos;s unpaid balance — the same figure as the
                    campus&apos;s own finance report.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  {Object.entries(s.invoicesByStatus).length === 0 ? (
                    <p className="text-muted-foreground">No invoices raised.</p>
                  ) : (
                    Object.entries(s.invoicesByStatus).map(([status, n]) => (
                      <div key={status} className="flex justify-between">
                        <span className="text-muted-foreground">{status.toLowerCase().replace(/_/g, " ")}</span>
                        <span className="tnum">{n}</span>
                      </div>
                    ))
                  )}
                  {s.money.map((m) => (
                    <div key={m.currency} className="space-y-1 border-t pt-2">
                      <div className="flex justify-between font-medium">
                        <span>Owed now ({m.currency})</span>
                        <span className="tnum">{money(m.outstandingMinor, m.currency)}</span>
                      </div>
                      {/* The finance report's ladder, from the campus's own today. */}
                      {(
                        [
                          ["Not yet due", m.aging.currentMinor, false],
                          ["1–30 days overdue", m.aging.d1_30Minor, true],
                          ["31–60 days overdue", m.aging.d31_60Minor, true],
                          ["Over 60 days overdue", m.aging.d60plusMinor, true],
                        ] as const
                      ).map(([label, v, late]) => (
                        <div key={label} className="flex justify-between">
                          <span className="text-muted-foreground">{label}</span>
                          <span className={`tnum ${late && v > 0 ? "text-destructive" : ""}`}>{money(v, m.currency)}</span>
                        </div>
                      ))}
                    </div>
                  ))}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Subscription</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Plan</span>
                    <span>{s.plan}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Status</span>
                    <span>
                      {s.subscriptionStatus === "ACTIVE" ? (
                        s.subscriptionStatus
                      ) : (
                        <Badge variant="destructive">
                          {s.subscriptionStatus === GROUP_NO_SUBSCRIPTION ? "No subscription" : s.subscriptionStatus}
                        </Badge>
                      )}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Renews</span>
                    <span>{s.currentPeriodEnd ? shortDate(s.currentPeriodEnd) : "—"}</span>
                  </div>
                </CardContent>
              </Card>
            </div>
          </>
        )}
      </div>
    </AppShell>
  );
}
