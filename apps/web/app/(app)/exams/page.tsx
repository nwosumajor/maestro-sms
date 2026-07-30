import type { ExamScheduleDto, ExamSittingDto, MyExamDto, IdNameDto, CbtExamDto, Serialized } from "@sms/types";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { hasPermission } from "@/lib/permissions";
import { AppShell } from "@/components/shell/AppShell";
import { PageHeader } from "@/components/shell/PageHeader";
import { ExamsClient } from "@/components/exam/ExamsClient";

export const dynamic = "force-dynamic";

export default async function ExamsPage({
  searchParams,
}: {
  // Next 14: searchParams is a plain object, not a Promise (every other page in
  // this app takes it this way).
  searchParams?: { schedule?: string };
}) {
  const session = await auth();
  const user = session!.user;
  const canManage = hasPermission(user.permissions, "exam.manage");
  const canRelease = hasPermission(user.permissions, "exam.release");

  // Narrowing by schedule happens in the QUERY, not the browser: a school with a
  // term of subjects x class levels shouldn't ship every sitting to render one.
  const scheduleQuery = searchParams?.schedule ? `?scheduleId=${encodeURIComponent(searchParams.schedule)}` : "";

  const [sittings, myExams, myInvigilations, classes, staff, rooms, schedules, draftExams] = await Promise.all([
    canManage ? apiGet<Serialized<ExamSittingDto>[]>(`/exams${scheduleQuery}`) : Promise.resolve([]),
    apiGet<Serialized<MyExamDto>[]>("/exams/mine"),
    apiGet<Serialized<MyExamDto>[]>("/exams/invigilations/mine"),
    canManage ? apiGet<Serialized<IdNameDto>[]>("/classes/mine") : Promise.resolve([]),
    canManage ? apiGet<{ id: string; name: string; roles?: string[] }[]>("/users?kind=staff") : Promise.resolve([]),
    // Halls come from the timetable's room registry, so a sitting can't invent
    // "Hall A" alongside an existing "hall A" — and capacity rides along.
    canManage ? apiGet<Serialized<IdNameDto>[]>("/timetable/rooms") : Promise.resolve([]),
    canManage ? apiGet<Serialized<ExamScheduleDto>[]>("/exams/schedules") : Promise.resolve([]),
    // Only DRAFT exams can be attached (they publish via schedule approval). Asking
    // the API for just those beats fetching every exam and filtering client-side.
    canManage ? apiGet<Serialized<CbtExamDto>[]>("/cbt/exams/all?status=DRAFT") : Promise.resolve([]),
  ]);

  const attachableExams = (draftExams ?? []).filter((e) => e.status === "DRAFT").map((e) => ({ id: e.id, title: e.title }));

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="exams" permissions={user.permissions}>
      <div className="space-y-6">
        <PageHeader
          title={<>Exams</>}
          subtitle={
            <>
              Plan a term&apos;s sittings (approved head-teacher → principal), seat and invigilate them, then run the halls on
              the day. Your own exams show your hall, time and seat.
            </>
          }
        />
        <ExamsClient
          canManage={canManage}
          canRelease={canRelease}
          sittings={sittings ?? []}
          myExams={myExams ?? []}
          myInvigilations={myInvigilations ?? []}
          classes={classes ?? []}
          staff={staff ?? []}
          rooms={rooms ?? []}
          schedules={schedules ?? []}
          attachableExams={attachableExams}
        />
      </div>
    </AppShell>
  );
}
