import type { AuditLogPageDto, Serialized } from "@sms/types";
import { hasPermission } from "@/lib/permissions";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { AuditLog } from "@/components/security/AuditLog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

type AuditPage = Serialized<AuditLogPageDto>;

export default async function AuditPage({ searchParams }: { searchParams: { action?: string; entity?: string } }) {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "security.audit.read")) redirect("/dashboard");

  const qs = new URLSearchParams();
  if (searchParams.action) qs.set("action", searchParams.action);
  if (searchParams.entity) qs.set("entity", searchParams.entity);
  const query = qs.toString();
  const page = await apiGet<AuditPage>(`/security/audit${query ? `?${query}` : ""}`);

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="admin" permissions={user.permissions}>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <PageHeader title={<>Audit log</>} subtitle={<>Every mutation and sensitive access, append-only and tamper-evident.
              Scoped to your school.</>} />
          <Link href="/admin" className="text-sm text-muted-foreground hover:underline">← Admin</Link>
        </div>

        <div className="flex flex-wrap gap-2 text-sm">
          <span className="text-muted-foreground">Quick filters:</span>
          {["security.", "medical", "fee.", "document.", "attendance."].map((a) => (
            <Link key={a} href={`/admin/audit?action=${a}`} className="rounded-md border border-border px-2 py-0.5 text-muted-foreground hover:bg-accent">{a}</Link>
          ))}
          {(searchParams.action || searchParams.entity) && (
            <Link href="/admin/audit" className="rounded-md border border-primary px-2 py-0.5 text-primary">clear</Link>
          )}
        </div>

        {page === null ? (
          <Alert variant="info"><AlertTitle>No access</AlertTitle><AlertDescription>Session expired.</AlertDescription></Alert>
        ) : page.entries.length === 0 ? (
          <Alert variant="info"><AlertTitle>No entries</AlertTitle><AlertDescription>Nothing matches.</AlertDescription></Alert>
        ) : (
          <AuditLog initial={page.entries} nextCursor={page.nextCursor} query={query} />
        )}
      </div>
    </AppShell>
  );
}
