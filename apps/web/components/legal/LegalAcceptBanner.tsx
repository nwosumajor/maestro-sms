"use client";

// Shell-wide clickwrap banner: shown to billing managers whose school has not
// yet accepted the CURRENT legal-pack version (first login of a provisioned
// admin, or after a material terms change bumped the version). Accepting
// appends to the school's append-only acceptance ledger, audited server-side.

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { readApiError } from "@/lib/api-error";

export function LegalAcceptBanner({ version }: { version: string }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  const accept = async () => {
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/sms/legal/acceptance", { method: "POST" });
    setBusy(false);
    if (res.ok) router.refresh();
    else setMsg(await readApiError(res));
  };

  return (
    <div className="border-b border-primary/30 bg-primary/10 px-4 py-2.5">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 text-sm">
        <p>
          Please review the platform terms (v{version}) for your school:{" "}
          <Link href="/legal/terms" target="_blank" className="font-medium underline underline-offset-2">Service Agreement</Link>,{" "}
          <Link href="/legal/dpa" target="_blank" className="font-medium underline underline-offset-2">Data Processing Agreement</Link> and{" "}
          <Link href="/legal/privacy" target="_blank" className="font-medium underline underline-offset-2">Privacy Policy</Link>.
        </p>
        <span className="flex items-center gap-2">
          {msg && <span className="text-xs text-destructive">{msg}</span>}
          <Button size="sm" disabled={busy} onClick={accept}>
            {busy ? "Recording…" : "I accept on behalf of my school"}
          </Button>
        </span>
      </div>
    </div>
  );
}
