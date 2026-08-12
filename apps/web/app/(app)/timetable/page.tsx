import type { IdNameDto, PeriodDto, TimetableEntryDto, UnstaffedLessonDto, Serialized } from "@sms/types";
import { hasPermission } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { TimetableAdmin } from "@/components/timetable/TimetableAdmin";
import { CoverPanel } from "@/components/timetable/CoverPanel";
import { UnstaffedLessons } from "@/components/timetable/UnstaffedLessons";
import { TimetableViews, TeacherLoadPanel } from "@/components/timetable/TimetableViews";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

type Unstaffed = Serialized<UnstaffedLessonDto>;

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
  // Gate matches this section's AppShell nav entry ("timetable.read"), so the page
  // cannot be reached by URL by someone the nav hides it from.
  if (!hasPermission(user.permissions, "timetable.read")) redirect("/dashboard");
  const canWrite = hasPermission(user.permissions, "timetable.write");
  const [periods, classes, rooms, allTeachers, unstaffed] = await Promise.all([
    apiGet<Period[]>("/timetable/periods"),
    apiGet<ClassRow[]>("/classes/mine"),
    // Rooms are needed by the ROOM view too, not just the admin editor, so this is
    // no longer gated on write.
    apiGet<Room[]>("/timetable/rooms"),
    // Teacher directory for the availability editor AND the teacher view (class.write
    // accompanies timetable.write on every writing role).
    hasPermission(user.permissions, "directory.people.read") ? apiGet<{ id: string; name: string; roles?: string[] }[]>("/directory/people?kind=teacher") : Promise.resolve(null),
    // Lessons whose teacher has left. Staff-wide only (the API 404s otherwise),
    // and fetched with the rest rather than after them — it is a small joined
    // query and this page already waits on four.
    canWrite ? apiGet<Unstaffed[]>("/timetable/unstaffed") : Promise.resolve(null),
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

        {/* Before cover: cover is "who is out today", this is "which lessons
            have nobody at all". The permanent problem reads first. */}
        {canWrite && unstaffed !== null && <UnstaffedLessons rows={unstaffed} />}
        {canWrite && <CoverPanel teachers={allTeachers ?? []} />}

        {list.length === 0 ? (
          <Alert variant="info">
            <AlertTitle>No classes</AlertTitle>
            <AlertDescription>You are not linked to any classes.</AlertDescription>
          </Alert>
        ) : (
          <TimetableViews
            classes={list}
            teachers={allTeachers ?? []}
            rooms={rooms ?? []}
            periods={periods ?? []}
            classId={selectedId}
            classEntries={entries ?? []}
            teacherOptions={teacherOptions}
            canWrite={canWrite}
          />
        )}

        {/* Load is a leadership question, so it sits below the grid rather than
            competing with it. Gated on write — a teacher does not need the roster's
            workload, and the endpoint is staff-wide only anyway. */}
        {canWrite && <TeacherLoadPanel />}
      </div>
    </AppShell>
  );
}
