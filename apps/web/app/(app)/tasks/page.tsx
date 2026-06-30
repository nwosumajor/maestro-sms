import type { TaskDto, Serialized } from "@sms/types";
import { hasPermission } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { TaskBoard } from "@/components/task/TaskBoard";

export const dynamic = "force-dynamic";

type Person = { id: string; name: string };

export default async function TasksPage() {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "task.participate")) redirect("/dashboard");
  const canAssign = hasPermission(user.permissions, "task.assign");

  // Managers pick from staff + students; reuse the staff-gated /users and /students.
  const [tasks, staff, students] = await Promise.all([
    apiGet<Serialized<TaskDto>[]>("/tasks"),
    canAssign ? apiGet<{ id: string; name: string }[]>("/users") : Promise.resolve([]),
    canAssign ? apiGet<{ id: string; name: string }[]>("/students") : Promise.resolve([]),
  ]);
  const map = new Map<string, Person>();
  for (const u of [...(staff ?? []), ...(students ?? [])]) map.set(u.id, { id: u.id, name: u.name });
  const people = [...map.values()].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="tasks" permissions={user.permissions}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Tasks</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {canAssign
              ? "Assign tasks to staff or students, track progress, and follow up with comments."
              : "Your assigned tasks — update your status, attach work, and comment."}
          </p>
        </div>
        <TaskBoard tasks={tasks ?? []} people={people} canAssign={canAssign} />
      </div>
    </AppShell>
  );
}
