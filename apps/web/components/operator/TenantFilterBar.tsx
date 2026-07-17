"use client";

// Search / filter / pagination controls for the operator tenant registry.
// All state lives in the URL (?q&plan&billing&page) so the server component
// refetches exactly one page — the console stays fast at 500+ schools.

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const PLANS = ["STANDARD", "PREMIUM", "ULTIMATE", "ENTERPRISE"] as const;
const BILLING = ["ACTIVE", "PAST_DUE", "CANCELED"] as const;

export function TenantFilterBar({
  q, plan, billing, page, pageSize, total, basePath = "/operator/tenants",
}: {
  q: string; plan: string; billing: string; page: number; pageSize: number; total: number;
  /** Route the filter/pagination navigates to (the registry now lives at /operator/tenants). */
  basePath?: string;
}) {
  const router = useRouter();
  const [search, setSearch] = React.useState(q);
  const pages = Math.max(1, Math.ceil(total / pageSize));

  const go = (next: { q?: string; plan?: string; billing?: string; page?: number }) => {
    const params = new URLSearchParams();
    const nq = next.q ?? search;
    const np = next.plan ?? plan;
    const nb = next.billing ?? billing;
    if (nq.trim()) params.set("q", nq.trim());
    if (np) params.set("plan", np);
    if (nb) params.set("billing", nb);
    const pg = next.page ?? 1; // any filter change resets to page 1
    if (pg > 1) params.set("page", String(pg));
    router.push(`${basePath}${params.size ? `?${params.toString()}` : ""}`);
  };

  const sel = "h-9 rounded-md border border-input bg-background px-3 text-sm";
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border/70 bg-card p-3 shadow-card">
      <form
        onSubmit={(e) => { e.preventDefault(); go({ q: search, page: 1 }); }}
        className="flex flex-1 items-center gap-2"
      >
        <Input
          aria-label="Search schools"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by school name or slug…"
          className="max-w-xs"
        />
        <Button type="submit" size="sm" variant="outline">Search</Button>
        {(q || plan || billing) && (
          <Button type="button" size="sm" variant="ghost" onClick={() => { setSearch(""); go({ q: "", plan: "", billing: "", page: 1 }); }}>
            Clear
          </Button>
        )}
      </form>
      <select aria-label="Plan filter" value={plan} onChange={(e) => go({ plan: e.target.value, page: 1 })} className={sel}>
        <option value="">All plans</option>
        {PLANS.map((pl) => <option key={pl} value={pl}>{pl.charAt(0) + pl.slice(1).toLowerCase()}</option>)}
      </select>
      <select aria-label="Billing filter" value={billing} onChange={(e) => go({ billing: e.target.value, page: 1 })} className={sel}>
        <option value="">All billing</option>
        {BILLING.map((b) => <option key={b} value={b}>{b.replace("_", " ").toLowerCase()}</option>)}
      </select>
      <div className="ml-auto flex items-center gap-2 text-sm text-muted-foreground">
        <span className="tnum">{total.toLocaleString()} school{total === 1 ? "" : "s"} · page {page}/{pages}</span>
        <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => go({ page: page - 1 })}>← Prev</Button>
        <Button size="sm" variant="outline" disabled={page >= pages} onClick={() => go({ page: page + 1 })}>Next →</Button>
      </div>
    </div>
  );
}
