"use client";

// =============================================================================
// Shared client primitives for the Dead & Wounded game screens
// =============================================================================
// The durable core is REST-only (live sockets are the step-2 transport, out of
// scope here), so the play screens keep their view fresh by polling the BFF.
// Everything here is display/UX only — the server is authoritative for scoring,
// turn order, win detection and validation (spec §9). The client-side
// digit check is friendly pre-validation; the API re-validates every guess.
// =============================================================================

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { interpretApiError } from "@/lib/api-error";

/** A guess/secret must be N DISTINCT digits 0–9 (mirrors the engine's rule). */
export function digitsValid(value: string, n: number): boolean {
  if (value.length !== n) return false;
  if (!/^[0-9]+$/.test(value)) return false;
  return new Set(value.split("")).size === n;
}

/** Send JSON to the BFF with any method; returns { ok, status, data, error }.
 *  Never throws on non-2xx. On failure, `error` ALWAYS carries the server's own
 *  message combined with a plain-language interpretation of the status (via
 *  interpretApiError) — so every consumer surfaces WHY, never a bare code. */
export async function sendSms<T = unknown>(
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: T | null; error: string | null }> {
  const res = await fetch(`/api/sms/${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data: T | null = null;
  let serverMessage: string | null = null;
  const text = await res.text();
  if (text) {
    try {
      const parsed = JSON.parse(text) as T & { message?: string | string[] };
      if (res.ok) data = parsed;
      else serverMessage = Array.isArray(parsed.message) ? parsed.message.join(", ") : parsed.message ?? null;
    } catch {
      if (!res.ok) serverMessage = text;
    }
  }
  const error = res.ok ? null : interpretApiError(res.status, serverMessage);
  return { ok: res.ok, status: res.status, data, error };
}

/** POST JSON to the BFF (the historical helper; delegates to sendSms). */
export async function postSms<T = unknown>(
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: T | null; error: string | null }> {
  return sendSms<T>("POST", path, body);
}

/**
 * Poll a BFF GET path on an interval, seeded with server-rendered initial data.
 * Pauses polling once `stop(data)` is true (e.g. the game finished).
 */
export function usePolled<T>(
  path: string,
  initial: T,
  opts: { intervalMs?: number; stop?: (data: T) => boolean } = {},
): { data: T; refresh: () => Promise<void> } {
  const { intervalMs = 2500, stop } = opts;
  const [data, setData] = React.useState<T>(initial);
  const dataRef = React.useRef<T>(initial);
  dataRef.current = data;

  const refresh = React.useCallback(async () => {
    const res = await fetch(`/api/sms/${path}`, { cache: "no-store" });
    if (res.ok) setData((await res.json()) as T);
  }, [path]);

  React.useEffect(() => {
    if (stop && stop(dataRef.current)) return;
    const id = setInterval(() => {
      if (stop && stop(dataRef.current)) return;
      void refresh();
    }, intervalMs);
    return () => clearInterval(id);
  }, [refresh, intervalMs, stop]);

  return { data, refresh };
}

/** Resolve the live game socket base. Behind nginx the API is same-origin under
 *  /ws/* (see infrastructure/nginx). In local dev set NEXT_PUBLIC_WS_URL to the
 *  API origin (e.g. ws://localhost:3001) since the API isn't proxied there. */
function wsBase(): string {
  const explicit = process.env.NEXT_PUBLIC_WS_URL;
  if (explicit) return explicit.replace(/\/+$/, "");
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}`;
}

/**
 * Live view of a DURABLE duel via the /ws/watch push bridge, with polling as a
 * resilient fallback. The server stays authoritative: the socket is READ-ONLY —
 * on every committed change the gateway re-reads the RLS-scoped, viewer-redacted
 * view (exactly what the REST GET returns) and pushes it, so this just swaps the
 * fixed 2.5s poll for instant updates.
 *
 * Degradation: while the socket is connected, polling is paused; if the handshake
 * fails or the socket drops (no ticket, API not proxied in dev, network blip), it
 * resumes polling and retries the socket with backoff. So the screen NEVER goes
 * stale even if sockets are unavailable. Stops both once `stop(data)` is true.
 *
 * `refresh()` is still a plain REST GET, so optimistic post-then-refresh keeps
 * working unchanged.
 */
export function useLiveGame<T>(
  gameId: string,
  restPath: string,
  initial: T,
  opts: { stop?: (data: T) => boolean; fallbackMs?: number; mode?: "duel" | "ring" | "race" | "league" | "ultimate" } = {},
): { data: T; refresh: () => Promise<void>; live: boolean } {
  const { stop, fallbackMs = 2500, mode = "duel" } = opts;
  const [data, setData] = React.useState<T>(initial);
  const [live, setLive] = React.useState(false);
  const dataRef = React.useRef<T>(initial);
  dataRef.current = data;
  // Keep `stop` in a ref so the connect effect doesn't depend on its identity —
  // callers pass an inline arrow, so a dep would reconnect the socket every render.
  const stopRef = React.useRef(stop);
  stopRef.current = stop;
  const stopped = React.useCallback(() => Boolean(stopRef.current && stopRef.current(dataRef.current)), []);

  const refresh = React.useCallback(async () => {
    const res = await fetch(`/api/sms/${restPath}`, { cache: "no-store" });
    if (res.ok) setData((await res.json()) as T);
  }, [restPath]);

  React.useEffect(() => {
    if (stopped()) return;
    let socket: WebSocket | null = null;
    let pollId: ReturnType<typeof setInterval> | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    let disposed = false;

    const startPolling = () => {
      if (pollId) return;
      pollId = setInterval(() => {
        if (stopped()) return;
        void refresh();
      }, fallbackMs);
    };
    const stopPolling = () => {
      if (pollId) clearInterval(pollId);
      pollId = null;
    };

    const scheduleRetry = () => {
      if (disposed || stopped() || retry) return;
      const delay = Math.min(1000 * 2 ** attempts++, 15000);
      retry = setTimeout(() => {
        retry = null;
        void connect();
      }, delay);
    };

    const connect = async () => {
      if (disposed || stopped()) return;
      // The handshake needs a verifiable token; the BFF mints a short-lived one.
      let token: string;
      try {
        const res = await fetch("/api/ws-ticket", { cache: "no-store" });
        if (!res.ok) throw new Error(`ticket ${res.status}`);
        token = ((await res.json()) as { token: string }).token;
      } catch {
        startPolling(); // no ticket → stay on REST
        scheduleRetry();
        return;
      }
      if (disposed) return;

      const url = `${wsBase()}/ws/watch?mode=${mode}&gameId=${encodeURIComponent(gameId)}&token=${encodeURIComponent(token)}`;
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch {
        startPolling();
        scheduleRetry();
        return;
      }
      socket = ws;

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data)) as
            | { type: "state"; game: T }
            | { type: "error"; code: string; message: string };
          if (msg.type === "state") {
            attempts = 0; // a good frame resets backoff
            setData(msg.game);
            if (stopped()) ws.close();
          } else {
            // 404/403/etc — fall back to REST (which renders the same outcome).
            startPolling();
          }
        } catch {
          /* ignore malformed frames */
        }
      };
      ws.onopen = () => {
        if (disposed) return ws.close();
        setLive(true);
        stopPolling(); // socket is the source of freshness now
        void refresh(); // immediate sync in case a change landed pre-open
      };
      ws.onclose = () => {
        setLive(false);
        socket = null;
        if (disposed || stopped()) return;
        startPolling(); // never go stale while reconnecting
        scheduleRetry();
      };
      ws.onerror = () => ws.close();
    };

    // Start on REST immediately, then upgrade to the socket.
    startPolling();
    void connect();

    return () => {
      disposed = true;
      stopPolling();
      if (retry) clearTimeout(retry);
      if (socket) {
        socket.onclose = null; // don't reconnect on intentional teardown
        socket.close();
      }
    };
  }, [gameId, mode, refresh, fallbackMs, stopped]);

  return { data, refresh, live };
}

