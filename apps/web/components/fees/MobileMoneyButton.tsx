"use client";

// =============================================================================
// MobileMoneyButton — pay school fees from a phone
// =============================================================================
// Mobile money is ASYNCHRONOUS: the prompt goes to the payer's handset and they
// approve it there. So this screen never claims a payment succeeded on submit —
// it says "check your phone", then polls until the rail tells us either way.
//
// The provider list comes from the SERVER, which knows the school's country and
// which rails the platform actually has credentials for. Hard-coding "M-Pesa" here
// would offer a Ghanaian parent something that does not exist where they live.
// =============================================================================

import * as React from "react";
import { useRouter } from "next/navigation";
import type { MobileMoneyOptionDto, Serialized } from "@sms/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { readApiError } from "@/lib/api-error";

type Option = Serialized<MobileMoneyOptionDto>;
type Phase = "idle" | "sending" | "waiting" | "done" | "failed";

/** How long to keep asking before telling the payer to check their statement.
 *  A rail that has not answered in three minutes usually never will. */
const POLL_LIMIT_MS = 180_000;
const POLL_EVERY_MS = 4_000;

export function MobileMoneyButton({ invoiceId }: { invoiceId: string }) {
  const router = useRouter();
  const [options, setOptions] = React.useState<Option[] | null>(null);
  const [provider, setProvider] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [phase, setPhase] = React.useState<Phase>("idle");
  const [msg, setMsg] = React.useState<string | null>(null);

  React.useEffect(() => {
    let live = true;
    (async () => {
      const res = await fetch("/api/sms/payments/mobile-money/options");
      if (!live || !res.ok) return;
      const list = (await res.json()) as Option[];
      setOptions(list);
      setProvider(list.find((o) => o.enabled)?.provider ?? "");
    })();
    return () => {
      live = false;
    };
  }, []);

  const usable = (options ?? []).filter((o) => o.enabled);
  // Nothing to show where no rail operates, or none is enabled — the card button
  // beside this one is still there.
  if (!options || usable.length === 0) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPhase("sending");
    setMsg(null);
    const res = await fetch("/api/sms/payments/mobile-money/charge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invoiceId, provider, phone }),
    });
    if (!res.ok) {
      setPhase("failed");
      setMsg(await readApiError(res));
      return;
    }
    const ack = (await res.json()) as { reference: string; instruction: string };
    setPhase("waiting");
    setMsg(ack.instruction);

    // Poll rather than assume. The payer is holding their phone; the answer comes
    // from the rail, not from us.
    const started = Date.now();
    const tick = async () => {
      if (Date.now() - started > POLL_LIMIT_MS) {
        setPhase("failed");
        setMsg("We have not heard back. If your phone was debited, the payment will appear shortly — do not pay twice.");
        return;
      }
      const s = await fetch(`/api/sms/payments/mobile-money/status?reference=${encodeURIComponent(ack.reference)}`);
      const row = s.ok ? ((await s.json()) as { status: string; failureReason?: string | null }) : null;
      if (row?.status === "SUCCEEDED") {
        setPhase("done");
        setMsg("Payment received. Thank you.");
        router.refresh();
        return;
      }
      if (row?.status === "FAILED") {
        setPhase("failed");
        setMsg(row.failureReason || "The payment was not completed.");
        return;
      }
      setTimeout(tick, POLL_EVERY_MS);
    };
    setTimeout(tick, POLL_EVERY_MS);
  };

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2 rounded-lg border p-3">
      <div className="space-y-1.5">
        <Label htmlFor="mm-provider">Mobile money</Label>
        <select
          id="mm-provider"
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          disabled={phase === "sending" || phase === "waiting"}
        >
          {usable.map((o) => (
            <option key={o.provider} value={o.provider}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="mm-phone">Phone number</Label>
        <Input
          id="mm-phone"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="0712 345 678"
          required
          disabled={phase === "sending" || phase === "waiting"}
          className="w-44"
        />
      </div>
      <Button type="submit" size="sm" disabled={!provider || phase === "sending" || phase === "waiting" || phase === "done"}>
        {phase === "sending" ? "Sending…" : phase === "waiting" ? "Waiting for approval…" : "Pay"}
      </Button>
      {msg && (
        <p className={`w-full text-sm ${phase === "failed" ? "text-destructive" : "text-muted-foreground"}`}>{msg}</p>
      )}
    </form>
  );
}
