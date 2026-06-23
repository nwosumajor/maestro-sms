import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

interface Recert {
  roles: { name: string; permissions: string[] }[];
  assignments: { id: string; name: string; email: string; roles: string[] }[];
  activeElevations: { id: string; permission: string; reason: string; breakGlass: boolean }[];
}
interface Anomalies {
  breakGlassCount: number;
  topMedicalReaders: { actorName: string; count: number }[];
}

export default async function RecertificationPage() {
  const session = await auth();
  const user = session!.user;
  if (!user.permissions.includes("security.audit.read")) redirect("/dashboard");

  const [rec, anom] = await Promise.all([
    apiGet<Recert>("/security/recertification"),
    apiGet<Anomalies>("/security/anomalies"),
  ]);

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="admin" permissions={user.permissions}>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Access recertification</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Periodic "who can do what" review: role definitions, user assignments,
              live elevations, and anomaly signals.
            </p>
          </div>
          <Link href="/admin" className="text-sm text-muted-foreground hover:underline">← Admin</Link>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <Card>
            <CardHeader><CardDescription>Active elevations</CardDescription><CardTitle className="text-2xl">{rec?.activeElevations.length ?? 0}</CardTitle></CardHeader>
          </Card>
          <Card>
            <CardHeader><CardDescription>Break-glass (30d)</CardDescription><CardTitle className="text-2xl">{anom?.breakGlassCount ?? 0}</CardTitle></CardHeader>
          </Card>
          <Card>
            <CardHeader><CardDescription>Users reviewed</CardDescription><CardTitle className="text-2xl">{rec?.assignments.length ?? 0}</CardTitle></CardHeader>
          </Card>
        </div>

        {anom && anom.topMedicalReaders.length > 0 && (
          <Card>
            <CardHeader><CardTitle className="text-base">Medical-record access (30 days)</CardTitle><CardDescription>Unusually high access is worth a look.</CardDescription></CardHeader>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <tbody>
                  {anom.topMedicalReaders.map((r) => (
                    <tr key={r.actorName} className="border-b border-border last:border-0">
                      <td className="px-4 py-2">{r.actorName}</td>
                      <td className="px-4 py-2 text-right text-muted-foreground">{r.count} reads</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader><CardTitle className="text-base">User → roles</CardTitle></CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <tbody>
                {(rec?.assignments ?? []).map((a) => (
                  <tr key={a.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-2 font-medium">{a.name}</td>
                    <td className="px-4 py-2 text-muted-foreground">{a.email}</td>
                    <td className="px-4 py-2">
                      <div className="flex flex-wrap gap-1">{a.roles.map((r) => <Badge key={r} variant="secondary">{r}</Badge>)}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Role → permissions</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {(rec?.roles ?? []).map((r) => (
              <div key={r.name}>
                <div className="mb-1 text-sm font-medium">{r.name} <span className="text-muted-foreground">({r.permissions.length})</span></div>
                <div className="flex flex-wrap gap-1">
                  {r.permissions.map((p) => <code key={p} className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{p}</code>)}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
