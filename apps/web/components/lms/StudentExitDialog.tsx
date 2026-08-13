"use client";

// Raise a student exit — the thing that actually ends a pupil's access.
//
// WHAT THIS REPLACES. Two ghost buttons on the roster, "Transfer" and
// "Withdraw", each a single click behind a `window.prompt`. They read like
// "this child has left the school" and did nothing of the sort: one enrolment
// row changed, the account stayed ACTIVE, the pupil could still sign in, and
// any other class they were in still listed them.
//
// So this screen is deliberately NOT a button. Ending a child's access is a
// decision an approver has to be able to check, which means showing them what
// they are about to end BEFORE they raise it: which classes, what money is
// still owed, and whether the pupil has already left. Every one of those is a
// question the old prompt made the clicker answer from memory.

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { readApiError } from "@/lib/api-error";
import { useFormat } from "@/components/shell/RegionProvider";

type Preview = {
  studentId: string;
  studentName: string;
  classNames: string[];
  outstandingMinor: number;
  currency: string;
  unreturnedBooks: string[];
  alreadyExited: boolean;
};

const KINDS = [
  { value: "TRANSFERRED", label: "Transferred to another school" },
  { value: "WITHDRAWN", label: "Withdrawn by the family" },
  { value: "GRADUATED", label: "Graduated / completed" },
] as const;

export function StudentExitDialog({
  studentId,
  studentName,
  onClose,
}: {
  studentId: string;
  studentName: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const { money } = useFormat();
  const [preview, setPreview] = React.useState<Preview | null>(null);
  const [kind, setKind] = React.useState<(typeof KINDS)[number]["value"]>("TRANSFERRED");
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [raised, setRaised] = React.useState(false);

  React.useEffect(() => {
    let live = true;
    void (async () => {
      const res = await fetch(`/api/sms/students/${studentId}/exit/preview`);
      if (!live) return;
      if (res.ok) setPreview((await res.json()) as Preview);
      else setError(await readApiError(res));
    })();
    return () => {
      live = false;
    };
  }, [studentId]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/sms/students/${studentId}/exit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, reason: reason.trim() || undefined }),
    });
    setBusy(false);
    if (res.ok) {
      setRaised(true);
      router.refresh();
    } else setError(await readApiError(res));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-lg rounded-lg border border-border bg-background p-5 shadow-lg">
        <h2 className="text-base font-semibold">Student exit — {studentName}</h2>

        {raised ? (
          // Say what happens NEXT and what has not happened yet. A staff member
          // told only "submitted" reasonably assumes the pupil is now gone, and
          // stops chasing the approval that is the entire point.
          <div className="mt-3 space-y-3">
            <Alert variant="info">
              <AlertTitle>Sent to the principal for approval</AlertTitle>
              <AlertDescription>
                Nothing has changed yet. {studentName} keeps their access and stays on every register until the
                principal approves it — they will see it under Approvals.
              </AlertDescription>
            </Alert>
            <Button className="w-full" onClick={onClose}>
              Done
            </Button>
          </div>
        ) : (
          <>
            <p className="mt-1 text-sm text-muted-foreground">
              This ends {studentName}&apos;s sign-in access and closes every class enrolment. It needs the
              principal&apos;s approval, and it cannot be done by one person.
            </p>

            {error && <p className="mt-3 text-sm text-destructive">{error}</p>}

            {!preview && !error && <p className="mt-4 text-sm text-muted-foreground">Loading…</p>}

            {preview && (
              <div className="mt-4 space-y-4">
                {preview.alreadyExited && (
                  <Alert variant="info">
                    <AlertTitle>This student has already left</AlertTitle>
                    <AlertDescription>No further request is needed.</AlertDescription>
                  </Alert>
                )}

                <dl className="rounded-md border border-border text-sm">
                  <div className="flex justify-between gap-4 border-b border-border px-3 py-2">
                    <dt className="text-muted-foreground">Classes that will close</dt>
                    <dd className="text-right font-medium">
                      {preview.classNames.length ? preview.classNames.join(", ") : "None"}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4 border-b border-border px-3 py-2">
                    <dt className="text-muted-foreground">Fees still outstanding</dt>
                    <dd className="text-right font-medium">
                      {money(preview.outstandingMinor, preview.currency)}
                    </dd>
                  </div>
                  {/* Books are NOT closed by the exit — a pupil leaving does not
                      return them, and marking the loans returned would record
                      something that did not happen. So the approver is told
                      while the family is still reachable. */}
                  <div className="flex justify-between gap-4 px-3 py-2">
                    <dt className="text-muted-foreground">Library books not returned</dt>
                    <dd className="text-right font-medium">
                      {preview.unreturnedBooks.length === 0
                        ? "None"
                        : preview.unreturnedBooks.join(", ")}
                    </dd>
                  </div>
                </dl>

                {preview.unreturnedBooks.length > 0 && (
                  <p className="text-sm text-muted-foreground">
                    Chase the {preview.unreturnedBooks.length === 1 ? "book" : "books"} before approving —
                    once the family has gone it is much harder, and the copies stay off the shelf until
                    they come back.
                  </p>
                )}

                {preview.outstandingMinor > 0 && (
                  // A SIGNAL, never a block. A school that cannot release a
                  // leaver over a debt has a data-protection problem, not a
                  // collections one — so this informs the approver and stops
                  // there.
                  <p className="text-sm text-muted-foreground">
                    There is still money owed on this student&apos;s account. That does not prevent the exit —
                    the invoices remain on record and payable — but the principal should know before approving.
                  </p>
                )}

                <div className="space-y-1.5">
                  <label className="text-sm font-medium" htmlFor="exit-kind">
                    Reason for leaving
                  </label>
                  <select
                    id="exit-kind"
                    className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
                    value={kind}
                    onChange={(e) => setKind(e.target.value as typeof kind)}
                  >
                    {KINDS.map((k) => (
                      <option key={k.value} value={k.value}>
                        {k.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label className="text-sm font-medium" htmlFor="exit-note">
                    Note for the principal <span className="font-normal text-muted-foreground">(optional)</span>
                  </label>
                  <textarea
                    id="exit-note"
                    rows={2}
                    className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                    placeholder="e.g. family relocating to Abuja from September"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </div>

                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={onClose} disabled={busy}>
                    Cancel
                  </Button>
                  <Button onClick={submit} disabled={busy || preview.alreadyExited}>
                    {busy ? "Sending…" : "Send for approval"}
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
