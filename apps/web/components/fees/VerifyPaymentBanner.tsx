"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { postSms } from "@/components/game/play-ui";

// Verify-on-return (lost-webhook recovery): Paystack redirects the payer back
// to the invoice page with ?reference=… — confirm the charge against the
// gateway so the payment posts even if the webhook never arrives. Idempotent
// server-side, so racing the webhook is safe.
export function VerifyPaymentBanner({ invoiceId }: { invoiceId: string }) {
  const router = useRouter();
  const search = useSearchParams();
  const reference = search.get("reference") ?? search.get("trxref");
  const [state, setState] = React.useState<"checking" | "posted" | "already" | "pending" | null>(
    reference ? "checking" : null,
  );

  React.useEffect(() => {
    if (!reference) return;
    let cancelled = false;
    void (async () => {
      const res = await postSms<{ status: string }>(`invoices/${invoiceId}/pay/confirm`, { reference });
      if (cancelled) return;
      if (res.ok && res.data?.status === "posted") {
        setState("posted");
        router.refresh();
      } else if (res.ok && res.data?.status === "already_recorded") {
        setState("already");
        router.refresh();
      } else {
        setState("pending");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reference, invoiceId, router]);

  if (!state) return null;
  const styles: Record<string, string> = {
    checking: "border-border bg-muted/50 text-muted-foreground",
    posted: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    already: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    pending: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  };
  const text: Record<string, string> = {
    checking: "Confirming your payment with the gateway…",
    posted: "Payment confirmed and recorded. Thank you!",
    already: "Payment already recorded. Thank you!",
    pending:
      "The gateway hasn't confirmed this charge yet. If you completed payment it will be recorded automatically shortly — no need to pay again.",
  };
  return <div className={`rounded-md border px-4 py-2 text-sm ${styles[state]}`}>{text[state]}</div>;
}
