import type { InvoiceListItemDto, WorkflowSummaryDto, Serialized } from "@sms/types";
import { hasPermission, type Permission } from "@/lib/permissions";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { money } from "@/lib/format";

export const dynamic = "force-dynamic";

type InvoiceRow = Serialized<InvoiceListItemDto>;
type WorkflowRow = Serialized<WorkflowSummaryDto>;

export default async function AdminPage() {
  const session = await auth();
  const user = session!.user;
  // Staff gate: the Admin area is for roles that can manage something.
  if (!hasPermission(user.permissions, "fee.manage")) redirect("/dashboard");

  const [students, classes, invoices, workflows] = await Promise.all([
    apiGet<{ id: string }[]>("/students"),
    apiGet<{ id: string }[]>("/classes/mine"),
    apiGet<InvoiceRow[]>("/invoices"),
    apiGet<WorkflowRow[]>("/workflows"),
  ]);

  const inv = invoices ?? [];
  const outstanding = inv.filter((i) => i.status === "ISSUED" || i.status === "PARTIALLY_PAID");
  const invoicedTotal = inv.reduce((n, i) => n + i.totalMinor, 0);
  const pendingApprovals = (workflows ?? []).filter((w) => w.state === "PENDING_REVIEW").length;

  const stats = [
    { label: "Students", value: String((students ?? []).length), href: "/students" },
    { label: "Classes", value: String((classes ?? []).length), href: "/classes" },
    { label: "Outstanding invoices", value: String(outstanding.length), href: "/fees" },
    { label: "Total invoiced", value: money(invoicedTotal, inv[0]?.currency ?? "NGN"), href: "/fees" },
    { label: "Approvals pending", value: String(pendingApprovals), href: "/workflows" },
  ];

  const actions = ([
    { label: "New invoice", href: "/fees", perm: "fee.manage", desc: "Bill a student for fees" },
    { label: "Fee catalog", href: "/fees", perm: "fee.manage", desc: "Manage reusable fee items" },
    { label: "Send announcement", href: "/notifications", perm: "notification.send", desc: "Notify a student/guardian" },
    { label: "Upload document", href: "/documents", perm: "document.write", desc: "Report cards, certificates" },
    { label: "Manage timetable", href: "/timetable", perm: "timetable.write", desc: "Periods, rooms, lessons" },
    { label: "Manage classes", href: "/classes", perm: "class.write", desc: "Create classes, enroll, assign" },
    { label: "Edit student records", href: "/students", perm: "student.profile.write", desc: "Profile, contacts, medical" },
    { label: "Audit log", href: "/admin/audit", perm: "security.audit.read", desc: "Mutations + sensitive access" },
    { label: "Access elevation", href: "/admin/security", perm: "security.elevation.request", desc: "Just-in-time privileges" },
    { label: "Recertification", href: "/admin/recertification", perm: "security.audit.read", desc: "Roles, assignments, anomalies" },
    { label: "Erasure requests", href: "/admin/privacy", perm: "privacy.erasure.review", desc: "NDPR right-to-erasure review" },
    { label: "Create profiles", href: "/admin/users", perm: "rbac.manage", desc: "Add staff, teachers, parents, students" },
    { label: "Roles & access", href: "/admin/roles", perm: "rbac.manage", desc: "Assign roles to users" },
    { label: "Bulk student onboarding", href: "/admin/import", perm: "student.import", desc: "SIS roster upload (maker-checker)" },
    { label: "Finance reports", href: "/fees/reports", perm: "fee.manage", desc: "Receivables aging + collection" },
    { label: "Admissions", href: "/admin/admissions", perm: "admission.review", desc: "Review public applications" },
  ] satisfies { label: string; href: string; perm: Permission; desc: string }[]).filter(
    (a) => user.permissions.includes(a.perm),
  );

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="admin" permissions={user.permissions}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Admin</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Operational overview and quick actions for {user.schoolName}.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {stats.map((s) => (
            <Link key={s.label} href={s.href}>
              <Card className="transition-colors hover:border-primary/40">
                <CardHeader>
                  <CardDescription>{s.label}</CardDescription>
                  <CardTitle className="text-2xl">{s.value}</CardTitle>
                </CardHeader>
              </Card>
            </Link>
          ))}
        </div>

        <div>
          <h2 className="mb-3 text-sm font-semibold text-muted-foreground">Quick actions</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {actions.map((a) => (
              <Link key={a.label} href={a.href}>
                <Card className="transition-colors hover:border-primary/40">
                  <CardContent className="p-4">
                    <div className="font-medium text-primary">{a.label} →</div>
                    <p className="mt-0.5 text-sm text-muted-foreground">{a.desc}</p>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </AppShell>
  );
}
