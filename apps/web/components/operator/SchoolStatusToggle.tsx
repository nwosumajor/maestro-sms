"use client";

// super_admin: enable/disable a whole school. DISABLED blocks every member
// login and hides the school from the public directory — the hard deactivation
// lever for long-unpaid or off-boarded tenants. Nothing is deleted; re-enabling
// restores everything instantly. Step-up gated server-side.

import * as React from "react";
import { useRouter } from "next/navigation";
import { sendWithStepUp } from "@/lib/stepup";
import { readApiError } from "@/lib/api-error";
import { Button } from "@/components/ui/button";

export function SchoolStatusToggle({ schoolId, status }: { schoolId: string; status: string }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);
  const disabled = status === "DISABLED";

  const toggle = async () => {
    const next = disabled ? "ACTIVE" : "DISABLED";
    if (
      !disabled &&
      !confirm(
        "Disable this school? EVERY member login will be blocked until it is re-enabled. No data is deleted.",
      )
    )
      return;
    setBusy(true);
    setMsg(null);
    const res = await sendWithStepUp("PUT", `operator/tenants/${schoolId}/status`, { status: next });
    setBusy(false);
    if (res.ok) {
      setMsg(next === "DISABLED" ? "School disabled — logins blocked." : "School re-enabled.");
      router.refresh();
    } else setMsg(await readApiError(res));
  };

  return (
    <span className="inline-flex items-center gap-2">
      <Button size="sm" variant={disabled ? "default" : "destructive"} disabled={busy} onClick={toggle}>
        {busy ? "Working…" : disabled ? "Re-enable school" : "Disable school"}
      </Button>
      {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
    </span>
  );
}
