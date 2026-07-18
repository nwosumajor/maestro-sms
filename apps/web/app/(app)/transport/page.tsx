import type { VehicleDto, TransportRouteDto, TransportAssignmentDto, TransportSummaryDto, Serialized } from "@sms/types";
import { hasPermission } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { TransportManager } from "@/components/transport/TransportManager";
import { Kpi } from "@/components/charts/charts";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

export default async function TransportPage() {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "transport.read")) redirect("/dashboard");
  const canManage = hasPermission(user.permissions, "transport.manage");
  const isDriver = user.roles.includes("driver") && !canManage;

  const [vehicles, routes, assignments, students, staff, summary] = await Promise.all([
    apiGet<Serialized<VehicleDto>[]>("/transport/vehicles"),
    apiGet<Serialized<TransportRouteDto>[]>("/transport/routes"),
    apiGet<Serialized<TransportAssignmentDto>[]>("/transport/assignments"),
    canManage ? apiGet<{ id: string; name: string }[]>("/students") : Promise.resolve([]),
    canManage ? apiGet<{ id: string; name: string }[]>("/users?kind=staff") : Promise.resolve([]),
    apiGet<Serialized<TransportSummaryDto>>("/transport/summary"),
  ]);

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="transport" permissions={user.permissions}>
      <div className="space-y-6">
        <PageHeader title={<>Transport Management</>} subtitle={<>{isDriver
              ? "Your assigned vehicle — its route, stops and passengers."
              : "Vehicles, routes & stops, seat-aware student assignment, and transport-fee scheduling — billed alongside academic fees. Route changes alert parents automatically."}</>} />

        {summary && (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Kpi label={isDriver ? "My vehicle" : "Vehicles"} value={summary.vehicles.toLocaleString()} sub={`${summary.seats.toLocaleString()} seats`} />
            <Kpi label="Routes" value={summary.routes.toLocaleString()} sub={`${summary.stops.toLocaleString()} stops`} />
            <Kpi label="Passengers" value={summary.passengers.toLocaleString()} />
            <Kpi label="Seats used" value={summary.seats ? `${Math.round((summary.seatsUsed / summary.seats) * 100)}%` : "—"} />
          </div>
        )}

        <TransportManager
          vehicles={vehicles ?? []}
          routes={routes ?? []}
          assignments={assignments ?? []}
          students={students ?? []}
          staff={staff ?? []}
          canManage={canManage}
        />
      </div>
    </AppShell>
  );
}
