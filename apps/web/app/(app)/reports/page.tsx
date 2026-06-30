import Link from "next/link";
import { hasPermission } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

// Unified Report Center: a single hub linking every report the caller can access.
// Each entry is permission-gated so the page only shows what they may open.
const REPORTS: { title: string; description: string; href: string; perm: string }[] = [
  { title: "Analytics overview", description: "Attendance %, fee collection, operational counts.", href: "/analytics", perm: "attendance.read" },
  { title: "Finance reports", description: "Receivables aging + fee collection.", href: "/fees/reports", perm: "fee.manage" },
  { title: "HR analytics", description: "Headcount, leave, payroll cost, expiring docs.", href: "/hr/analytics", perm: "hr.read" },
  { title: "Access recertification", description: "Who has what access + anomaly signals.", href: "/admin/recertification", perm: "security.audit.read" },
  { title: "Audit log", description: "Scoped, filterable security audit trail.", href: "/admin/audit", perm: "security.audit.read" },
  { title: "Library report", description: "Issued/overdue books + fine collection.", href: "/library", perm: "library.manage" },
  { title: "Form responses", description: "Survey & feedback results.", href: "/forms", perm: "form.manage" },
];

export default async function ReportsPage() {
  const session = await auth();
  const user = session!.user;
  const visible = REPORTS.filter((r) => hasPermission(user.permissions, r.perm as never));
  if (visible.length === 0) redirect("/dashboard");

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="reports" permissions={user.permissions}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Report Center</h1>
          <p className="mt-1 text-sm text-muted-foreground">Every report you can access, in one place.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((r) => (
            <Link key={r.href} href={r.href}>
              <Card className="h-full transition-colors hover:border-primary">
                <CardHeader>
                  <CardTitle className="text-base">{r.title}</CardTitle>
                  <CardDescription>{r.description}</CardDescription>
                </CardHeader>
                <CardContent><span className="text-sm text-primary">Open →</span></CardContent>
              </Card>
            </Link>
          ))}
        </div>
      </div>
    </AppShell>
  );
}
