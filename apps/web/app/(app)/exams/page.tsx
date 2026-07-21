import type { ExamSittingDto, MyExamDto, IdNameDto, Serialized } from "@sms/types";
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

  const [sittings, myExams, myInvigilations, classes, staff] = await Promise.all([
    canManage ? apiGet<Serialized<ExamSittingDto>[]>("/exams") : Promise.resolve([]),
    apiGet<Serialized<MyExamDto>[]>("/exams/mine"),
    apiGet<Serialized<MyExamDto>[]>("/exams/invigilations/mine"),
    canManage ? apiGet<Serialized<IdNameDto>[]>("/classes/mine") : Promise.resolve([]),
    canManage ? apiGet<{ id: string; name: string; roles?: string[] }[]>("/users?kind=staff") : Promise.resolve([]),
  ]);

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="exams" permissions={user.permissions}>
      <div className="space-y-6">
        <PageHeader
          title={<>Exams</>}
          subtitle={<>Exam halls, seating plans and invigilation. Your own exams show your hall, time and seat number.</>}
        />
        <ExamsClient
          canManage={canManage}
          sittings={sittings ?? []}
          myExams={myExams ?? []}
          myInvigilations={myInvigilations ?? []}
          classes={classes ?? []}
          staff={staff ?? []}
        />
      </div>
    </AppShell>
  );
}
