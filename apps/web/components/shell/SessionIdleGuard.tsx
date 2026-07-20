"use client";

// =============================================================================
// SessionIdleGuard — 10-minute inactivity logout with a 60-second warning
// =============================================================================
// Mounted inside AppShell (signed-in pages only). Three jobs:
//   1. Track real user activity (pointer/keys/scroll/touch) locally.
//   2. While ACTIVE, keep the server session alive: middleware rolls the
//      11-minute cookie on navigation, but a user reading one page for 9
//      minutes never touches the server — so we ping /api/auth/session every
//      4 active minutes to re-issue the JWT (auth.ts updateAge).
//   3. At 9 minutes idle, show a blocking "session expiring in 60s" dialog;
//      "Continue" extends the server session and resets the clock; no answer
//      by 10 minutes signs out and lands on /login?next=<current page>, so
//      re-authenticating returns the user exactly where they were.
// The 11-minute SERVER maxAge is the backstop: an abandoned tab's cookie dies
// on its own shortly after the client-side sign-out fires (or would have).
// =============================================================================

import * as React from "react";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import { Button } from "@/components/ui/button";

const IDLE_LIMIT_MS = 10 * 60_000; // hard sign-out
const WARN_BEFORE_MS = 60_000; // dialog opens 60s before the limit
const KEEPALIVE_MS = 4 * 60_000; // server ping cadence while active

export function SessionIdleGuard() {
  const pathname = usePathname();
  const lastActivity = React.useRef(Date.now());
  const lastPing = React.useRef(Date.now());
  const signingOut = React.useRef(false);
  const [secondsLeft, setSecondsLeft] = React.useState<number | null>(null);

  const keepAlive = React.useCallback(() => {
    lastPing.current = Date.now();
    // Reading the session re-issues the rolling JWT cookie (updateAge).
    void fetch("/api/auth/session", { cache: "no-store" }).catch(() => {});
  }, []);

  const doSignOut = React.useCallback(() => {
    if (signingOut.current) return;
    signingOut.current = true;
    const next = encodeURIComponent(pathname + window.location.search);
    void signOut({ redirect: false }).finally(() => {
      window.location.href = `/login?next=${next}`;
    });
  }, [pathname]);

  const stay = React.useCallback(() => {
    lastActivity.current = Date.now();
    setSecondsLeft(null);
    keepAlive();
  }, [keepAlive]);

  React.useEffect(() => {
    const markActive = () => {
      // Activity during the warning does NOT dismiss the dialog — an explicit
      // "Continue" click does, so a stray mouse nudge can't silently extend.
      if (secondsLeft === null) lastActivity.current = Date.now();
    };
    const events: Array<keyof WindowEventMap> = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart", "scroll"];
    for (const ev of events) window.addEventListener(ev, markActive, { passive: true });

    const tick = window.setInterval(() => {
      const idleFor = Date.now() - lastActivity.current;
      if (idleFor >= IDLE_LIMIT_MS) {
        doSignOut();
        return;
      }
      if (idleFor >= IDLE_LIMIT_MS - WARN_BEFORE_MS) {
        setSecondsLeft(Math.max(1, Math.ceil((IDLE_LIMIT_MS - idleFor) / 1000)));
      } else if (secondsLeft !== null) {
        setSecondsLeft(null);
      }
      // Keep the rolling server cookie alive while the user is actually active.
      if (Date.now() - lastPing.current >= KEEPALIVE_MS && idleFor < KEEPALIVE_MS) keepAlive();
    }, 1000);

    return () => {
      for (const ev of events) window.removeEventListener(ev, markActive);
      window.clearInterval(tick);
    };
  }, [secondsLeft, doSignOut, keepAlive]);

  if (secondsLeft === null) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="idle-title"
        className="mx-4 w-full max-w-sm rounded-2xl border bg-card p-6 shadow-xl"
      >
        <h2 id="idle-title" className="text-lg font-semibold tracking-tight">
          Still there?
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          You have been inactive for a while. For your security you will be signed out in{" "}
          <span className="tnum font-semibold text-foreground">{secondsLeft}s</span>.
        </p>
        <div className="mt-5 flex items-center gap-2">
          <Button onClick={stay}>Continue session</Button>
          <Button variant="outline" onClick={doSignOut}>
            Sign out now
          </Button>
        </div>
      </div>
    </div>
  );
}
