"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SCHOOL_SUSPENDED_CODE } from "@sms/types";

export function LoginForm({ next }: { next?: string | null }) {
  const router = useRouter();
  // Server-validated relative path (login/page.tsx safeNext) — re-checked here
  // because a client can mount this component with anything.
  const dest = next && next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard";
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [code, setCode] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await signIn("credentials", { email, password, code, redirect: false });
    setBusy(false);
    if (res?.error) {
      // A SUSPENDED SCHOOL IS TOLD SO. It is the one refusal nobody here can
      // act on — no password, no code and no number of attempts will change it —
      // and the catch-all below sent those users to check their password.
      setError(
        res.code === SCHOOL_SUSPENDED_CODE
          ? "This school's access has been suspended by the platform, so nobody at the school can sign in. Nothing has been deleted — your records are as you left them. Please contact your provider to have access restored."
          : "Invalid email, password, or 2FA code. After 3 failed attempts the account is locked — a platform administrator must reactivate it.",
      );
      return;
    }
    router.push(dest);
    router.refresh();
  };

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@school.example"
          required
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="code">2FA code <span className="font-normal text-muted-foreground">(if enabled)</span></Label>
        <Input
          id="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="123456"
        />
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button type="submit" className="w-full" disabled={busy}>
        {busy ? "Signing in…" : "Sign in"}
      </Button>
      <p className="text-center text-sm">
        <a href="/reset-password" className="text-primary underline-offset-2 hover:underline">
          Forgot your password?
        </a>
      </p>
    </form>
  );
}
