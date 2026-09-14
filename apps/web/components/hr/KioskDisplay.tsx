"use client";

import * as React from "react";

const KIOSK_STEP_MS = 30_000;

/**
 * The rotating clock-in code, full-screen, for an unattended display.
 *
 * The countdown is what removes a stale code, NOT a failed fetch: a device that
 * slept, a throttled tab and a refused request all end the same way — the number
 * on the glass is past its window — and only its own clock catches all three.
 * This mirrors the logic already proven on the admin panel rather than inventing
 * a second rule, because two screens disagreeing about which code is live is the
 * whole failure.
 */
export function KioskDisplay({ schoolName }: { schoolName: string }) {
  const [code, setCode] = React.useState<{ code: string; until: number } | null>(null);
  const [offline, setOffline] = React.useState(false);
  const [nowMs, setNowMs] = React.useState(() => Date.now());

  React.useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const r = await fetch("/api/sms/hr/attendance/kiosk/code", { cache: "no-store" });
        if (!alive) return;
        if (r.ok) {
          const c = (await r.json()) as { code: string; secondsRemaining: number };
          setCode({ code: c.code, until: Date.now() + c.secondsRemaining * 1000 });
          setOffline(false);
        } else {
          setOffline(true);
        }
      } catch {
        // A failed refresh does NOT blank the code — the one on screen is valid
        // until its own window runs out, and blanking it would send a queue of
        // staff to the office over a dropped packet.
        if (alive) setOffline(true);
      }
      if (alive) timer = setTimeout(tick, 5000);
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);

  React.useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 500);
    return () => clearInterval(id);
  }, []);

  // ±1 step, matching `verifyTotp(secret, code, 1, …)` on the server: a code read
  // at the very end of its window is still accepted for one more step, so showing
  // it for that step is correct rather than generous.
  const expiresAt = code ? code.until + KIOSK_STEP_MS : 0;
  const live = Boolean(code) && nowMs < expiresAt;
  const secondsLeft = live ? Math.max(0, Math.ceil((expiresAt - nowMs) / 1000)) : 0;

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background p-8 text-center">
      <p className="text-lg text-muted-foreground">{schoolName}</p>
      <h1 className="text-2xl font-medium">Staff clock-in</h1>
      {live && code ? (
        <>
          <p className="font-mono text-[16vw] leading-none tracking-[0.15em] tabular-nums sm:text-[12rem]">
            {code.code}
          </p>
          <p className="text-muted-foreground" aria-live="polite">
            Changes in {secondsLeft}s
          </p>
        </>
      ) : (
        // SAYS WHICH. "No code" reads as a broken screen; the two causes need
        // different people — one is the kiosk being switched off, the other is
        // this device's connection.
        <p className="max-w-md text-xl text-muted-foreground">
          {offline
            ? "Cannot reach the school system — check this display's connection."
            : "Clock-in is not open. Ask the office to enable the kiosk."}
        </p>
      )}
      <p className="max-w-md text-sm text-muted-foreground">
        Enter this code on your own device, under Leave → My attendance, to clock in or out.
      </p>
    </main>
  );
}
