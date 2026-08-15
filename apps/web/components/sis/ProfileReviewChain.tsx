"use client";

// The pupil-profile review chain, on one pupil's record.
//
// The chain is: the pupil (or their parent) SUBMITS a complete profile → the
// class SUPERVISOR checks it → a school ADMIN approves it. All three endpoints
// existed and were reachable from nothing at all: the submit had no button, and
// neither review stage had a screen. The completion endpoint even describes
// itself as driving a first-sign-in prompt that was never built.
//
// One component serves every party, because the SERVER already decides who may
// do what — submit is gated on the profile write permission, the supervisor
// check on the relationship (404 otherwise), approval on rbac.manage. Showing a
// control the caller cannot use would only move the refusal later, so each is
// offered on the permission its endpoint requires and the server remains the
// authority.

import type { SisCompletionDto, Serialized } from "@sms/types";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { readApiError } from "@/lib/api-error";

type Completion = Serialized<SisCompletionDto>;

const LABEL: Record<string, string> = {
  INCOMPLETE: "Not submitted",
  SUBMITTED: "Waiting for review",
  CHANGES_REQUESTED: "Changes requested",
  APPROVED: "Approved",
};

export function ProfileReviewChain({
  studentId,
  canSubmit,
  canReview,
  canApprove,
}: {
  studentId: string;
  /** Holds student.profile.write — the pupil, their parent, or SIS staff. */
  canSubmit: boolean;
  /** Holds student.profile.read — the supervisor check is relationship-scoped
   *  server-side, so a non-supervisor's press is refused there. */
  canReview: boolean;
  /** Holds rbac.manage — the approval stage. */
  canApprove: boolean;
}) {
  const [state, setState] = React.useState<Completion | null>(null);
  const [note, setNote] = React.useState("");
  const [msg, setMsg] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    const res = await fetch(`/api/sms/students/${studentId}/profile/completion`, { cache: "no-store" });
    if (!res.ok) {
      setState(null);
      return;
    }
    setState((await res.json()) as Completion);
  }, [studentId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const act = async (path: string, body: unknown, ok: string) => {
    setBusy(true);
    setMsg(null);
    const res = await fetch(`/api/sms/students/${studentId}/profile/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    setBusy(false);
    if (!res.ok) {
      // The server's refusals are the useful ones here — "Still to fill in:
      // guardian phone, date of birth" and "The class supervisor has not checked
      // this profile yet" both tell the reader exactly what to do next.
      setMsg(await readApiError(res));
      return;
    }
    setMsg(ok);
    setNote("");
    await load();
  };

  if (!state) return null;

  const status = state.status;
  const missing = state.missing ?? [];

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Profile review</CardTitle>
        <CardDescription>
          A pupil&apos;s profile is submitted, checked by the class supervisor, then approved by the school office.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="rounded-full border border-border px-2 py-0.5 text-xs">{LABEL[status] ?? status}</span>
          {state.submittedAt && (
            <span className="text-xs text-muted-foreground">submitted {String(state.submittedAt).slice(0, 10)}</span>
          )}
          {state.approvedAt && (
            <span className="text-xs text-muted-foreground">approved {String(state.approvedAt).slice(0, 10)}</span>
          )}
        </div>

        {/* What is still missing — the endpoint names the fields, so the pupil is
            never left guessing why Submit refuses. */}
        {missing.length > 0 && (
          <p className="text-sm text-muted-foreground">
            Still to fill in: <span className="text-foreground">{missing.join(", ")}</span>
          </p>
        )}

        {/* Why it came back. Without this the pupil sees "changes requested" and
            no reason. */}
        {status === "CHANGES_REQUESTED" && state.reviewNote && (
          <p className="rounded-md border border-border bg-muted/40 p-2 text-sm">
            <span className="font-medium">Reviewer asked for:</span> {state.reviewNote}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {canSubmit && status !== "APPROVED" && status !== "SUBMITTED" && (
            <Button size="sm" disabled={busy || missing.length > 0} onClick={() => void act("submit", {}, "Submitted for review.")}>
              Submit for review
            </Button>
          )}

          {canReview && status === "SUBMITTED" && !state.approvedAt && (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void act("supervisor-review", { decision: "PASS" }, "Checked — passed to the school office.")}
              >
                Supervisor: passes
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void act("supervisor-review", { decision: "CHANGES", note }, "Sent back to the pupil with your note.")
                }
              >
                Ask for changes
              </Button>
              <input
                aria-label="Note for the pupil"
                className="h-9 min-w-[16rem] flex-1 rounded-md border border-input bg-background px-3 text-sm"
                placeholder="What needs changing?"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </>
          )}

          {canApprove && status === "SUBMITTED" && (
            // The server refuses this until the supervisor has checked, and says
            // so — so the button stays visible rather than silently absent.
            <Button size="sm" disabled={busy} onClick={() => void act("approve", {}, "Profile approved.")}>
              Approve
            </Button>
          )}
        </div>

        {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
      </CardContent>
    </Card>
  );
}
