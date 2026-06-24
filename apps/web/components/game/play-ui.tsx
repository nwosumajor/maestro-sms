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

/** A guess/secret must be N DISTINCT digits 0–9 (mirrors the engine's rule). */
export function digitsValid(value: string, n: number): boolean {
  if (value.length !== n) return false;
  if (!/^[0-9]+$/.test(value)) return false;
  return new Set(value.split("")).size === n;
}

/** POST JSON to the BFF; returns { ok, status, data }. Never throws on non-2xx. */
export async function postSms<T = unknown>(
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: T | null; error: string | null }> {
  const res = await fetch(`/api/sms/${path}`, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data: T | null = null;
  let error: string | null = null;
  const text = await res.text();
  if (text) {
    try {
      const parsed = JSON.parse(text) as T & { message?: string | string[] };
      if (res.ok) data = parsed;
      else error = Array.isArray(parsed.message) ? parsed.message.join(", ") : parsed.message ?? null;
    } catch {
      if (!res.ok) error = text;
    }
  }
  return { ok: res.ok, status: res.status, data, error };
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

/** A short inline status message (error red / neutral muted). */
export function StatusLine({ msg, error }: { msg: string | null; error?: boolean }) {
  if (!msg) return null;
  return <p className={cn("text-sm", error ? "text-destructive" : "text-muted-foreground")}>{msg}</p>;
}
