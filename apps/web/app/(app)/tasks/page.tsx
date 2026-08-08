import type { PageDto, TaskDto, Serialized } from "@sms/types";
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
  const [taskPage, staffList, studentList] = await Promise.all([
    apiGet<PageDto<Serialized<TaskDto>>>("/tasks"),
    hasPermission(user.permissions, "directory.people.read") ? apiGet<Person[]>("/directory/people?kind=staff") : Promise.resolve([]),
    // /students requires class.read, NOT task.assign — head_admin holds the
    // latter and not the former, so this asked and was refused, and the student
    // picker rendered empty with no explanation.
    //
    // Deliberately NOT solved by adding a `student` kind to /directory/people:
    // that endpoint is open to every picker-holding role INCLUDING parents, and
    // a flat list of pupil names is roster-level data on MINORS. /students is
    // relationship-scoped (teacher -> their classes, parent -> their children)
    // and that scoping is the point. Compare /discipline/file-targets, which is
    // purpose-built and gated on the permission its own page uses — the shape to
    // copy when a picker needs its own list.
    canAssign && hasPermission(user.permissions, "class.read")
      ? apiGet<Person[]>("/students")
      : Promise.resolve([]),
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
        <TaskBoard page={taskPage ?? { items: [], nextCursor: null }} staff={staff} students={students} canAssign={canAssign} />
      </div>
    </AppShell>
  );
}
