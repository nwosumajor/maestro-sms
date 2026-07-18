import type { CalendarEventDto, Serialized } from "@sms/types";
import { hasPermission } from "@/lib/permissions";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { dateTime } from "@/lib/format";
import { EventForm } from "@/components/calendar/EventForm";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

type Ev = Serialized<CalendarEventDto>;

export default async function CalendarPage() {
  const session = await auth();
  const user = session!.user;
  const events = await apiGet<Ev[]>("/events");
  const canWrite = hasPermission(user.permissions, "event.write");

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="calendar" permissions={user.permissions}>
      <div className="space-y-6">
        <PageHeader title={<>Calendar</>} subtitle={<>Upcoming school events.</>} />

        {canWrite && <EventForm />}

        {events === null || events.length === 0 ? (
          <Alert variant="info"><AlertTitle>No events</AlertTitle><AlertDescription>Nothing upcoming.</AlertDescription></Alert>
        ) : (
          <div className="space-y-2">
            {events.map((e) => (
              <Card key={e.id}>
                <CardContent className="flex items-center justify-between gap-3 p-4">
                  <div>
                    <div className="font-medium">{e.title}</div>
                    <div className="text-sm text-muted-foreground">{dateTime(e.startsAt)}</div>
                  </div>
                  {e.audience === "STAFF" && <Badge variant="outline">Staff only</Badge>}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
