"use client";

// Operator growth console: promo codes (percent off a school's first charge)
// and agents/resellers (attribution code -> commission ledger). Writes are
// owner-only + step-up; the money itself moves outside the system (bank
// transfer to the agent) — "Mark paid" records that it happened.

import * as React from "react";
import { sendWithStepUp } from "@/lib/stepup";
import { readApiError } from "@/lib/api-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { shortDate } from "@/lib/format";

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
  accruedMinor: number;
  paidOutMinor: number;
}
interface CommissionRow {
  id: string;
  schoolName: string;
  amountMinor: number;
  currency: string;
  status: string;
  createdAt: string;
  agent: { name: string; code: string };
}

const naira = (minor: number, currency = "NGN") =>
  new Intl.NumberFormat("en-NG", { style: "currency", currency }).format(minor / 100);

export function GrowthManager({
  promos,
  agents,
  commissions,
}: {
  promos: Promo[];
  agents: AgentRow[];
  commissions: CommissionRow[];
}) {
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
                      · {a.commissionBp / 100}% · accrued {naira(a.accruedMinor)} · paid {naira(a.paidOutMinor)}
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
          {commissions.length === 0 ? (
            <p className="text-sm text-muted-foreground">None accrued yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {commissions.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm">
                  <span>
                    <span className="font-medium">{c.agent.name}</span>{" "}
                    <span className="text-muted-foreground">
                      · {c.schoolName} · {naira(c.amountMinor, c.currency)} · {shortDate(c.createdAt)}
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
