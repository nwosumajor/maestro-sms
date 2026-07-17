"use client";

// Student CBT list: published exams they can sit — start (or resume) drops
// straight into the exam room route.

import type { CbtExamDto, Serialized } from "@sms/types";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { readApiError } from "@/lib/api-error";
import { dateTime } from "@/lib/format";

type Exam = Serialized<CbtExamDto>;

export function CbtStudentList({ exams }: { exams: Exam[] }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);

  const start = async (examId: string) => {
    setBusy(examId);
    setMsg(null);
    const res = await fetch(`/api/sms/cbt/exams/${examId}/start`, { method: "POST" });
    setBusy(null);
    if (res.ok) {
      const sitting = (await res.json()) as { sittingId: string };
      router.push(`/cbt/sitting/${sitting.sittingId}`);
      return;
    }
    setMsg(await readApiError(res));
  };

  if (exams.length === 0) {
    return <p className="text-sm text-muted-foreground">No exams are open for you right now — check back when your teacher schedules one.</p>;
  }

  return (
    <div className="space-y-3">
      {exams.map((e) => {
        const now = Date.now();
        const openNow = now >= new Date(e.startAt).getTime() && now <= new Date(e.endAt).getTime();
        const finished = e.mySittingStatus && e.mySittingStatus !== "IN_PROGRESS";
        return (
          <Card key={e.id}>
            <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div>
                <p className="font-medium">{e.title}</p>
                <p className="text-xs text-muted-foreground">
                  {e.questionCount} questions · {e.durationMinutes} minutes · window {dateTime(e.startAt)} → {dateTime(e.endAt)}
                </p>
              </div>
              {finished ? (
                <span className="flex items-center gap-2">
                  <Badge variant="secondary">Done</Badge>
                  <Button variant="outline" size="sm" onClick={() => router.push(`/cbt/sitting/${e.mySittingId}`)}>
                    View result
                  </Button>
                </span>
              ) : e.mySittingId ? (
                <Button size="sm" disabled={busy !== null} onClick={() => router.push(`/cbt/sitting/${e.mySittingId}`)}>
                  Resume
                </Button>
              ) : openNow ? (
                <Button size="sm" disabled={busy !== null} onClick={() => start(e.id)}>
                  {busy === e.id ? "Starting…" : "Start exam"}
                </Button>
              ) : (
                <Badge variant="outline">{now < new Date(e.startAt).getTime() ? "Opens soon" : "Closed"}</Badge>
              )}
            </CardContent>
          </Card>
        );
      })}
      {msg && <p className="text-sm text-destructive">{msg}</p>}
    </div>
  );
}
