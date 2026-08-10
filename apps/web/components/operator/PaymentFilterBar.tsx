"use client";

// Period + facet filters for the platform revenue ledger, plus the CSV export.
//
// The filters live in the URL rather than component state so a finance query is
// a link: "last quarter, paid only" can be bookmarked, shared with an
// accountant, or reopened next month. It also means the export button can carry
// exactly the query the table is showing, with no second source of truth about
// what "the current filter" is.

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Filters = { from: string; to: string; status: string; plan: string; currency: string; q: string };

const STATUSES = ["", "PAID", "PENDING", "FAILED", "ABANDONED"];
const PLANS = ["", "STANDARD", "PREMIUM", "ULTIMATE", "ENTERPRISE"];
const CURRENCIES = ["", "NGN", "USD"];

/** Quick periods a finance desk actually asks for, rather than making them
 *  compute month boundaries by hand every time. */
function presets(): Array<{ label: string; from: string; to: string }> {
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);
  const startOfYear = new Date(now.getFullYear(), 0, 1);
  return [
    { label: "This month", from: iso(startOfMonth), to: iso(now) },
    { label: "Last month", from: iso(startOfLastMonth), to: iso(endOfLastMonth) },
    { label: "This year", from: iso(startOfYear), to: iso(now) },
  ];
}

export function PaymentFilterBar({ initial }: { initial: Filters }) {
  const router = useRouter();
  const params = useSearchParams();
  const [f, setF] = React.useState<Filters>(initial);

  const queryFrom = (next: Filters) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(next)) if (v) q.set(k, v);
    return q.toString();
  };

  const apply = (next: Filters) => {
    setF(next);
    // Any filter change returns to page 1 — staying on page 7 of a narrower
    // result set shows an empty table that looks like "no payments".
    router.push(`/operator/payments${queryFrom(next) ? `?${queryFrom(next)}` : ""}`);
  };

  const set = (k: keyof Filters) => (v: string) => setF({ ...f, [k]: v });
  const currentQuery = params.toString();

  return (
    <div className="space-y-3 rounded-lg border border-border p-4">
      <div className="flex flex-wrap gap-2">
        {presets().map((p) => (
          <Button key={p.label} type="button" variant="outline" size="sm" onClick={() => apply({ ...f, from: p.from, to: p.to })}>
            {p.label}
          </Button>
        ))}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          apply(f);
        }}
        className="flex flex-wrap items-end gap-3"
      >
        <div className="space-y-1.5">
          <Label htmlFor="rev-from">From</Label>
          <Input id="rev-from" type="date" value={f.from} onChange={(e) => set("from")(e.target.value)} className="w-40" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="rev-to">To</Label>
          <Input id="rev-to" type="date" value={f.to} onChange={(e) => set("to")(e.target.value)} className="w-40" />
        </div>
        {(
          [
            ["rev-status", "Status", "status", STATUSES],
            ["rev-plan", "Plan", "plan", PLANS],
            ["rev-currency", "Currency", "currency", CURRENCIES],
          ] as const
        ).map(([id, label, key, options]) => (
          <div key={id} className="space-y-1.5">
            <Label htmlFor={id}>{label}</Label>
            <select
              id={id}
              value={f[key]}
              onChange={(e) => set(key)(e.target.value)}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            >
              {options.map((o) => (
                <option key={o} value={o}>{o || `All ${label.toLowerCase()}s`}</option>
              ))}
            </select>
          </div>
        ))}
        <div className="space-y-1.5">
          <Label htmlFor="rev-q">School</Label>
          <Input id="rev-q" value={f.q} onChange={(e) => set("q")(e.target.value)} placeholder="Search name" className="w-44" />
        </div>
        <Button type="submit">Apply</Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            // `cleared` tells the page this really is "all time", rather than a
            // first visit that should default to the current month.
            setF({ from: "", to: "", status: "", plan: "", currency: "", q: "" });
            router.push("/operator/payments?cleared=1");
          }}
        >
          Clear
        </Button>
        {/* Exactly the query the table is showing — one source of truth for
            "the current filter", so the CSV can never disagree with the screen. */}
        <a
          href={`/api/sms/operator/payments/export.csv${currentQuery ? `?${currentQuery}` : ""}`}
          className="inline-flex h-9 items-center rounded-md border border-input px-3 text-sm font-medium hover:bg-accent"
        >
          Export CSV
        </a>
      </form>
    </div>
  );
}
