import type { DocumentRequirementDto, Serialized } from "@sms/types";
import { hasPermission } from "@/lib/permissions";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AdmissionsReview, type Application } from "@/components/admissions/AdmissionsReview";
import { FormFeeCard } from "@/components/admissions/FormFeeCard";
import { PageHeader } from "@/components/shell/PageHeader";
import { RequirementsEditor } from "@/components/documents/RequirementsEditor";

export const dynamic = "force-dynamic";

export default async function AdminAdmissionsPage() {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "admission.review")) redirect("/dashboard");
  // Only the registrar tier may shape the document list, so only ask when they
  // can — a 403 read would render as "this school asks for nothing", which is
  // the opposite of the truth.
  const canManageDocs = hasPermission(user.permissions, "student.profile.write");
  const [apps, formFee, requirements] = await Promise.all([
    apiGet<Application[]>("/admissions"),
    apiGet<{ formFeeMinor: number }>("/admissions/settings/form-fee"),
    canManageDocs
      ? apiGet<Serialized<DocumentRequirementDto>[]>("/documents/requirements?scope=STUDENT_ADMISSION")
      : Promise.resolve(null),
  ]);

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="admin" permissions={user.permissions}>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <PageHeader title={<>Admissions</>} subtitle={<>Parent enrolment applications, quarantined from student data until accepted. Each is reviewed by
              School admin → HR → Principal (a different person per stage); schedule the entrance exam and the
              applicant is emailed on acceptance. The public form lives at <code>/enroll</code>.</>} />
          <Link href="/admin" className="text-sm text-muted-foreground hover:underline">← Admin</Link>
        </div>
        {formFee && (
          <FormFeeCard initialMinor={formFee.formFeeMinor} canManage={hasPermission(user.permissions, "fee.manage")} />
        )}
        {/* What families are asked to send. Editable, because schools differ and
            adding one should be a row rather than a release. */}
        {canManageDocs && requirements !== null && (
          <RequirementsEditor
            scope="STUDENT_ADMISSION"
            initial={requirements}
            title="Documents asked of families"
          />
        )}
        {/* A failed read used to render "No applications — none recorded for
            this school", and an admissions officer who believes that stops
            looking. A family waiting on a decision is the cost. */}
        {apps === null ? (
          <Alert variant="destructive">
            <AlertTitle>Applications could not be loaded</AlertTitle>
            <AlertDescription>
              This is not a report that none were submitted. Reload before treating the queue as clear —
              applicants are waiting on a decision.
            </AlertDescription>
          </Alert>
        ) : apps.length === 0 ? (
          <Alert variant="info"><AlertTitle>No applications</AlertTitle><AlertDescription>None recorded for this school.</AlertDescription></Alert>
        ) : (
          <AdmissionsReview apps={apps} />
        )}
      </div>
    </AppShell>
  );
}
