import { hasPermission } from "@/lib/permissions";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { ElevationPanel, type Grant } from "@/components/security/ElevationPanel";

export const dynamic = "force-dynamic";

export default async function SecurityPage() {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "security.elevation.request")) redirect("/dashboard");

  const grants = (await apiGet<Grant[]>("/security/elevation")) ?? [];

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="admin" permissions={user.permissions}>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Access elevation</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Just-in-time, time-boxed privilege grants. Separation of duties on
              approval; every step is audit-logged.
            </p>
          </div>
          <Link href="/admin" className="text-sm text-muted-foreground hover:underline">← Admin</Link>
        </div>

        <ElevationPanel
          grants={grants}
          userId={user.id}
          canApprove={hasPermission(user.permissions, "security.elevation.approve")}
        />
      </div>
    </AppShell>
  );
}
