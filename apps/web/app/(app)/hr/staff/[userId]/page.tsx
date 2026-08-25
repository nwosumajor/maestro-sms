import type { AppraisalDto, DisciplinaryCaseDto, EmployeeDto, EmploymentChangeDto, PayComponentDto, StaffChecklistDto, StaffDocumentDto, StaffExitDto, SubmissionChecklistDto, TrainingRecordDto, Serialized, StaffHandoverDto } from "@sms/types";
import Link from "next/link";
import { hasPermission } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { LoadFailure } from "@/components/ui/load-failure";
import { StaffLifecyclePanel } from "@/components/hr/StaffLifecyclePanel";
import { ReviewsPanel } from "@/components/hr/ReviewsPanel";
import { CompensationPanel } from "@/components/hr/CompensationPanel";
import { EmploymentLifecycle } from "@/components/hr/EmploymentLifecycle";
import { ExitPanel } from "@/components/hr/ExitPanel";
import { PageHeader } from "@/components/shell/PageHeader";
import { HandoverPanel } from "@/components/hr/HandoverPanel";
import { DocumentChecklist } from "@/components/documents/DocumentChecklist";

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
  const [checklists, documents, training, appraisals, cases, components, employee, changes, exits, docChecklist, handover] = await Promise.all([
    apiGet<Serialized<StaffChecklistDto>[]>(`/hr/staff/checklists?userId=${userId}`),
    apiGet<Serialized<StaffDocumentDto>[]>(`/hr/staff/documents?userId=${userId}`),
    apiGet<Serialized<TrainingRecordDto>[]>(`/hr/staff/training?userId=${userId}`),
    canAppraise ? apiGet<Serialized<AppraisalDto>[]>(`/hr/appraisals?userId=${userId}`) : Promise.resolve(null),
    canDiscipline ? apiGet<Serialized<DisciplinaryCaseDto>[]>(`/hr/disciplinary?userId=${userId}`) : Promise.resolve(null),
    apiGet<Serialized<PayComponentDto>[]>(`/hr/employees/${userId}/components`),
    apiGet<Serialized<EmployeeDto>>(`/hr/employees/${userId}`),
    apiGet<Serialized<EmploymentChangeDto>[]>(`/hr/employment/changes?userId=${userId}`),
    apiGet<Serialized<StaffExitDto>[]>(`/hr/exits`),
    // The onboarding paperwork. Only HR may read it, so ask only when they can
    // — an unauthorised call would 403 and render as "nothing outstanding",
    // which is the opposite of the truth.
    canWrite
      ? apiGet<Serialized<SubmissionChecklistDto>>(`/documents/checklist?subjectKind=STAFF&subjectId=${userId}`)
      : Promise.resolve(null),
    // What they still hold. Worth knowing BEFORE an exit as much as after —
    // "what would we have to cover" is the question a head asks the moment
    // somebody hands in their notice.
    canWrite ? apiGet<Serialized<StaffHandoverDto>>(`/hr/staff/${userId}/handover`) : Promise.resolve(null),
  ]);
  // The employment record is where a name comes from; it hangs off `user`. The
  // five lists below are a fallback for a record this reader cannot see, never
  // the primary source — scavenging the title from whichever of them happened
  // to have a row showed the literal "Staff member" to anyone with none, which
  // is every newly-recorded employee.
  const name =
    employee?.user?.name ??
    checklists?.[0]?.userName ??
    documents?.[0]?.userName ??
    training?.[0]?.userName ??
    appraisals?.[0]?.userName ??
    cases?.[0]?.userName ??
    "Staff member";

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="hr" permissions={user.permissions}>
      <div className="space-y-6">
        <PageHeader eyebrow={<><Link href="/hr" className="text-sm text-muted-foreground hover:underline">← Back to HR</Link></>} title={<>{name}</>} subtitle={<>Onboarding, compliance documents and training for this staff member.</>} />
        {/* Employment changes and exits are maker-checker, and a disciplinary
            case file is a record someone relies on being complete. An empty
            panel from a failed read reads as "nothing on file". */}
        {/* What this member of staff still owes the school. Their CV arrives
            here automatically when they are hired. */}
        {canWrite && docChecklist && (
          <DocumentChecklist subjectKind="STAFF" subjectId={userId} initial={docChecklist} canDecide />
        )}
        {canWrite && (changes === null || exits === null) && (
          <LoadFailure what="This staff member's employment history">
            Confirmations, promotions or an exit awaiting a second approver would not be shown.
          </LoadFailure>
        )}
        {canWrite && <EmploymentLifecycle userId={userId} employee={employee} initial={changes ?? []} canApprove={canApprove} />}
        {canWrite && <CompensationPanel userId={userId} initial={components ?? []} />}
        {canWrite && <ExitPanel userId={userId} initial={exits ?? []} canApprove={canApprove} />}
        {canWrite && <HandoverPanel handover={handover} />}
        <StaffLifecyclePanel userId={userId} checklists={checklists ?? []} documents={documents ?? []} training={training ?? []} />
        {(appraisals === null || cases === null) && (
          <LoadFailure what="Appraisals and disciplinary cases">
            Treat the panel below as incomplete — an open case may exist that is not listed.
          </LoadFailure>
        )}
        <ReviewsPanel userId={userId} appraisals={appraisals ?? []} cases={cases ?? []} canAppraise={canAppraise} canDiscipline={canDiscipline} />
      </div>
    </AppShell>
  );
}
