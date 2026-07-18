import type { AppraisalDto, DisciplinaryCaseDto, EmployeeDto, EmploymentChangeDto, PayComponentDto, StaffChecklistDto, StaffDocumentDto, StaffExitDto, TrainingRecordDto, Serialized } from "@sms/types";
import Link from "next/link";
import { hasPermission } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { StaffLifecyclePanel } from "@/components/hr/StaffLifecyclePanel";
import { ReviewsPanel } from "@/components/hr/ReviewsPanel";
import { CompensationPanel } from "@/components/hr/CompensationPanel";
import { EmploymentLifecycle } from "@/components/hr/EmploymentLifecycle";
import { ExitPanel } from "@/components/hr/ExitPanel";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

export default async function StaffDetailPage({ params }: { params: { userId: string } }) {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "hr.read")) redirect("/dashboard");
  const { userId } = params;
  const canAppraise = hasPermission(user.permissions, "hr.appraisal.manage");
  const canDiscipline = hasPermission(user.permissions, "hr.disciplinary.manage");
  const canWrite = hasPermission(user.permissions, "hr.write");
  const canApprove = hasPermission(user.permissions, "hr.salary.approve");
  const [checklists, documents, training, appraisals, cases, components, employee, changes, exits] = await Promise.all([
    apiGet<Serialized<StaffChecklistDto>[]>(`/hr/staff/checklists?userId=${userId}`),
    apiGet<Serialized<StaffDocumentDto>[]>(`/hr/staff/documents?userId=${userId}`),
    apiGet<Serialized<TrainingRecordDto>[]>(`/hr/staff/training?userId=${userId}`),
    canAppraise ? apiGet<Serialized<AppraisalDto>[]>(`/hr/appraisals?userId=${userId}`) : Promise.resolve(null),
    canDiscipline ? apiGet<Serialized<DisciplinaryCaseDto>[]>(`/hr/disciplinary?userId=${userId}`) : Promise.resolve(null),
    apiGet<Serialized<PayComponentDto>[]>(`/hr/employees/${userId}/components`),
    apiGet<Serialized<EmployeeDto>>(`/hr/employees/${userId}`),
    apiGet<Serialized<EmploymentChangeDto>[]>(`/hr/employment/changes?userId=${userId}`),
    apiGet<Serialized<StaffExitDto>[]>(`/hr/exits`),
  ]);
  const name = checklists?.[0]?.userName ?? documents?.[0]?.userName ?? training?.[0]?.userName ?? appraisals?.[0]?.userName ?? cases?.[0]?.userName ?? "Staff member";

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="hr" permissions={user.permissions}>
      <div className="space-y-6">
        <PageHeader eyebrow={<><Link href="/hr" className="text-sm text-muted-foreground hover:underline">← Back to HR</Link></>} title={<>{name}</>} subtitle={<>Onboarding, compliance documents and training for this staff member.</>} />
        {canWrite && <EmploymentLifecycle userId={userId} employee={employee} initial={changes ?? []} canApprove={canApprove} />}
        {canWrite && <CompensationPanel userId={userId} initial={components ?? []} />}
        {canWrite && <ExitPanel userId={userId} initial={exits ?? []} canApprove={canApprove} />}
        <StaffLifecyclePanel userId={userId} checklists={checklists ?? []} documents={documents ?? []} training={training ?? []} />
        <ReviewsPanel userId={userId} appraisals={appraisals ?? []} cases={cases ?? []} canAppraise={canAppraise} canDiscipline={canDiscipline} />
      </div>
    </AppShell>
  );
}
