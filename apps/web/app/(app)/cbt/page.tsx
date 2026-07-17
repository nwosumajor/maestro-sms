import type { CbtBankDto, CbtExamDto, Serialized } from "@sms/types";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { hasPermission } from "@/lib/permissions";
import { AppShell } from "@/components/shell/AppShell";
import { CbtStaffPanel } from "@/components/cbt/CbtStaffPanel";
import { CbtStudentList } from "@/components/cbt/CbtStudentList";

export const dynamic = "force-dynamic";

// CBT exam hall (add-on module): staff author banks and run timed mock exams;
// students sit them. Server-marked; keys never reach an open sitting.
export default async function CbtPage() {
  const session = await auth();
  const user = session!.user;
  const isStaff = hasPermission(user.permissions, "cbt.manage");

  const [banks, exams] = isStaff
    ? await Promise.all([
        apiGet<Serialized<CbtBankDto>[]>("/cbt/banks").then((r) => r ?? []),
        apiGet<Serialized<CbtExamDto>[]>("/cbt/exams/all").then((r) => r ?? []),
      ])
    : [[], await apiGet<Serialized<CbtExamDto>[]>("/cbt/exams").then((r) => r ?? [])];

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="cbt" permissions={user.permissions}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">CBT Exam Hall</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {isStaff
              ? "Timed, auto-marked mock exams (WAEC/JAMB style) from your question banks. Publish an exam and every student gets a freshly-sampled paper."
              : "Your computer-based exams. The timer runs on the school's clock — answers save as you pick them, and your paper submits itself when time is up."}
          </p>
        </div>
        {isStaff ? <CbtStaffPanel banks={banks} exams={exams} /> : <CbtStudentList exams={exams} />}
      </div>
    </AppShell>
  );
}
