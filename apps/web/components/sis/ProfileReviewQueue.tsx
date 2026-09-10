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
  // ONE PAGE, AND HOW MANY ARE WAITING.
  //
  // This fetched a bare array capped at 500 and rendered it whole. At a term
  // start a large school submits far more than that at once — measured at 1,200
  // — so a reviewer saw a screenful, cleared it, and had nothing anywhere to
  // say that 700 more sat behind it. Oldest-first means the right rows were on
  // top; the count is what was missing.
  const [rows, setRows] = React.useState<Row[] | null>(null);
  const [total, setTotal] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(50);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    void (async () => {
      const res = await fetch(`/api/sms/students/profile-reviews${page > 1 ? `?page=${page}` : ""}`, { cache: "no-store" });
      // A failed read stays null. `[]` hides the card, which reads to a reviewer
      // as "nothing is waiting for you" — the one thing a queue must never say
      // when it does not know.
      if (res.ok) {
        const j = (await res.json()) as { items: Row[]; total: number; page: number; pageSize: number };
        setRows(j.items);
        setTotal(j.total);
        setPageSize(j.pageSize);
      }
      else setFailed(true);
    })();
  }, [page]);

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
        <CardTitle className="text-base">
          Profiles waiting for you{total > 0 ? ` (${total})` : ""}
        </CardTitle>
        <CardDescription>
          Pupil profiles that have been submitted, longest wait first. Open one to check it, ask for changes, or
          approve it.
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

        {/* WHAT IS SHOWN OUT OF WHAT IS WAITING. A screenful with no number
            reads as the whole queue — and at a term start it is a third of it. */}
        {total > pageSize && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-2 text-xs text-muted-foreground">
            <span>
              Showing {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of {total} waiting
            </span>
            <span className="flex items-center gap-3">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => setPage((n) => Math.max(1, n - 1))}
                className="underline underline-offset-2 disabled:no-underline disabled:opacity-40"
              >
                Previous
              </button>
              <span>
                Page {page} of {Math.max(1, Math.ceil(total / pageSize))}
              </span>
              <button
                type="button"
                disabled={page * pageSize >= total}
                onClick={() => setPage((n) => n + 1)}
                className="underline underline-offset-2 disabled:no-underline disabled:opacity-40"
              >
                Next
              </button>
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
