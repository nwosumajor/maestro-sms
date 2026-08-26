"use client";

// Staff review queue for student subject selections. The server scopes the
// list: a class supervisor sees selections naming them; school_admin /
// head_teacher / principal see all. Buttons only render for the stage the
// caller can actually act on (the API re-enforces identity + SoD).

import type { SubjectSelectionDto, SubjectSelectionPageDto, Serialized } from "@sms/types";
import * as React from "react";
import { sendSms } from "@/components/game/play-ui";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Selection = Serialized<SubjectSelectionDto>;
type Page = Serialized<SubjectSelectionPageDto>;

export function SelectionReview({ userId, canApproveFinal }: { userId: string; canApproveFinal: boolean }) {
  // TWO reads, because they answer two questions. The queue is asked for BY
  // STATUS in SQL and comes back oldest-first; the history is a separate page.
  //
  // // GOTCHA: this used to be one capped read filtered in memory —
  // `rows.filter(s => s.status === "PENDING_…")` over whatever survived
  // `take: 200`. A selection stays pending because nobody has reviewed it, so
  // pending rows AGE, and the list was ordered by `updatedAt`, which a REVIEW
  // bumps: working through the queue pushed the rest of it off the end.
  // Measured live on one term of a 901-pupil school — 21 awaiting review, 200
  // rows returned, every one APPROVED, and this card reading "Nothing awaiting
  // review."
  const [queue, setQueue] = React.useState<Page | null>(null);
  const [history, setHistory] = React.useState<Page | null>(null);
  const [page, setPage] = React.useState(1);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    const [q, h] = await Promise.all([
      fetch(`/api/sms/subject-selections?filter=open&page=${page}`),
      fetch("/api/sms/subject-selections?filter=decided"),
    ]);
    if (q.ok) setQueue((await q.json()) as Page);
    if (h.ok) setHistory((await h.json()) as Page);
  }, [page]);
  React.useEffect(() => { load(); }, [load]);

  if (!queue) return null;
  const pending = queue.items;
  const done = (history?.items ?? []).slice(0, 10);
  const waiting = queue.pendingTotal;
  if (pending.length === 0 && done.length === 0) return null;

  const actionable = (s: Selection) =>
    (s.status === "PENDING_SUPERVISOR" && s.supervisorId === userId) ||
    (s.status === "PENDING_ADMIN" && canApproveFinal);

  const act = async (s: Selection, action: "APPROVE" | "REJECT") => {
    const note = action === "REJECT" ? (prompt("Reason (shown to the student):") ?? undefined) : undefined;
    setBusy(s.id); setMsg(null);
    const res = await sendSms("POST", `subject-selections/${s.id}/review`, { action, note });
    setBusy(null);
    if (res.ok) load(); else setMsg(res.error ?? "Request failed.");
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Subject selections</CardTitle>
        <CardDescription>
          Student subject choices for the term. Each passes the class supervisor, then the school
          admin or head teacher (a different person), before it takes effect in grading.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {/* The count comes from the DATABASE, not from the rows on screen, so
            it cannot be made to read zero by a page that happens to hold none. */}
        {waiting === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing awaiting review.</p>
        ) : (
          <p className="text-sm font-medium">
            {waiting} selection{waiting === 1 ? "" : "s"} awaiting review
            {queue.total > pending.length && (
              <span className="font-normal text-muted-foreground">
                {" "}· showing {(queue.page - 1) * queue.pageSize + 1}–
                {(queue.page - 1) * queue.pageSize + pending.length} of {queue.total}, oldest first
              </span>
            )}
          </p>
        )}
        {[...pending, ...done].map((s) => (
          <div key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
            <div className="min-w-0">
              <p className="text-sm font-medium">
                {s.studentName} <span className="text-muted-foreground">· {s.className} · {s.termName}</span>
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {s.subjects.map((x) => x.name).join(", ")}
              </p>
              {/* Say it where the decision is made. PENDING_ADMIN looks the same
                  whether a form teacher passed it or whether the class has none,
                  and the difference is whether this reviewer is the second check
                  or the only one. */}
              {s.status === "PENDING_ADMIN" && s.supervisorStage === "SKIPPED_NO_SUPERVISOR" && (
                <p className="text-xs text-amber-700 dark:text-amber-500">
                  No form-teacher check — {s.className} has no supervisor, so yours is the only review.
                </p>
              )}
              {s.status === "PENDING_ADMIN" && s.supervisorStage === "PASSED" && s.supervisorName && (
                <p className="text-xs text-muted-foreground">Passed by {s.supervisorName}.</p>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Badge variant={s.status === "APPROVED" ? "default" : s.status === "REJECTED" ? "destructive" : "secondary"}>
                {s.status === "PENDING_SUPERVISOR" ? "supervisor" : s.status === "PENDING_ADMIN" ? "final approval" : s.status.toLowerCase()}
              </Badge>
              {actionable(s) && (
                <>
                  <Button size="sm" className="h-7 text-xs" disabled={busy === s.id} onClick={() => act(s, "APPROVE")}>Approve</Button>
                  <Button size="sm" variant="destructive" className="h-7 text-xs" disabled={busy === s.id} onClick={() => act(s, "REJECT")}>Reject</Button>
                </>
              )}
            </div>
          </div>
        ))}
        {queue.total > queue.pageSize && (
          <div className="flex items-center gap-2 pt-1">
            <Button size="sm" variant="outline" className="h-7 text-xs" disabled={queue.page <= 1}
              onClick={() => setPage((n) => Math.max(1, n - 1))}>Newer</Button>
            <Button size="sm" variant="outline" className="h-7 text-xs"
              disabled={queue.page * queue.pageSize >= queue.total}
              onClick={() => setPage((n) => n + 1)}>Older</Button>
          </div>
        )}
        {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
      </CardContent>
    </Card>
  );
}
