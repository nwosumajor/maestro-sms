"use client";

// =============================================================================
// PlatformDelegations — the owner lends a duty, and takes it back
// =============================================================================
// Sits beside PlatformStaff because it is the same job: who works here, and what
// are they allowed to do this month. Owner-only, for the same reason hiring is —
// a manager who could delegate to another manager would make the split meaningless.
//
// The lendable list comes from the SERVER, never from a copy here. A UI list that
// drifted from what the API accepts would offer a duty that then fails to save, or
// worse, quietly hide one the owner is entitled to lend.
// =============================================================================

import { useEffect, useState } from "react";
import type { PlatformDelegationDto, Serialized } from "@sms/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { sendWithStepUp } from "@/lib/stepup";
import { interpretApiError } from "@/lib/api-error";
import { shortDate } from "@/lib/format";

type Delegation = Serialized<PlatformDelegationDto>;
type Lendable = { permissions: string[]; maxDays: number; defaultDays: number };

/** Plain-language names for the duties. The permission string is shown too — it is
 *  what appears in the audit log, and matching the two up is the whole job when
 *  somebody later asks what a manager was allowed to do. */
const DUTY_LABEL: Record<string, string> = {
  "platform.tenants.read": "View the tenant registry and analytics",
  "platform.tenants.write": "Provision and edit schools",
  "platform.onboarding.review": "Review onboarding requests",
  "platform.audit.read": "Read the platform audit trail",
  "platform.user.read": "View school user accounts",
  "platform.user.unlock": "Unlock locked accounts",
  "platform.grace.manage": "Extend billing grace periods",
  "platform.feedback.review": "Answer the feedback inbox",
};

export function PlatformDelegations({ staff }: { staff: { id: string; name: string; email: string }[] }) {
  const [rows, setRows] = useState<Delegation[] | null>(null);
  const [lendable, setLendable] = useState<Lendable | null>(null);
  const [userId, setUserId] = useState("");
  const [permission, setPermission] = useState("");
  const [reason, setReason] = useState("");
  const [days, setDays] = useState<number | "">("");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function load() {
    const [d, l] = await Promise.all([
      fetch("/api/sms/operator/platform-delegations"),
      fetch("/api/sms/operator/platform-delegations/lendable"),
    ]);
    if (d.ok) setRows((await d.json()) as Delegation[]);
    if (l.ok) {
      const parsed = (await l.json()) as Lendable;
      setLendable(parsed);
      setPermission((p) => p || parsed.permissions[0] || "");
      setDays((v) => (v === "" ? parsed.defaultDays : v));
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy("grant");
    setNote(null);
    // Step-up: handing someone reach into every tenant deserves a fresh re-auth.
    const res = await sendWithStepUp("POST", "/api/sms/operator/platform-delegations", {
      userId,
      permission,
      reason,
      days: days === "" ? undefined : days,
    });
    setBusy(null);
    if (res.ok) {
      setReason("");
      await load();
      setNote("Duty delegated.");
    } else {
      setNote(interpretApiError(res.status, await res.text()));
    }
  }

  async function revoke(id: string) {
    setBusy(id);
    // No step-up to TAKE BACK: removing access must never be harder than granting it.
    const res = await fetch(`/api/sms/operator/platform-delegations/${id}/revoke`, { method: "POST" });
    setBusy(null);
    if (res.ok) {
      await load();
      setNote("Duty taken back — effective on their next request.");
    } else {
      setNote(interpretApiError(res.status, await res.text()));
    }
  }

  const live = (rows ?? []).filter((r) => r.active);
  const past = (rows ?? []).filter((r) => !r.active);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Delegated duties</CardTitle>
        <CardDescription>
          Lend a platform manager one duty for a set number of days. It expires on its own, and you
          can take it back at any time — a hand-back applies on their very next request, not whenever
          their session ends. Impersonation, pricing, plan credentials, student records and hiring
          are never lendable at any duration.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5">
        <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
          <div className="space-y-1.5">
            <Label htmlFor="dg-who">Manager</Label>
            <select
              id="dg-who"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              required
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="">Choose…</option>
              {staff.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.email})
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="dg-perm">Duty</Label>
            <select
              id="dg-perm"
              value={permission}
              onChange={(e) => setPermission(e.target.value)}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            >
              {(lendable?.permissions ?? []).map((p) => (
                <option key={p} value={p}>
                  {DUTY_LABEL[p] ?? p}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="dg-days">Days</Label>
            <Input
              id="dg-days"
              type="number"
              min={1}
              max={lendable?.maxDays ?? 90}
              value={days}
              onChange={(e) => setDays(e.target.value === "" ? "" : Number(e.target.value))}
              className="w-24"
            />
          </div>
          <div className="min-w-56 flex-1 space-y-1.5">
            <Label htmlFor="dg-why">Reason</Label>
            <Input
              id="dg-why"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Covering onboarding while I travel"
              required
            />
          </div>
          <Button type="submit" size="sm" disabled={busy === "grant" || !userId}>
            {busy === "grant" ? "Delegating…" : "Delegate"}
          </Button>
        </form>

        <div>
          <p className="mb-2 text-sm font-medium">
            Currently lent {live.length > 0 && <span className="text-muted-foreground">({live.length})</span>}
          </p>
          {live.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No duties are lent right now. Managers hold only what their role gives them.
            </p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {live.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{r.userName}</span>
                  <Badge variant="secondary">{DUTY_LABEL[r.permission] ?? r.permission}</Badge>
                  {/* Days remaining, not just the date: "3 days left" is the thing
                      you act on; the date is the thing you verify. */}
                  <Badge variant={r.daysLeft <= 3 ? "destructive" : "outline"}>
                    {r.daysLeft} day{r.daysLeft === 1 ? "" : "s"} left
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    until {shortDate(r.expiresAt)} · {r.reason}
                  </span>
                  <Button size="sm" variant="outline" disabled={busy === r.id} onClick={() => revoke(r.id)}>
                    {busy === r.id ? "Taking back…" : "Take back"}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {past.length > 0 && (
          <details>
            {/* Kept, not deleted: this is the answer to "who could do that in March". */}
            <summary className="cursor-pointer text-sm text-muted-foreground">
              Ended ({past.length}) — expired or handed back
            </summary>
            <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
              {past.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-2">
                  <span>{r.userName}</span>
                  <span className="font-mono text-xs">{r.permission}</span>
                  <span className="text-xs">
                    {r.revokedAt
                      ? `taken back ${shortDate(r.revokedAt)}${r.revokedByName ? ` by ${r.revokedByName}` : ""}`
                      : `expired ${shortDate(r.expiresAt)}`}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}

        {note && <p className="text-sm text-muted-foreground">{note}</p>}
      </CardContent>
    </Card>
  );
}
