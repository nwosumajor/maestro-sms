import type { InvoiceSummaryDto, WorkflowSummaryDto, Serialized } from "@sms/types";
import { hasPermission, type Permission } from "@/lib/permissions";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { money } from "@/lib/format";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

type InvoiceSummary = Serialized<InvoiceSummaryDto>;
type WorkflowRow = Serialized<WorkflowSummaryDto>;

export default async function AdminPage() {
  const session = await auth();
  const user = session!.user;
  // Staff gate: the Admin area is for roles that can manage something.
  if (!hasPermission(user.permissions, "fee.manage")) redirect("/dashboard");

  const [students, classes, invoices, workflows] = await Promise.all([
    // The COUNT, not the roster. This tile counting `.length` of /students is why
    // that list had to stay uncapped — and why the whole roster was shipped to
    // five pages to render one number.
    apiGet<{ students: number }>("/students/count"),
    apiGet<{ id: string }[]>("/classes/mine"),
    // The SUMMARY aggregate, not a page of rows. Summing rows in Node only ever
    // covered the most recent page, so "Total invoiced" quietly under-reported once
    // a school passed that many invoices.
    apiGet<InvoiceSummary>("/invoices/summary"),
    // A PAGE, not an array — /workflows is filtered and paged. This tile counts
    // what is waiting on THIS person, which the API already computes, so ask for
    // exactly that instead of counting a page of the whole school's register.
    apiGet<{ items: WorkflowRow[]; total: number }>("/workflows?mine=1"),
  ]);

  // A FAILED READ IS NOT A ZERO. `?? 0` here printed "Outstanding ₦0.00",
  // "Past due 0" and "Approvals pending 0" whenever a read failed — telling an
  // administrator every fee is collected and nothing is waiting on them. /dashboard
  // was fixed this way already; this page kept the false zeros.
  const feesUnknown = invoices === null;
  const currency = invoices?.currency ?? "NGN";
  const pendingApprovals = workflows?.total ?? 0;

  /** An em dash where a number cannot be established. */
  const num = (value: number, unknown: boolean) => (unknown ? "—" : String(value));
  const cash = (minor: number, unknown: boolean) => (unknown ? "—" : money(minor, currency));

  const stats = [
    { label: "Students", value: num(students?.students ?? 0, students === null), href: "/students" },
    { label: "Classes", value: num((classes ?? []).length, classes === null), href: "/classes" },
    { label: "Outstanding", value: cash(invoices?.outstandingMinor ?? 0, feesUnknown), href: "/fees" },
    { label: "Collected", value: cash(invoices?.collectedMinor ?? 0, feesUnknown), href: "/fees" },
    { label: "Past due", value: num(invoices?.overdueCount ?? 0, feesUnknown), href: "/fees" },
    { label: "Approvals pending", value: num(pendingApprovals, workflows === null), href: "/workflows" },
  ];
  const anyFigureMissing = students === null || classes === null || feesUnknown || workflows === null;

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
    { label: "Data protection", href: "/admin/compliance", perm: "privacy.compliance.manage", desc: "Regime, DPO, breach register" },
    { label: "Long-term archives", href: "/admin/archives", perm: "privacy.archive.manage", desc: "Year snapshots for a records request years later" },
    // Two CSV exports that existed with no download link anywhere — a leader
    // could not get their own roster out of the product without an API call.
    { label: "Student roster (CSV)", href: "/api/sms/admin/export/students.csv", perm: "rbac.manage", desc: "Every student, for a spreadsheet or a return", download: true },
    { label: "Staff list (CSV)", href: "/api/sms/admin/export/staff.csv", perm: "rbac.manage", desc: "Every staff member and their roles", download: true },
    { label: "Create profiles", href: "/admin/users", perm: "rbac.manage", desc: "Add staff, teachers, parents, students" },
    { label: "Roles & access", href: "/admin/roles", perm: "rbac.manage", desc: "Assign roles to users" },
    { label: "Bulk student onboarding", href: "/admin/import", perm: "student.import", desc: "SIS roster upload (maker-checker)" },
    { label: "Parent onboarding", href: "/admin/parents", perm: "parent.import", desc: "Create guardian logins + link children" },
    { label: "Finance reports", href: "/fees/reports", perm: "fee.manage", desc: "Receivables aging + collection" },
    { label: "Admissions", href: "/admin/admissions", perm: "admission.review", desc: "Review public applications" },
    { label: "School branding", href: "/admin/branding", perm: "school.branding.manage", desc: "Logo + brand colour (login, certificates, ID cards)" },
  ] satisfies { label: string; href: string; perm: Permission; desc: string; download?: boolean }[]).filter(
    (a) => user.permissions.includes(a.perm),
  );

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="admin" permissions={user.permissions}>
      <div className="space-y-6">
        <PageHeader title={<>Admin</>} subtitle={<>Operational overview and quick actions for {user.schoolName}.</>} />

        {anyFigureMissing && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
            Some figures below could not be loaded and show as &ldquo;—&rdquo;. That is a failure to read them, not
            a zero — do not treat a dash as &ldquo;nothing outstanding&rdquo;.
          </div>
        )}

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
            {actions.map((a) => {
              const card = (
                <Card className="transition-colors hover:border-primary/40">
                  <CardContent className="p-4">
                    <div className="font-medium text-primary">{a.label} →</div>
                    <p className="mt-0.5 text-sm text-muted-foreground">{a.desc}</p>
                  </CardContent>
                </Card>
              );
              // A file download must be a real anchor: next/link would attempt a
              // client-side navigation to a CSV and simply do nothing visible.
              return "download" in a && a.download ? (
                <a key={a.label} href={a.href} download>
                  {card}
                </a>
              ) : (
                <Link key={a.label} href={a.href}>
                  {card}
                </Link>
              );
            })}
          </div>
        </div>
      </div>
    </AppShell>
  );
}
