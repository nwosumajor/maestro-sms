// Platform-owner business dashboard (super_admin home). Cross-tenant metrics —
// customer schools, plan mix, revenue, onboarding pipeline — fetched from
// GET /operator/analytics. Read-only; rendered at the top of the Operator console.

import type { PlatformAnalyticsDto, Serialized } from "@sms/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { money, shortDate } from "@/lib/format";

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-border p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

function Mix({ title, data }: { title: string; data: Record<string, number> }) {
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</p>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {entries.length === 0 ? (
          <span className="text-sm text-muted-foreground">—</span>
        ) : (
          entries.map(([k, v]) => (
            <Badge key={k} variant="secondary" className="font-normal">
              {k}: {v}
            </Badge>
          ))
        )}
      </div>
    </div>
  );
}

export function PlatformAnalytics({ data }: { data: Serialized<PlatformAnalyticsDto> | null }) {
  if (!data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Platform analytics</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Analytics are unavailable (the privileged database connection is not configured).
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Platform analytics</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat
            label="Customer schools"
            value={String(data.schools.total)}
            sub={`${data.schools.active} active · ${data.schools.disabled} disabled`}
          />
          <Stat label="Students" value={data.people.students.toLocaleString()} />
          <Stat label="Staff" value={data.people.staff.toLocaleString()} />
          <Stat
            label="Revenue (paid)"
            value={money(data.revenue.paidTotalMinor)}
            sub={`${money(data.revenue.last30dMinor)} last 30d · ${data.revenue.payments} payments`}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <Mix title="By plan (effective)" data={data.schoolsByPlan} />
          <Mix title="By subscription status" data={data.schoolsByStatus} />
          <Mix title="Onboarding pipeline" data={data.onboardingPipeline} />
        </div>

        {data.recentPayments.length > 0 && (
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Recent payments</p>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="py-1.5 pr-3 font-medium">School</th>
                    <th className="py-1.5 pr-3 font-medium">Plan</th>
                    <th className="py-1.5 pr-3 font-medium">Amount</th>
                    <th className="py-1.5 font-medium">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recentPayments.map((pay, i) => (
                    <tr key={i} className="border-b border-border/50">
                      <td className="py-1.5 pr-3">{pay.schoolName}</td>
                      <td className="py-1.5 pr-3">{pay.plan}</td>
                      <td className="py-1.5 pr-3">{money(pay.amountMinor)}</td>
                      <td className="py-1.5 text-muted-foreground">{shortDate(pay.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
