import type { MeetingSlotDto, MeetingBookingDto, ChildOverviewDto, Serialized } from "@sms/types";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { hasPermission } from "@/lib/permissions";
import { AppShell } from "@/components/shell/AppShell";
import { PageHeader } from "@/components/shell/PageHeader";
import { MeetingsClient, type AudienceChoice } from "@/components/meeting/MeetingsClient";

export const dynamic = "force-dynamic";

export default async function MeetingsPage() {
  const session = await auth();
  const user = session!.user;
  const canHost = hasPermission(user.permissions, "meeting.host");
  const canBook = hasPermission(user.permissions, "meeting.book");
  if (!canHost && !canBook) redirect("/dashboard");

  const [mySlots, openSlots, myBookings, family, audiences] = await Promise.all([
    canHost ? apiGet<Serialized<MeetingSlotDto>[]>("/meetings/slots/mine") : Promise.resolve([]),
    canBook ? apiGet<Serialized<MeetingSlotDto>[]>("/meetings/slots/open") : Promise.resolve([]),
    canBook ? apiGet<Serialized<MeetingBookingDto>[]>("/meetings/bookings/mine") : Promise.resolve([]),
    canBook ? apiGet<{ children: Serialized<ChildOverviewDto>[] }>("/family/overview") : Promise.resolve({ children: [] }),
    // The scopes THIS host may address, from the server — so the picker can
    // never offer one the create endpoint would refuse.
    canHost ? apiGet<AudienceChoice[]>("/meetings/audiences") : Promise.resolve([]),
  ]);
  const children = (family?.children ?? []).map((c) => ({ studentId: c.studentId, studentName: c.studentName }));

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="meetings" permissions={user.permissions}>
      <div className="space-y-6">
        <PageHeader
          title={<>Parent-teacher meetings</>}
          subtitle={
            <>
              Appointments with one family, and meetings called for a class, a year group or the whole school. Parents
              see only what they are invited to.
            </>
          }
        />
        <MeetingsClient
          canHost={canHost}
          canBook={canBook}
          mySlots={mySlots ?? []}
          openSlots={openSlots ?? []}
          myBookings={myBookings ?? []}
          children={children}
          audiences={audiences ?? []}
        />
      </div>
    </AppShell>
  );
}
