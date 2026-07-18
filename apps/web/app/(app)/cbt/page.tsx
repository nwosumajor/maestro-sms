import type { CbtAuthoringOptionsDto, CbtBankDto, CbtExamDto, Serialized } from "@sms/types";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { hasPermission } from "@/lib/permissions";
import { AppShell } from "@/components/shell/AppShell";
import { CbtStaffPanel } from "@/components/cbt/CbtStaffPanel";
import { CbtStudentList } from "@/components/cbt/CbtStudentList";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

// CBT exam hall (add-on module): staff author banks and run timed mock exams;
// students sit them. Server-marked; keys never reach an open sitting.
export default async function CbtPage() {
  const session = await auth();
  const user = session!.user;
  const isStaff = hasPermission(user.permissions, "cbt.manage");

  const emptyOptions: Serialized<CbtAuthoringOptionsDto> = { schoolWide: false, subjects: [], classes: [] };
  const [banks, exams, options] = isStaff
    ? await Promise.all([
        apiGet<Serialized<CbtBankDto>[]>("/cbt/banks").then((r) => r ?? []),
        apiGet<Serialized<CbtExamDto>[]>("/cbt/exams/all").then((r) => r ?? []),
        apiGet<Serialized<CbtAuthoringOptionsDto>>("/cbt/authoring-options").then((r) => r ?? emptyOptions),
      ])
    : [[], await apiGet<Serialized<CbtExamDto>[]>("/cbt/exams").then((r) => r ?? []), emptyOptions];

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="cbt" permissions={user.permissions}>
      <div className="space-y-6">
        <PageHeader title={<>CBT Exam Hall</>} subtitle={<>{isStaff
              ? "Timed, auto-marked mock exams (WAEC/JAMB style) from your question banks. Publish an exam and every student gets a freshly-sampled paper."
              : "Your computer-based exams. The timer runs on the school's clock — answers save as you pick them, and your paper submits itself when time is up."}</>} />
        {isStaff ? <CbtStaffPanel banks={banks} exams={exams} options={options} /> : <CbtStudentList exams={exams} />}
      </div>
    </AppShell>
  );
}
