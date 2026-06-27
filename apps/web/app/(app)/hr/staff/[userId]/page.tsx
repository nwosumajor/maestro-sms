import type { AppraisalDto, DisciplinaryCaseDto, StaffChecklistDto, StaffDocumentDto, TrainingRecordDto, Serialized } from "@sms/types";
import Link from "next/link";
import { hasPermission } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { StaffLifecyclePanel } from "@/components/hr/StaffLifecyclePanel";
import { ReviewsPanel } from "@/components/hr/ReviewsPanel";

export const dynamic = "force-dynamic";

export default async function StaffDetailPage({ params }: { params: { userId: string } }) {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "hr.read")) redirect("/dashboard");
  const { userId } = params;
  const canAppraise = hasPermission(user.permissions, "hr.appraisal.manage");
  const canDiscipline = hasPermission(user.permissions, "hr.disciplinary.manage");
  const [checklists, documents, training, appraisals, cases] = await Promise.all([
    apiGet<Serialized<StaffChecklistDto>[]>(`/hr/staff/checklists?userId=${userId}`),
    apiGet<Serialized<StaffDocumentDto>[]>(`/hr/staff/documents?userId=${userId}`),
    apiGet<Serialized<TrainingRecordDto>[]>(`/hr/staff/training?userId=${userId}`),
    canAppraise ? apiGet<Serialized<AppraisalDto>[]>(`/hr/appraisals?userId=${userId}`) : Promise.resolve(null),
    canDiscipline ? apiGet<Serialized<DisciplinaryCaseDto>[]>(`/hr/disciplinary?userId=${userId}`) : Promise.resolve(null),
  ]);
  const name = checklists?.[0]?.userName ?? documents?.[0]?.userName ?? training?.[0]?.userName ?? appraisals?.[0]?.userName ?? cases?.[0]?.userName ?? "Staff member";

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="hr" permissions={user.permissions}>
      <div className="space-y-6">
        <div>
          <Link href="/hr" className="text-sm text-muted-foreground hover:underline">← Back to HR</Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">{name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">Onboarding, compliance documents and training for this staff member.</p>
        </div>
        <StaffLifecyclePanel userId={userId} checklists={checklists ?? []} documents={documents ?? []} training={training ?? []} />
        <ReviewsPanel userId={userId} appraisals={appraisals ?? []} cases={cases ?? []} canAppraise={canAppraise} canDiscipline={canDiscipline} />
      </div>
    </AppShell>
  );
}
