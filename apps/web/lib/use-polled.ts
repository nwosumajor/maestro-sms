"use client";

// =============================================================================
// usePolled — repeat a BFF GET on a timer, and SAY when it stops getting
// through.
//
// Four screens hand-rolled this loop and all four had the same hole:
// `if (res.ok) setData(...)`, so a refused or failed refresh silently kept the
// old data and the screen simply stopped moving — indistinguishable from a
// screen with nothing new on it. That is the whole problem, because these are
// exactly the screens whose point is that something IS changing: a live quiz,
// a bus on a map, an exam hall's roll, a rotating gate code.
//
// MEASURED on the running stack, on the sharpest of them: a live quiz polls
// every 1.5 s per player and one CLASS is over the school's request budget —
// 21% of refreshes refused at forty players, 39% at sixty. A school's own wifi
// does it for free.
// =============================================================================

import * as React from "react";

export interface Polled<T> {
  data: T;
  /** Fetch now. Resolves true when the screen holds the server's current state. */
  refresh: () => Promise<boolean>;
  /** The last refresh did not get through — what is on screen may be behind. */
  stale: boolean;
}

export function usePolled<T>(
  path: string,
  initial: T,
  opts: { intervalMs?: number; stop?: (data: T) => boolean } = {},
): Polled<T> {
  const { intervalMs = 2500, stop } = opts;
  const [data, setData] = React.useState<T>(initial);
  const [stale, setStale] = React.useState(false);
  const dataRef = React.useRef<T>(initial);
  dataRef.current = data;

  const refresh = React.useCallback(async () => {
    const res = await fetch(`/api/sms/${path}`, { cache: "no-store" }).catch(() => null);
    if (res?.ok) {
      setData((await res.json()) as T);
      setStale(false);
      return true;
    }
    setStale(true);
    return false;
  }, [path]);

  React.useEffect(() => {
    if (stop && stop(dataRef.current)) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    // BACK OFF WHEN REFUSED, rather than hammering at the same rate. A poll
    // that meets a rate limit and retries immediately is part of the reason it
    // is being limited; the wait doubles to ten seconds and resets on success.
    let wait = intervalMs;
    const tick = async () => {
      if (cancelled) return;
      if (!(stop && stop(dataRef.current))) {
        const ok = await refresh();
        wait = ok ? intervalMs : Math.min(wait * 2, 10_000);
      }
      if (!cancelled) timer = setTimeout(tick, wait);
    };
    timer = setTimeout(tick, intervalMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [refresh, intervalMs, stop]);

  return { data, refresh, stale };
}
