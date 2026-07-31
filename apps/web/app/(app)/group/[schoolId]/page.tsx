// One campus in depth, for a director who wants to know WHY a row looks wrong.
// Aggregates only — monthly totals, status counts, headcount. A director is not
// staff at this campus and never reaches a pupil, an invoice or a record here;
// those stay behind that school's own permissions. 404 unless the campus is in a
// group they direct.

import type { GroupSchoolDetailDto, Serialized } from "@sms/types";
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

export default async function GroupSchoolPage({ params }: { params: { schoolId: string } }) {
  const session = await auth();
  const user = session!.user;
  const s = await apiGet<Serialized<GroupSchoolDetailDto>>(`/group/schools/${params.schoolId}`);

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="group" permissions={user.permissions}>
      <div className="space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <PageHeader
            title={<>{s ? s.name : "Campus"}</>}
            subtitle={s ? <>{s.groupName} · figures only, never pupil records.</> : <>Not available.</>}
          />
          <Link href="/group" className={buttonVariants({ variant: "outline", size: "sm" })}>
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
                    {f.toLowerCase().replace(/_/g, " ")}
                  </Badge>
                ))}
              </div>
            )}

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
                <CardDescription>Collections and attendance, month by month.</CardDescription>
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
                        <td className="px-4 py-2.5">{t.month}</td>
                        <td className="tnum px-4 py-2.5 text-right">
                          {money(t.collectedMinor, s.money[0]?.currency ?? "NGN")}
                        </td>
                        <td className="tnum px-4 py-2.5 text-right">
                          {t.attendancePct == null ? (
                            <span className="text-muted-foreground">—</span>
                          ) : (
                            <span className={t.attendancePct < 85 ? "font-medium text-destructive" : ""}>
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
                  <CardDescription>Invoices by status — outstanding is what has been issued but not paid.</CardDescription>
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
                    <div key={m.currency} className="flex justify-between border-t pt-2">
                      <span className="text-muted-foreground">Outstanding ({m.currency})</span>
                      <span className="tnum">{money(m.outstandingMinor, m.currency)}</span>
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
                        <Badge variant="destructive">{s.subscriptionStatus}</Badge>
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
