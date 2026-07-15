"use client";

// =============================================================================
// ImpersonateButton — become a user to reproduce what they see
// =============================================================================
// Support tool: access here is decided by JWT → guard → RLS plus relationship
// scoping and module entitlements, so a bug can be specific to ONE user in ONE
// school and invisible from the operator's own account. This is the only
// practical way to see it.
//
// Flow: POST /operator/impersonate (step-up gated + audited, super_admin only)
// mints a short-lived signed token for the target → hand it to the `impersonate`
// Auth.js provider, which verifies it and swaps the session → land on their
// dashboard AS them. Every subsequent action still records who was driving
// (the token's imp.by rides into the API token — see lib/apiToken.ts).
//
// Confirm first: this is the riskiest action in the system, and a misclick lands
// you inside a real school's data as a real person.
// =============================================================================

import { useState } from "react";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { postWithStepUp } from "@/lib/stepup";
import { interpretApiError } from "@/lib/api-error";

export function ImpersonateButton({
  schoolId,
  userId,
  userName,
  schoolName,
}: {
  schoolId: string;
  userId: string;
  userName: string;
  schoolName: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function go() {
    if (
      !window.confirm(
        `Sign in as ${userName} at ${schoolName}?\n\n` +
          "You will see their app exactly as they do. Everything you do is audited and " +
          "attributed to you. To return, sign out and log back in as yourself.",
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    // postWithStepUp handles the 403 STEPUP_REQUIRED -> password -> retry dance.
    const res = await postWithStepUp("operator/impersonate", { schoolId, userId });
    if (!res.ok) {
      setError(interpretApiError(res.status, await res.text()));
      setBusy(false);
      return;
    }
    const { token } = (await res.json()) as { token: string };
    // Swap the session. redirect:false so we can surface a failure instead of a
    // silent bounce to /login.
    const out = await signIn("impersonate", { token, redirect: false });
    if (out?.error) {
      setError("The impersonation token was rejected — it may have expired. Try again.");
      setBusy(false);
      return;
    }
    router.push("/dashboard");
    router.refresh();
  }

  return (
    <span className="inline-flex items-center gap-2">
      <Button size="sm" variant="ghost" className="h-7" disabled={busy} onClick={go}>
        {busy ? "Starting…" : "Sign in as"}
      </Button>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </span>
  );
}
