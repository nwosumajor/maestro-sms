import type { AcademicSessionDto, ClassDto, PromotionBatchDto, SubjectDto, Serialized } from "@sms/types";
import Link from "next/link";
import { hasPermission } from "@/lib/permissions";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { ClassAdmin } from "@/components/lms/ClassAdmin";
import { ClassSubjectsAdmin } from "@/components/lms/ClassSubjectsAdmin";
import { PromotionManager } from "@/components/lms/PromotionManager";
import { AcademicCalendar } from "@/components/lms/AcademicCalendar";
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
  const [classes, students, staff, parents, subjects, promotions, sessions, rooms] = await Promise.all([
    apiGet<ClassDto[]>("/classes/mine"),
    canWrite ? apiGet<{ id: string; name: string }[]>("/students") : Promise.resolve(null),
    canWrite ? apiGet<{ id: string; name: string; roles: string[] }[]>("/users?kind=staff") : Promise.resolve(null),
    canWrite ? apiGet<{ id: string; name: string; roles: string[] }[]>("/users?kind=parent") : Promise.resolve(null),
    canManageSubjects ? apiGet<SubjectDto[]>("/subjects") : Promise.resolve(null),
    canPromote ? apiGet<Serialized<PromotionBatchDto>[]>("/promotions") : Promise.resolve(null),
    canManageAcademic ? apiGet<Serialized<AcademicSessionDto>[]>("/academic/sessions") : Promise.resolve(null),
    // Offering fixed-room picker (CSP input); null (no timetable.read) hides it.
    canManageSubjects ? apiGet<{ id: string; name: string }[]>("/timetable/rooms") : Promise.resolve(null),
  ]);

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
          <ClassAdmin classes={classes} students={students} users={[...staff, ...(parents ?? [])]} />
        )}

        {canManageSubjects && classes && staff && subjects && (
          <ClassSubjectsAdmin classes={classes} subjects={subjects} users={staff} rooms={rooms ?? []} />
        )}

        {canManageAcademic && sessions && <AcademicCalendar sessions={sessions} />}

        {canPromote && classes && promotions && (
          <PromotionManager
            classes={classes}
            batches={promotions}
            currentUserId={user.id}
            canApprove={canApprovePromotion}
          />
        )}

        {classes === null ? (
          <Alert variant="info">
            <AlertTitle>No access</AlertTitle>
            <AlertDescription>
              Your role does not include <code>class.read</code>, or the session
              expired.
            </AlertDescription>
          </Alert>
        ) : classes.length === 0 ? (
          <Alert variant="info">
            <AlertTitle>No classes yet</AlertTitle>
            <AlertDescription>
              You are not linked to any classes in this school.
            </AlertDescription>
          </Alert>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {classes.map((c) => (
              <Card key={c.id}>
                <CardHeader>
                  <CardTitle className="text-base">{c.name}</CardTitle>
                  <CardDescription>{c.subject ?? "General"}</CardDescription>
                </CardHeader>
                <CardContent className="flex items-center justify-between gap-2">
                  <code className="text-xs text-muted-foreground">{c.id}</code>
                  <div className="flex gap-2">
                    <Link
                      href={`/classes/${c.id}/info`}
                      className={buttonVariants({ size: "sm", variant: "outline" })}
                    >
                      Info
                    </Link>
                    {hasPermission(user.permissions, "enrollment.read") && (
                      <Link
                        href={`/classes/${c.id}/roster`}
                        className={buttonVariants({ size: "sm", variant: "outline" })}
                      >
                        Roster
                      </Link>
                    )}
                    <Link
                      href={`/classes/${c.id}/content`}
                      className={buttonVariants({ size: "sm", variant: "outline" })}
                    >
                      Content
                    </Link>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
