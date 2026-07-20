import type { IdNameDto, PeriodDto, TimetableEntryDto, Serialized } from "@sms/types";
import { hasPermission } from "@/lib/permissions";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { cn } from "@/lib/utils";
import { TimetableAdmin } from "@/components/timetable/TimetableAdmin";
import { TimetableGrid } from "@/components/timetable/TimetableGrid";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

type Period = Serialized<PeriodDto>;
type ClassRow = Serialized<IdNameDto>;
type Room = Serialized<IdNameDto>;
type Entry = Serialized<TimetableEntryDto>;

export default async function TimetablePage({
  searchParams,
}: {
  searchParams: { classId?: string };
}) {
  const session = await auth();
  const user = session!.user;
  const canWrite = hasPermission(user.permissions, "timetable.write");
  const [periods, classes, rooms, allTeachers] = await Promise.all([
    apiGet<Period[]>("/timetable/periods"),
    apiGet<ClassRow[]>("/classes/mine"),
    canWrite ? apiGet<Room[]>("/timetable/rooms") : Promise.resolve(null),
    // Teacher directory for the availability editor (class.write accompanies
    // timetable.write on every writing role).
    canWrite ? apiGet<{ id: string; name: string }[]>("/users?kind=teacher") : Promise.resolve(null),
  ]);

  const list = classes ?? [];
  const selectedId = searchParams.classId ?? list[0]?.id;
  // Entries for the grid, plus (for staff) the class's teacher options so an
  // inline edit can reassign the teacher: roster teachers merged with the
  // class's subject-offering teachers (same set the create form allows).
  const [entries, roster, offerings] = await Promise.all([
    selectedId ? apiGet<Entry[]>(`/timetable/classes/${selectedId}`) : Promise.resolve([]),
    canWrite && selectedId ? apiGet<{ teachers: IdNameDto[] }>(`/classes/${selectedId}`) : Promise.resolve(null),
    canWrite && selectedId ? apiGet<{ teacherId: string; teacherName: string }[]>(`/classes/${selectedId}/subjects`) : Promise.resolve(null),
  ]);
  const teacherOptions = (() => {
    const merged = new Map<string, IdNameDto>();
    (roster?.teachers ?? []).forEach((t) => merged.set(t.id, t));
    (offerings ?? []).forEach((o) => merged.set(o.teacherId, { id: o.teacherId, name: o.teacherName }));
    return [...merged.values()];
  })();

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="timetable" permissions={user.permissions}>
      <div className="space-y-6">
        <PageHeader title={<>Timetable</>} subtitle={<>The weekly lesson grid.{" "}
            {canWrite
              ? "Click a + to add a lesson, or hover a lesson to Edit or Delete it. "
              : ""}
            A <strong>room</strong> is the physical space a lesson occupies (a
            classroom, lab or hall); assigning one lets the system prevent
            double-booking — the same teacher, class, <em>or room</em> can never
            be scheduled twice in one slot (a clash is refused with the reason).</>} />

        {canWrite && (
          <TimetableAdmin
            classes={list}
            periods={periods ?? []}
            rooms={rooms ?? []}
            teachers={allTeachers ?? []}
          />
        )}

        {list.length === 0 ? (
          <Alert variant="info">
            <AlertTitle>No classes</AlertTitle>
            <AlertDescription>You are not linked to any classes.</AlertDescription>
          </Alert>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              {list.map((c) => (
                <Link
                  key={c.id}
                  href={`/timetable?classId=${c.id}`}
                  className={cn(
                    "rounded-md border px-3 py-1.5 text-sm font-medium transition-colors",
                    c.id === selectedId
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:bg-accent",
                  )}
                >
                  {c.name}
                </Link>
              ))}
            </div>

            <TimetableGrid
              classId={selectedId}
              entries={entries ?? []}
              periods={periods ?? []}
              rooms={rooms ?? []}
              teachers={teacherOptions}
              canWrite={canWrite}
            />
          </>
        )}
      </div>
    </AppShell>
  );
}
