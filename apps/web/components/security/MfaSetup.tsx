"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { postWithStepUp } from "@/lib/stepup";
import { readApiError } from "@/lib/api-error";

export function MfaSetup({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [secret, setSecret] = React.useState<string | null>(null);
  const [uri, setUri] = React.useState<string | null>(null);
  const [code, setCode] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  const enroll = async () => {
    setBusy(true); setMsg(null);
    const res = await fetch("/api/sms/security/mfa/enroll", { method: "POST" });
    setBusy(false);
    if (!res.ok) { setMsg("Could not start enrollment."); return; }
    const data = (await res.json()) as { secret: string; otpauthUri: string };
    setSecret(data.secret); setUri(data.otpauthUri);
  };

  const verify = async () => {
    setBusy(true); setMsg(null);
    const res = await fetch("/api/sms/security/mfa/verify", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }),
    });
    setBusy(false);
    if (res.ok) { setMsg("Two-factor enabled."); setSecret(null); router.refresh(); }
    else setMsg("Invalid code — check the time on your authenticator.");
  };

  const disable = async () => {
    const c = prompt("Enter a current 2FA code to disable:");
    if (!c) return;
    // Disabling MFA is step-up gated: the shared sender prompts for the password
    // re-auth (and retries on a wrong one) before retrying the disable with it.
    const res = await postWithStepUp("security/mfa/disable", { code: c });
    if (res.ok) { setMsg("Two-factor disabled."); router.refresh(); }
    else setMsg(await readApiError(res));
  };

  if (enabled) {
    return (
      <div className="space-y-3">
        <Badge variant="secondary">Enabled</Badge>
        <p className="text-sm text-muted-foreground">Your account is protected with an authenticator app.</p>
        <Button variant="ghost" onClick={disable}>Disable two-factor</Button>
        {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {!secret ? (
        <>
          <p className="text-sm text-muted-foreground">Protect your account with a time-based one-time code.</p>
          <Button onClick={enroll} disabled={busy}>Set up two-factor</Button>
        </>
      ) : (
        <div className="space-y-3">
          <p className="text-sm">Add this secret to your authenticator app (or scan the otpauth URI):</p>
          <code className="block break-all rounded bg-muted px-2 py-1 text-xs">{secret}</code>
          {uri && <code className="block break-all rounded bg-muted px-2 py-1 text-[10px] text-muted-foreground">{uri}</code>}
          <div className="flex items-end gap-2">
            <div className="space-y-1.5">
              <Label htmlFor="mfa-code">Enter the 6-digit code</Label>
              <Input id="mfa-code" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" className="w-32" />
            </div>
            <Button onClick={verify} disabled={busy || code.length !== 6}>Verify &amp; enable</Button>
          </div>
        </div>
      )}
      {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
    </div>
  );
}
