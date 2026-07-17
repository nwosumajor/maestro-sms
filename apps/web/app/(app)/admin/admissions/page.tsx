import { hasPermission } from "@/lib/permissions";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AdmissionsReview, type Application } from "@/components/admissions/AdmissionsReview";
import { FormFeeCard } from "@/components/admissions/FormFeeCard";

export const dynamic = "force-dynamic";

export default async function AdminAdmissionsPage() {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "admission.review")) redirect("/dashboard");
  const [apps, formFee] = await Promise.all([
    apiGet<Application[]>("/admissions").then((a) => a ?? []),
    apiGet<{ formFeeMinor: number }>("/admissions/settings/form-fee"),
  ]);

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="admin" permissions={user.permissions}>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Admissions</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Parent enrolment applications, quarantined from student data until accepted. Each is reviewed by
              School admin → HR → Principal (a different person per stage); schedule the entrance exam and the
              applicant is emailed on acceptance. The public form lives at <code>/enroll</code>.
            </p>
          </div>
          <Link href="/admin" className="text-sm text-muted-foreground hover:underline">← Admin</Link>
        </div>
        {formFee && (
          <FormFeeCard initialMinor={formFee.formFeeMinor} canManage={hasPermission(user.permissions, "fee.manage")} />
        )}
        {apps.length === 0 ? (
          <Alert variant="info"><AlertTitle>No applications</AlertTitle><AlertDescription>None received yet.</AlertDescription></Alert>
        ) : (
          <AdmissionsReview apps={apps} />
        )}
      </div>
    </AppShell>
  );
}
