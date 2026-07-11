"use client";

// Teacher's per-student completion overview for a class ("who's done what").
// Staff-only; the API (GET /classes/:id/progress) enforces teacher-of-class
// scoping (404 otherwise). Read-only.

import type { ClassProgressDto, Serialized } from "@sms/types";
import * as React from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function ClassProgress({ classId }: { classId: string }) {
  const [data, setData] = React.useState<Serialized<ClassProgressDto> | null>(null);
  const [loaded, setLoaded] = React.useState(false);

  React.useEffect(() => {
    let live = true;
    (async () => {
      const res = await fetch(`/api/sms/classes/${classId}/progress`);
      if (live && res.ok) setData((await res.json()) as Serialized<ClassProgressDto>);
      if (live) setLoaded(true);
    })();
    return () => {
      live = false;
    };
  }, [classId]);

  if (!loaded || !data || data.students.length === 0) return null;
  const total = data.totalPublished;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Class progress</CardTitle>
        <CardDescription>
          How many of the {total} published item{total === 1 ? "" : "s"} each student has marked complete.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2.5">
        {data.students.map((s) => {
          const pct = total ? Math.round((s.completed / total) * 100) : 0;
          return (
            <div key={s.studentId} className="flex items-center gap-3">
              <span className="w-40 shrink-0 truncate text-sm">{s.studentName}</span>
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
              </div>
              <span className="tnum w-14 shrink-0 text-right text-xs text-muted-foreground">
                {s.completed}/{total}
              </span>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
