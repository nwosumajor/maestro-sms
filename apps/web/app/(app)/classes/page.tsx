import type { AcademicSessionDto, ClassDto, ClassOverviewDto, PromotionBatchDto, SchoolHolidayDto, SubjectDto, Serialized, CalendarFinding } from "@sms/types";
import Link from "next/link";
import { hasPermission } from "@/lib/permissions";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { ClassAdmin } from "@/components/lms/ClassAdmin";
import { ClassGrid } from "@/components/lms/ClassGrid";
import { ClassSubjectsAdmin } from "@/components/lms/ClassSubjectsAdmin";
import { PromotionManager } from "@/components/lms/PromotionManager";
import { AcademicCalendar, type CalendarShape } from "@/components/lms/AcademicCalendar";
import { SubjectCatalogue } from "@/components/lms/SubjectCatalogue";
import { GradingPolicyCard } from "@/components/lms/GradingPolicyCard";
import { CalendarHealth } from "@/components/lms/CalendarHealth";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";


export default async function ClassesPage() {
  const session = await auth();
  const user = session!.user;
  const canWrite = hasPermission(user.permissions, "class.write");
  const canManageSubjects = hasPermission(user.permissions, "subject.manage");
  const canPromote = hasPermission(user.permissions, "class.promote");
  const canApprovePromotion = hasPermission(user.permissions, "class.promote.approve");
  const canManageAcademic = hasPermission(user.permissions, "academic.manage");
  const canReview = hasPermission(user.permissions, "lms.content.approve");
  // Server-side kind filtering: staff for teacher/supervisor pickers, parents for
  // guardian linking — students never pollute a staff picker (and the payload
  // stays small in a large school).
  const [overview, students, staff, subjects, promotions, sessions, rooms, holidays, calendarFindings, shape] = await Promise.all([
    // ONE request carries the class list AND the figures it is managed by; the
    // counts are grouped server-side, so this costs the same at sixty classes.
    apiGet<Serialized<ClassOverviewDto>[]>("/classes/overview"),
    // Roster no longer prefetched: the enrol/link controls search on demand.
    Promise.resolve(null),
    canWrite ? apiGet<{ id: string; name: string; roles: string[] }[]>("/users?kind=staff") : Promise.resolve(null),
    // The guardian directory is no longer fetched at all. It existed to fill one
    // dropdown, and in a large school that is thousands of rows shipped on every
    // visit; the picker searches the server instead.
    canManageSubjects ? apiGet<SubjectDto[]>("/subjects") : Promise.resolve(null),
    canPromote ? apiGet<Serialized<PromotionBatchDto>[]>("/promotions") : Promise.resolve(null),
    canManageAcademic ? apiGet<Serialized<AcademicSessionDto>[]>("/academic/sessions") : Promise.resolve(null),
    // Offering fixed-room picker (CSP input); null (no timetable.read) hides it.
    canManageSubjects ? apiGet<{ id: string; name: string }[]>("/timetable/rooms") : Promise.resolve(null),
    canManageAcademic ? apiGet<Serialized<SchoolHolidayDto>[]>("/academic/holidays") : Promise.resolve(null),
    // What an incomplete calendar has switched off. Same source as the sessions
    // above, so the panel cannot disagree with the editor beside it.
    canManageAcademic ? apiGet<CalendarFinding[]>("/academic/health") : Promise.resolve(null),
      // The school's year shape, so the term-name choices and the quick-create
    // describe the year this school actually runs.
    canManageAcademic ? apiGet<CalendarShape>("/academic/shape") : Promise.resolve(null),
]);

  // The admin panels only need id/name/level/nextClassId/supervisorId — all of which
  // the overview already carries, so the page no longer fetches the class list twice.
  const classes: Serialized<ClassDto>[] | null =
    overview?.map((c) => ({
      id: c.id,
      name: c.name,
      level: c.level,
      nextClassId: c.nextClassId,
      supervisorId: c.supervisorId,
    })) ?? null;

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="classes" permissions={user.permissions}>
      <div className="space-y-6">
        <div className="flex items-start justify-between gap-3">
          <PageHeader title={<>My classes</>} subtitle={<>Scoped to you: teachers see classes they teach, students see classes
              they are enrolled in. Enforced server-side by relationship checks on
              top of Row-Level Security.</>} />
          {canReview && (
            <Link href="/content/approvals" className={buttonVariants({ size: "sm", variant: "outline" })}>
              Content approvals
            </Link>
          )}
        </div>

        {canWrite && classes && students && staff && (
          <ClassAdmin classes={classes} students={students} users={staff} />
        )}

        {/* The catalogue sits ABOVE the per-class assignment: you pick the
            school's subjects first, then attach them to classes. Ordering the
            page the other way round is why people typed them by hand. */}
        {canManageSubjects && <SubjectCatalogue />}
        {/* Grading policy sits with the academic setup, beside the calendar and
            the subject list — the three things a school configures once a year. */}
        {canManageSubjects && <GradingPolicyCard canManage={canManageAcademic} />}
        {canManageSubjects && classes && staff && subjects && (
          <ClassSubjectsAdmin classes={classes} subjects={subjects} users={staff} rooms={rooms ?? []} />
        )}

        {canManageAcademic && <CalendarHealth findings={calendarFindings ?? []} />}
        {canManageAcademic && sessions && <AcademicCalendar sessions={sessions} holidays={holidays ?? []} shape={shape} />}

        {canPromote && classes && promotions && (
          <PromotionManager
            classes={classes}
            batches={promotions}
            currentUserId={user.id}
            canApprove={canApprovePromotion}
          />
        )}

        {overview === null ? (
          <Alert variant="info">
            <AlertTitle>No access</AlertTitle>
            <AlertDescription>
              Your role does not include <code>class.read</code>, or the session
              expired.
            </AlertDescription>
          </Alert>
        ) : overview.length === 0 ? (
          <Alert variant="info">
            <AlertTitle>No classes yet</AlertTitle>
            <AlertDescription>
              You are not linked to any classes in this school.
            </AlertDescription>
          </Alert>
        ) : (
          <ClassGrid classes={overview} canEnrol={hasPermission(user.permissions, "enrollment.read")} />
        )}
      </div>
    </AppShell>
  );
}
