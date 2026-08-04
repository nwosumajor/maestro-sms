import type { AcademicSessionDto, AnalyticsOverviewDto, Serialized } from "@sms/types";
import { redirect } from "next/navigation";
import { hasPermission } from "@/lib/permissions";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Kpi } from "@/components/charts/charts";
import { RCDonut, RCColumns, RCBars } from "@/components/charts/rc";
import { RC } from "@/components/charts/colors";
import { money } from "@/lib/format";
import { PageHeader } from "@/components/shell/PageHeader";
import { PeriodBar } from "@/components/analytics/PeriodBar";

export const dynamic = "force-dynamic";

type Overview = Serialized<AnalyticsOverviewDto>;

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams?: { termId?: string; from?: string; to?: string };
}) {
  const session = await auth();
  const user = session!.user;
  // Analytics serves fee.read holders only — school-wide staff + families. Other
  // roles (teacher, HR, warden…) get an empty family scope, so send them to the
  // dashboard instead of a page of zeros (matches the nav gate in AppShell).
  if (!hasPermission(user.permissions, "fee.read")) redirect("/dashboard");
  // The window is a QUERY parameter, so each choice re-runs the server aggregate
  // rather than filtering anything in the browser.
  const qs = new URLSearchParams();
  for (const k of ["termId", "from", "to"] as const) {
    const v = searchParams?.[k];
    if (v) qs.set(k, v);
  }
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  const [o, sessions] = await Promise.all([
    apiGet<Overview>(`/analytics/overview${suffix}`),
    // Term list for the selector. An accountant holds fee.read but not class.read,
    // so this can come back null — the page then offers the current term and an
    // explicit range, rather than failing.
    apiGet<Serialized<AcademicSessionDto>[]>("/academic/sessions"),
  ]);
  const terms = (sessions ?? []).flatMap((s) => s.terms ?? []).slice(0, 12);

  const att = o?.attendance;
  const gr = o?.grades;
  const fees = o?.fees;
  const dem = o?.demographics;

  const toBars = (rec: Record<string, number>, color: string) =>
    Object.entries(rec).sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value, color }));

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="analytics" permissions={user.permissions}>
      <div className="space-y-8">
        <PageHeader
          title={<>Analytics</>}
          subtitle={
            <>
              {o?.scope === "school" ? "School-wide figures" : "Your family's figures"} for{" "}
              {o?.period?.label ?? "the current term"}. Defaults to the current term, so these agree with the
              term-scoped report card.
            </>
          }
        />

        <PeriodBar
          period={o?.period}
          terms={terms}
          activeTermId={searchParams?.termId}
          exportHref={`/api/sms/analytics/overview.csv${suffix}`}
        />

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
                {/* The bands come from the SERVER, on the school's own scale.
                    This line used to spell out "A >= 70 ... F < 45" — a third
                    hard-coded copy of the thresholds, with no E band, which
                    disagreed with both the report card and the aggregate it
                    described. */}
                <CardDescription>
                  Published assignment grades, banded on your school&rsquo;s grading scale
                  {gr.averagePct !== null ? ` — average ${gr.averagePct}%` : ""}.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {gr.graded > 0 ? (
                  <RCColumns
                    data={gr.bands.map((b, i) => ({
                      label: b.grade,
                      value: b.count,
                      // Best band first through to the lowest: the palette walks
                      // from primary to red across however many bands exist, so a
                      // nine-band WAEC scale reads the same way as a five-band one.
                      color: [RC.primary, RC.primarySoft, RC.primaryFaint, RC.amber, RC.red][
                        Math.min(4, Math.floor((i / Math.max(1, gr.bands.length - 1)) * 4))
                      ],
                    }))}
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
