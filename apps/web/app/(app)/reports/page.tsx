import Link from "next/link";
import { canSeeReportCenter, hasPermission } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

// Unified Report Center: a single hub linking every report the caller can access.
// Each entry is permission-gated so the page only shows what they may open.
//
// GATE PARITY: the analytics entry was gated on `attendance.read` while the
// /analytics NAV entry is gated on `fee.read`, and the two disagreed in both
// directions. A teacher, warden, driver or librarian holds attendance.read and
// not fee.read, so this hub handed them a link to the one page the nav hides
// from them ON PURPOSE — because analytics resolves to an empty "family" scope
// for anyone with no children, i.e. a screen of zeros. A parent or student got
// the opposite problem: a hub containing exactly ONE card, pointing at a page
// already in their nav, described in staff language ("fee collection,
// operational counts") for a view that is family-scoped when they open it.
// One rule, stated once: this card now matches the nav gate exactly, and the
// nav entry for the hub itself (AppShell) is limited to the staff reports —
// so a family reader goes straight to Analytics, where the scope is labelled.
const REPORTS: { title: string; description: string; href: string; perm: string }[] = [
  { title: "Analytics overview", description: "Attendance %, fee collection, operational counts.", href: "/analytics", perm: "fee.read" },
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
  // The SAME gate as the nav entry (one rule, one place). Without it a parent or
  // student reaching this URL directly still got the hub, because they hold
  // fee.read and the analytics card alone kept `visible` non-empty — the nav
  // hiding the link is not a gate.
  if (!canSeeReportCenter(user.permissions)) redirect("/dashboard");
  const visible = REPORTS.filter((r) => hasPermission(user.permissions, r.perm as never));
  if (visible.length === 0) redirect("/dashboard");

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="reports" permissions={user.permissions}>
      <div className="space-y-6">
        <PageHeader title={<>Report Center</>} subtitle={<>Every report you can access, in one place.</>} />
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
