import type { CbtAuthoringOptionsDto, CbtExamPageDto, CbtBankDto, CbtExamDto, Serialized } from "@sms/types";
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
export default async function CbtPage({ searchParams }: { searchParams?: Promise<{ q?: string; page?: string }> }) {
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
  // The console's own controls, carried in the URL so a found exam has a link.
  // They narrow in SQL: filtering the fetched page in the browser could only
  // ever see the 100 rows that survived the cap.
  const sp = (await searchParams) ?? {};
  const q = (sp.q ?? "").trim();
  const page = Number(sp.page) > 0 ? Number(sp.page) : 1;
  let examPage: Serialized<CbtExamPageDto> = { items: [], total: 0, shown: 0, page, pageSize: 100 };

  if (isStaff) {
    const query = new URLSearchParams();
    if (q) query.set("q", q);
    if (page > 1) query.set("page", String(page));
    const qs = query.toString();
    const [b, e, o] = await Promise.all([
      apiGet<Serialized<CbtBankDto>[]>("/cbt/banks").then((r) => r ?? []),
      apiGet<Serialized<CbtExamPageDto>>(`/cbt/exams/all${qs ? `?${qs}` : ""}`),
      apiGet<Serialized<CbtAuthoringOptionsDto>>("/cbt/authoring-options").then((r) => r ?? emptyOptions),
    ]);
    banks = b;
    options = o;
    examPage = e ?? examPage;
    exams = examPage.items;
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
          <CbtStaffPanel
            banks={banks}
            exams={exams}
            examTotal={examPage.total}
            examPage={examPage.page}
            examPageSize={examPage.pageSize}
            examQuery={q}
            options={options}
            canManage={hasPermission(user.permissions, "cbt.manage")}
          />
        ) : isReviewer ? (
          <CbtReviewPanel banks={banks} />
        ) : (
          <CbtStudentList exams={exams} />
        )}
      </div>
    </AppShell>
  );
}
