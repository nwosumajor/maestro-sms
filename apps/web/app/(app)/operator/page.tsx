import type { TenantDto, Serialized } from "@sms/types";
import { hasPermission } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { shortDate } from "@/lib/format";

export const dynamic = "force-dynamic";

type Tenant = Serialized<TenantDto>;

export default async function OperatorPage() {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "platform.operate")) redirect("/dashboard");
  const tenants = (await apiGet<Tenant[]>("/operator/tenants")) ?? [];

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="operator" permissions={user.permissions}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Platform operator</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Cross-tenant overview. Impersonation is API-driven, step-up gated, and
            fully audit-logged — never silent.
          </p>
        </div>
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-muted-foreground">
                <tr>
                  <th className="px-4 py-2.5 font-medium">School</th>
                  <th className="px-4 py-2.5 font-medium">Slug</th>
                  <th className="px-4 py-2.5 font-medium">Users</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 font-medium">Since</th>
                </tr>
              </thead>
              <tbody>
                {tenants.map((t) => (
                  <tr key={t.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-2.5 font-medium">{t.name}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">{t.slug}</td>
                    <td className="px-4 py-2.5">{t.users}</td>
                    <td className="px-4 py-2.5"><Badge variant={t.status === "ACTIVE" ? "secondary" : "outline"}>{t.status}</Badge></td>
                    <td className="px-4 py-2.5 text-muted-foreground">{shortDate(t.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
