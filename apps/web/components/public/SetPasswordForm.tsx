"use client";

// Public invite-acceptance form: a provisioned admin sets their FIRST password
// via the one-time signed link emailed at provisioning. The token is single-use
// server-side; on success we hand off to the school's branded login page.

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function SetPasswordForm({ token }: { token: string }) {
  const [password, setPassword] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<{ email: string; schoolSlug: string } | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 8) return setErr("Password must be at least 8 characters.");
    if (password !== confirm) return setErr("Passwords do not match.");
    setBusy(true);
    setErr(null);
    const res = await fetch("/api/public/invite/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, password }),
    });
    setBusy(false);
    if (res.ok) setDone((await res.json()) as { email: string; schoolSlug: string });
    else {
      const j = (await res.json().catch(() => null)) as { message?: string } | null;
      setErr(j?.message ?? "This invite link is invalid or has expired.");
    }
  };

  if (done) {
    return (
      <div className="space-y-3 text-sm">
        <p>
          Your password is set. Sign in as <span className="font-medium">{done.email}</span> to get started —
          the in-app <span className="font-medium">Help</span> page has the getting-started guide.
        </p>
        <a href={`/login?school=${encodeURIComponent(done.schoolSlug)}`}>
          <Button className="w-full">Go to sign in</Button>
        </a>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="sp-pw">New password</Label>
        <Input id="sp-pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="sp-cf">Confirm password</Label>
        <Input id="sp-cf" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required minLength={8} />
      </div>
      {err && <p className="text-sm text-destructive">{err}</p>}
      <Button type="submit" className="w-full" disabled={busy}>
        {busy ? "Setting…" : "Set password & activate account"}
      </Button>
    </form>
  );
}
