import type { HrAnalyticsDto, Serialized } from "@sms/types";
import Link from "next/link";
import { hasPermission } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { money } from "@/lib/format";

export const dynamic = "force-dynamic";

function Stat({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{label}</CardTitle></CardHeader>
      <CardContent>
        <p className="text-2xl font-semibold">{value}</p>
        {sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
      </CardContent>
    </Card>
  );
}

export default async function HrAnalyticsPage() {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "hr.read")) redirect("/dashboard");
  const a = await apiGet<Serialized<HrAnalyticsDto>>("/hr/analytics");

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="hr" permissions={user.permissions}>
      <div className="space-y-6">
        <div>
          <Link href="/hr" className="text-sm text-muted-foreground hover:underline">← Back to HR</Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">HR analytics</h1>
          <p className="mt-1 text-sm text-muted-foreground">School-wide HR metrics. No salaries or bank details are shown here.</p>
        </div>

        {!a ? <p className="text-sm text-muted-foreground">No data.</p> : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label="Active staff" value={`${a.headcount.active} / ${a.headcount.total}`} />
              <Stat
                label="Staff accounts"
                value={a.headcount.staffAccounts}
                sub={a.headcount.unrecorded > 0 ? `${a.headcount.unrecorded} awaiting employment record` : undefined}
              />
              <Stat label="Pending leave" value={a.leave.pendingRequests} />
              <Stat label="Leave days taken (YTD)" value={a.leave.daysTakenThisYear} />
              <Stat label="Docs expiring ≤30d" value={a.documents.expiringSoon} />
              <Stat label="Open disciplinary" value={a.disciplinary.openCases} />
              <Stat label="Training (planned/done)" value={`${a.training.planned} / ${a.training.completed}`} />
              <Stat label="Latest payroll net" value={a.payroll.latestPeriod ? money(a.payroll.totalNetMinor) : "—"} />
              <Stat label="Appraisals acknowledged" value={a.appraisals.acknowledged} />
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <Card>
                <CardHeader><CardTitle className="text-base">By department</CardTitle></CardHeader>
                <CardContent className="space-y-1 text-sm">
                  {a.byDepartment.length === 0 ? <p className="text-muted-foreground">No staff.</p> : a.byDepartment.map((d) => (
                    <div key={d.department} className="flex justify-between"><span>{d.department}</span><span className="text-muted-foreground">{d.count}</span></div>
                  ))}
                </CardContent>
              </Card>
              <Card>
                <CardHeader><CardTitle className="text-base">By employment type</CardTitle></CardHeader>
                <CardContent className="space-y-1 text-sm">
                  {a.byEmploymentType.map((t) => (
                    <div key={t.type} className="flex justify-between"><span>{t.type}</span><span className="text-muted-foreground">{t.count}</span></div>
                  ))}
                </CardContent>
              </Card>
            </div>
          </>
        )}
      </div>
    </AppShell>
  );
}
