"use client";

// The school has just come back from paying for a message-credit bundle.
// Settle it here, then say how many credits they now hold.
//
// THE GAP THIS CLOSES. The checkout already sent Paystack a callback_url
// pointing at /billing?verifyCredits=<ref>, and the API already had the
// endpoint to settle it — but nothing on the page ever called it. So the
// redirect landed on a billing screen that did nothing, and the credits only
// appeared when the daily card-reconciliation sweep next ran. A school that
// had just been charged NGN 50,000 saw an unchanged balance and reasonably
// concluded the purchase had failed.
//
// Deliberately a separate component from PaymentVerifyBanner: a subscription
// answers "what period did I buy", a bundle answers "how many credits do I now
// have". Sharing one component would mean one of those questions gets a
// generic answer.

import * as React from "react";
import { useRouter } from "next/navigation";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export function CreditVerifyBanner({ reference }: { reference: string }) {
  const router = useRouter();
  const [state, setState] = React.useState<"checking" | "credited" | "pending" | "error">("checking");
  const [balance, setBalance] = React.useState<number | null>(null);

  React.useEffect(() => {
    let live = true;
    // A gateway redirect can beat its own webhook, and verification is one
    // round trip to Paystack — so try a few times before concluding anything
    // rather than telling a school who HAS paid that we cannot see it.
    void (async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const res = await fetch("/api/sms/notifications/credits/verify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reference }),
        });
        if (!live) return;
        if (!res.ok) {
          setState("error");
          return;
        }
        const data = (await res.json()) as { credited: boolean; balance: number };
        setBalance(data.balance);
        if (data.credited) {
          setState("credited");
          // Refresh so the balance on the card agrees with this banner — one
          // screen must not show two different numbers.
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

  if (state === "checking") {
    return (
      <Alert variant="info">
        <AlertTitle>Confirming your purchase…</AlertTitle>
        <AlertDescription>This takes a moment. Please don&apos;t pay again.</AlertDescription>
      </Alert>
    );
  }

  if (state === "credited") {
    return (
      <Alert variant="info">
        <AlertTitle>Credits added</AlertTitle>
        <AlertDescription>
          Your balance is now <span className="font-medium">{(balance ?? 0).toLocaleString()}</span> message
          credits. SMS and WhatsApp alerts will send normally.
        </AlertDescription>
      </Alert>
    );
  }

  // NOT "failed". The money may well have been taken — and telling a school
  // their payment failed when it did not is what makes them pay twice.
  return (
    <Alert variant="info">
      <AlertTitle>We haven&apos;t been able to confirm this purchase yet</AlertTitle>
      <AlertDescription>
        If you were charged, nothing is lost — purchases are reconciled automatically and the credits will
        appear. Please don&apos;t buy the bundle again.{" "}
        <Button variant="outline" size="sm" className="ml-2" onClick={() => router.refresh()}>
          Check again
        </Button>
      </AlertDescription>
    </Alert>
  );
}
