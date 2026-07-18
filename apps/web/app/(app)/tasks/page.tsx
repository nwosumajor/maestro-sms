import type { TaskDto, Serialized } from "@sms/types";
import { hasPermission } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { TaskBoard } from "@/components/task/TaskBoard";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

type Person = { id: string; name: string };

export default async function TasksPage() {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "task.participate")) redirect("/dashboard");
  const canAssign = hasPermission(user.permissions, "task.assign");

  // Managers assign to staff OR students — two server-filtered lists, kept
  // separate so the picker is categorised instead of one mixed directory.
  const [tasks, staffList, studentList] = await Promise.all([
    apiGet<Serialized<TaskDto>[]>("/tasks"),
    canAssign ? apiGet<Person[]>("/users?kind=staff") : Promise.resolve([]),
    canAssign ? apiGet<Person[]>("/students") : Promise.resolve([]),
  ]);
  const byName = (a: Person, b: Person) => a.name.localeCompare(b.name);
  const staff = [...(staffList ?? [])].sort(byName);
  const students = [...(studentList ?? [])].sort(byName);

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="tasks" permissions={user.permissions}>
      <div className="space-y-6">
        <PageHeader title={<>Tasks</>} subtitle={<>{canAssign
              ? "Assign tasks to staff or students, track progress, and follow up with comments."
              : "Your assigned tasks — update your status, attach work, and comment."}</>} />
        <TaskBoard tasks={tasks ?? []} staff={staff} students={students} canAssign={canAssign} />
      </div>
    </AppShell>
  );
}
