import type { AuditLogRowDto, Serialized } from "@sms/types";
import { hasPermission } from "@/lib/permissions";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Card, CardContent } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { dateTime } from "@/lib/format";

export const dynamic = "force-dynamic";

type AuditRow = Serialized<AuditLogRowDto>;

export default async function AuditPage({ searchParams }: { searchParams: { action?: string; entity?: string } }) {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "security.audit.read")) redirect("/dashboard");

  const qs = new URLSearchParams();
  if (searchParams.action) qs.set("action", searchParams.action);
  if (searchParams.entity) qs.set("entity", searchParams.entity);
  const rows = await apiGet<AuditRow[]>(`/security/audit${qs.toString() ? `?${qs}` : ""}`);

  const isSecurity = (a: string) => a.startsWith("security.") || a.includes("medical") || a.includes("download");

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="admin" permissions={user.permissions}>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Audit log</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Every mutation and sensitive access, append-only and tamper-evident.
              Scoped to your school.
            </p>
          </div>
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

        {rows === null ? (
          <Alert variant="info"><AlertTitle>No access</AlertTitle><AlertDescription>Session expired.</AlertDescription></Alert>
        ) : rows.length === 0 ? (
          <Alert variant="info"><AlertTitle>No entries</AlertTitle><AlertDescription>Nothing matches.</AlertDescription></Alert>
        ) : (
          <Card>
            <CardContent className="overflow-x-auto p-0">
              <table className="w-full text-sm">
                <thead className="border-b border-border text-left text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2.5 font-medium">When</th>
                    <th className="px-4 py-2.5 font-medium">Actor</th>
                    <th className="px-4 py-2.5 font-medium">Action</th>
                    <th className="px-4 py-2.5 font-medium">Entity</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b border-border last:border-0">
                      <td className="whitespace-nowrap px-4 py-2 text-muted-foreground">{dateTime(r.createdAt)}</td>
                      <td className="px-4 py-2">{r.actorName}</td>
                      <td className="px-4 py-2">
                        <code className={isSecurity(r.action) ? "text-destructive" : ""}>{r.action}</code>
                      </td>
                      <td className="px-4 py-2 text-muted-foreground">{r.entity}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        )}
      </div>
    </AppShell>
  );
}
