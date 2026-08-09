"use client";

import * as React from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { sendSms } from "@/components/game/play-ui";

type Channel = string;
type Labels = Record<Channel, { name: string; comingSoon: string }>;
type Stranded = { id: string; name: string; currency: string };
type Readiness = { channel: string; enabled: boolean; configured: boolean; missing: string | null };
type Health = Record<string, { ok: boolean; at: string; detail: string }>;

/**
 * The platform's payment switchboard.
 *
 * Deliberately states the blast radius on the screen rather than in a runbook:
 * which rails are live, which are advertised as "coming soon" to payers, and —
 * the part that costs money if it is wrong — which live schools would be left
 * with no way to take payment at all.
 */
export function PaymentChannels({
  initialEnabled,
  all,
  labels,
  initialStranded,
  readiness,
  health,
}: {
  initialEnabled: Channel[];
  all: Channel[];
  labels: Labels;
  initialStranded: Stranded[];
  readiness: Readiness[];
  /** Last result of the DAILY check — the only line here that reflects reality
   *  over time rather than configuration at this instant. */
  health: Health;
}) {
  const [enabled, setEnabled] = React.useState<Channel[]>(initialEnabled);
  const [stranded, setStranded] = React.useState<Stranded[]>(initialStranded);
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [needsForce, setNeedsForce] = React.useState(false);
  // Per-channel connection results. A present key is not a working key, and the
  // difference is otherwise discovered by a parent at checkout.
  const [tested, setTested] = React.useState<Record<string, { ok: boolean; detail: string } | "testing">>({});

  const test = async (c: Channel) => {
    setTested((t) => ({ ...t, [c]: "testing" }));
    const res = await sendSms<{ ok: boolean; detail: string }>("POST", `operator/payment-channels/${c}/test`);
    setTested((t) => ({
      ...t,
      [c]: res.ok && res.data ? res.data : { ok: false, detail: res.error ?? "The test could not be run." },
    }));
  };

  const toggle = (c: Channel) => {
    setNeedsForce(false);
    setMsg(null);
    setEnabled((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));
  };

  const save = async (force: boolean) => {
    setBusy(true);
    setMsg(null);
    const res = await sendSms("PUT", "operator/payment-channels", { enabled, force });
    setBusy(false);
    if (!res.ok) {
      setMsg(res.error);
      // The server refuses a stranding change once; the operator may overrule
      // it, but only after being told exactly who it affects.
      if (/no way to take payment/i.test(res.error ?? "")) setNeedsForce(true);
      return;
    }
    setStranded((res.data as { stranded?: Stranded[] })?.stranded ?? []);
    setNeedsForce(false);
    setMsg("Saved. New payments will use only the rails above.");
  };

  const ready = React.useMemo(
    () => Object.fromEntries(readiness.map((r) => [r.channel, r])) as Record<string, Readiness>,
    [readiness],
  );
  const [checking, setChecking] = React.useState(false);
  const runHealth = async () => {
    setChecking(true);
    const res = await sendSms("POST", "operator/payment-channels/health/run");
    setChecking(false);
    setMsg(res.ok ? "Health check run. Reload to see the updated status." : res.error);
  };
  const dirty = JSON.stringify([...enabled].sort()) !== JSON.stringify([...initialEnabled].sort());

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Payment channels</CardTitle>
        <CardDescription>
          Which rails the platform will <strong>start</strong> a charge on, for school fees and for its own
          subscription billing. Switching one off never affects money already taken — webhooks, returns and the
          reconciliation sweeps keep settling every channel, so a payment made a minute before you save here
          still lands on the invoice.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          {all.map((c) => {
            const on = enabled.includes(c);
            return (
              <label
                key={c}
                className="flex cursor-pointer items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
              >
                <span className="min-w-0">
                  <span className="text-sm font-medium">{labels[c]?.name ?? c}</span>
                  {/* The RESULT of talking to the gateway outranks everything
                      else on this row: it is the only line that reflects
                      reality rather than configuration. */}
                  {tested[c] && tested[c] !== "testing" && (
                    <span
                      className={`mt-0.5 block text-xs ${(tested[c] as { ok: boolean }).ok ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"}`}
                    >
                      {(tested[c] as { ok: boolean }).ok ? "✓ " : "✗ "}
                      {(tested[c] as { detail: string }).detail}
                    </span>
                  )}
                  {!tested[c] && on && health?.[c] && (
                    <span className={`mt-0.5 block text-xs ${health[c].ok ? "text-muted-foreground" : "text-destructive"}`}>
                      {health[c].ok ? "Last daily check: healthy" : `Last daily check FAILED — ${health[c].detail}`}
                    </span>
                  )}
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {!on
                      ? labels[c]?.comingSoon ?? "Not enabled."
                      : ready[c] && !ready[c].configured
                        ? `Switched on but NOT usable — set ${ready[c].missing}.`
                        : "Live — payers can use this now."}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-2" onClick={(e) => e.preventDefault()}>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={tested[c] === "testing"}
                    onClick={() => void test(c)}
                  >
                    {tested[c] === "testing" ? "Testing…" : "Test connection"}
                  </Button>
                  {/* ON and USABLE are different questions. A rail switched on
                      with no credentials refuses every payer, and the first
                      report of that would otherwise come from a parent. */}
                  {on && ready[c] && !ready[c].configured && (
                    <Badge variant="destructive" title={`Set ${ready[c].missing}`}>
                      no credentials
                    </Badge>
                  )}
                  <Badge variant={on ? "secondary" : "outline"}>{on ? "on" : "coming soon"}</Badge>
                  <input type="checkbox" checked={on} onChange={() => toggle(c)} className="h-4 w-4" />
                </span>
              </label>
            );
          })}
        </div>

        {stranded.length > 0 && (
          <Alert variant="destructive">
            <AlertTitle>
              {stranded.length} live school{stranded.length === 1 ? "" : "s"} cannot take payment
            </AlertTitle>
            <AlertDescription>
              No enabled rail can settle their billing currency:{" "}
              {stranded.map((s) => `${s.name} (${s.currency})`).join(", ")}. They will be unable to collect fees
              until a rail that covers them is switched on.
            </AlertDescription>
          </Alert>
        )}

        {msg && (
          <p className={needsForce ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>{msg}</p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={busy || !dirty || enabled.length === 0} onClick={() => save(false)}>
            {busy ? "Saving…" : "Save channels"}
          </Button>
          {/* The same check that runs daily. Here so the owner can confirm a fix
              immediately rather than waiting for tomorrow's sweep. */}
          <Button size="sm" variant="outline" disabled={checking} onClick={() => void runHealth()}>
            {checking ? "Checking…" : "Run health check now"}
          </Button>
          {needsForce && (
            <Button size="sm" variant="destructive" disabled={busy} onClick={() => save(true)}>
              Apply anyway
            </Button>
          )}
          {enabled.length === 0 && (
            <span className="text-xs text-destructive">
              At least one channel must stay on, or nobody can pay.
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
