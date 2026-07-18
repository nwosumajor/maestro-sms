import type { GroupOverviewDto, Serialized } from "@sms/types";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { money, shortDate } from "@/lib/format";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

// Cross-campus dashboard for multi-school proprietors (the GROUP add-on).
// Directorship is verified server-side (404 for everyone else) — this page
// simply renders whatever the API allows. Aggregates only, never student PII.
export default async function GroupPage() {
  const session = await auth();
  const user = session!.user;
  const data = await apiGet<Serialized<GroupOverviewDto>>("/group/overview");

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="group" permissions={user.permissions}>
      <div className="space-y-6">
        <PageHeader title={<>{data ? data.groupName : "Group console"}</>} subtitle={<>One view across every campus — enrollment, attendance, collections, and each school&apos;s
            subscription health.</>} />

        {!data ? (
          <Alert variant="info">
            <AlertTitle>No group access</AlertTitle>
            <AlertDescription>
              This console is for designated group directors. If you run several schools on the platform,
              ask the platform operator to set up your group and name you as a director.
            </AlertDescription>
          </Alert>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {(
                [
                  ["Students", data.totals.students.toLocaleString()],
                  ["Staff", data.totals.staff.toLocaleString()],
                  ["Collected this month", money(data.totals.collectedThisMonthMinor, "NGN")],
                  ["Outstanding fees", money(data.totals.outstandingFeesMinor, "NGN")],
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
              <CardHeader>
                <CardTitle className="text-base">Campuses ({data.schools.length})</CardTitle>
                <CardDescription>Today&apos;s attendance and this month&apos;s collections, per school.</CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-muted-foreground">
                        <th className="px-4 py-2 font-medium">School</th>
                        <th className="px-4 py-2 font-medium">Students</th>
                        <th className="px-4 py-2 font-medium">Staff</th>
                        <th className="px-4 py-2 font-medium">Attendance today</th>
                        <th className="px-4 py-2 font-medium">Collected (month)</th>
                        <th className="px-4 py-2 font-medium">Outstanding</th>
                        <th className="px-4 py-2 font-medium">Plan</th>
                        <th className="px-4 py-2 font-medium">Renews</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.schools.map((s) => (
                        <tr key={s.schoolId} className="border-b last:border-0">
                          <td className="px-4 py-2.5">
                            <span className="font-medium">{s.name}</span>
                            {!s.active && <Badge variant="destructive" className="ml-2">Disabled</Badge>}
                          </td>
                          <td className="tnum px-4 py-2.5">{s.students.toLocaleString()}</td>
                          <td className="tnum px-4 py-2.5">{s.staff.toLocaleString()}</td>
                          <td className="tnum px-4 py-2.5">
                            {s.attendanceTodayPct == null ? (
                              <span className="text-muted-foreground">no register yet</span>
                            ) : (
                              <span className={s.attendanceTodayPct < 80 ? "font-medium text-destructive" : ""}>
                                {s.attendanceTodayPct}%
                              </span>
                            )}
                          </td>
                          <td className="tnum px-4 py-2.5">{money(s.collectedThisMonthMinor, "NGN")}</td>
                          <td className="tnum px-4 py-2.5">
                            <span className={s.outstandingFeesMinor > 0 ? "text-amber-600 dark:text-amber-400" : ""}>
                              {money(s.outstandingFeesMinor, "NGN")}
                            </span>
                          </td>
                          <td className="px-4 py-2.5">
                            {s.plan}
                            {s.subscriptionStatus !== "ACTIVE" && (
                              <Badge variant="destructive" className="ml-1.5">{s.subscriptionStatus}</Badge>
                            )}
                          </td>
                          <td className="px-4 py-2.5">{s.currentPeriodEnd ? shortDate(s.currentPeriodEnd) : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </AppShell>
  );
}
