"use client";

// =============================================================================
// What this school asks for
// =============================================================================
// Editable, because schools differ and the difference is not interesting: one
// wants an immunisation card, another a transfer letter, a third a
// state-of-origin certificate. Adding one is a row, not a release.
//
// A requirement is switched OFF rather than deleted. Submissions already filed
// against it keep their meaning, and it stops appearing as outstanding
// everywhere at once.
// =============================================================================

import * as React from "react";
import { useRouter } from "next/navigation";
import type { DocumentRequirementDto, Serialized } from "@sms/types";
import { postSms, sendSms } from "@/components/game/play-ui";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Requirement = Serialized<DocumentRequirementDto>;

export function RequirementsEditor({
  scope,
  initial,
  title,
}: {
  scope: "STUDENT_ADMISSION" | "STAFF_ONBOARDING";
  initial: Requirement[];
  title: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [label, setLabel] = React.useState("");
  const [mandatory, setMandatory] = React.useState(false);
  // DOES THIS DOCUMENT RUN OUT?
  //
  // `needsExpiry` is what makes a verifier record an expiry date, and
  // `outstandingRequirements` then stops counting the document as held once
  // that date passes. Both API paths have always accepted it and this screen
  // sent it on neither — so the SEEDED requirements (teaching licence, identity
  // document) tracked expiry and a school's OWN never could. A safeguarding
  // certificate a school added itself stayed ticked off for ever.
  const [needsExpiry, setNeedsExpiry] = React.useState(false);

  async function seed() {
    setBusy(true);
    setError(null);
    // Idempotent on the key: this fills an empty list, it never resets a
    // curated one — so it is safe to press twice.
    const res = await postSms(`documents/requirements/seed-defaults?scope=${scope}`, {});
    setBusy(false);
    if (res.ok) router.refresh();
    else setError(res.error);
  }

  async function add() {
    const key = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);
    if (key.length < 2) {
      setError("Give it a name of at least two letters.");
      return;
    }
    setBusy(true);
    setError(null);
    const res = await postSms("documents/requirements", { appliesTo: scope, key, label: label.trim(), mandatory, needsExpiry });
    setBusy(false);
    if (res.ok) {
      setAdding(false);
      setLabel("");
      setMandatory(false);
      setNeedsExpiry(false);
      router.refresh();
    } else setError(res.error);
  }

  async function toggle(r: Requirement, patch: { active?: boolean; mandatory?: boolean; needsExpiry?: boolean }) {
    setBusy(true);
    setError(null);
    const res = await sendSms("PUT", `documents/requirements/${r.id}`, patch);
    setBusy(false);
    if (res.ok) router.refresh();
    else setError(res.error);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>
          {initial.length === 0
            ? "Nothing is asked for yet. Start from the usual list and change it to suit the school."
            : "Switch one off to stop asking for it — anything already sent in keeps its place."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>}

        {initial.map((r) => (
          <div key={r.id} className={`flex flex-wrap items-center gap-2 rounded-md border border-border p-3 ${r.active ? "" : "opacity-60"}`}>
            <div className="min-w-0">
              <p className="truncate font-medium">{r.label}</p>
              {r.description && <p className="text-xs text-muted-foreground">{r.description}</p>}
            </div>
            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => toggle(r, { mandatory: !r.mandatory })}
                className={`rounded px-1.5 py-0.5 text-[11px] ${r.mandatory ? "bg-amber-500/15 text-amber-600 dark:text-amber-400" : "bg-muted text-muted-foreground"}`}
              >
                {r.mandatory ? "Required" : "Optional"}
              </button>
              {/* The repair path. Without it a requirement created before
                  anybody thought about expiry could never start tracking it,
                  and the only fix was to stop asking for it and add it again
                  under a new key — losing every document already supplied
                  against the old one. */}
              <button
                type="button"
                disabled={busy}
                title={
                  r.needsExpiry
                    ? "This document runs out — the office records an expiry date and it stops counting as held once it passes."
                    : "This document does not run out — once supplied it counts as held for good."
                }
                onClick={() => toggle(r, { needsExpiry: !r.needsExpiry })}
                className={`rounded px-1.5 py-0.5 text-[11px] ${r.needsExpiry ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"}`}
              >
                {r.needsExpiry ? "Expires" : "No expiry"}
              </button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => toggle(r, { active: !r.active })}>
                {r.active ? "Stop asking" : "Ask again"}
              </Button>
            </div>
          </div>
        ))}

        <div className="flex flex-wrap gap-2">
          {initial.length === 0 && (
            <Button size="sm" disabled={busy} onClick={seed}>
              {busy ? "Adding…" : "Use the usual list"}
            </Button>
          )}
          {!adding ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setAdding(true)}>
              Ask for something else
            </Button>
          ) : (
            <>
              <input
                className="flex-1 rounded-md border border-border bg-background px-2 py-1 text-sm"
                placeholder="e.g. State of origin certificate"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
              <label className="flex items-center gap-1 text-sm">
                <input type="checkbox" checked={mandatory} onChange={(e) => setMandatory(e.target.checked)} />
                Required
              </label>
              <label className="flex items-center gap-1 text-sm" title="A licence, a DBS check, a medical clearance — anything with a date on it.">
                <input
                  type="checkbox"
                  checked={needsExpiry}
                  onChange={(e) => setNeedsExpiry(e.target.checked)}
                />
                Expires
              </label>
              <Button size="sm" disabled={busy || !label.trim()} onClick={add}>Add</Button>
              <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
