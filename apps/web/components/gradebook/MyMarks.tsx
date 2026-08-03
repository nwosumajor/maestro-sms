"use client";

// A pupil's (or a parent's children's) marks, assessment by assessment.
//
// The report card shows a term-WEIGHTED total; this is the detail behind it.
// /grades/mine was built, relationship-scoped and permission-gated — and no page
// ever fetched it, so a student could see their grade but never the marks that
// produced it.
import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Mark = {
  id: string;
  score: number | null;
  maxScore?: number | null;
  assessmentTitle?: string | null;
  subjectName?: string | null;
  studentName?: string | null;
  gradedAt?: string | null;
};

export function MyMarks() {
  const [rows, setRows] = useState<Mark[] | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      const r = await fetch("/api/sms/grades/mine");
      if (live) setRows(r.ok ? ((await r.json()) as Mark[]) : []);
    })();
    return () => {
      live = false;
    };
  }, []);

  // Nothing marked yet is the normal state early in a term — say so rather than
  // rendering an empty box that looks broken.
  if (rows === null) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Marks so far</CardTitle>
        <CardDescription>
          Individual pieces of work. The report card totals these using the school&rsquo;s weighting.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing has been marked yet this term.</p>
        ) : (
          <ul className="divide-y divide-border/70">
            {rows.map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-2 py-1.5 text-sm">
                <span className="min-w-0">
                  <span className="truncate">{m.assessmentTitle ?? "Assessment"}</span>
                  <span className="block text-xs text-muted-foreground">
                    {[m.studentName, m.subjectName].filter(Boolean).join(" · ")}
                  </span>
                </span>
                <span className="font-medium tabular-nums">
                  {m.score ?? "—"}
                  {m.maxScore ? <span className="text-muted-foreground"> / {m.maxScore}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
