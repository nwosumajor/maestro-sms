"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { CreditBalanceDto, Serialized } from "@sms/types";
import { postSms } from "@/components/game/play-ui";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { minorFrom, money } from "@/lib/format";

// The student's fee-credit balance on the invoice page: staff can apply it to
// this invoice or move an overpayment into it; family can top it up (prepay
// via hosted checkout — gracefully reports when online payments are off).
export function CreditPanel({
  invoiceId,
  studentId,
  currency,
  initial,
  canManage,
  overpaidMinor,
  balanceDueMinor,
}: {
  invoiceId: string;
  studentId: string;
  currency: string;
  initial: Serialized<CreditBalanceDto> | null;
  canManage: boolean;
  overpaidMinor: number;
  balanceDueMinor: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [prepayAmount, setPrepayAmount] = React.useState("");

  // THE BALANCE THIS INVOICE CAN ACTUALLY USE.
  //
  // The panel used to render `balanceMinor` under `currency`, and `currency` is
  // the INVOICE's — so one ledger read as "$100.00" on a dollar invoice and
  // "₦100.00" on a naira one, for the same pupil, on the same afternoon. The
  // API now splits the ledger by currency because minor units of one currency
  // are not minor units of another and there is no rate here to convert them.
  const credit = initial?.balances.find((b) => b.currency === currency)?.balanceMinor ?? 0;
  // Credit the pupil holds that THIS invoice cannot spend. Named rather than
  // hidden: a parent who paid it can see it on their other invoice, and a
  // balance that silently vanishes reads as money lost.
  const elsewhere = (initial?.balances ?? []).filter((b) => b.currency !== currency && b.balanceMinor > 0);
  // Prepay is charged in the SCHOOL's own currency, not this invoice's —
  // `initPrepay` raises it that way deliberately. Labelling the box with the
  // invoice's currency invited a parent to type dollars and be charged naira.
  const prepayCurrency = initial?.currency ?? currency;
  const showApply = canManage && credit > 0 && balanceDueMinor > 0;
  const showMoveOverpay = canManage && overpaidMinor > 0;
  // Family sees the panel whenever the API let them read the balance (even at
  // zero — hiding it would make prepaying impossible to START); others only
  // when they can act on it.
  if (!initial && !canManage) return null;

  const run = async (path: string, body?: unknown) => {
    setBusy(true);
    setMsg(null);
    const res = await postSms<{ authorizationUrl?: string }>(path, body);
    setBusy(false);
    if (res.ok && res.data?.authorizationUrl) {
      window.location.href = res.data.authorizationUrl;
      return;
    }
    if (res.ok) router.refresh();
    else setMsg(res.error ?? "Failed.");
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">
          Credit balance <span className="tnum font-mono">{money(credit, currency)}</span>
        </CardTitle>
        <CardDescription>
          Advance payments and overpayments held on the student's account, applied to invoices when due.
          {elsewhere.length > 0 && (
            <>
              {" "}
              This pupil also holds{" "}
              {elsewhere.map((b, i) => (
                <span key={b.currency}>
                  {i > 0 ? " and " : ""}
                  <span className="tnum font-mono">{money(b.balanceMinor, b.currency)}</span>
                </span>
              ))}
              , which cannot be applied to an invoice in {currency}.
            </>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          {showApply && (
            <Button size="sm" disabled={busy} onClick={() => run(`invoices/${invoiceId}/apply-credit`)}>
              Apply {money(Math.min(credit, balanceDueMinor), currency)} to this invoice
            </Button>
          )}
          {showMoveOverpay && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => run(`invoices/${invoiceId}/overpayment-to-credit`)}>
              Move {money(overpaidMinor, currency)} overpayment to credit
            </Button>
          )}
          <input
            type="number"
            min="100"
            step="0.01"
            placeholder={`Top up (${prepayCurrency})`}
            className="w-36 rounded-md border bg-background p-1.5 text-sm"
            value={prepayAmount}
            onChange={(e) => setPrepayAmount(e.target.value)}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !prepayAmount || Number(prepayAmount) < 100}
            onClick={() => run(`students/${studentId}/prepay/init`, { amountMinor: minorFrom(prepayAmount, prepayCurrency) })}
          >
            Prepay online
          </Button>
        </div>
        {msg && <p className="text-sm text-destructive">{msg}</p>}
      </CardContent>
    </Card>
  );
}
