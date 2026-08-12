"use client";

// Lessons whose regular teacher has left the school.
//
// A departure closes the employment record and the account, but it does not
// touch the timetable. The lessons stay, timetabled to somebody who will not
// arrive, and the grid renders them exactly like any other — same colour, same
// name, no mark of any kind. The school finds out when a class sits unattended.
//
// DELIBERATELY NOT THE COVER PANEL. Cover answers "who is out today" — approved
// leave, a bounded window, assign a reliever for that date. This answers "which
// lessons have no teacher at all, permanently", which is a staffing decision
// rather than a daily one. Offering a reliever for one Tuesday against a vacancy
// that needs filling for the year would be the wrong tool, confidently applied.
//
// It reassigns nothing on purpose: who takes over a departed colleague's classes
// is a judgement about workload and subject, not something to automate.

import * as React from "react";
import Link from "next/link";
import type { Serialized, UnstaffedLessonDto } from "@sms/types";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useFormat } from "@/components/shell/RegionProvider";

type Row = Serialized<UnstaffedLessonDto>;

const DAY_ORDER = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"];
const title = (d: string) => d.charAt(0) + d.slice(1).toLowerCase();

export function UnstaffedLessons({ rows }: { rows: Row[] }) {
  const { shortDate } = useFormat();

  // Nothing to say is worth saying plainly — an empty card that looks broken
  // sends somebody hunting for a bug that is not there.
  if (rows.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Lessons with no teacher</CardTitle>
          <CardDescription>
            Every timetabled lesson has a teacher who is still at the school.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const byTeacher = new Map<string, Row[]>();
  for (const r of rows) {
    const list = byTeacher.get(r.teacherId) ?? [];
    list.push(r);
    byTeacher.set(r.teacherId, list);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          Lessons with no teacher
          <Badge variant="destructive" className="ml-2 align-middle">
            {rows.length}
          </Badge>
        </CardTitle>
        <CardDescription>
          These lessons are timetabled to someone who has left. Nothing else in the system will flag them —
          assign a new teacher on the timetable, or the class will have nobody.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Grouped by the departed teacher, because that is the unit of the
            decision: one person's classes get reassigned together, usually to
            one colleague, not lesson by lesson down a flat list. */}
        {[...byTeacher.entries()].map(([teacherId, lessons]) => (
          <div key={teacherId} className="rounded-md border border-border">
            <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-3 py-2">
              <span className="font-medium">{lessons[0].teacherName}</span>
              <span className="text-xs text-muted-foreground">
                left {lessons[0].leftOn ? shortDate(lessons[0].leftOn) : "the school"} ·{" "}
                {lessons.length} lesson{lessons.length === 1 ? "" : "s"} a week
              </span>
            </div>
            <ul className="divide-y divide-border text-sm">
              {[...lessons]
                .sort(
                  (a, b) =>
                    DAY_ORDER.indexOf(a.dayOfWeek) - DAY_ORDER.indexOf(b.dayOfWeek) ||
                    (a.startsAt ?? "").localeCompare(b.startsAt ?? ""),
                )
                .map((l) => (
                  <li key={l.entryId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5">
                    <span>
                      <span className="text-muted-foreground">{title(l.dayOfWeek)}</span>{" "}
                      {l.startsAt ?? l.periodName} ·{" "}
                      {l.classId ? (
                        <Link href={`/classes/${l.classId}`} className="hover:underline">
                          {l.className}
                        </Link>
                      ) : (
                        l.className
                      )}
                    </span>
                    <span className="text-muted-foreground">{l.subjectName ?? "—"}</span>
                  </li>
                ))}
            </ul>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
