"use client";

// =============================================================================
// InlineSearch — one search box, for surfaces that had a search endpoint and no
// way to type into it
// =============================================================================
// Both /messages/search and /discussion/search were built, permission-gated and
// unreachable: the thread list and the discussion hub had no input. Shared here
// because two near-identical boxes drift, and the useful behaviour — don't query
// on one character, don't hammer per keystroke, say when nothing matched — is
// the same on both.
//
// The server refuses a term under 2 characters, so this does too rather than
// firing a request it knows will come back empty.
// =============================================================================

import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";

const MIN_TERM = 2;
const DEBOUNCE_MS = 250;

export function InlineSearch<T>({
  path,
  placeholder,
  render,
  emptyLabel = "Nothing matched.",
}: {
  /** API path WITHOUT the query, e.g. "messages/search". */
  path: string;
  placeholder: string;
  render: (results: T[]) => React.ReactNode;
  emptyLabel?: string;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<T[] | null>(null);
  const [busy, setBusy] = useState(false);
  // Guards against a slow early request landing after a fast later one and
  // painting stale results over fresh ones.
  const seq = useRef(0);

  useEffect(() => {
    const term = q.trim();
    if (term.length < MIN_TERM) {
      setResults(null);
      return;
    }
    const mine = ++seq.current;
    const t = setTimeout(async () => {
      setBusy(true);
      const res = await fetch(`/api/sms/${path}?q=${encodeURIComponent(term)}`);
      const data = res.ok ? ((await res.json()) as T[]) : [];
      if (mine === seq.current) {
        setResults(data);
        setBusy(false);
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [q, path]);

  return (
    <div className="space-y-2">
      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={placeholder}
        className="h-8 max-w-sm text-sm"
        aria-label={placeholder}
      />
      {q.trim().length > 0 && q.trim().length < MIN_TERM && (
        <p className="text-xs text-muted-foreground">Keep typing — at least {MIN_TERM} characters.</p>
      )}
      {busy && <p className="text-xs text-muted-foreground">Searching…</p>}
      {!busy && results && results.length === 0 && <p className="text-xs text-muted-foreground">{emptyLabel}</p>}
      {!busy && results && results.length > 0 && render(results)}
    </div>
  );
}
