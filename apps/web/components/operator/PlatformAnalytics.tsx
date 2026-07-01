// Platform-owner business dashboard (super_admin home). Decision-grade cross-tenant
// metrics from GET /operator/analytics — MRR, growth, acquisition funnel, churn risk,
// module adoption, plan mix, revenue. Server component; interactive Recharts panels
// (client) receive serialisable props. Read-only.

import type { PlatformAnalyticsDto, Serialized } from "@sms/types";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Kpi } from "@/components/charts/charts";
import { RCArea, RCBars, RCColumns, RCDonut } from "@/components/charts/rc";
import { RC } from "@/components/charts/colors";
import { money, shortDate } from "@/lib/format";

const PLAN_PALETTE = [RC.primary, RC.primarySoft, RC.primaryFaint, RC.amber, RC.muted];
const STATUS_COLOR: Record<string, string> = { ACTIVE: RC.primary, PAST_DUE: RC.amber, CANCELED: RC.red, CANCELLED: RC.red };

function planColors(keys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  keys.forEach((k, i) => (out[k] = PLAN_PALETTE[i % PLAN_PALETTE.length]));
  return out;
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
            Analytics are unavailable — the privileged database connection is not configured.
          </p>
        </CardContent>
      </Card>
    );
  }

  const planKeys = [...new Set([...Object.keys(data.schoolsByPlan), ...Object.keys(data.mrr.byPlan)])];
  const planColor = planColors(planKeys);

  const planDonut = Object.entries(data.schoolsByPlan).sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ name, value, color: planColor[name] ?? RC.muted }));
  const statusDonut = Object.entries(data.schoolsByStatus).sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ name, value, color: STATUS_COLOR[name] ?? RC.muted }));
  const mrrByPlan = Object.entries(data.mrr.byPlan).sort((a, b) => b[1] - a[1]).map(([label, v]) => ({ label, value: v / 100, color: planColor[label] ?? RC.primary }));
  const trend = data.growth.map((g) => ({ month: g.month, schools: g.schools, students: g.students, revenue: g.revenueMinor / 100 }));
  const funnel = [
    { label: "Requests", value: data.funnel.requests, color: RC.primaryFaint },
    { label: "Approved", value: data.funnel.approved, color: RC.primarySoft },
    { label: "Provisioned", value: data.funnel.provisioned, color: RC.primary },
    { label: "Paying", value: data.funnel.paying, color: RC.primary },
  ];
  const adoption = data.moduleAdoption.slice(0, 10).map((m) => ({ label: m.label, value: m.schools }));
  const topSchools = data.topSchools.map((s) => ({ label: s.name, value: s.students }));
  const pipeline = Object.entries(data.onboardingPipeline).sort((a, b) => b[1] - a[1]).map(([label, value], i) => ({ label, value, color: PLAN_PALETTE[i % PLAN_PALETTE.length] }));

  return (
    <div className="space-y-6">
      {/* Headline KPIs */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Kpi label="Monthly recurring revenue" value={money(data.mrr.totalMinor)} sub={`${data.mrr.payingSchools} paying schools`} />
        <Kpi label="Avg revenue / school" value={money(data.mrr.arpaMinor)} sub="per month (ARPA)" />
        <Kpi label="Revenue · all time" value={money(data.revenue.paidTotalMinor)} sub={`${money(data.revenue.last30dMinor)} last 30d`} />
        <Kpi label="Customer schools" value={data.schools.total.toLocaleString()} sub={`${data.people.students.toLocaleString()} students · ${data.people.staff.toLocaleString()} staff`} />
      </div>

      {/* Trends */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Revenue trend</CardTitle>
            <CardDescription>Collected subscription revenue, last 6 months.</CardDescription>
          </CardHeader>
          <CardContent>
            <RCArea data={trend} series={[{ key: "revenue", label: "Revenue", color: RC.primary, money: true }]} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Growth</CardTitle>
            <CardDescription>New schools and students onboarded per month.</CardDescription>
          </CardHeader>
          <CardContent>
            <RCArea
              data={trend}
              series={[
                { key: "students", label: "New students", color: RC.primarySoft },
                { key: "schools", label: "New schools", color: RC.primary },
              ]}
            />
          </CardContent>
        </Card>
      </div>

      {/* Plan economics */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Schools by plan</CardTitle>
            <CardDescription>Effective plan in force today.</CardDescription>
          </CardHeader>
          <CardContent>{planDonut.length ? <RCDonut data={planDonut} /> : <Empty>No schools yet.</Empty>}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Subscription status</CardTitle>
            <CardDescription>Where paying schools stand.</CardDescription>
          </CardHeader>
          <CardContent>{statusDonut.length ? <RCDonut data={statusDonut} /> : <Empty>No subscriptions yet.</Empty>}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">MRR by plan</CardTitle>
            <CardDescription>Which tiers drive recurring revenue.</CardDescription>
          </CardHeader>
          <CardContent>{mrrByPlan.length ? <RCColumns data={mrrByPlan} money /> : <Empty>No recurring revenue yet.</Empty>}</CardContent>
        </Card>
      </div>

      {/* Platform-wide student demographics */}
      {data.demographics.profiled > 0 && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Students by gender</CardTitle>
              <CardDescription>Across all customer schools ({data.demographics.profiled.toLocaleString()} profiles).</CardDescription>
            </CardHeader>
            <CardContent>
              <RCDonut
                data={[
                  { name: "Male", value: data.demographics.gender.Male ?? 0, color: RC.primary },
                  { name: "Female", value: data.demographics.gender.Female ?? 0, color: RC.primarySoft },
                  ...(data.demographics.gender.Other ? [{ name: "Other", value: data.demographics.gender.Other, color: RC.muted }] : []),
                ]}
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Students by age band</CardTitle>
              <CardDescription>Platform-wide age distribution.</CardDescription>
            </CardHeader>
            <CardContent>
              <RCColumns
                data={Object.entries(data.demographics.ageBand).sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value, color: RC.primary }))}
              />
            </CardContent>
          </Card>
        </div>
      )}

      {/* Acquisition + product signals */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Acquisition funnel</CardTitle>
            <CardDescription>Request → approve → provision → pay.</CardDescription>
          </CardHeader>
          <CardContent><RCBars data={funnel} /></CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Module adoption</CardTitle>
            <CardDescription>Schools with each module switched on.</CardDescription>
          </CardHeader>
          <CardContent>{adoption.length ? <RCBars data={adoption} color={RC.primarySoft} /> : <Empty>No modules enabled.</Empty>}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Largest schools</CardTitle>
            <CardDescription>By enrolled students.</CardDescription>
          </CardHeader>
          <CardContent>{topSchools.length ? <RCBars data={topSchools} color={RC.primary} /> : <Empty>No schools yet.</Empty>}</CardContent>
        </Card>
      </div>

      {/* Risk + revenue feed */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Retention risk</CardTitle>
            <CardDescription>Delinquent and churned accounts to act on.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-3 gap-3">
              <RiskTile label="Past due" value={data.risk.pastDue} tone="amber" />
              <RiskTile label="Canceled" value={data.risk.canceled} tone="red" />
              <RiskTile label="Onboarding" value={pipeline.reduce((a, b) => a + b.value, 0)} tone="muted" />
            </div>
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
              <p className="eyebrow text-amber-700">MRR at risk</p>
              <p className="tnum mt-1 text-lg font-semibold">{money(data.risk.atRiskMrrMinor)}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">Recurring revenue from past-due schools — recover before it churns.</p>
            </div>
            {pipeline.length > 0 && <RCBars data={pipeline} height={140} color={RC.muted} />}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Latest payments</CardTitle>
            <CardDescription>Most recent subscription payments.</CardDescription>
          </CardHeader>
          <CardContent>
            {data.recentPayments.length ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs text-muted-foreground">
                      <th className="py-1.5 pr-3 font-medium">School</th>
                      <th className="py-1.5 pr-3 font-medium">Plan</th>
                      <th className="py-1.5 pr-3 text-right font-medium">Amount</th>
                      <th className="py-1.5 font-medium">Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recentPayments.slice(0, 7).map((pay, i) => (
                      <tr key={i} className="border-b border-border/50">
                        <td className="py-1.5 pr-3">{pay.schoolName}</td>
                        <td className="py-1.5 pr-3 text-muted-foreground">{pay.plan}</td>
                        <td className="tnum py-1.5 pr-3 text-right font-medium">{money(pay.amountMinor)}</td>
                        <td className="py-1.5 text-muted-foreground">{shortDate(pay.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty>No payments recorded yet.</Empty>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function RiskTile({ label, value, tone }: { label: string; value: number; tone: "amber" | "red" | "muted" }) {
  const color = tone === "amber" ? "text-amber-600" : tone === "red" ? "text-destructive" : "text-foreground";
  return (
    <div className="rounded-lg border border-border/70 bg-background/60 p-3 text-center">
      <p className={`tnum text-2xl font-semibold tracking-tight ${color}`}>{value.toLocaleString()}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-6 text-center text-sm text-muted-foreground">{children}</p>;
}
