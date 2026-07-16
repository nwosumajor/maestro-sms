"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { readApiError } from "@/lib/api-error";

export function PayOnlineButton({ invoiceId }: { invoiceId: string }) {
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  const pay = async () => {
    setBusy(true); setMsg(null);
    const res = await fetch(`/api/sms/invoices/${invoiceId}/pay/init`, { method: "POST" });
    if (res.ok) {
      const data = (await res.json()) as { authorizationUrl: string; feeMinor?: number; chargedMinor?: number };
      // Transparency before the redirect: when a payer-borne convenience fee
      // applies, say so (the gateway page shows only the total).
      if (data.feeMinor && data.feeMinor > 0 && data.chargedMinor) {
        const fmt = (n: number) => new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN" }).format(n / 100);
        setMsg(`Includes a ${fmt(data.feeMinor)} platform convenience fee — total ${fmt(data.chargedMinor)}. Redirecting…`);
      }
      window.location.href = data.authorizationUrl;
      return;
    }
    setBusy(false);
    setMsg(res.status === 503 ? "Online payments are not configured for this school." : await readApiError(res));
  };

  return (
    <div className="flex items-center gap-3">
      <Button onClick={pay} disabled={busy}>{busy ? "Starting…" : "Pay online (card)"}</Button>
      {msg && <span className="text-sm text-muted-foreground">{msg}</span>}
    </div>
  );
}
