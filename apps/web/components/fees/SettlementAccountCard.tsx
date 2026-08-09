"use client";

// School fee-settlement setup (Paystack split): finance staff register the
// school's OWN bank; from then on every parent card payment settles there
// directly (the platform keeps only its configured commission). The full
// account number goes to Paystack and is never stored here.
//
// TWO STEPS, DELIBERATELY. This card used to take a bank and a 10-digit number
// and save them, while telling the user "the account is verified with Paystack"
// — which was never true. Creating a subaccount proves an account EXISTS, not
// whose it is, so a transposed digit landing on another valid account at the
// same bank was accepted silently and every parent fee from then on settled to
// a stranger, with the invoice marked PAID at both ends. Now the name is
// resolved and shown, and saving is only possible after it has been confirmed.

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
import { useFormat } from "@/components/shell/RegionProvider";

type Bank = { code: string; name: string };

export function SettlementAccountCard({ initial }: { initial: SettlementAccountDto }) {
  const { money: fmtMoney } = useFormat();
  const router = useRouter();
  const [banks, setBanks] = React.useState<Bank[] | null>(null);
  const [bankCode, setBankCode] = React.useState(initial.bankCode ?? "");
  const [accountNumber, setAccountNumber] = React.useState("");
  const [resolved, setResolved] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  // The real bank list, not ten hard-coded ones. A school banking with Kuda,
  // Opay or Moniepoint could not previously find itself here at all — and a
  // school that cannot set up settlement collects into the platform instead.
  React.useEffect(() => {
    let live = true;
    void (async () => {
      const res = await fetch("/api/sms/fees/settlement/banks");
      if (!live || !res.ok) return;
      const rows = (await res.json()) as Bank[];
      setBanks(rows);
      setBankCode((c) => c || rows[0]?.code || "");
    })();
    return () => {
      live = false;
    };
  }, []);

  // Any edit invalidates a confirmation: the name on screen must always be the
  // name for the numbers currently in the boxes, or the confirmation is stale
  // and means nothing.
  const reset = () => {
    setResolved(null);
    setMsg(null);
  };

  const check = async () => {
    if (!/^\d{10}$/.test(accountNumber)) return setMsg("Enter the 10-digit NUBAN account number.");
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/sms/fees/settlement/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bankCode, accountNumber }),
    });
    setBusy(false);
    if (res.ok) setResolved(((await res.json()) as { accountName: string }).accountName);
    else setMsg(await readApiError(res));
  };

  const save = async () => {
    if (!resolved) return;
    setBusy(true);
    setMsg(null);
    const res = await sendWithStepUp("PUT", "fees/settlement", {
      bankCode,
      accountNumber,
      confirmedAccountName: resolved,
    });
    setBusy(false);
    if (res.ok) {
      setMsg("Settlement account saved — parent card payments now settle to your bank.");
      setAccountNumber("");
      setResolved(null);
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
            : "Register your school's bank so parents' online fee payments settle straight to your account (Paystack split). Until you do, online fee payments settle into the PLATFORM's account and have to be released to you by hand — set this up before you invite parents to pay online."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {/* MONEY THE SCHOOL IS OWED. Loud and first, because the failure this
            replaces was silent: parents paid, invoices went PAID, and the cash
            sat in the platform's balance with nothing anywhere recording it. */}
        {initial.heldByPlatformMinor > 0 && (
          <div className="mb-4 rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
            <p className="text-sm font-medium">
              {fmtMoney(initial.heldByPlatformMinor)} of parents&apos; payments is held by the platform
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {initial.heldPaymentCount} payment{initial.heldPaymentCount === 1 ? "" : "s"} settled into the
              platform&apos;s account because no settlement bank was registered at the time. Those invoices are
              correctly marked paid — this is money owed to you. Register your bank below so future payments
              come straight to you, then contact support to have this released.
            </p>
          </div>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void (resolved ? save() : check());
          }}
          className="flex flex-wrap items-end gap-3"
        >
          <div className="space-y-1.5">
            <Label htmlFor="st-bank">Bank</Label>
            <select
              id="st-bank"
              value={bankCode}
              onChange={(e) => {
                setBankCode(e.target.value);
                reset();
              }}
              disabled={!banks}
              className="h-9 max-w-[15rem] rounded-md border border-input bg-background px-3 text-sm"
            >
              {banks ? (
                banks.map((b) => (
                  <option key={b.code} value={b.code}>{b.name}</option>
                ))
              ) : (
                <option value="">Loading banks…</option>
              )}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="st-acct">Account number (NUBAN)</Label>
            <Input
              id="st-acct"
              inputMode="numeric"
              maxLength={10}
              value={accountNumber}
              onChange={(e) => {
                setAccountNumber(e.target.value.replace(/\D/g, ""));
                reset();
              }}
              placeholder="0123456789"
              className="w-44"
            />
          </div>
          <Button type="submit" disabled={busy || !banks}>
            {busy ? "Checking…" : resolved ? "Confirm and save" : "Check account name"}
          </Button>
        </form>

        {/* The whole point of the two steps: the school reads the name back
            before a single naira is routed there. */}
        {resolved && (
          <div className="mt-3 rounded-md border border-input bg-muted/40 p-3">
            <p className="text-sm">
              This account is in the name{" "}
              <span className="font-medium">{resolved}</span>.
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              If that is not your school&apos;s account, change the number — every parent&apos;s fee payment will
              settle here.
            </p>
          </div>
        )}

        {msg && <p className="mt-3 text-sm text-muted-foreground">{msg}</p>}
        <p className="mt-3 text-xs text-muted-foreground">
          We store only the bank and the last 4 digits. Gateway charges on fee collections are borne by the
          school&apos;s settlement share.
        </p>

        {/* Platform convenience fee: who bears it. Shown only when a fee is
            actually configured — a zero fee needs no decision. */}
        {initial.sampleFeeMinor > 0 && (
          <div className="mt-5 border-t border-border pt-4">
            <p className="text-sm font-medium">Online-payment convenience fee</p>
            <p className="mt-1 text-xs text-muted-foreground">
              A platform fee applies to each online payment (about{" "}
              {fmtMoney(initial.sampleFeeMinor)}{" "}
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
