"use client";

// Operator growth console: promo codes (percent off a school's first charge)
// and agents/resellers (attribution code -> commission ledger). Writes are
// owner-only + step-up; the money itself moves outside the system (bank
// transfer to the agent) — "Mark paid" records that it happened.

import * as React from "react";
import { useFormat } from "@/components/shell/RegionProvider";
import { sendWithStepUp } from "@/lib/stepup";
import { readApiError } from "@/lib/api-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMoney } from "@sms/types";


interface Promo {
  id: string;
  code: string;
  percentOff: number;
  maxUses: number | null;
  usedCount: number;
  expiresAt: string | null;
  active: boolean;
}
interface AgentRow {
  id: string;
  name: string;
  email: string;
  code: string;
  commissionBp: number;
  active: boolean;
  /** Commissions PER CURRENCY. A subscription settles in naira through Paystack
   *  or in dollars through Stripe, and the commission accrues on that charge —
   *  the aggregate behind this used to drop the currency, so an agent with one
   *  Nigerian school and one American one had kobo added to cents on a figure
   *  somebody is actually paid. */
  byCurrency: Array<{ currency: string; accruedMinor: number; paidOutMinor: number }>;
}
type CommissionPage = {
  items: CommissionRow[];
  total: number;
  shown: number;
  page: number;
  pageSize: number;
  owed: Array<{ currency: string; amountMinor: number; count: number }>;
  /** The filter the caller asked for, so the dropdown keeps it. */
  status?: string;
};

interface CommissionRow {
  id: string;
  schoolName: string;
  amountMinor: number;
  currency: string;
  status: string;
  createdAt: string;
  agent: { name: string; code: string };
}

// SCALED BY THE CURRENCY, never by a literal 100. This divided by 100 and was
// covered by a file-level exemption in `money-is-not-divided-by-a-hundred`
// granted for something else entirely — `commissionBp / 100`, which is basis
// points and genuinely correct. An exemption written for one reason had quietly
// come to cover a second, different thing in the same file. `formatMoney` asks
// Intl how many minor units the currency has.
const cash = (minor: number, currency: string) => formatMoney(minor, currency, "en-NG");

