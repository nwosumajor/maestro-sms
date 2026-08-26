"use client";

// Fee money the platform collected on a school's behalf, and paying it over.
//
// A parent's card payment made BEFORE the school registered a settlement bank
// lands in the platform's own gateway account. The invoice is correctly PAID and
// the cash is the platform's to hand across. The school's fees page has shown
// that balance for a while under the only instruction the product could offer —
// "contact support to have this released" — so the number could only ever go up
// and nothing recorded that a transfer had happened.
//
// THIS DOES NOT MOVE MONEY, and the panel says so. Somebody makes the transfer
// at a bank; this records it, against the specific payments it discharges, so
// the balance falls for a reason that can be checked against a bank statement.
//
// Silent when a school is owed nothing — most are, and a row of zeroes on every
// tenant is noise that hides the one that matters.

import type { SettlementHoldingDto, Serialized } from "@sms/types";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { readApiError } from "@/lib/api-error";
import { money } from "@/lib/format";

type Holding = Serialized<SettlementHoldingDto>;

export function SettlementHolding({ schoolId, canRelease }: { schoolId: string; canRelease: boolean }) {
  const [data, setData] = React.useState<Holding | null>(null);
  const [reference, setReference] = React.useState("");
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);
  // Which currency's payout is being recorded — a school can be owed in more
  // than one, and each is a separate bank transfer with its own reference.
  const [open, setOpen] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    const res = await fetch(`/api/sms/operator/tenants/${schoolId}/settlement-holding`, { cache: "no-store" });
    if (res.ok) setData((await res.json()) as Holding);
  }, [schoolId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const release = async (currency: string) => {
    setBusy(true);
    setMsg(null);
    const res = await fetch(`/api/sms/operator/tenants/${schoolId}/settlement-release`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reference, note: note || null, currency }),
    });
    setBusy(false);
    if (!res.ok) {
      setMsg(await readApiError(res));
      return;
    }
    const next = (await res.json()) as Holding;
    setData(next);
    setReference("");
    setNote("");
    setOpen(null);
    setMsg("Recorded. The school's balance now shows this as paid.");
  };

  if (!data) return null;
  const owed = data.held.length > 0;
  // Nothing owed and nothing ever paid over: this school has never had money
  // held, so there is nothing to say about it.
  if (!owed && data.releases.length === 0) return null;

  return (
    <div className="mt-2 rounded-md border border-border p-2 text-xs">
      {/* // GOTCHA: this used to print ONE figure and, when the school was owed
          in two currencies, added them — kobo plus cents under the platform's
          own symbol — with a note underneath saying the money was in more than
          one currency. The note was right and the number above it was not.
          There is no FX rate in this platform, so each currency is its own
          line and its own bank transfer. */}
      {owed ? (
        <div className="space-y-1">
          {data.held.map((h) => (
            <div key={h.currency}>
              <p className="font-medium text-amber-700 dark:text-amber-500">
                Holding {money(h.amountMinor, h.currency)} for this school
                <span className="font-normal text-muted-foreground">
                  {" "}
                  — {h.paymentCount} payment{h.paymentCount === 1 ? "" : "s"} taken before they registered a bank.
                </span>
              </p>
              {canRelease && (
                <div className="mt-1">
                  {open !== h.currency ? (
                    <Button size="sm" variant="outline" onClick={() => setOpen(h.currency)}>
                      Record a {h.currency} payout
                    </Button>
                  ) : (
                    <div className="space-y-2">
                      <p className="text-muted-foreground">
                        Make the bank transfer first. This records that you did — it does not move any money.
                      </p>
                      <Input
                        aria-label={`Bank reference for the ${h.currency} transfer`}
                        placeholder="Bank reference for the transfer"
                        value={reference}
                        onChange={(e) => setReference(e.target.value)}
                        className="h-8 text-xs"
                      />
                      <Input
                        aria-label={`Note on the ${h.currency} payout`}
                        placeholder="Note (optional)"
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        className="h-8 text-xs"
                      />
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          disabled={busy || reference.trim().length < 3}
                          onClick={() => void release(h.currency)}
                        >
                          Record {money(h.amountMinor, h.currency)} paid
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setOpen(null)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <p className="text-muted-foreground">Nothing currently held. {data.releases.length} release(s) on record.</p>
      )}

      {data.releases.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-muted-foreground">
          {data.releases.slice(0, 3).map((r) => (
            <li key={r.id}>
              Paid {money(r.amountMinor, r.currency)} · {String(r.releasedAt).slice(0, 10)} · ref {r.reference}
            </li>
          ))}
        </ul>
      )}

      {msg && <p className="mt-1 text-muted-foreground">{msg}</p>}
    </div>
  );
}
