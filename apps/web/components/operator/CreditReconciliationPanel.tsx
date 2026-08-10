"use client";

// Whether message-credit reconciliation is actually healthy, shown where the
// credits are managed.
//
// The sweep alerts the owner by email on a discrepancy, and an email is a thing
// you can miss — or filter, or read on a phone and forget. This puts the same
// state on the screen somebody opens when they are already thinking about
// credits, and adds the button to run it now.
//
// Everything except the button is derived from the ledger the platform already
// owns, so it costs no provider round trip and cannot go stale in a cache.

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { readApiError } from "@/lib/api-error";

interface Posture {
  lastCheckpointAt: string | null;
  schoolsCheckpointed: number;
  unlinkedDebits: number;
  linkedDebits: number;
  windowDays: number;
}

interface SweepResult {
  checkpointed: number;
  unlinked: number;
  unknownToProvider: number;
  uncharged: number;
  skipped?: string;
}

export function CreditReconciliationPanel({ canRun }: { canRun: boolean }) {
  const [posture, setPosture] = React.useState<Posture | null>(null);
  const [result, setResult] = React.useState<SweepResult | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  React.useEffect(() => {
    let live = true;
    void (async () => {
      const res = await fetch("/api/sms/operator/message-credits/reconciliation");
      if (live && res.ok) setPosture((await res.json()) as Posture);
    })();
    return () => {
      live = false;
    };
  }, []);

  const run = async () => {
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/sms/notifications/credits/reconcile/run", { method: "POST" });
    setBusy(false);
    if (!res.ok) return setMsg(await readApiError(res));
    setResult((await res.json()) as SweepResult);
  };

  const stale =
    posture?.lastCheckpointAt == null ||
    Date.now() - new Date(posture.lastCheckpointAt).getTime() > 36 * 3_600_000;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Credit reconciliation</CardTitle>
        <CardDescription>
          The platform is billed per message and charges per credit. This compares the two.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {posture === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <>
            {/* A sweep that has not run recently is the failure that hides every
                other failure — say so before showing any of its numbers. */}
            {stale && (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
                <p className="text-sm font-medium">Reconciliation has not run recently</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {posture.lastCheckpointAt
                    ? `Last run ${new Date(posture.lastCheckpointAt).toLocaleString()}.`
                    : "It has never run."}{" "}
                  Until it does, nothing is checking charged credits against messages actually sent.
                </p>
              </div>
            )}

            <dl className="grid gap-3 sm:grid-cols-3">
              <div>
                <dt className="text-xs text-muted-foreground">Last run</dt>
                <dd className="text-sm font-medium">
                  {posture.lastCheckpointAt ? new Date(posture.lastCheckpointAt).toLocaleString() : "never"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Schools covered</dt>
                <dd className="text-sm font-medium tabular-nums">{posture.schoolsCheckpointed}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">
                  Verifiable charges ({posture.windowDays}d)
                </dt>
                <dd className="text-sm font-medium tabular-nums">
                  {posture.linkedDebits} of {posture.linkedDebits + posture.unlinkedDebits}
                </dd>
              </div>
            </dl>

            {/* Not an error — it is the honest measure of how much of the recent
                ledger can be checked at all. Sends made before the provider id
                was recorded can never be verified either way. */}
            {posture.unlinkedDebits > 0 && (
              <p className="text-xs text-muted-foreground">
                {posture.unlinkedDebits} charge{posture.unlinkedDebits === 1 ? "" : "s"} in the last{" "}
                {posture.windowDays} days carry no provider reference and cannot be checked either way.
              </p>
            )}
          </>
        )}

        {canRun && (
          <div className="flex items-center gap-3 border-t border-border pt-3">
            <Button variant="outline" size="sm" onClick={run} disabled={busy}>
              {busy ? "Reconciling…" : "Run reconciliation now"}
            </Button>
            {result && (
              <span className="text-sm">
                {result.skipped === "NO_PROVIDER" ? (
                  // Distinct from "everything matched". A sweep that could not
                  // ask the provider has verified nothing.
                  <span className="text-muted-foreground">
                    Checkpointed {result.checkpointed} school(s). The messaging provider could not be
                    queried, so charges were <span className="font-medium">not verified</span>.
                  </span>
                ) : result.skipped === "NO_DB" ? (
                  <span className="text-muted-foreground">Could not run — privileged database not configured.</span>
                ) : result.unknownToProvider > 0 || result.uncharged > 0 ? (
                  <span>
                    <span className="font-medium">{result.unknownToProvider}</span> charged with no matching
                    message; <span className="font-medium">{result.uncharged}</span> sent with no charge.
                  </span>
                ) : (
                  <span className="text-muted-foreground">Everything reconciled.</span>
                )}
              </span>
            )}
            {msg && <span className="text-sm text-muted-foreground">{msg}</span>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
