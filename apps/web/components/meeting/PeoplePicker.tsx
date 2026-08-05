"use client";

// =============================================================================
// PeoplePicker — search and tick, for parents or colleagues
// =============================================================================
// Both pickers this page needs are the same shape: search a category of people,
// tick some, see who you have. Building two would have meant two debounces, two
// empty states and two ways of showing the chosen set.
//
// It SEARCHES rather than listing. A school has hundreds of parents and a
// scrolling list of all of them is a list nobody finishes — and rendering it is
// work done on every keystroke for a set the user will pick three from. The
// query goes to the server (`GET /users?kind=&q=`), which already narrows by
// role category, so a parent can never appear in the colleague picker.
//
// The CHOSEN set is kept outside the results, deliberately: someone who ticks a
// parent, searches for another, and no longer sees the first would reasonably
// think they had lost it.
// =============================================================================

import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type Person = { id: string; name: string; email?: string | null };

export function PeoplePicker({
  kind,
  label,
  hint,
  value,
  onChange,
  max,
}: {
  /** Narrows the SERVER query by role category. */
  kind: "parent" | "meeting-host";
  label: string;
  hint: string;
  value: Person[];
  onChange: (next: Person[]) => void;
  max: number;
}) {
  const [q, setQ] = React.useState("");
  const [results, setResults] = React.useState<Person[]>([]);
  const [searching, setSearching] = React.useState(false);

  // Debounced: a request per keystroke would be a query per keystroke on a table
  // that grows with the school.
  React.useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setResults([]);
      return;
    }
    let live = true;
    setSearching(true);
    const t = setTimeout(async () => {
      const res = await fetch(`/api/sms/users?kind=${kind}&q=${encodeURIComponent(term)}`);
      if (!live) return;
      setResults(res.ok ? ((await res.json()) as Person[]).slice(0, 20) : []);
      setSearching(false);
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, kind]);

  const chosen = new Set(value.map((v) => v.id));
  const add = (p: Person) => {
    if (chosen.has(p.id) || value.length >= max) return;
    onChange([...value, p]);
  };
  const remove = (id: string) => onChange(value.filter((v) => v.id !== id));

  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <div>
        <Label htmlFor={`pick-${kind}`}>{label}</Label>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>

      {/* The chosen set FIRST and always visible — it is the answer to "who have
          I picked", which a results list scrolling underneath cannot be. */}
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => remove(v.id)}
              title={`Remove ${v.name}`}
              className="inline-flex items-center gap-1 rounded-md border border-primary bg-primary/10 px-2 py-1 text-xs text-primary"
            >
              {v.name}
              <span aria-hidden>×</span>
              <span className="sr-only">Remove</span>
            </button>
          ))}
        </div>
      )}

      <Input
        id={`pick-${kind}`}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={kind === "parent" ? "Search parents by name…" : "Search colleagues by name…"}
        className="h-9"
        disabled={value.length >= max}
      />

      {value.length >= max ? (
        <p className="text-xs text-muted-foreground">That is the maximum of {max}. Remove one to add another.</p>
      ) : q.trim().length > 0 && q.trim().length < 2 ? (
        <p className="text-xs text-muted-foreground">Type at least two letters.</p>
      ) : searching ? (
        <p className="text-xs text-muted-foreground">Searching…</p>
      ) : q.trim().length >= 2 && results.length === 0 ? (
        <p className="text-xs text-muted-foreground">Nobody matches “{q.trim()}”.</p>
      ) : (
        results.length > 0 && (
          <div className="max-h-44 overflow-y-auto rounded-md border border-border">
            {results.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => add(r)}
                disabled={chosen.has(r.id)}
                className={`flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-sm ${
                  chosen.has(r.id) ? "cursor-default text-muted-foreground" : "hover:bg-muted"
                }`}
              >
                <span className="min-w-0 truncate">
                  {r.name}
                  {r.email && <span className="ml-1.5 text-xs text-muted-foreground">{r.email}</span>}
                </span>
                {chosen.has(r.id) && <Badge variant="outline" className="text-[11px]">added</Badge>}
              </button>
            ))}
          </div>
        )
      )}
    </div>
  );
}
