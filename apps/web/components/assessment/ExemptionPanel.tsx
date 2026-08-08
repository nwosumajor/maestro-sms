"use client";

// =============================================================================
// ExemptionPanel — grant or withdraw an integrity accommodation
// =============================================================================
// The control that was missing. /help tells a pupil "if you use assistive
// technology, ask your teacher for an exemption" and tells the teacher to
// "grant exemptions for students using assistive technology"; until now there
// was nowhere to do it, so the pupil asked and the teacher had no answer.
//
// Wording matters here more than usual. This is a disability accommodation, not
// a disciplinary lever: it is described as switching monitoring OFF for a pupil
// who needs their own tools, never as "trusting" or "excusing" them.
// =============================================================================

import * as React from "react";
import type { IntegrityExemptionDto, Serialized } from "@sms/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { sendSms } from "@/components/game/play-ui";
import { shortDate } from "@/lib/format";

type Row = Serialized<IntegrityExemptionDto>;

export function ExemptionPanel({
  studentId,
  studentName,
  initial,
  canWrite,
}: {
  studentId: string;
  studentName: string;
  initial: Row[] | null;
  canWrite: boolean;
}) {
  const [rows, setRows] = React.useState<Row[] | null>(initial);
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const refresh = async () => {
    // sendSms is for MUTATIONS; a plain fetch through the same BFF prefix for the
    // re-read. A failed refresh leaves `rows` null, which renders as "could not
    // load" rather than as "no accommodation".
    const res = await fetch(`/api/sms/integrity/exemptions?studentId=${studentId}`, { cache: "no-store" });
    setRows(res.ok ? ((await res.json()) as Row[]) : null);
  };

  const grant = async () => {
    setBusy(true);
    setError(null);
    const res = await sendSms("POST", "integrity/exemptions", { studentId, reason });
    if (res.ok) {
      setReason("");
      await refresh();
    } else {
      setError(res.error);
    }
    setBusy(false);
  };

  const revoke = async (id: string) => {
    setBusy(true);
    setError(null);
    const res = await sendSms("DELETE", `integrity/exemptions/${id}`, {});
    if (res.ok) await refresh();
    else setError(res.error);
    setBusy(false);
  };

  const active = (rows ?? []).filter((r) => r.active);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Integrity monitoring accommodation</CardTitle>
        <CardDescription>
          Turns paste-blocking and focus tracking off for {studentName}. Grant one where a pupil uses assistive
          technology — a screen reader, speech-to-text or a switch device — because those tools trip the monitoring
          simply by being used.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* A failed read must not read as "no accommodation" — a teacher would
            conclude the pupil has none and leave the monitoring on. */}
        {rows === null ? (
          <p className="text-sm text-destructive">
            Could not load accommodations. This is a failure to load, not a report that there are none — please
            refresh before deciding.
          </p>
        ) : active.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No accommodation in place. Monitoring applies to {studentName} as it does to the rest of the class.
          </p>
        ) : (
          <ul className="space-y-2">
            {active.map((r) => (
              <li key={r.id} className="rounded-lg border border-border bg-card p-3 text-sm">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-medium">
                      {r.assessmentTitle ? `For "${r.assessmentTitle}"` : "All assessments"}
                    </p>
                    <p className="mt-0.5 text-muted-foreground">{r.reason}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Granted by {r.grantedByName} on {shortDate(r.createdAt)}
                    </p>
                  </div>
                  {canWrite && (
                    <Button variant="outline" size="sm" disabled={busy} onClick={() => revoke(r.id)}>
                      Withdraw
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        {canWrite && (
          <div className="space-y-2 border-t border-border pt-4">
            <label htmlFor="exemption-reason" className="text-sm font-medium">
              Grant an accommodation
            </label>
            <input
              id="exemption-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why it is needed — e.g. uses speech-to-text"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              maxLength={500}
            />
            <p className="text-xs text-muted-foreground">
              Recorded against your name and kept even after it is withdrawn, so the decision can be reviewed later.
            </p>
            <Button onClick={grant} disabled={busy || reason.trim().length < 3}>
              {busy ? "Saving…" : "Grant for all assessments"}
            </Button>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
