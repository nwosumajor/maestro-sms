"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { readApiError } from "@/lib/api-error";
import { useFormat } from "@/components/shell/RegionProvider";

/**
 * PRE-FLIGHT, resolved on the SERVER and passed in.
 *
 * A button that starts a payment which cannot succeed is the worst outcome —
 * the payer has chosen, waited, and been failed. Checking from a useEffect
 * would still SHIP the button in the HTML and remove it a moment later, which
 * is a real window in which someone can click it, and a flicker on the page a
 * parent is most anxious about. The page already fetches the invoice; asking
 * this alongside it costs nothing and the dead button is never rendered.
 *
 * `null` means the page could not establish it — the button stays, because a
 * failed pre-flight must never block a payment that might have worked.
 */
export function PayOnlineButton({
  invoiceId,
  availability,
}: {
  invoiceId: string;
  availability?: { available: boolean; reason: string | null } | null;
}) {
  const { money: fmtMoney } = useFormat();
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);
  const unavailable = availability != null && !availability.available;

  const pay = async () => {
    setBusy(true); setMsg(null);
    const res = await fetch(`/api/sms/invoices/${invoiceId}/pay/init`, { method: "POST" });
    if (res.ok) {
      const data = (await res.json()) as { authorizationUrl: string; feeMinor?: number; chargedMinor?: number };
      // Transparency before the redirect: when a payer-borne convenience fee
      // applies, say so (the gateway page shows only the total).
      if (data.feeMinor && data.feeMinor > 0 && data.chargedMinor) {
        // The SCHOOL's currency — a parent paying a British school saw a naira sign.
        const fmt = (n: number) => fmtMoney(n);
        setMsg(`Includes a ${fmt(data.feeMinor)} platform convenience fee — total ${fmt(data.chargedMinor)}. Redirecting…`);
      }
      window.location.href = data.authorizationUrl;
      return;
    }
    setBusy(false);
    setMsg(res.status === 503 ? "Online payments are not configured for this school." : await readApiError(res));
  };

  if (unavailable) {
    // No dead button. A payer who cannot pay online needs to know that and to
    // stop looking — not to click and be refused.
    return (
      <p className="text-sm text-muted-foreground">
        {availability?.reason ?? "Online card payment is temporarily unavailable."}
      </p>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <Button onClick={pay} disabled={busy}>{busy ? "Starting…" : "Pay online (card)"}</Button>
      {msg && <span className="text-sm text-muted-foreground">{msg}</span>}
    </div>
  );
}
