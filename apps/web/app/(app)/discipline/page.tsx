import type { DisciplineComplaintDto, PageDto, Serialized } from "@sms/types";
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
    canManage ? apiGet<Person[]>("/users?kind=staff") : Promise.resolve([]),
    apiGet<Person[]>("/discipline/file-targets?type=TEACHER"),
    apiGet<Person[]>("/discipline/file-targets?type=STUDENT"),
  ]);
  const byName = (a: Person, b: Person) => a.name.localeCompare(b.name);
  const staff = [...(staffList ?? [])].sort(byName);
  const teachers = [...(teacherList ?? [])].sort(byName);
  const students = [...(studentList ?? [])].sort(byName);
  const page = complaintsPage ?? { items: [], nextCursor: null };

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="discipline" permissions={user.permissions}>
      <div className="space-y-6">
        <PageHeader title={<>Discipline Room</>} subtitle={<>File complaints against students or teachers; staff review, assign resolvers, and record an action. Every
            decision is made by a person — nothing is automated.</>} />
        <DisciplineRoom page={page} staff={staff} teachers={teachers} students={students} canManage={canManage} />
      </div>
    </AppShell>
  );
}
