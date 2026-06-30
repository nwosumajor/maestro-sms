import type { VehicleDto, TransportRouteDto, TransportAssignmentDto, Serialized } from "@sms/types";
import { hasPermission } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { TransportManager } from "@/components/transport/TransportManager";

export const dynamic = "force-dynamic";

export default async function TransportPage() {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "transport.read")) redirect("/dashboard");
  const canManage = hasPermission(user.permissions, "transport.manage");

  const [vehicles, routes, assignments, students] = await Promise.all([
    apiGet<Serialized<VehicleDto>[]>("/transport/vehicles"),
    apiGet<Serialized<TransportRouteDto>[]>("/transport/routes"),
    apiGet<Serialized<TransportAssignmentDto>[]>("/transport/assignments"),
    canManage ? apiGet<{ id: string; name: string }[]>("/students") : Promise.resolve([]),
  ]);

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="transport" permissions={user.permissions}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Transport Management</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Vehicles, routes &amp; stops, seat-aware student assignment, and transport-fee scheduling — billed alongside
            academic fees. Route changes alert parents automatically.
          </p>
        </div>
        <TransportManager
          vehicles={vehicles ?? []}
          routes={routes ?? []}
          assignments={assignments ?? []}
          students={students ?? []}
          canManage={canManage}
        />
      </div>
    </AppShell>
  );
}
