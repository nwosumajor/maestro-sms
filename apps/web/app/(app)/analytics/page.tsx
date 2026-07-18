import type { AnalyticsOverviewDto, Serialized } from "@sms/types";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Kpi } from "@/components/charts/charts";
import { RCDonut, RCColumns, RCBars } from "@/components/charts/rc";
import { RC } from "@/components/charts/colors";
import { money } from "@/lib/format";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

type Overview = Serialized<AnalyticsOverviewDto>;

export default async function AnalyticsPage() {
  const session = await auth();
  const user = session!.user;
  const o = await apiGet<Overview>("/analytics/overview");

  const att = o?.attendance;
  const gr = o?.grades;
  const fees = o?.fees;
  const dem = o?.demographics;

  const toBars = (rec: Record<string, number>, color: string) =>
    Object.entries(rec).sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value, color }));

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="analytics" permissions={user.permissions}>
      <div className="space-y-8">
        <PageHeader title={<>Analytics</>} subtitle={<>{o?.scope === "school" ? "School-wide figures, last 30 days." : "Your family's figures, last 30 days."}</>} />

        {/* KPI band */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {att && <Kpi label="Attendance rate" value={att.ratePct != null ? `${att.ratePct}%` : "—"} sub={`${att.total.toLocaleString()} records`} />}
          {gr && <Kpi label="Average grade" value={gr.averagePct != null ? `${gr.averagePct}%` : "—"} sub={`${gr.graded.toLocaleString()} graded`} />}
          {fees && <Kpi label="Fees collected" value={money(fees.collectedMinor)} sub={`${money(fees.outstandingMinor)} outstanding`} />}
          {o?.operations?.students !== undefined && <Kpi label="Students" value={o.operations.students.toLocaleString()} sub={o.operations.classes !== undefined ? `${o.operations.classes} classes` : undefined} />}
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          {/* Attendance breakdown — donut */}
          {att && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Attendance breakdown</CardTitle>
                <CardDescription>How the last 30 days of registers were marked.</CardDescription>
              </CardHeader>
              <CardContent>
                {att.total > 0 ? (
                  <RCDonut
                    data={[
                      { name: "Present", value: att.PRESENT, color: RC.primary },
                      { name: "Late", value: att.LATE, color: RC.amber },
                      { name: "Excused", value: att.EXCUSED, color: RC.muted },
                      { name: "Absent", value: att.ABSENT, color: RC.red },
                    ]}
                  />
                ) : (
                  <EmptyNote>No attendance has been recorded in the last 30 days.</EmptyNote>
                )}
              </CardContent>
            </Card>
          )}

          {/* Grade distribution — columns */}
          {gr && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Grade distribution</CardTitle>
                <CardDescription>Published grades by band (A ≥ 70 · B 60–69 · C 50–59 · D 45–49 · F &lt; 45).</CardDescription>
              </CardHeader>
              <CardContent>
                {gr.graded > 0 ? (
                  <RCColumns
                    data={[
                      { label: "A", value: gr.A, color: RC.primary },
                      { label: "B", value: gr.B, color: RC.primarySoft },
                      { label: "C", value: gr.C, color: RC.primaryFaint },
                      { label: "D", value: gr.D, color: RC.amber },
                      { label: "F", value: gr.F, color: RC.red },
                    ]}
                  />
                ) : (
                  <EmptyNote>No grades have been published yet.</EmptyNote>
                )}
              </CardContent>
            </Card>
          )}

          {/* Fees — invoiced vs collected vs outstanding */}
          {fees && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Fees</CardTitle>
                <CardDescription>{fees.invoices.toLocaleString()} billable invoices.</CardDescription>
              </CardHeader>
              <CardContent>
                <RCBars
                  money
                  height={180}
                  data={[
                    { label: "Invoiced", value: fees.invoicedMinor / 100, color: RC.primaryFaint },
                    { label: "Collected", value: fees.collectedMinor / 100, color: RC.primary },
                    { label: "Outstanding", value: fees.outstandingMinor / 100, color: RC.amber },
                  ]}
                />
              </CardContent>
            </Card>
          )}

          {/* Operations snapshot (staff) */}
          {o?.operations && (o.operations.pendingApprovals !== undefined || o.operations.integritySignals !== undefined) && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Operations</CardTitle>
                <CardDescription>Live counts across the school.</CardDescription>
              </CardHeader>
              <CardContent>
                <RCBars
                  height={180}
                  data={[
                    ...(o.operations.students !== undefined ? [{ label: "Students", value: o.operations.students, color: RC.primary }] : []),
                    ...(o.operations.classes !== undefined ? [{ label: "Classes", value: o.operations.classes, color: RC.primarySoft }] : []),
                    ...(o.operations.pendingApprovals !== undefined ? [{ label: "Approvals pending", value: o.operations.pendingApprovals, color: RC.amber }] : []),
                    ...(o.operations.integritySignals !== undefined ? [{ label: "Integrity signals", value: o.operations.integritySignals, color: RC.muted }] : []),
                  ]}
                />
              </CardContent>
            </Card>
          )}
        </div>

        {/* Student demographics — every profile parameter, charted */}
        {dem && dem.profiled > 0 && (
          <div className="space-y-4">
            <div>
              <h2 className="text-lg font-semibold tracking-tight">Student demographics</h2>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Across {dem.profiled.toLocaleString()} student profiles in your school.
              </p>
            </div>
            <div className="grid gap-4 lg:grid-cols-3">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">By gender</CardTitle>
                  <CardDescription>Male / female split of the student body.</CardDescription>
                </CardHeader>
                <CardContent>
                  <RCDonut
                    data={[
                      { name: "Male", value: dem.gender.Male ?? 0, color: RC.primary },
                      { name: "Female", value: dem.gender.Female ?? 0, color: RC.primarySoft },
                      ...(dem.gender.Other ? [{ name: "Other", value: dem.gender.Other, color: RC.muted }] : []),
                    ]}
                  />
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">By age band</CardTitle>
                  <CardDescription>Age distribution from dates of birth.</CardDescription>
                </CardHeader>
                <CardContent>
                  <RCColumns data={toBars(dem.ageBand, RC.primary)} />
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">By state of origin</CardTitle>
                  <CardDescription>Where students come from.</CardDescription>
                </CardHeader>
                <CardContent>
                  <RCBars data={toBars(dem.state, RC.primarySoft).slice(0, 8)} />
                </CardContent>
              </Card>
            </div>
          </div>
        )}

        {!att && !gr && !fees && !o?.operations && !dem && (
          <p className="text-sm text-muted-foreground">No analytics available for your role yet.</p>
        )}
      </div>
    </AppShell>
  );
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return <p className="py-6 text-center text-sm text-muted-foreground">{children}</p>;
}