export function GrowthManager({
  promos,
  agents,
  commissions,
}: {
  promos: Promo[];
  agents: AgentRow[];
  /** A PAGE with what is still OWED counted in SQL. The ledger was the newest
   *  200 of the whole fleet with no count and no status filter, and the id to
   *  mark one paid is obtainable nowhere else — so 547 unpaid commissions could
   *  not be reached, counted or settled through the product. */
  commissions: CommissionPage;
}) {
  // Dates follow the SCHOOL's timezone, not the platform's.
  const { shortDate } = useFormat();
  const rows = commissions.items;
  const [msg, setMsg] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [promoForm, setPromoForm] = React.useState({ code: "", percentOff: "10", maxUses: "" });
  const [agentForm, setAgentForm] = React.useState({ name: "", email: "", code: "", commissionBp: "500" });

  const act = async (fn: () => ReturnType<typeof sendWithStepUp>, okMsg: string) => {
    setBusy(true);
    setMsg(null);
    const res = await fn();
    setBusy(false);
    if (res.ok) {
      setMsg(okMsg);
      window.location.reload();
    } else setMsg(await readApiError(res));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Growth: promo codes &amp; agents</CardTitle>
        <CardDescription>
          Promo codes discount a school&apos;s FIRST subscription payment. Agents earn a one-time commission
          (bp of the first charge) on schools attributed to their code at provisioning. Step-up required for
          changes; payouts are recorded here after the bank transfer.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Promo codes */}
        <div>
          <p className="mb-2 text-sm font-medium">Promo codes</p>
          {promos.length === 0 ? (
            <p className="text-sm text-muted-foreground">None yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {promos.map((pr) => (
                <li key={pr.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm">
                  <span>
                    <span className="font-mono font-semibold">{pr.code}</span>{" "}
                    <span className="text-muted-foreground">
                      · {pr.percentOff}% off · used {pr.usedCount}
                      {pr.maxUses != null ? `/${pr.maxUses}` : ""}
                      {pr.expiresAt ? ` · expires ${shortDate(pr.expiresAt)}` : ""}
                    </span>{" "}
                    {!pr.active && <Badge variant="outline">disabled</Badge>}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      act(() => sendWithStepUp("PUT", `operator/promos/${pr.id}/active`, { active: !pr.active }), "Saved.")
                    }
                  >
                    {pr.active ? "Disable" : "Enable"}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <Input className="w-36 font-mono uppercase" placeholder="CODE" value={promoForm.code} onChange={(e) => setPromoForm({ ...promoForm, code: e.target.value.toUpperCase() })} />
            <Input className="tnum w-20" inputMode="numeric" placeholder="% off" value={promoForm.percentOff} onChange={(e) => setPromoForm({ ...promoForm, percentOff: e.target.value.replace(/\D/g, "") })} />
            <Input className="tnum w-24" inputMode="numeric" placeholder="Max uses" value={promoForm.maxUses} onChange={(e) => setPromoForm({ ...promoForm, maxUses: e.target.value.replace(/\D/g, "") })} />
            <Button
              size="sm"
              disabled={busy || !promoForm.code || !Number(promoForm.percentOff)}
              onClick={() =>
                act(
                  () =>
                    sendWithStepUp("POST", "operator/promos", {
                      code: promoForm.code,
                      percentOff: Number(promoForm.percentOff),
                      maxUses: promoForm.maxUses ? Number(promoForm.maxUses) : null,
                    }),
                  "Promo created.",
                )
              }
            >
              Add promo
            </Button>
          </div>
        </div>

        {/* Agents */}
        <div className="border-t border-border pt-4">
          <p className="mb-2 text-sm font-medium">Agents</p>
          {agents.length === 0 ? (
            <p className="text-sm text-muted-foreground">None yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {agents.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm">
                  <span>
                    <span className="font-medium">{a.name}</span>{" "}
                    <span className="font-mono text-xs">{a.code}</span>{" "}
                    <span className="text-muted-foreground">
                      · {a.commissionBp / 100}% ·{" "}
                      {a.byCurrency
                        .map((c) => `accrued ${cash(c.accruedMinor, c.currency)} · paid ${cash(c.paidOutMinor, c.currency)}`)
                        .join(" · ")}
                    </span>{" "}
                    {!a.active && <Badge variant="outline">disabled</Badge>}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      act(() => sendWithStepUp("PUT", `operator/agents/${a.id}/active`, { active: !a.active }), "Saved.")
                    }
                  >
                    {a.active ? "Disable" : "Enable"}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <Input className="w-36" placeholder="Name" value={agentForm.name} onChange={(e) => setAgentForm({ ...agentForm, name: e.target.value })} />
            <Input className="w-44" placeholder="Email" value={agentForm.email} onChange={(e) => setAgentForm({ ...agentForm, email: e.target.value })} />
            <Input className="w-28 font-mono uppercase" placeholder="CODE" value={agentForm.code} onChange={(e) => setAgentForm({ ...agentForm, code: e.target.value.toUpperCase() })} />
            <Input className="tnum w-24" inputMode="numeric" placeholder="bp (500=5%)" value={agentForm.commissionBp} onChange={(e) => setAgentForm({ ...agentForm, commissionBp: e.target.value.replace(/\D/g, "") })} />
            <Button
              size="sm"
              disabled={busy || !agentForm.name || !agentForm.email || !agentForm.code || !Number(agentForm.commissionBp)}
              onClick={() =>
                act(
                  () =>
                    sendWithStepUp("POST", "operator/agents", {
                      name: agentForm.name,
                      email: agentForm.email,
                      code: agentForm.code,
                      commissionBp: Number(agentForm.commissionBp),
                    }),
                  "Agent created.",
                )
              }
            >
              Add agent
            </Button>
          </div>
        </div>

        {/* Commissions */}
        <div className="border-t border-border pt-4">
          <p className="mb-2 text-sm font-medium">Commissions</p>
          {/* WHAT IS STILL OWED, over the whole ledger and per currency. The
              operator's question is "who do we still owe", and until now there
              was no way to ask it. */}
          {commissions.owed.length > 0 && (
            <p className="mb-2 text-xs text-muted-foreground">
              Outstanding:{" "}
              {commissions.owed.map((o, i) => (
                <span key={o.currency}>
                  {i > 0 ? " · " : ""}
                  <strong className="text-foreground">{cash(o.amountMinor, o.currency)}</strong> ({o.count})
                </span>
              ))}
            </p>
          )}
          <form method="GET" className="mb-2 flex flex-wrap items-center gap-2 text-xs">
            <label htmlFor="commission-status" className="text-muted-foreground">Show</label>
            <select
              id="commission-status"
              name="commissionStatus"
              defaultValue={commissions.status ?? ""}
              className="h-7 rounded-md border border-border bg-background px-2"
            >
              <option value="">Everything</option>
              <option value="ACCRUED">Still owed</option>
              <option value="PAID_OUT">Paid out</option>
            </select>
            <button type="submit" className="h-7 rounded-md border border-border px-2 hover:bg-muted">Apply</button>
            <span className="text-muted-foreground">
              {commissions.total > commissions.shown
                ? `showing ${commissions.shown} of ${commissions.total}`
                : `${commissions.total} commission${commissions.total === 1 ? "" : "s"}`}
            </span>
          </form>
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">None accrued yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {rows.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm">
                  <span>
                    <span className="font-medium">{c.agent.name}</span>{" "}
                    <span className="text-muted-foreground">
                      · {c.schoolName} · {cash(c.amountMinor, c.currency)} · {shortDate(c.createdAt)}
                    </span>{" "}
                    <Badge variant={c.status === "PAID_OUT" ? "secondary" : "default"}>
                      {c.status === "PAID_OUT" ? "Paid out" : "Accrued"}
                    </Badge>
                  </span>
                  {c.status === "ACCRUED" && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        act(() => sendWithStepUp("POST", `operator/commissions/${c.id}/paid`, {}), "Marked paid out.")
                      }
                    >
                      Mark paid
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
      </CardContent>
    </Card>
  );
}
