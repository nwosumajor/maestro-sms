import type { DisciplineComplaintDto, Serialized } from "@sms/types";
import { hasPermission } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { DisciplineRoom } from "@/components/discipline/DisciplineRoom";

export const dynamic = "force-dynamic";

export default async function DisciplinePage() {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "discipline.file")) redirect("/dashboard");
  const canManage = hasPermission(user.permissions, "discipline.manage");

  // Categorised: the "against" list follows the Student/Teacher type selector,
  // and resolvers are picked from staff only — never one mixed directory.
  type Person = { id: string; name: string };
  const [complaints, staffList, teacherList, studentList] = await Promise.all([
    apiGet<Serialized<DisciplineComplaintDto>[]>("/discipline/complaints"),
    canManage ? apiGet<Person[]>("/users?kind=staff") : Promise.resolve([]),
    canManage ? apiGet<Person[]>("/users?kind=teacher") : Promise.resolve([]),
    canManage ? apiGet<Person[]>("/students") : Promise.resolve([]),
  ]);
  const byName = (a: Person, b: Person) => a.name.localeCompare(b.name);
  const staff = [...(staffList ?? [])].sort(byName);
  const teachers = [...(teacherList ?? [])].sort(byName);
  const students = [...(studentList ?? [])].sort(byName);

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="discipline" permissions={user.permissions}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Discipline Room</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            File complaints against students or teachers; staff review, assign resolvers, and record an action. Every
            decision is made by a person — nothing is automated.
          </p>
        </div>
        <DisciplineRoom complaints={complaints ?? []} staff={staff} teachers={teachers} students={students} canManage={canManage} />
      </div>
    </AppShell>
  );
}
