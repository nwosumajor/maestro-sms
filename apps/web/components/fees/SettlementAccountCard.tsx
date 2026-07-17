"use client";

// School fee-settlement setup (Paystack split): finance staff register the
// school's OWN bank; from then on every parent card payment settles there
// directly (the platform keeps only its configured commission). The full
// account number goes to Paystack for verification and is never stored here.

import type { SettlementAccountDto } from "@sms/types";
import * as React from "react";
import { useRouter } from "next/navigation";
import { sendWithStepUp } from "@/lib/stepup";
import { readApiError } from "@/lib/api-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

// Common Nigerian bank codes for the picker; "Other" allows any code.
const BANKS: [string, string][] = [
  ["044", "Access Bank"],
  ["058", "GTBank"],
  ["057", "Zenith Bank"],
  ["011", "First Bank"],
  ["033", "UBA"],
  ["070", "Fidelity Bank"],
  ["232", "Sterling Bank"],
  ["221", "Stanbic IBTC"],
  ["035", "Wema Bank"],
  ["050", "Ecobank"],
];

export function SettlementAccountCard({ initial }: { initial: SettlementAccountDto }) {
  const router = useRouter();
  const [bankCode, setBankCode] = React.useState(initial.bankCode ?? BANKS[0][0]);
  const [accountNumber, setAccountNumber] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^\d{10}$/.test(accountNumber)) return setMsg("Enter the 10-digit NUBAN account number.");
    setBusy(true);
    setMsg(null);
    const res = await sendWithStepUp("PUT", "fees/settlement", { bankCode, accountNumber });
    setBusy(false);
    if (res.ok) {
      setMsg("Settlement account saved — parent card payments now settle to your bank.");
      setAccountNumber("");
      router.refresh();
    } else setMsg(await readApiError(res));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          Fee settlement account
          {initial.configured ? (
            <Badge variant="secondary">Direct to your bank</Badge>
          ) : (
            <Badge variant="outline">Not set — settles via the platform</Badge>
          )}
        </CardTitle>
        <CardDescription>
          {initial.configured
            ? `Parents' card payments settle directly to ${initial.bankName ?? "your bank"} ····${initial.accountLast4 ?? ""}. Update below to change the account.`
            : "Register your school's bank so parents' online fee payments settle straight to your account (Paystack split). Until then, collections settle via the platform and are remitted."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="st-bank">Bank</Label>
            <select
              id="st-bank"
              value={bankCode}
              onChange={(e) => setBankCode(e.target.value)}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            >
              {BANKS.map(([code, name]) => (
                <option key={code} value={code}>{name}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="st-acct">Account number (NUBAN)</Label>
            <Input
              id="st-acct"
              inputMode="numeric"
              maxLength={10}
              value={accountNumber}
              onChange={(e) => setAccountNumber(e.target.value.replace(/\D/g, ""))}
              placeholder="0123456789"
              className="w-44"
            />
          </div>
          <Button type="submit" disabled={busy}>
            {busy ? "Verifying…" : initial.configured ? "Update account" : "Set up direct settlement"}
          </Button>
        </form>
        {msg && <p className="mt-3 text-sm text-muted-foreground">{msg}</p>}
        <p className="mt-3 text-xs text-muted-foreground">
          The account is verified with Paystack; we store only the bank and last 4 digits. Gateway charges on
          fee collections are borne by the school&apos;s settlement share.
        </p>

        {/* Platform convenience fee: who bears it. Shown only when a fee is
            actually configured — a zero fee needs no decision. */}
        {initial.sampleFeeMinor > 0 && (
          <div className="mt-5 border-t border-border pt-4">
            <p className="text-sm font-medium">Online-payment convenience fee</p>
            <p className="mt-1 text-xs text-muted-foreground">
              A platform fee applies to each online payment (about{" "}
              {new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN" }).format(initial.sampleFeeMinor / 100)}{" "}
              on a ₦10,000 payment). Choose who bears it:
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {(
                [
                  ["PARENT", "Payer bears it", "Parents pay invoice + fee; you receive the full invoice."],
                  ["SCHOOL", "School bears it", "Parents pay the invoice only; the fee comes out of your settlement."],
                ] as const
              ).map(([value, label, hint]) => {
                const active = (initial.feeBearer ?? "PARENT") === value;
                return (
                  <button
                    key={value}
                    type="button"
                    disabled={busy}
                    title={hint}
                    onClick={async () => {
                      setBusy(true);
                      setMsg(null);
                      const res = await sendWithStepUp("PUT", "fees/settlement/fee-bearer", { bearer: value });
                      setBusy(false);
                      if (res.ok) {
                        setMsg(`Saved — ${label.toLowerCase()}.`);
                        router.refresh();
                      } else setMsg(await readApiError(res));
                    }}
                    className={
                      "rounded-md border px-3 py-2 text-left text-sm transition-colors " +
                      (active ? "border-primary bg-primary/5 font-medium" : "border-border hover:bg-accent")
                    }
                  >
                    {label}
                    <span className="block text-xs font-normal text-muted-foreground">{hint}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
