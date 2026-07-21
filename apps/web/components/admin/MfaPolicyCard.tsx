"use client";

import * as React from "react";
import { sendWithStepUp } from "@/lib/stepup";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

// Per-school "require MFA for all staff" policy. Step-up gated (security
// policy). When on, every staff member is forced to enrol TOTP before they can
// use the app (students and parents are unaffected).
export function MfaPolicyCard({ initial }: { initial: boolean }) {
  const [on, setOn] = React.useState(initial);
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  const save = async (next: boolean) => {
    setBusy(true);
    setMsg(null);
    const res = await sendWithStepUp("PUT", "admin/security/mfa-policy", { requireStaffMfa: next });
    setBusy(false);
    if (res.ok) {
      setOn(next);
      setMsg("Saved.");
    } else {
      const body = (await res.json().catch(() => null)) as { message?: string } | null;
      setMsg(body?.message ?? "Failed.");
    }
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Require two-factor authentication for staff</CardTitle>
        <CardDescription>
          When on, every staff member must set up an authenticator app before they can use the app. Students and
          parents are not affected. The platform owner is always exempt.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={on} disabled={busy} onChange={(e) => save(e.target.checked)} />
          {on ? "Required for all staff" : "Optional"}
        </label>
        {busy && <span className="text-sm text-muted-foreground">Saving…</span>}
        {msg && <span className="text-sm text-muted-foreground">{msg}</span>}
      </CardContent>
    </Card>
  );
}