/** A guess entry box that enforces N distinct digits before enabling submit. */
export function GuessForm({
  length,
  onSubmit,
  disabled,
  cta = "Guess",
  placeholder,
}: {
  length: number;
  onSubmit: (value: string) => Promise<void> | void;
  disabled?: boolean;
  cta?: string;
  placeholder?: string;
}) {
  const [value, setValue] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const valid = digitsValid(value, length);

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      await onSubmit(value);
      setValue("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <Input
        inputMode="numeric"
        autoComplete="off"
        value={value}
        disabled={disabled || busy}
        maxLength={length}
        placeholder={placeholder ?? `${length} distinct digits`}
        onChange={(e) => setValue(e.target.value.replace(/[^0-9]/g, "").slice(0, length))}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        className="w-44 font-mono tracking-[0.3em]"
        aria-label="Your guess"
      />
      <Button onClick={submit} disabled={disabled || busy || !valid}>
        {busy ? "…" : cta}
      </Button>
    </div>
  );
}

/** The dead/wounded score of one guess, shown as two compact pills. */
export function ScorePips({ dead, wounded }: { dead: number; wounded: number }) {
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-xs">
      <span className="rounded bg-destructive/15 px-1.5 py-0.5 font-semibold text-destructive">
        {dead} dead
      </span>
      <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-semibold text-amber-600">
        {wounded} wnd
      </span>
    </span>
  );
}

/** A monospace list of guesses with their scores (most recent first). */
export function GuessList({
  guesses,
  emptyLabel = "No guesses yet.",
}: {
  guesses: { value: string; dead: number; wounded: number; createdAt: string }[];
  emptyLabel?: string;
}) {
  if (guesses.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyLabel}</p>;
  }
  const ordered = [...guesses].reverse();
  return (
    <ul className="space-y-1.5">
      {ordered.map((g, i) => (
        <li
          key={`${g.createdAt}-${i}`}
          className="flex items-center justify-between rounded-md border border-border px-3 py-1.5"
        >
          <span className="font-mono text-sm tracking-[0.25em]">{g.value}</span>
          <ScorePips dead={g.dead} wounded={g.wounded} />
        </li>
      ))}
    </ul>
  );
}

/** Connection indicator: live push (green pulse) vs REST poll fallback. */
export function LiveDot({ live }: { live: boolean }) {
  return (
    <span
      className="inline-flex items-center gap-1 text-xs text-muted-foreground"
      title={live ? "Live updates over WebSocket" : "Polling (live socket unavailable)"}
    >
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          live ? "animate-pulse bg-emerald-500" : "bg-muted-foreground/40",
        )}
      />
      {live ? "Live" : "Polling"}
    </span>
  );
}

/** A short inline status message (error red / neutral muted). */
export function StatusLine({ msg, error }: { msg: string | null; error?: boolean }) {
  if (!msg) return null;
  return <p className={cn("text-sm", error ? "text-destructive" : "text-muted-foreground")}>{msg}</p>;
}
