"use client";

import * as React from "react";
import Link from "next/link";
import type { InvoiceListItemDto, InvoiceSummaryDto, Serialized } from "@sms/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { money, shortDate, titleCase } from "@/lib/format";

type Row = Serialized<InvoiceListItemDto>;
type Summary = Serialized<InvoiceSummaryDto>;

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  DRAFT: "outline",
  ISSUED: "default",
  PARTIALLY_PAID: "secondary",
  PAID: "secondary",
  CANCELLED: "destructive",
};

/** Named groups, not raw statuses — "Unpaid" is the question an accountant asks;
 *  ISSUED vs PARTIALLY_PAID is an implementation detail of the answer. */
const FILTERS: Array<{ key: string; label: string; status?: string }> = [
  { key: "all", label: "All" },
  { key: "ISSUED", label: "Issued", status: "ISSUED" },
  { key: "PARTIALLY_PAID", label: "Part-paid", status: "PARTIALLY_PAID" },
  { key: "PAID", label: "Paid", status: "PAID" },
  { key: "DRAFT", label: "Draft", status: "DRAFT" },
];

/**
 * The invoice list: filtered and paged against the SERVER.
 *
 * It was previously a flat `take: 200` with no filter UI, so an accountant saw the
 * 200 most recent invoices and anything older was unreachable from this page — a
 * term's billing for a few hundred students exceeds that in one issue run.
 *
 * Totals come from their own aggregate over the whole visible set, never from the
 * rows on screen: with paging, a total derived from a page is simply wrong.
 */
export function InvoiceBrowser({
  initial,
  initialCursor,
  summary,
  canManage,
}: {
  initial: Row[];
  initialCursor: string | null;
  summary: Summary | null;
  canManage: boolean;
}) {
  const [rows, setRows] = React.useState<Row[]>(initial);
  const [cursor, setCursor] = React.useState<string | null>(initialCursor);
  const [filter, setFilter] = React.useState("all");
  const [q, setQ] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  const query = React.useCallback(
    (nextCursor?: string) => {
      const f = FILTERS.find((x) => x.key === filter);
      const params = new URLSearchParams();
      if (f?.status) params.set("status", f.status);
      if (q.trim()) params.set("q", q.trim());
      if (nextCursor) params.set("cursor", nextCursor);
      return `/api/sms/invoices?${params.toString()}`;
    },
    [filter, q],
  );

  const load = React.useCallback(
    async (append: boolean, nextCursor?: string) => {
      setBusy(true);
      setMsg(null);
      const res = await fetch(query(nextCursor));
      if (!res.ok) {
        setBusy(false);
        setMsg("Could not load invoices.");
        return;
      }
      const page = (await res.json()) as { items: Row[]; nextCursor: string | null };
      setRows((prev) => (append ? [...prev, ...page.items] : page.items));
      setCursor(page.nextCursor);
      setBusy(false);
    },
    [query],
  );

  // Re-query on a filter change; debounce the text box so typing a reference does
  // not fire a request per keystroke.
  const first = React.useRef(true);
  React.useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const t = setTimeout(() => void load(false), 250);
    return () => clearTimeout(t);
  }, [filter, q, load]);

  return (
    <div className="space-y-4">
      {summary && (
        <Card>
          <CardContent className="flex flex-wrap items-center gap-x-8 gap-y-3 py-4">
            <div>
              <p className="text-2xl font-semibold tabular-nums">{money(summary.outstandingMinor, summary.currency)}</p>
              <p className="text-xs text-muted-foreground">outstanding</p>
            </div>
            <div>
              <p className="text-2xl font-semibold tabular-nums">{money(summary.collectedMinor, summary.currency)}</p>
              <p className="text-xs text-muted-foreground">collected</p>
            </div>
            {summary.overdueCount > 0 && (
              <div>
                <p className="text-2xl font-semibold tabular-nums text-destructive">{summary.overdueCount}</p>
                <p className="text-xs text-muted-foreground">past due</p>
              </div>
            )}
            {canManage && (
              <Link href="/fees/reports" className="ml-auto text-sm text-muted-foreground underline hover:text-foreground">
                reports →
              </Link>
            )}
          </CardContent>
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-md border p-1">
          {FILTERS.map((f) => (
            <Button key={f.key} size="sm" variant={filter === f.key ? "default" : "ghost"} onClick={() => setFilter(f.key)}>
              {f.label}
            </Button>
          ))}
        </div>
        <input
          placeholder="Search reference…"
          className="w-52 rounded-md border bg-background p-1.5 text-sm"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {busy && <span className="text-xs text-muted-foreground">Loading…</span>}
      </div>

      <Card>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-muted-foreground">
              <tr>
                <th className="px-4 py-2.5 font-medium">Reference</th>
                <th className="px-4 py-2.5 font-medium">Due</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((inv) => (
                <tr key={inv.id} className="border-b border-border last:border-0 hover:bg-accent/40">
                  <td className="px-4 py-2.5">
                    <Link href={`/fees/${inv.id}`} className="font-medium text-primary hover:underline">
                      {inv.reference}
                    </Link>
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">{inv.dueDate ? shortDate(inv.dueDate) : "—"}</td>
                  <td className="px-4 py-2.5">
                    <Badge variant={STATUS_VARIANT[inv.status] ?? "outline"}>{titleCase(inv.status.replace("_", " "))}</Badge>
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{money(inv.totalMinor, inv.currency)}</td>
                </tr>
              ))}
              {rows.length === 0 && !busy && (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-muted-foreground">
                    No invoices match.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {/* Only offered when there IS another page, so its absence means "that's all"
          rather than "the button did nothing". */}
      {cursor && (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void load(true, cursor)}>
            Load more
          </Button>
        </div>
      )}
      {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
    </div>
  );
}
