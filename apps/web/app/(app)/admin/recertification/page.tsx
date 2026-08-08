import type { RecertificationDto, SecurityAnomaliesDto, Serialized } from "@sms/types";
import { hasPermission } from "@/lib/permissions";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

type Recert = Serialized<RecertificationDto>;
type Anomalies = Serialized<SecurityAnomaliesDto>;

export default async function RecertificationPage() {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "security.audit.read")) redirect("/dashboard");

  const [rec, anom] = await Promise.all([
    apiGet<Recert>("/security/recertification"),
    apiGet<Anomalies>("/security/anomalies"),
  ]);

  // A FAILED READ IS NOT A ZERO — and on THIS page a zero is a security
  // all-clear. `?? 0` rendered "Active elevations 0" and "Break-glass (30d) 0"
  // whenever a read failed, which is precisely the finding a reviewer opens
  // this page to look for. An em dash says the figure could not be established.
  const num = (value: number | undefined, unknown: boolean) => (unknown ? "—" : String(value ?? 0));
  const anyMissing = rec === null || anom === null;

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="admin" permissions={user.permissions}>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <PageHeader title={<>Access recertification</>} subtitle={<>Periodic "who can do what" review: role definitions, user assignments,
              live elevations, and anomaly signals.</>} />
          <Link href="/admin" className="text-sm text-muted-foreground hover:underline">← Admin</Link>
        </div>

        {anyMissing && (
          <Alert variant="destructive">
            <AlertTitle>This review is incomplete</AlertTitle>
            <AlertDescription>
              {rec === null && anom === null
                ? "Neither the access review nor the anomaly signals could be loaded."
                : rec === null
                  ? "The access review (elevations and assignments) could not be loaded."
                  : "The anomaly signals (break-glass, medical-record access) could not be loaded."}{" "}
              Figures shown as &ldquo;—&rdquo; are unknown, <strong>not zero</strong>. Do not sign off a
              recertification from this page until it loads cleanly.
            </AlertDescription>
          </Alert>
        )}

        <div className="grid gap-4 sm:grid-cols-3">
          <Card>
            <CardHeader><CardDescription>Active elevations</CardDescription><CardTitle className="text-2xl">{num(rec?.activeElevations.length, rec === null)}</CardTitle></CardHeader>
          </Card>
          <Card>
            <CardHeader><CardDescription>Break-glass (30d)</CardDescription><CardTitle className="text-2xl">{num(anom?.breakGlassCount, anom === null)}</CardTitle></CardHeader>
          </Card>
          <Card>
            <CardHeader><CardDescription>Users reviewed</CardDescription><CardTitle className="text-2xl">{num(rec?.assignments.length, rec === null)}</CardTitle></CardHeader>
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
          <CardHeader>
            <CardTitle className="text-base">Staff access → roles</CardTitle>
            {/* Say what is NOT here. This table used to list every account in
                the school — on a 900-pupil school, 901 of 977 rows were a pupil
                holding "student" — which buried the handful of staff grants a
                reviewer is here to check. Excluding them is only defensible if
                the page admits to it. */}
            <CardDescription>
              Accounts holding a role beyond the pupil/guardian baseline
              {rec !== null && rec.baselineAccountsExcluded > 0 && (
                <>
                  . {rec.baselineAccountsExcluded.toLocaleString()} pupil and guardian account
                  {rec.baselineAccountsExcluded === 1 ? " is" : "s are"} not listed — they hold no role to
                  recertify. Anyone given a staff role appears here regardless.
                </>
              )}
            </CardDescription>
          </CardHeader>
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
