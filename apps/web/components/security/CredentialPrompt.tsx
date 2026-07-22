"use client";

// =============================================================================
// CredentialPrompt — in-app masked credential entry for step-up re-auth
// =============================================================================
// Replaces window.prompt() for password entry. A native prompt renders a PLAIN
// TEXT field: the password is fully readable on screen (shoulder-surfing), it
// cannot be styled or made accessible, and password managers cannot fill it —
// which pushes people toward short, memorised, reused passwords.
//
// This is a promise-bridging modal: `requestCredential()` is callable from
// plain async code (lib/stepup.ts is a function, not a component), and resolves
// when the user submits or cancels. The host component registers itself on
// mount; it lives in AppShell, so it is present for every authenticated page.
//
// SECURITY: if no host is mounted the request FAILS CLOSED (resolves null →
// "cancelled") rather than falling back to window.prompt — a fallback would
// silently reintroduce the very exposure this exists to remove.
// =============================================================================

import * as React from "react";
import { Button } from "@/components/ui/button";

type Mode = "password" | "code";
type PendingRequest = { message: string; mode: Mode; resolve: (value: string | null) => void };

let openRequest: ((req: Omit<PendingRequest, "resolve">) => Promise<string | null>) | null = null;

/** Ask the user for a credential. Resolves to the entered value, or null if
 *  they cancelled (or no host is mounted — fail closed). */
export function requestCredential(message: string, mode: Mode = "password"): Promise<string | null> {
  if (!openRequest) return Promise.resolve(null);
  return openRequest({ message, mode });
}

export function CredentialPromptHost() {
  const [pending, setPending] = React.useState<PendingRequest | null>(null);
  const [value, setValue] = React.useState("");
  const [reveal, setReveal] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    openRequest = (req) =>
      new Promise<string | null>((resolve) => {
        setValue("");
        setReveal(false);
        setPending({ ...req, resolve });
      });
    return () => {
      openRequest = null;
    };
  }, []);

  React.useEffect(() => {
    if (pending) inputRef.current?.focus();
  }, [pending]);

  const finish = React.useCallback(
    (result: string | null) => {
      pending?.resolve(result);
      setPending(null);
      // Do not leave the secret sitting in component state after the dialog closes.
      setValue("");
      setReveal(false);
    },
    [pending],
  );

  if (!pending) return null;

  const isCode = pending.mode === "code";

  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) finish(null); // click-away cancels
      }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="credential-prompt-title"
        className="w-full max-w-sm rounded-2xl border bg-card p-6 shadow-xl"
        onSubmit={(e) => {
          e.preventDefault();
          if (value) finish(value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") finish(null);
        }}
      >
        <h2 id="credential-prompt-title" className="text-lg font-semibold tracking-tight">
          {isCode ? "Enter your 2FA code" : "Confirm your password"}
        </h2>
        <p className="mt-1.5 text-sm text-muted-foreground">{pending.message}</p>

        <div className="relative mt-4">
          <input
            ref={inputRef}
            // Masked by default — the whole point. A code stays masked too:
            // it is still a credential someone can read over your shoulder.
            type={reveal ? "text" : "password"}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            // Lets password managers fill this properly instead of forcing a
            // typed-from-memory password.
            autoComplete={isCode ? "one-time-code" : "current-password"}
            inputMode={isCode ? "numeric" : undefined}
            aria-label={isCode ? "2FA code" : "Password"}
            className="h-10 w-full rounded-md border border-input bg-background px-3 pr-16 text-sm outline-none focus:border-primary/60"
          />
          <button
            type="button"
            onClick={() => setReveal((v) => !v)}
            aria-pressed={reveal}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
          >
            {reveal ? "Hide" : "Show"}
          </button>
        </div>

        <div className="mt-5 flex items-center gap-2">
          <Button type="submit" disabled={!value}>
            Confirm
          </Button>
          <Button type="button" variant="outline" onClick={() => finish(null)}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
