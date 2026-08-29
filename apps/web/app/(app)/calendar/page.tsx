import type { AcademicSessionDto, CalendarEventDto, SchoolHolidayDto, Serialized } from "@sms/types";
import { hasPermission } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { dateTime, regionOf, shortDate } from "@/lib/format";
import { EventForm } from "@/components/calendar/EventForm";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

type Ev = Serialized<CalendarEventDto>;
type Entry = { key: string; at: number; title: string; when: string; kind: "event" | "term" | "holiday"; staffOnly?: boolean };

export default async function CalendarPage() {
  const session = await auth();
  const user = session!.user;
  // Dates follow the SCHOOL's timezone, not the platform's.
  const region = regionOf(user);
  // Gate matches this section's AppShell nav entry ("event.read"), so the page
  // cannot be reached by URL by someone the nav hides it from.
  if (!hasPermission(user.permissions, "event.read")) redirect("/dashboard");
  const canWrite = hasPermission(user.permissions, "event.write");
  // The academic overlay (term boundaries + holidays) is class.read-gated; every
  // role that reaches the calendar holds it, but guard anyway so a missing grant
  // degrades to just events instead of failing the page.
  const canAcademic = hasPermission(user.permissions, "class.read");

  const [events, sessions, holidays] = await Promise.all([
    apiGet<Ev[]>("/events"),
    canAcademic ? apiGet<Serialized<AcademicSessionDto>[]>("/academic/sessions") : Promise.resolve(null),
    canAcademic ? apiGet<Serialized<SchoolHolidayDto>[]>("/academic/holidays") : Promise.resolve(null),
  ]);

  // One timeline: events + term begins/ends + holidays, sorted by date, from
  // yesterday onward so the page always opens on what's next.
  const cutoff = Date.now() - 86_400_000;
  const entries: Entry[] = [];
  for (const e of events ?? []) {
    entries.push({ key: `e${e.id}`, at: new Date(e.startsAt).getTime(), title: e.title, when: dateTime(e.startsAt, region), kind: "event", staffOnly: e.audience === "STAFF" });
  }
  for (const s of sessions ?? []) {
    for (const t of s.terms) {
      if (t.startDate) entries.push({ key: `ts${t.id}`, at: new Date(t.startDate).getTime(), title: `${t.name} begins — ${s.name}`, when: shortDate(t.startDate, region), kind: "term" });
      if (t.endDate) entries.push({ key: `te${t.id}`, at: new Date(t.endDate).getTime(), title: `${t.name} ends — ${s.name}`, when: shortDate(t.endDate, region), kind: "term" });
    }
  }
  for (const h of holidays ?? []) {
    const span = h.startDate === h.endDate ? shortDate(h.startDate, region) : `${shortDate(h.startDate, region)} – ${shortDate(h.endDate, region)}`;
    entries.push({ key: `h${h.id}`, at: new Date(h.startDate).getTime(), title: h.name, when: span, kind: "holiday" });
  }
  const timeline = entries.filter((x) => x.at >= cutoff).sort((a, b) => a.at - b.at);

  const badge = (kind: Entry["kind"]) =>
    kind === "term" ? <Badge variant="secondary">Term</Badge> : kind === "holiday" ? <Badge variant="outline">Holiday</Badge> : null;

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="calendar" permissions={user.permissions}>
      <div className="space-y-6">
        <PageHeader title={<>Calendar</>} subtitle={<>Upcoming events, term boundaries and holidays.</>} />

        {canWrite && <EventForm />}

        {timeline.length === 0 ? (
          <Alert variant="info"><AlertTitle>Nothing upcoming</AlertTitle><AlertDescription>No events, term dates or holidays ahead.</AlertDescription></Alert>
        ) : (
          <div className="space-y-2">
            {timeline.map((x) => (
              <Card key={x.key}>
                <CardContent className="flex items-center justify-between gap-3 p-4">
                  <div>
                    <div className="font-medium">{x.title}</div>
                    <div className="text-sm text-muted-foreground">{x.when}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    {badge(x.kind)}
                    {x.staffOnly && <Badge variant="outline">Staff only</Badge>}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
