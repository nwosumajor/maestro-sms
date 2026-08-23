"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { IdNameDto, PeriodDto, TimetableEntryDto, Serialized } from "@sms/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { TimetableGrid } from "./TimetableGrid";

type Period = Serialized<PeriodDto>;
type Entry = Serialized<TimetableEntryDto>;
type IdName = Serialized<IdNameDto>;

const DAYS = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"] as const;
/** Above this many options the chip row becomes a search box. */
const PICKER_CHIP_LIMIT = 14;

/**
 * One grid, three axes: CLASS, TEACHER, ROOM.
 *
 * The page only ever offered the class axis, so a teacher — the largest group of
 * users here — had to open each class they teach and hunt for their own name to
 * answer "when do I teach?". The API already supported the teacher filter; nothing
 * called it. The room axis answers the question rooms exist for at all: what is in
 * Lab 1 on Tuesday.
 *
 * The class view stays the EDITABLE one. Teacher and room views are read-only on
 * purpose: a lesson belongs to a class, and editing it from a teacher's week invites
 * the mistake of moving a lesson without seeing what else that class has that day.
 */
export function TimetableViews({
  classes,
  teachers,
  rooms,
  periods,
  classId,
  classEntries,
  teacherOptions,
  canWrite,
}: {
  classes: IdName[];
  teachers: IdName[];
  rooms: IdName[];
  periods: Period[];
  classId?: string;
  classEntries: Entry[];
  teacherOptions: IdName[];
  canWrite: boolean;
}) {
  // Only offer an axis there is something to pick on. The teacher directory only
  // loads for staff, so offering a "Teacher" tab to a student meant a tab with an
  // empty dropdown behind it — a control that looks broken rather than restricted.
  const axes = React.useMemo(
    () => ["class", ...(teachers.length > 0 ? ["teacher"] : []), ...(rooms.length > 0 ? ["room"] : [])] as Array<"class" | "teacher" | "room">,
    [teachers.length, rooms.length],
  );
  const [axis, setAxis] = React.useState<"class" | "teacher" | "room">("class");
  const [teacherId, setTeacherId] = React.useState<string>("");
  const [roomId, setRoomId] = React.useState<string>("");
  const [entries, setEntries] = React.useState<Entry[] | null>(null);
  const [loading, setLoading] = React.useState(false);

  const target = axis === "teacher" ? teacherId : axis === "room" ? roomId : "";

  React.useEffect(() => {
    if (axis === "class" || !target) {
      setEntries(null);
      return;
    }
    let live = true;
    setLoading(true);
    (async () => {
      const q = axis === "teacher" ? `teacherId=${target}` : `roomId=${target}`;
      const res = await fetch(`/api/sms/timetable/view?${q}`);
      if (!live) return;
      setEntries(res.ok ? ((await res.json()) as Entry[]) : []);
      setLoading(false);
    })();
    return () => {
      live = false;
    };
  }, [axis, target]);

  const shown = axis === "class" ? classEntries : entries ?? [];
  // Only teaching periods count towards "free slots" — counting break rows would
  // report every timetable as having gaps it cannot fill.
  const teachingPeriods = periods.filter((p) => !p.isBreak).length;
  const totalSlots = teachingPeriods * DAYS.length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {axes.length > 1 && (
          <div className="flex items-center gap-1 rounded-md border p-1">
            {axes.map((a) => (
              <Button key={a} size="sm" variant={axis === a ? "default" : "ghost"} onClick={() => setAxis(a)} className="capitalize">
                {a}
              </Button>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {axis === "teacher" && (
            <select aria-label="Pick a teacher" className="rounded-md border bg-background p-1.5 text-sm" value={teacherId} onChange={(e) => setTeacherId(e.target.value)}>
              <option value="">Pick a teacher…</option>
              {teachers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          )}
          {axis === "room" && (
            <select aria-label="Pick a room" className="rounded-md border bg-background p-1.5 text-sm" value={roomId} onChange={(e) => setRoomId(e.target.value)}>
              <option value="">Pick a room…</option>
              {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          )}
          {/* Print is offered for the two axes a school actually pins up: a class
              timetable for the wall, a teacher's for their planner. */}
          {axis === "class" && classId && (
            <a className="text-sm text-muted-foreground underline hover:text-foreground" href={`/api/sms/timetable/print.pdf?classId=${classId}`}>
              print
            </a>
          )}
          {axis === "teacher" && teacherId && (
            <a className="text-sm text-muted-foreground underline hover:text-foreground" href={`/api/sms/timetable/print.pdf?teacherId=${teacherId}`}>
              print
            </a>
          )}
          {/* CSV for whatever is on screen, INCLUDING the room axis and the
              whole school — the PDF prints one class or one teacher, which is
              right for a wall and useless for checking a grid in a spreadsheet
              or handing the master to whoever builds the exam schedule.
              Scoping is the view's own, so this exports exactly what is
              visible and nothing more. */}
          <a
            className="text-sm text-muted-foreground underline hover:text-foreground"
            href={`/api/sms/timetable/export.csv${
              axis === "class" && classId
                ? `?classId=${classId}`
                : axis === "teacher" && teacherId
                  ? `?teacherId=${teacherId}`
                  : axis === "room" && roomId
                    ? `?roomId=${roomId}`
                    : ""
            }`}
          >
            CSV
          </a>
        </div>
      </div>

      {axis === "class" && <ClassPicker classes={classes} selectedId={classId} />}

      {axis !== "class" && !target && (
        <p className="text-sm text-muted-foreground">
          {axis === "teacher"
            ? "Pick a teacher to see their week — every lesson they teach, across all their classes."
            : "Pick a room to see everything scheduled in it."}
        </p>
      )}

      {axis === "class" ? (
        classId ? (
          <TimetableGrid
            classId={classId}
            entries={classEntries}
            periods={periods}
            rooms={rooms}
            teachers={teacherOptions}
            canWrite={canWrite}
          />
        ) : null
      ) : target ? (
        loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <ReadOnlyGrid entries={shown} periods={periods} label={axis === "teacher" ? "class" : "class"} totalSlots={totalSlots} />
        )
      ) : null}
    </div>
  );
}

/** Chips for a handful of classes, a search box once there are too many to scan. */
function ClassPicker({ classes, selectedId }: { classes: IdName[]; selectedId?: string }) {
  const router = useRouter();
  const [q, setQ] = React.useState("");
  if (classes.length === 0) return null;

  const shown =
    classes.length <= PICKER_CHIP_LIMIT
      ? classes
      : classes.filter((c) => c.name.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 40);

  return (
    <div className="space-y-2">
      {/* /classes/mine returns EVERY class for whole-school staff, so a large school
          rendered a wall of chips here. */}
      {classes.length > PICKER_CHIP_LIMIT && (
        <input
          placeholder={`Search ${classes.length} classes…`}
          className="w-56 rounded-md border bg-background p-1.5 text-sm"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      )}
      <div className="flex flex-wrap gap-2">
        {shown.map((c) => (
          <button
            key={c.id}
            onClick={() => router.push(`/timetable?classId=${c.id}`)}
            className={`rounded-md border px-3 py-1.5 text-sm font-medium transition-colors ${
              c.id === selectedId ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-accent"
            }`}
          >
            {c.name}
          </button>
        ))}
        {shown.length === 0 && <span className="text-sm text-muted-foreground">No class matches “{q}”.</span>}
      </div>
    </div>
  );
}

/**
 * The teacher/room grid. Read-only, and it shows the CLASS in each cell — the piece
 * of information the chosen axis does not already tell you.
 */
function ReadOnlyGrid({
  entries,
  periods,
  totalSlots,
}: {
  entries: Entry[];
  periods: Period[];
  label: string;
  totalSlots: number;
}) {
  const cell = (periodId: string, day: string) => entries.find((e) => e.periodId === periodId && e.dayOfWeek === day);
  const free = Math.max(0, totalSlots - entries.length);

  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground tabular-nums">
        {entries.length} of {totalSlots} period{totalSlots === 1 ? "" : "s"} used · {free} free
      </p>
      <div className="overflow-x-auto rounded-xl border border-border/70 bg-card shadow-card">
        <table className="w-full min-w-[640px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-left text-muted-foreground">
              <th className="px-3 py-2.5 font-medium">Period</th>
              {DAYS.map((d) => (
                <th key={d} className="px-3 py-2.5 font-medium capitalize">{d.toLowerCase()}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {periods.map((p) => (
              <tr key={p.id} className="border-b border-border last:border-0 align-top">
                <td className="whitespace-nowrap px-3 py-2.5">
                  <div className="font-medium">{p.name}</div>
                  <div className="text-xs text-muted-foreground">{p.startTime}–{p.endTime}</div>
                </td>
                {DAYS.map((d) => {
                  const e = cell(p.id, d);
                  return (
                    <td key={d} className="px-2 py-2 align-top">
                      {p.isBreak ? (
                        <span className="text-xs text-muted-foreground/50">break</span>
                      ) : e ? (
                        <div className="rounded-md bg-primary/[0.06] px-2 py-1.5">
                          <div className="font-medium">{e.subject}</div>
                          <div className="text-xs text-muted-foreground">
                            {e.className}
                            {e.room ? ` · ${e.room.name}` : ""}
                          </div>
                        </div>
                      ) : (
                        <span className="text-muted-foreground/40">·</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
            {periods.length === 0 && (
              <tr>
                <td colSpan={DAYS.length + 1} className="px-3 py-4 text-muted-foreground">
                  No periods defined yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * Standing teaching load. The solver already computes overload, but only during a
 * generate run — shown once and discarded. This is the same question asked of the
 * timetable as it stands, which is what a head teacher needs before agreeing to move
 * a lesson.
 */
export function TeacherLoadPanel() {
  type Row = { teacherId: string; teacherName: string; assigned: number; capacity: number; percent: number };
  const [rows, setRows] = React.useState<Row[] | null>(null);

  React.useEffect(() => {
    let live = true;
    (async () => {
      const res = await fetch("/api/sms/timetable/load");
      if (!live) return;
      setRows(res.ok ? ((await res.json()) as Row[]) : []);
    })();
    return () => {
      live = false;
    };
  }, []);

  if (rows === null) return null;
  if (rows.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Teaching load</CardTitle>
        <CardDescription>
          Periods assigned against the periods each teacher is actually available for — their declared unavailability is
          already deducted, so a part-timer is not shown as under-used.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-1.5">
        {rows.map((r) => (
          <div key={r.teacherId} className="flex items-center gap-3 text-sm">
            <span className="w-40 shrink-0 truncate">{r.teacherName}</span>
            <span className="w-16 shrink-0 tabular-nums text-muted-foreground">
              {r.assigned}/{r.capacity}
            </span>
            {/* The bar makes the outliers findable without reading every number. */}
            <span className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
              <span
                className={`block h-full rounded-full ${r.percent >= 90 ? "bg-destructive" : r.percent >= 70 ? "bg-amber-500" : "bg-primary"}`}
                style={{ width: `${Math.min(100, r.percent)}%` }}
              />
            </span>
            <span className="w-10 shrink-0 text-right tabular-nums text-muted-foreground">{r.percent}%</span>
            {r.percent >= 90 && <Badge variant="destructive">near capacity</Badge>}
            {r.assigned === 0 && <Badge variant="outline">no lessons</Badge>}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
