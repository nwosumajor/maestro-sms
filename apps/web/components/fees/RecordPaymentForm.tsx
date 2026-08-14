"use client";

import * as React from "react";
import { toMajor, toMinor } from "@sms/types";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { money } from "@/lib/format";
import { readApiError } from "@/lib/api-error";

const METHODS = ["CASH", "BANK_TRANSFER", "CARD", "MOBILE_MONEY", "OTHER"] as const;

export function RecordPaymentForm({
  invoiceId,
  balanceMinor,
  currency,
}: {
  invoiceId: string;
  balanceMinor: number;
  currency: string;
}) {
  const router = useRouter();
  // toMajor/toMinor ask the CURRENCY how many minor units it has. Dividing and
  // multiplying by 100 is not a display rounding here — this field WRITES money.
  // In a zero-decimal currency (the CFA franc and ten others in the catalogue)
  // it prefilled a hundredth of the balance and then multiplied whatever the
  // bursar typed by 100 on the way back in.
  const [amountMajor, setAmountMajor] = React.useState(String(toMajor(balanceMinor, currency)));
  const [method, setMethod] = React.useState<(typeof METHODS)[number]>("CASH");
  const [kind, setKind] = React.useState<"PAYMENT" | "REFUND">("PAYMENT");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [info, setInfo] = React.useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const amountMinor = toMinor(parseFloat(amountMajor), currency);
    if (!Number.isFinite(amountMinor) || amountMinor <= 0) {
      setError("Enter a valid amount.");
      return;
    }
    setBusy(true);
    setError(null);
    setInfo(null);
    const res = await fetch(`/api/sms/invoices/${invoiceId}/payments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amountMinor, method, kind }),
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.status === 400 ? "Amount exceeds the allowed limit." : await readApiError(res));
      return;
    }
    const pay = (await res.json()) as { status?: string };
    if (pay.status === "PENDING_APPROVAL") setInfo("Submitted for a second approver (maker-checker).");
    router.refresh();
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 sm:flex-row sm:items-end">
      <div className="space-y-1.5">
        <Label htmlFor="amount">Amount ({currency})</Label>
        <Input
          id="amount"
          inputMode="decimal"
          value={amountMajor}
          onChange={(e) => setAmountMajor(e.target.value)}
          className="w-40"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="method">Method</Label>
        <select
          id="method"
          value={method}
          onChange={(e) => setMethod(e.target.value as (typeof METHODS)[number])}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
        >
          {METHODS.map((m) => (
            <option key={m} value={m}>
              {m.replace("_", " ")}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="kind">Type</Label>
        <select
          id="kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as "PAYMENT" | "REFUND")}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
        >
          <option value="PAYMENT">Payment</option>
          <option value="REFUND">Refund</option>
        </select>
      </div>
      <Button type="submit" disabled={busy}>
        {busy ? "Recording…" : `${kind === "REFUND" ? "Refund" : "Record"} ${money(Math.round(parseFloat(amountMajor || "0") * 100), currency)}`}
      </Button>
      {error && <p className="text-sm text-destructive sm:ml-3">{error}</p>}
      {info && <p className="text-sm text-muted-foreground sm:ml-3">{info}</p>}
    </form>
  );
}
