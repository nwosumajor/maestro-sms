import type { ExamScheduleDto, ExamSittingDto, MyExamDto, IdNameDto, CbtExamDto, Serialized } from "@sms/types";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { hasPermission } from "@/lib/permissions";
import { AppShell } from "@/components/shell/AppShell";
import { PageHeader } from "@/components/shell/PageHeader";
import { ExamsClient } from "@/components/exam/ExamsClient";

export const dynamic = "force-dynamic";

export default async function ExamsPage() {
  const session = await auth();
  const user = session!.user;
  const canManage = hasPermission(user.permissions, "exam.manage");
  const canRelease = hasPermission(user.permissions, "exam.release");

  const [sittings, myExams, myInvigilations, classes, staff, schedules, cbtExams] = await Promise.all([
    canManage ? apiGet<Serialized<ExamSittingDto>[]>("/exams") : Promise.resolve([]),
    apiGet<Serialized<MyExamDto>[]>("/exams/mine"),
    apiGet<Serialized<MyExamDto>[]>("/exams/invigilations/mine"),
    canManage ? apiGet<Serialized<IdNameDto>[]>("/classes/mine") : Promise.resolve([]),
    canManage ? apiGet<{ id: string; name: string; roles?: string[] }[]>("/users?kind=staff") : Promise.resolve([]),
    canManage ? apiGet<Serialized<ExamScheduleDto>[]>("/exams/schedules") : Promise.resolve([]),
    canManage ? apiGet<Serialized<CbtExamDto>[]>("/cbt/exams/all") : Promise.resolve([]),
  ]);

  // Only DRAFT CBT exams can be attached to a sitting (they publish via approval).
  const attachableExams = (cbtExams ?? []).filter((e) => e.status === "DRAFT").map((e) => ({ id: e.id, title: e.title }));

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="exams" permissions={user.permissions}>
      <div className="space-y-6">
        <PageHeader
          title={<>Exams</>}
          subtitle={<>Schedule exams (approved head-teacher → principal), seat and invigilate, and open each exam on the day. Your own exams show your hall, time and seat.</>}
        />
        <ExamsClient
          canManage={canManage}
          canRelease={canRelease}
          sittings={sittings ?? []}
          myExams={myExams ?? []}
          myInvigilations={myInvigilations ?? []}
          classes={classes ?? []}
          staff={staff ?? []}
          schedules={schedules ?? []}
          attachableExams={attachableExams}
        />
      </div>
    </AppShell>
  );
}
