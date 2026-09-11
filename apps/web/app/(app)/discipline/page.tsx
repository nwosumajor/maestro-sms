import type { FileTargetsDto, DisciplineComplaintDto, PageDto, Serialized } from "@sms/types";
import { hasPermission } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { DisciplineRoom } from "@/components/discipline/DisciplineRoom";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

export default async function DisciplinePage() {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "discipline.file")) redirect("/dashboard");
  const canManage = hasPermission(user.permissions, "discipline.manage");

  // The "against" pickers are RELATIONSHIP-SCOPED server-side (a student sees
  // classmates + the teachers who teach them; staff see the school), so even a
  // non-manager filer can name a valid target — the old page only fetched these
  // for managers, leaving everyone else with an empty, unusable form. Resolvers
  // (assign) stay staff-only and are fetched only when the caller can manage.
  type Person = { id: string; name: string };
  const [complaintsPage, staffList, teacherList, studentList] = await Promise.all([
    apiGet<PageDto<Serialized<DisciplineComplaintDto>>>("/discipline/complaints"),
    hasPermission(user.permissions, "directory.people.read") ? apiGet<Person[]>("/directory/people?kind=staff") : Promise.resolve([]),
    apiGet<Serialized<FileTargetsDto>>("/discipline/file-targets?type=TEACHER"),
    apiGet<Serialized<FileTargetsDto>>("/discipline/file-targets?type=STUDENT"),
  ]);
  const byName = (a: Person, b: Person) => a.name.localeCompare(b.name);
  const staff = [...(staffList ?? [])].sort(byName);
  // The FIRST PAGE, not the whole school. A roll of 1,200 returned 500 names —
  // A to K — and 690 pupils could not be named in a complaint at all, because
  // the form offered a plain dropdown of whatever arrived. The picker searches
  // the server now, and these seed it so the common case needs no request.
  const teachers = [...(teacherList?.items ?? [])].sort(byName);
  const students = [...(studentList?.items ?? [])].sort(byName);
  const page = complaintsPage ?? { items: [], nextCursor: null };

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="discipline" permissions={user.permissions}>
      <div className="space-y-6">
        <PageHeader title={<>Discipline Room</>} subtitle={<>File complaints against students or teachers; staff review, assign resolvers, and record an action. Every
            decision is made by a person — nothing is automated.</>} />
        <DisciplineRoom
          page={page}
          staff={staff}
          teachers={teachers}
          students={students}
          canManage={canManage}
          studentTotal={studentList?.total ?? students.length}
          teacherTotal={teacherList?.total ?? teachers.length}
        />
      </div>
    </AppShell>
  );
}
