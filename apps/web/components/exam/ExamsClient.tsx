"use client";

import * as React from "react";
import { useRegion } from "@/components/shell/RegionProvider";
import { todayIn } from "@/lib/format";
import type { ExamScheduleDto, ExamSittingDto, MyExamDto, Serialized } from "@sms/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { shortDate } from "@/lib/format";
import { ExamPlanner } from "./ExamPlanner";
import { ExamDayBoard } from "./ExamDayBoard";

type Sitting = Serialized<ExamSittingDto>;
type Schedule = Serialized<ExamScheduleDto>;
type MyExam = Serialized<MyExamDto>;
type IdName = { id: string; name: string };

/**
 * Exam logistics + online CBT.
 *
 * Split into two modes because they are two different jobs done weeks apart:
 * PLAN builds and approves a term's schedule; EXAM DAY runs the halls on the
 * morning. One combined list served neither well — planning needs the whole term
 * visible, exam day needs one date with problems surfaced.
 *
 * Everyone (including students and parents) sees their own exams above; only
 * exam.manage holders get the console.
 */
export function ExamsClient({
  canManage,
  canRelease,
  sittings,
  myExams,
  myInvigilations,
  classes,
  staff,
  rooms,
  schedules,
  attachableExams,
}: {
  canManage: boolean;
  canRelease: boolean;
  sittings: Sitting[];
  myExams: MyExam[];
  myInvigilations: MyExam[];
  classes: IdName[];
  staff: { id: string; name: string; roles?: string[] }[];
  rooms: IdName[];
  schedules: Schedule[];
  attachableExams: { id: string; title: string }[];
}) {
  // Default to EXAM DAY when something is actually on today — on exam morning that
  // is the screen you want, and on any other day planning is.
  const { timezone } = useRegion();
  const today = todayIn(timezone);
  const [mode, setMode] = React.useState<"plan" | "day">(() =>
    sittings.some((s) => s.date === today) ? "day" : "plan",
  );

  return (
    <div className="space-y-6">
      {(myExams.length > 0 || myInvigilations.length > 0) && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">{myInvigilations.length > 0 ? "Your exams & duties" : "Your exams"}</CardTitle>
            <CardDescription>Hall, time and seat number for each upcoming exam.</CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto p-0">
            <table className="w-full text-sm">
              <tbody>
                {[...myExams, ...myInvigilations].map((e, i) => (
                  <tr key={`${e.title}-${e.date}-${i}`} className="border-b border-border last:border-0">
                    <td className="px-4 py-2 whitespace-nowrap">{shortDate(e.date)}</td>
                    <td className="px-4 py-2">
                      {e.title}
                      {e.subject ? <span className="text-muted-foreground"> · {e.subject}</span> : null}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground whitespace-nowrap">{e.startsAt}–{e.endsAt} · {e.hall}</td>
                    <td className="px-4 py-2 text-right">
                      {e.seatNo > 0 ? (
                        <span className="rounded-full bg-primary/12 px-2 py-0.5 text-xs font-medium text-primary">
                          {e.studentName ? `${e.studentName} · ` : ""}Seat {e.seatNo}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">{e.studentName}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {canManage && (
        <>
          <div className="flex items-center gap-1 rounded-md border p-1 w-fit">
            <Button size="sm" variant={mode === "plan" ? "default" : "ghost"} onClick={() => setMode("plan")}>
              Plan
            </Button>
            <Button size="sm" variant={mode === "day" ? "default" : "ghost"} onClick={() => setMode("day")}>
              Exam day
            </Button>
          </div>

          {mode === "plan" ? (
            <ExamPlanner
              sittings={sittings}
              schedules={schedules}
              classes={classes}
              staff={staff}
              rooms={rooms}
              attachableExams={attachableExams}
              canRelease={canRelease}
            />
          ) : (
            <ExamDayBoard canRelease={canRelease} />
          )}
        </>
      )}
    </div>
  );
}
