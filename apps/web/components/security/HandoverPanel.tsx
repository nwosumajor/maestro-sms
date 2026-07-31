"use client";

// =============================================================================
// HandoverPanel — lend a duty you already hold, without waiting to be asked
// =============================================================================
// The sibling of ElevationPanel, pointed the other way. Elevation is bottom-up: a
// colleague asks and a different senior approves. This is top-down: a senior going
// on leave arranges cover in advance.
//
// The permission list offered here is the CALLER'S OWN, because the server refuses
// to hand over anything the granter does not hold themselves. Offering a wider list
// would present options that always fail — and imply an authority the person does
// not have.
// =============================================================================

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { UserPicker } from "@/components/people/UserPicker";
import { readApiError } from "@/lib/api-error";

/** Kept in step with NON_ELEVATABLE_PERMISSIONS on the server. Shown as disabled
 *  rather than hidden: "you cannot lend this" is more useful than silence when
 *  somebody goes looking for it. */
const NEVER_LENDABLE = new Set([
  "fee.approve",
  "hr.salary.approve",
  "rbac.manage",
  "security.elevation.approve",
  "billing.manage",
  "billing.dunning.run",
  "scholarship.admin",
  "game.ultimate.admin",
]);

export function HandoverPanel({ myPermissions }: { myPermissions: string[] }) {
  const router = useRouter();
  const [userId, setUserId] = React.useState("");
  const [permission, setPermission] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [days, setDays] = React.useState(7);
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  // Only what this person actually holds, minus what nobody may lend.
  const lendable = React.useMemo(
    () => myPermissions.filter((p) => !NEVER_LENDABLE.has(p) && !p.startsWith("platform.")).sort(),
    [myPermissions],
  );
  const blocked = React.useMemo(() => myPermissions.filter((p) => NEVER_LENDABLE.has(p)).sort(), [myPermissions]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/sms/security/elevation/delegate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, permission, reason, hours: days * 24 }),
    });
    setBusy(false);
    if (res.ok) {
      setReason("");
      setMsg(`Handed over for ${days} day${days === 1 ? "" : "s"}. It expires on its own, or revoke it above.`);
      router.refresh();
    } else {
      setMsg(await readApiError(res));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Hand over a duty</CardTitle>
        <CardDescription>
          Going away? Lend a colleague one of your duties for a set number of days, without waiting
          for them to ask. It expires on its own, you can take it back at any time, and every use is
          recorded against them. You can only hand over what you hold yourself.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
          <div className="w-56 space-y-1.5">
            <Label htmlFor="ho-who">Colleague</Label>
            <UserPicker kind="staff" value={userId} onChange={setUserId} placeholder="Search staff…" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ho-perm">Duty</Label>
            <select
              id="ho-perm"
              value={permission}
              onChange={(e) => setPermission(e.target.value)}
              required
              className="h-9 max-w-64 rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="">Choose…</option>
              {lendable.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ho-days">Days</Label>
            <Input
              id="ho-days"
              type="number"
              min={1}
              max={60}
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              className="w-24"
            />
          </div>
          <div className="min-w-56 flex-1 space-y-1.5">
            <Label htmlFor="ho-why">Reason</Label>
            <Input
              id="ho-why"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Covering admissions while I am on leave"
              required
            />
          </div>
          <Button type="submit" size="sm" disabled={busy || !userId || !permission}>
            {busy ? "Handing over…" : "Hand over"}
          </Button>
        </form>

        {blocked.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {/* Named, not hidden. These are the second pair of eyes on money, pay and
                access — lending one does not delegate a duty, it removes a control. */}
            Not lendable by anyone, at any length: <span className="font-mono">{blocked.join(", ")}</span> — each is
            the approving half of a two-person rule, so handing it over would remove the check rather
            than share the work.
          </p>
        )}

        {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
      </CardContent>
    </Card>
  );
}
