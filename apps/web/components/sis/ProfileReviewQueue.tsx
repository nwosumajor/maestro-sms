"use client";

// What is waiting for THIS reviewer.
//
// The three chain endpoints each act on one named pupil, which is useless until
// you know which pupil — so a supervisor had no way to discover that anything
// had been submitted, and the school office had no way to see what the
// supervisor had already checked. The queue answers "whose turn is it, and is it
// mine", and the SERVER decides the stage: a supervisor sees the pupils in
// classes they supervise, `rbac.manage` sees the ones already checked.
//
// Renders nothing when the queue is empty, which is the normal state.

import type { ProfileReviewRowDto, Serialized } from "@sms/types";
import * as React from "react";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Row = Serialized<ProfileReviewRowDto>;

export function ProfileReviewQueue() {
  const [rows, setRows] = React.useState<Row[] | null>(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    void (async () => {
      const res = await fetch("/api/sms/students/profile-reviews", { cache: "no-store" });
      // A failed read stays null. `[]` hides the card, which reads to a reviewer
      // as "nothing is waiting for you" — the one thing a queue must never say
      // when it does not know.
      if (res.ok) setRows((await res.json()) as Row[]);
      else setFailed(true);
    })();
  }, []);

  if (failed) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Profiles waiting for you</CardTitle>
          <CardDescription>
            Couldn&rsquo;t load the review queue. Reload to try again — this does not mean it is
            empty.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (!rows || rows.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Profiles waiting for you</CardTitle>
        <CardDescription>
          Pupil profiles that have been submitted. Open one to check it, ask for changes, or approve it.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="px-4 py-1 font-medium">Pupil</th>
              <th className="px-2 py-1 font-medium">Class</th>
              <th className="px-2 py-1 font-medium">Waiting on</th>
              <th className="px-2 py-1 font-medium">Submitted</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.studentId} className="border-b border-border/50 last:border-0">
                <td className="px-4 py-2">
                  <Link className="underline underline-offset-2" href={`/students/${r.studentId}`}>
                    {r.studentName}
                  </Link>
                </td>
                <td className="px-2 py-2 text-muted-foreground">{r.className ?? "—"}</td>
                <td className="px-2 py-2">
                  {/* Naming the stage is what stops two reviewers each assuming
                      the other has it. */}
                  <span className="rounded-full border border-border px-2 py-0.5 text-xs">
                    {r.stage === "SUPERVISOR" ? "Class supervisor" : "School office"}
                  </span>
                </td>
                <td className="px-2 py-2 text-muted-foreground">
                  {r.submittedAt ? String(r.submittedAt).slice(0, 10) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
