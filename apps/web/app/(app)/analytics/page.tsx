import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { money } from "@/lib/format";

export const dynamic = "force-dynamic";

interface Overview {
  scope: "school" | "family";
  attendance?: { PRESENT: number; ABSENT: number; LATE: number; EXCUSED: number; total: number; ratePct: number | null };
  fees?: { invoicedMinor: number; collectedMinor: number; outstandingMinor: number; invoices: number };
  operations?: { students?: number; classes?: number; pendingApprovals?: number; integritySignals?: number };
}

function Bar({ label, value, total, tone }: { label: string; value: number; total: number; tone: string }) {
  const pct = total ? Math.round((value / total) * 100) : 0;
  return (
    <div>
      <div className="mb-0.5 flex justify-between text-xs"><span>{label}</span><span className="text-muted-foreground">{value} ({pct}%)</span></div>
      <div className="h-2 w-full rounded bg-muted"><div className={`h-2 rounded ${tone}`} style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

export default async function AnalyticsPage() {
  const session = await auth();
  const user = session!.user;
  const o = await apiGet<Overview>("/analytics/overview");

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="analytics" permissions={user.permissions}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {o?.scope === "school" ? "School-wide figures, last 30 days." : "Your family's figures, last 30 days."}
          </p>
        </div>

        {o?.operations && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {o.operations.students !== undefined && <Stat label="Students" value={String(o.operations.students)} />}
            {o.operations.classes !== undefined && <Stat label="Classes" value={String(o.operations.classes)} />}
            {o.operations.pendingApprovals !== undefined && <Stat label="Approvals pending" value={String(o.operations.pendingApprovals)} />}
            {o.operations.integritySignals !== undefined && <Stat label="Integrity signals (30d)" value={String(o.operations.integritySignals)} />}
          </div>
        )}

        <div className="grid gap-4 lg:grid-cols-2">
          {o?.attendance && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Attendance</CardTitle>
                <CardDescription>{o.attendance.ratePct ?? "—"}% present/late across {o.attendance.total} records</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                <Bar label="Present" value={o.attendance.PRESENT} total={o.attendance.total} tone="bg-primary" />
                <Bar label="Late" value={o.attendance.LATE} total={o.attendance.total} tone="bg-secondary-foreground/60" />
                <Bar label="Absent" value={o.attendance.ABSENT} total={o.attendance.total} tone="bg-destructive" />
                <Bar label="Excused" value={o.attendance.EXCUSED} total={o.attendance.total} tone="bg-muted-foreground/40" />
              </CardContent>
            </Card>
          )}

          {o?.fees && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Fees</CardTitle>
                <CardDescription>{o.fees.invoices} billable invoices</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid grid-cols-3 gap-3 text-center">
                  <div><div className="text-xs text-muted-foreground">Invoiced</div><div className="font-semibold">{money(o.fees.invoicedMinor)}</div></div>
                  <div><div className="text-xs text-muted-foreground">Collected</div><div className="font-semibold">{money(o.fees.collectedMinor)}</div></div>
                  <div><div className="text-xs text-muted-foreground">Outstanding</div><div className="font-semibold">{money(o.fees.outstandingMinor)}</div></div>
                </div>
                <Bar label="Collection rate" value={o.fees.collectedMinor} total={o.fees.invoicedMinor} tone="bg-primary" />
              </CardContent>
            </Card>
          )}
        </div>

        {!o?.attendance && !o?.fees && !o?.operations && (
          <p className="text-sm text-muted-foreground">No analytics available for your role yet.</p>
        )}
      </div>
    </AppShell>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardHeader><CardDescription>{label}</CardDescription><CardTitle className="text-2xl">{value}</CardTitle></CardHeader>
    </Card>
  );
}
