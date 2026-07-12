"use client";

// =============================================================================
// CompensationPanel — recurring pay components on one employee (client island)
// =============================================================================
// hr.write adds/removes allowances & deductions; payroll runs snapshot what was
// active, so history never rewrites. Amounts entered in naira, stored in kobo.
// The API is authoritative (permissions, employee existence, audit).
// =============================================================================

import type { PayComponentDto, Serialized } from "@sms/types";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Component = Serialized<PayComponentDto>;

const naira = (m: number) => `₦${(m / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })}`;

async function req(method: string, path: string, body?: unknown) {
  const res = await fetch(`/api/sms${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const raw = await res.text();
  const data = raw ? JSON.parse(raw) : null;
  if (res.ok) return { ok: true as const, data };
  const j = data as { message?: string | string[] } | null;
  const error = j?.message ? (Array.isArray(j.message) ? j.message.join(", ") : j.message) : `Failed (${res.status}).`;
  return { ok: false as const, error };
}

export function CompensationPanel({ userId, initial }: { userId: string; initial: Component[] }) {
  const router = useRouter();
  const [items, setItems] = React.useState<Component[]>(initial);
  const [kind, setKind] = React.useState("ALLOWANCE");
  const [name, setName] = React.useState("");
  const [amount, setAmount] = React.useState("");
  const [err, setErr] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function refresh() {
    const r = await req("GET", `/hr/employees/${userId}/components`);
    if (r.ok) setItems(r.data as Component[]);
    router.refresh();
  }

  async function add() {
    const minor = Math.round(Number(amount) * 100);
    if (!name.trim() || !(minor > 0)) return;
    setBusy(true);
    setErr(null);
    const r = await req("POST", `/hr/employees/${userId}/components`, { kind, name: name.trim(), amountMinor: minor });
    setBusy(false);
    if (r.ok) {
      setName("");
      setAmount("");
      void refresh();
    } else setErr(r.error);
  }

  async function remove(id: string) {
    setErr(null);
    const r = await req("DELETE", `/hr/components/${id}`);
    if (r.ok) void refresh();
    else setErr(r.error);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Pay components</CardTitle>
        <CardDescription>
          Recurring monthly allowances (add to gross) and deductions (after tax). Applied to every new payroll
          run; past runs keep their snapshot.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-end gap-2">
          <select
            aria-label="Kind"
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
          >
            <option value="ALLOWANCE">Allowance</option>
            <option value="DEDUCTION">Deduction</option>
          </select>
          <Input className="w-40" placeholder="Name (e.g. Housing)" value={name} onChange={(e) => setName(e.target.value)} />
          <Input
            className="w-32"
            type="number"
            min="0"
            step="0.01"
            placeholder="₦ / month"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <Button size="sm" onClick={add} disabled={busy || !name.trim() || !amount}>
            Add
          </Button>
        </div>

        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">No components — payroll uses the basic salary only.</p>
        ) : (
          <ul className="space-y-1">
            {items.map((c) => (
              <li key={c.id} className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm">
                <Badge variant={c.kind === "ALLOWANCE" ? "default" : "secondary"}>
                  {c.kind === "ALLOWANCE" ? "+" : "−"} {c.kind.toLowerCase()}
                </Badge>
                <span className="font-medium">{c.name}</span>
                <span className="ml-auto tabular-nums">{naira(c.amountMinor)}/mo</span>
                <Button size="sm" variant="ghost" className="h-7 px-2 text-destructive" onClick={() => remove(c.id)}>
                  ✕
                </Button>
              </li>
            ))}
          </ul>
        )}
        {err && <p className="text-sm text-destructive">{err}</p>}
      </CardContent>
    </Card>
  );
}
