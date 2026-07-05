import type { AcademicSessionDto, IdNameDto, StudentSessionReportDto, Serialized } from "@sms/types";
import { hasPermission } from "@/lib/permissions";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { GradingConsole } from "@/components/gradebook/GradingConsole";
import { ReportCard } from "@/components/gradebook/ReportCard";
import { SubjectPicker } from "@/components/gradebook/SubjectPicker";
import { SelectionReview } from "@/components/gradebook/SelectionReview";

export const dynamic = "force-dynamic";

type Session = Serialized<AcademicSessionDto>;
type Named = Serialized<IdNameDto>;
type Report = Serialized<StudentSessionReportDto>;

export default async function GradebookPage() {
  const session = await auth();
  const user = session!.user;
  const canGrade = hasPermission(user.permissions, "grade.write");
  const canPickSubjects = hasPermission(user.permissions, "subject.select");
  const canApproveSelections = hasPermission(user.permissions, "subject.selection.approve");
  // Any staff member might be a class supervisor (that's a relationship, not a
  // role), so staff always get the review panel — it renders nothing when the
  // server-scoped list is empty.
  const showReviewPanel = canGrade || canApproveSelections;

  const sessions = (await apiGet<Session[]>("/academic/sessions")) ?? [];
  const currentSession = sessions.find((s) => s.isCurrent) ?? sessions[0];

  // Teachers/admins grade; students & parents read their own / children's cards.
  const classes = canGrade ? ((await apiGet<Named[]>("/classes/mine")) ?? []) : [];

  let reports: Report[] = [];
  if (!canGrade && currentSession) {
    // /students is relationship-scoped: a student sees themselves, a parent their children.
    const students = (await apiGet<Named[]>("/students")) ?? [];
    reports = (
      await Promise.all(
        students.map((s) =>
          apiGet<Report>(`/term-results/report/${s.id}/${currentSession.id}`).catch(() => null),
        ),
      )
    ).filter((r): r is Report => r !== null);
  }

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="gradebook" permissions={user.permissions}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Grades</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {canGrade
              ? "Enter each student's exam, midterm, assignment and class-note scores for a subject and term; the weighted total (exam 60% · midterm 20% · assignment 10% · class note 10%) is calculated automatically. Submitting for publication routes through head-teacher and principal approval before families see the grades."
              : "Your published results for each subject, term by term, across the session."}
          </p>
        </div>

        {canPickSubjects && <SubjectPicker />}
        {showReviewPanel && <SelectionReview userId={user.id} canApproveFinal={canApproveSelections} />}

        {canGrade ? (
          <GradingConsole classes={classes} sessions={sessions} />
        ) : reports.length > 0 ? (
          <div className="space-y-6">
            {reports.map((r) => <ReportCard key={r.studentId} report={r} />)}
          </div>
        ) : (
          <Alert variant="info">
            <AlertTitle>No results yet</AlertTitle>
            <AlertDescription>
              {currentSession
                ? "No published grades to show for the current session yet. They'll appear here once your teachers publish them."
                : "The school hasn't set up an academic session yet."}
            </AlertDescription>
          </Alert>
        )}
      </div>
    </AppShell>
  );
}
