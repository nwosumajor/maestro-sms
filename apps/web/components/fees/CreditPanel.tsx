"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { CreditBalanceDto, Serialized } from "@sms/types";
import { postSms } from "@/components/game/play-ui";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { money } from "@/lib/format";

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

  const credit = initial?.balanceMinor ?? 0;
  const showApply = canManage && credit > 0 && balanceDueMinor > 0;
  const showMoveOverpay = canManage && overpaidMinor > 0;
  if (!initial && !canManage) return null;
  if (credit === 0 && !showMoveOverpay && !canManage) return null;

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
            placeholder={`Top up (${currency})`}
            className="w-36 rounded-md border bg-background p-1.5 text-sm"
            value={prepayAmount}
            onChange={(e) => setPrepayAmount(e.target.value)}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !prepayAmount || Number(prepayAmount) < 100}
            onClick={() => run(`students/${studentId}/prepay/init`, { amountMinor: Math.round(Number(prepayAmount) * 100) })}
          >
            Prepay online
          </Button>
        </div>
        {msg && <p className="text-sm text-destructive">{msg}</p>}
      </CardContent>
    </Card>
  );
}
