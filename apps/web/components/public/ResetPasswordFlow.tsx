"use client";

// Public forgot-password flow. Two modes on one component:
//  - no token: ask for the account email; the API ALWAYS answers ok (no account
//    oracle) and emails a 30-minute single-use reset link when the account exists.
//  - token present (from the emailed link): choose the new password.

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function ResetPasswordFlow({ token }: { token: string }) {
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [sent, setSent] = React.useState(false);
  const [done, setDone] = React.useState<{ email: string; schoolSlug: string } | null>(null);

  const request = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    await fetch("/api/public/password-reset/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    }).catch(() => undefined);
    setBusy(false);
    setSent(true); // always — the server never reveals whether the account exists
  };

  const confirmReset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 8) return setErr("Password must be at least 8 characters.");
    if (password !== confirm) return setErr("Passwords do not match.");
    setBusy(true);
    setErr(null);
    const res = await fetch("/api/public/password-reset/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, password }),
    });
    setBusy(false);
    if (res.ok) setDone((await res.json()) as { email: string; schoolSlug: string });
    else {
      const j = (await res.json().catch(() => null)) as { message?: string } | null;
      setErr(j?.message ?? "This reset link is invalid or has expired.");
    }
  };

  if (done) {
    return (
      <div className="space-y-3 text-sm">
        <p>
          Your password has been changed. Sign in as <span className="font-medium">{done.email}</span> with
          your new password.
        </p>
        <a href={`/login?school=${encodeURIComponent(done.schoolSlug)}`}>
          <Button className="w-full">Go to sign in</Button>
        </a>
      </div>
    );
  }

  if (!token) {
    if (sent) {
      return (
        <p className="text-sm">
          If an account exists for <span className="font-medium">{email}</span>, a reset link is on its way —
          it works once and expires in 30 minutes. Check your spam folder too.
        </p>
      );
    }
    return (
      <form onSubmit={request} className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="rp-email">Account email</Label>
          <Input id="rp-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? "Sending…" : "Email me a reset link"}
        </Button>
      </form>
    );
  }

  return (
    <form onSubmit={confirmReset} className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="rp-pw">New password</Label>
        <Input id="rp-pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="rp-cf">Confirm password</Label>
        <Input id="rp-cf" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required minLength={8} />
      </div>
      {err && <p className="text-sm text-destructive">{err}</p>}
      <Button type="submit" className="w-full" disabled={busy}>
        {busy ? "Resetting…" : "Set new password"}
      </Button>
    </form>
  );
}
