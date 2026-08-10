"use client";

// The school has just come back from the gateway. Settle, then SAY WHAT THEY
// BOUGHT.
//
// Two failures this replaces. The subscription checkout carried no return URL
// at all, so a school that had just paid landed nowhere in particular and the
// flow depended entirely on a webhook arriving; when one did not, Paystack said
// "Payment successful" while the payment history still said "Awaiting payment".
// A school reading that reasonably concludes the payment failed and pays again.
//
// And even when it did settle, nothing told them the ONE thing they were buying:
// the new period. "Paid" is a receipt; "covered until 3 June 2031" is the answer
// to the question they actually had.

import * as React from "react";
import { useRouter } from "next/navigation";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

type Result = {
  settled: boolean;
  subscription: { plan: string; status: string; currentPeriodEnd: string | null };
};

export function PaymentVerifyBanner({ reference }: { reference: string }) {
  const router = useRouter();
  const [state, setState] = React.useState<"checking" | "settled" | "pending" | "error">("checking");
  const [sub, setSub] = React.useState<Result["subscription"] | null>(null);

  React.useEffect(() => {
    let live = true;
    // A gateway redirect can beat its own webhook, and verification is a single
    // round trip to Paystack — so try a few times before concluding anything
    // rather than telling a school who HAS paid that we cannot see it.
    void (async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const res = await fetch("/api/sms/billing/payments/verify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reference }),
        });
        if (!live) return;
        if (!res.ok) {
          setState("error");
          return;
        }
        const data = (await res.json()) as Result;
        setSub(data.subscription);
        if (data.settled) {
          setState("settled");
          // Refresh so the history row and the plan card agree with this banner
          // — one screen must not show two answers.
          router.refresh();
          return;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (live) setState("pending");
    })();
    return () => {
      live = false;
    };
  }, [reference, router]);

  const until = sub?.currentPeriodEnd
    ? new Date(sub.currentPeriodEnd).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })
    : null;

  if (state === "checking") {
    return (
      <Alert variant="info">
        <AlertTitle>Confirming your payment…</AlertTitle>
        <AlertDescription>This takes a moment. Please don&apos;t pay again.</AlertDescription>
      </Alert>
    );
  }

  if (state === "settled") {
    return (
      <Alert variant="info">
        <AlertTitle>Payment confirmed — {sub?.plan} is active</AlertTitle>
        <AlertDescription>
          {until ? (
            <>
              Your subscription now runs until <span className="font-medium">{until}</span>. A receipt is available
              from the payment history below.
            </>
          ) : (
            <>Your plan is active. A receipt is available from the payment history below.</>
          )}
        </AlertDescription>
      </Alert>
    );
  }

  // NOT "failed". The money may well have been taken — we simply cannot confirm
  // it yet, and telling a school their payment failed when it did not is what
  // makes them pay twice.
  return (
    <Alert variant="info">
      <AlertTitle>We haven&apos;t been able to confirm this payment yet</AlertTitle>
      <AlertDescription>
        If you were charged, nothing is lost — payments are reconciled automatically and your plan will activate.
        Please don&apos;t pay again.{" "}
        <Button variant="outline" size="sm" className="ml-2" onClick={() => router.refresh()}>
          Check again
        </Button>
      </AlertDescription>
    </Alert>
  );
}
