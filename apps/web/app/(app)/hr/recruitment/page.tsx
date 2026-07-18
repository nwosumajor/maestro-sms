import type { ApplicantDto, JobRequisitionDto, Serialized } from "@sms/types";
import Link from "next/link";
import { hasPermission } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { RecruitmentManager } from "@/components/hr/RecruitmentManager";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

export default async function RecruitmentPage() {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "hr.recruit.manage")) redirect("/dashboard");
  const [requisitions, applicants] = await Promise.all([
    apiGet<Serialized<JobRequisitionDto>[]>("/hr/recruitment/requisitions"),
    apiGet<Serialized<ApplicantDto>[]>("/hr/recruitment/applicants"),
  ]);

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="hr" permissions={user.permissions}>
      <div className="space-y-6">
        <PageHeader eyebrow={<><Link href="/hr" className="text-sm text-muted-foreground hover:underline">← Back to HR</Link></>} title={<>Recruitment</>} subtitle={<>Job requisitions and the applicant pipeline. Hiring an applicant provisions a staff account.</>} />
        <RecruitmentManager requisitions={requisitions ?? []} applicants={applicants ?? []} />
      </div>
    </AppShell>
  );
}
