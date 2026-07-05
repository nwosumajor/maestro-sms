"use client";

// super_admin per-school subscription editor (Operator Console). Pick a plan tier,
// then tick/untick individual modules (stored as per-school overrides). Writes go
// to PUT /operator/tenants/:id/subscription; the backend ModuleGuard + web nav
// pick up the new posture immediately.

import {
  MODULE_CATALOG,
  PLANS,
  PLAN_MODULES,
  resolveModules,
  type ModuleKey,
  type Plan,
  type Serialized,
  type SubscriptionDto,
} from "@sms/types";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { readApiError } from "@/lib/api-error";

const PLAN_LIST: Plan[] = [PLANS.STANDARD, PLANS.PREMIUM, PLANS.ULTIMATE, PLANS.ENTERPRISE];

export function SubscriptionManager({ schoolId, plan: initialPlan }: { schoolId: string; plan: string }) {
  const [open, setOpen] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [plan, setPlan] = React.useState<Plan>((initialPlan as Plan) ?? PLANS.ENTERPRISE);
  const [selected, setSelected] = React.useState<Set<ModuleKey>>(new Set());
  const [msg, setMsg] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const load = async () => {
    setOpen(true);
    if (selected.size > 0) return;
    setLoading(true);
    const res = await fetch(`/api/sms/operator/tenants/${schoolId}/subscription`, { cache: "no-store" });
    setLoading(false);
    if (res.ok) {
      const sub = (await res.json()) as Serialized<SubscriptionDto>;
      setPlan(sub.plan as Plan);
      setSelected(new Set(sub.modules as ModuleKey[]));
    }
  };

  const changePlan = (next: Plan) => {
    setPlan(next);
    // Reset selection to the tier bundle; the admin then tweaks from there.
    setSelected(new Set(PLAN_MODULES[next]));
  };

  const toggle = (m: ModuleKey) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(m) ? next.delete(m) : next.add(m);
      return next;
    });

  const save = async () => {
    setBusy(true);
    setMsg(null);
    // Derive overrides relative to the plan bundle.
    const base = new Set<ModuleKey>(PLAN_MODULES[plan]);
    const enabled = [...selected].filter((m) => !base.has(m));
    const disabled = [...base].filter((m) => !selected.has(m));
    const res = await fetch(`/api/sms/operator/tenants/${schoolId}/subscription`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan, overrides: { enabled, disabled } }),
    });
    setBusy(false);
    setMsg(res.ok ? "Saved." : await readApiError(res));
  };

  if (!open) {
    return (
      <Button variant="outline" size="sm" onClick={load}>
        Manage modules
      </Button>
    );
  }

  // Show resolved preview so the admin sees exactly what the school will get.
  const preview = resolveModules(plan, {
    enabled: [...selected].filter((m) => !new Set(PLAN_MODULES[plan]).has(m)),
    disabled: [...new Set(PLAN_MODULES[plan])].filter((m) => !selected.has(m)),
  });

  return (
    <div className="mt-3 rounded-md border border-border p-4">
      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <label className="text-sm font-medium">Plan</label>
            <select
              value={plan}
              onChange={(e) => changePlan(e.target.value as Plan)}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            >
              {PLAN_LIST.map((pl) => (
                <option key={pl} value={pl}>
                  {pl}
                </option>
              ))}
            </select>
            <span className="text-xs text-muted-foreground">{preview.length} modules enabled</span>
          </div>

          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {MODULE_CATALOG.map((m) => {
              const on = selected.has(m.key);
              const inPlan = new Set(PLAN_MODULES[plan]).has(m.key);
              return (
                <label
                  key={m.key}
                  className={cn(
                    "flex items-start gap-2 rounded-md border px-3 py-2 text-sm",
                    on ? "border-primary/40 bg-primary/5" : "border-border",
                  )}
                >
                  <input type="checkbox" checked={on} onChange={() => toggle(m.key)} className="mt-0.5 h-4 w-4" />
                  <span>
                    <span className="font-medium">{m.label}</span>
                    {!inPlan && on && <span className="ml-1 text-xs text-amber-600">(add-on)</span>}
                    {inPlan && !on && <span className="ml-1 text-xs text-destructive">(removed)</span>}
                    <span className="block text-xs text-muted-foreground">{m.description}</span>
                  </span>
                </label>
              );
            })}
          </div>

          <div className="flex items-center gap-3">
            <Button size="sm" onClick={save} disabled={busy}>
              {busy ? "Saving…" : "Save subscription"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Close
            </Button>
            {msg && <span className="text-sm text-muted-foreground">{msg}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
