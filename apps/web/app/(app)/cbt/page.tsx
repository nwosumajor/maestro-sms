import type { CbtAuthoringOptionsDto, CbtBankDto, CbtExamDto, Serialized } from "@sms/types";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { hasPermission } from "@/lib/permissions";
import { AppShell } from "@/components/shell/AppShell";
import { CbtStaffPanel } from "@/components/cbt/CbtStaffPanel";
import { CbtReviewPanel } from "@/components/cbt/CbtReviewPanel";
import { CbtStudentList } from "@/components/cbt/CbtStudentList";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

// CBT exam hall (add-on module). THREE audiences, not two:
//   - authors (cbt.manage)  -> author banks + run exams
//   - reviewers (cbt.review) -> read-only oversight of banks/questions, no key.
//     The head teacher approves CBT publishing, so they must be able to vet what
//     is going to students; without this branch they fell to the student view.
//   - students (cbt.take)   -> sit their own exams
export default async function CbtPage() {
  const session = await auth();
  const user = session!.user;
  // Mirrors the nav's anyPerm — any ONE of these may open the section.
  if (!hasPermission(user.permissions, "cbt.manage") && !hasPermission(user.permissions, "cbt.take") && !hasPermission(user.permissions, "cbt.review")) redirect("/dashboard");
  const isStaff = hasPermission(user.permissions, "cbt.manage");
  const isReviewer = !isStaff && hasPermission(user.permissions, "cbt.review");

  const emptyOptions: Serialized<CbtAuthoringOptionsDto> = { schoolWide: false, subjects: [], classes: [] };
  let banks: Serialized<CbtBankDto>[] = [];
  let exams: Serialized<CbtExamDto>[] = [];
  let options = emptyOptions;

  if (isStaff) {
    [banks, exams, options] = await Promise.all([
      apiGet<Serialized<CbtBankDto>[]>("/cbt/banks").then((r) => r ?? []),
      apiGet<Serialized<CbtExamDto>[]>("/cbt/exams/all").then((r) => r ?? []),
      apiGet<Serialized<CbtAuthoringOptionsDto>>("/cbt/authoring-options").then((r) => r ?? emptyOptions),
    ]);
  } else if (isReviewer) {
    // Banks only — a reviewer authors nothing, so no authoring options are fetched.
    banks = await apiGet<Serialized<CbtBankDto>[]>("/cbt/banks").then((r) => r ?? []);
  } else {
    exams = await apiGet<Serialized<CbtExamDto>[]>("/cbt/exams").then((r) => r ?? []);
  }

  const subtitle = isStaff
    ? "Timed, auto-marked mock exams (WAEC/JAMB style) from your question banks. Publish an exam and every student gets a freshly-sampled paper."
    : isReviewer
      ? "Read the question banks before you approve an exam for publishing. Answer keys stay with the subject teacher who authored them."
      : "Your computer-based exams. The timer runs on the school's clock — answers save as you pick them, and your paper submits itself when time is up.";

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="cbt" permissions={user.permissions}>
      <div className="space-y-6">
        <PageHeader title={<>CBT Exam Hall</>} subtitle={<>{subtitle}</>} />
        {isStaff ? (
          <CbtStaffPanel banks={banks} exams={exams} options={options} />
        ) : isReviewer ? (
          <CbtReviewPanel banks={banks} />
        ) : (
          <CbtStudentList exams={exams} />
        )}
      </div>
    </AppShell>
  );
}
