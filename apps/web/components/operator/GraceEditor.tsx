"use client";

// Per-school grace window (days past due before the STANDARD-floor downgrade).
// DELEGABLE (platform.grace.manage — manager_admin holds it): the API hard-caps
// the value at GRACE_DAYS_MAX, so this is bounded customer-service leeway for a
// late payer, never an unbounded comp (plan/period changes stay owner-only).

import { useState } from "react";
import { GRACE_DAYS_MAX, SUBSCRIPTION_GRACE_DAYS } from "@sms/types";
import { Button } from "@/components/ui/button";
import { sendWithStepUp } from "@/lib/stepup";
import { interpretApiError } from "@/lib/api-error";

export function GraceEditor({ schoolId, initial }: { schoolId: string; initial: number | null }) {
  const [value, setValue] = useState<number | null>(initial);
  const [draft, setDraft] = useState<string>(initial === null ? "" : String(initial));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function save() {
    // Empty input = back to the platform default.
    const graceDays = draft.trim() === "" ? null : Number(draft);
    if (graceDays !== null && (!Number.isInteger(graceDays) || graceDays < 0 || graceDays > GRACE_DAYS_MAX)) {
      setNote(`Grace must be a whole number of days between 0 and ${GRACE_DAYS_MAX} (or empty for the default).`);
      return;
    }
    setBusy(true);
    setNote(null);
    const res = await sendWithStepUp("PUT", `operator/tenants/${schoolId}/grace`, { graceDays });
    if (res.ok) {
      setValue(graceDays);
      setNote(graceDays === null ? `Reset to the platform default (${SUBSCRIPTION_GRACE_DAYS} days).` : "Saved.");
    } else {
      setNote(interpretApiError(res.status, await res.text()));
    }
    setBusy(false);
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <span className="text-muted-foreground">
        Grace: <strong>{value ?? `default (${SUBSCRIPTION_GRACE_DAYS})`}</strong> day{(value ?? SUBSCRIPTION_GRACE_DAYS) === 1 ? "" : "s"}
      </span>
      <input
        type="number"
        min={0}
        max={GRACE_DAYS_MAX}
        placeholder="default"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        className="h-7 w-20 rounded-md border border-input bg-background px-2 text-xs"
      />
      <Button size="sm" variant="outline" className="h-7" disabled={busy} onClick={save}>
        {busy ? "Saving…" : "Set grace"}
      </Button>
      {note && <span className="text-muted-foreground">{note}</span>}
    </div>
  );
}
