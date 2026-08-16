"use client";

// What did NOT reach a family.
//
// Every external delivery failure has always been recorded — a number the
// provider rejected, a bounced receipt, a message skipped because the school had
// run out of credits — and nothing ever read it. The school was told the alert
// had gone out, and for those families it had not.
//
// Deliberately quiet when there is nothing wrong: a panel that is always on
// screen saying "0 problems" is one people stop reading, and this needs to be
// noticed on the day it is not zero.
//
// Names the recipient and the channel, never the address the message was sent
// to. A failure report is not a route to a phone book.

import type { DeliveryProblemsDto, Serialized } from "@sms/types";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { readApiError } from "@/lib/api-error";

type Problems = Serialized<DeliveryProblemsDto>;

/** The provider's words are for us; these are for the person who has to act. */
function advise(error: string | null): string | null {
  const e = (error ?? "").toLowerCase();
  if (e.includes("no message credits")) return "Buy a bundle on the Billing page to restart SMS and WhatsApp.";
  if (e.startsWith("no target")) return "This person has no phone number or email on file — add one on their record.";
  if (e.includes("outcome unknown")) return "Sent to the provider, but the result was never recorded. It was not sent again.";
  return null;
}

export function DeliveryProblems() {
  const [data, setData] = React.useState<Problems | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    const res = await fetch("/api/sms/notifications/deliveries/problems?days=7", { cache: "no-store" });
    if (res.ok) setData((await res.json()) as Problems);
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const runRecovery = async () => {
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/sms/notifications/deliveries/recovery/run", { method: "POST" });
    setBusy(false);
    if (!res.ok) {
      setMsg(await readApiError(res));
      return;
    }
    const r = (await res.json()) as { requeued: number; abandoned: number; scanned: number };
    setMsg(
      r.scanned === 0
        ? "Nothing was waiting."
        : `Checked ${r.scanned} waiting. Sent ${r.requeued} again; closed ${r.abandoned} whose outcome could not be known.`,
    );
    void load();
  };

  // Nothing to report and nothing stuck — stay off the page entirely.
  if (!data || (data.total === 0 && data.pending === 0)) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Messages that did not arrive</CardTitle>
        <CardDescription>
          {data.total > 0
            ? `${data.total} external delivery ${data.total === 1 ? "failure" : "failures"} in the last ${data.windowDays} days.`
            : "No failures."}{" "}
          {data.pending > 0 && `${data.pending} still waiting to be sent.`} Everyone here still has the message in their
          in-app inbox — it is the email, SMS or WhatsApp copy that did not go out.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {data.failures.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="py-1 pr-3 font-medium">Who</th>
                  <th className="py-1 pr-3 font-medium">About</th>
                  <th className="py-1 pr-3 font-medium">Channel</th>
                  <th className="py-1 font-medium">Why</th>
                </tr>
              </thead>
              <tbody>
                {data.failures.map((f) => {
                  const hint = advise(f.error);
                  return (
                    <tr key={f.id} className="border-b border-border/50 align-top last:border-0">
                      <td className="py-1 pr-3 whitespace-nowrap">{f.recipientName}</td>
                      <td className="py-1 pr-3">{f.title}</td>
                      <td className="py-1 pr-3 whitespace-nowrap text-muted-foreground">{f.channel}</td>
                      <td className="py-1 text-muted-foreground">
                        {hint ?? f.error ?? "No reason recorded."}
                        {hint && f.error && <span className="block text-xs opacity-60">{f.error}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void runRecovery()}>
            Check for stuck messages
          </Button>
          <span className="text-xs text-muted-foreground">
            This runs hourly on its own; the button is for when you would rather not wait.
          </span>
        </div>
        {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
      </CardContent>
    </Card>
  );
}
