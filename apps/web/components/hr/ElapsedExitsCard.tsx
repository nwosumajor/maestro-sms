"use client";

// Close the accounts of staff whose last working day has passed.
//
// WHAT THIS BACKS UP. Approving a staff exit used to close the EMPLOYMENT record
// and nothing else — the account stayed active, so a teacher who had left could
// still sign in holding grades, attendance, student profiles and medical
// records. Access now ends on the last working day: at approval if that day has
// already passed, otherwise on the nightly sweep, so somebody serving a month's
// notice keeps teaching their classes.
//
// This button is the same job for one school, on demand. It exists because a
// scheduled job nobody can trigger is a job nobody can verify — the billing
// dunning sweep learned that first — and because "has it actually run?" is a
// question an administrator asks during an incident, not before one.

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { readApiError } from "@/lib/api-error";

export function ElapsedExitsCard() {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/sms/hr/exits/revoke-elapsed", { method: "POST" });
    setBusy(false);
    if (!res.ok) return setMsg(await readApiError(res));
    const { revoked, scanned } = (await res.json()) as { revoked: number; scanned: number };
    // Says what it DID and what it LOOKED AT. "Closed 0" on its own reads as a
    // failure; "0 to close — all 12 already closed" is the same number meaning
    // something completely different, and only one of them needs acting on.
    setMsg(
      scanned === 0
        ? "No approved exits have reached their last working day."
        : revoked === 0
          ? `Nothing to close — all ${scanned} departed staff already have their access closed.`
          : `Closed access for ${revoked} of ${scanned} departed staff.`,
    );
    router.refresh();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Departed staff access</CardTitle>
        <CardDescription>
          A staff member&apos;s account closes automatically on their last working day. Run this to close any
          that are already past it — for example after a system outage, or to confirm it has happened.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <Button variant="outline" onClick={run} disabled={busy}>
          {busy ? "Checking…" : "Close elapsed exits"}
        </Button>
        {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
      </CardContent>
    </Card>
  );
}
