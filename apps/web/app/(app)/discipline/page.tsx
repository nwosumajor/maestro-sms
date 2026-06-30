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

  const [complaints, staff, students] = await Promise.all([
    apiGet<Serialized<DisciplineComplaintDto>[]>("/discipline/complaints"),
    canManage ? apiGet<{ id: string; name: string }[]>("/users") : Promise.resolve([]),
    canManage ? apiGet<{ id: string; name: string }[]>("/students") : Promise.resolve([]),
  ]);
  const map = new Map<string, { id: string; name: string }>();
  for (const u of [...(staff ?? []), ...(students ?? [])]) map.set(u.id, { id: u.id, name: u.name });
  const people = [...map.values()].sort((a, b) => a.name.localeCompare(b.name));

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
        <DisciplineRoom complaints={complaints ?? []} people={people} canManage={canManage} />
      </div>
    </AppShell>
  );
}
