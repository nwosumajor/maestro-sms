"use client";

import * as React from "react";

type Person = { id: string; name: string };

/**
 * Name the person a complaint is about, by typing.
 *
 * The form used a plain `<select>` filled from one request to
 * `/discipline/file-targets`, which returns at most 500 names ordered by name.
 * Measured on a 1,200-pupil roll: it returned A to K, so **690 pupils could not
 * be named in a complaint at all** — the dropdown simply did not contain them,
 * and nothing on the screen said why. A concern that cannot be filed is a
 * concern that goes unrecorded, and this is a safeguarding path.
 *
 * The endpoint is the DISCIPLINE one, not the directory: who you may file
 * against is relationship-scoped (a pupil may name a classmate, not the school),
 * and searching the directory instead would quietly widen that.
 *
 * `seed` is the page the server already sent. When it answers the query, no
 * request is made — the same bargain `UserPicker` strikes.
 */
export function TargetPicker({
  type,
  value,
  onChange,
  seed,
  total,
}: {
  type: "STUDENT" | "TEACHER";
  value: string;
  onChange: (id: string) => void;
  seed: Person[];
  total: number;
}) {
  const [q, setQ] = React.useState("");
  const [results, setResults] = React.useState<Person[] | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

  const chosen = React.useMemo(
    () => [...seed, ...(results ?? [])].find((u) => u.id === value),
    [seed, results, value],
  );

  React.useEffect(() => {
    const needle = q.trim();
    if (needle.length < 2) {
      setResults(null);
      return;
    }
    const local = seed.filter((u) => u.name.toLowerCase().includes(needle.toLowerCase()));
    // Only trust the seed when it is the WHOLE set. If more exist than arrived,
    // a local hit does not mean there is no better one past the cap — which is
    // the mistake that made the dropdown look complete.
    if (local.length > 0 && seed.length >= total) {
      setResults(local);
      return;
    }
    let live = true;
    const t = setTimeout(async () => {
      setBusy(true);
      const res = await fetch(
        `/api/sms/discipline/file-targets?type=${type}&q=${encodeURIComponent(needle)}`,
        { cache: "no-store" },
      );
      if (!live) return;
      if (res.ok) {
        setResults(((await res.json()) as { items: Person[] }).items);
        setFailed(false);
      } else {
        // NOT an empty list: "nobody by that name" is a statement about the
        // school, and a failed request does not know it.
        setResults(null);
        setFailed(true);
      }
      setBusy(false);
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, seed, type, total]);

  const list = results ?? seed.slice(0, 20);

  return (
    <div className="min-w-60 space-y-1">
      {chosen ? (
        <div className="flex items-center gap-2">
          <span className="rounded-md border border-border bg-muted/40 px-2 py-1 text-sm">{chosen.name}</span>
          <button type="button" className="text-xs underline underline-offset-2" onClick={() => { onChange(""); setQ(""); }}>
            change
          </button>
        </div>
      ) : (
        <>
          <input
            aria-label="Against"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={type === "STUDENT" ? "Type a pupil's name…" : "Type a teacher's name…"}
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
          />
          {failed && <p className="text-xs text-destructive">Couldn&rsquo;t search just now — this does not mean nobody matches.</p>}
          {list.length > 0 && (
            <ul className="max-h-44 overflow-auto rounded-md border border-border">
              {list.map((u) => (
                <li key={u.id}>
                  <button
                    type="button"
                    onClick={() => { onChange(u.id); setQ(""); }}
                    className="block w-full px-2 py-1 text-left text-sm hover:bg-primary/10"
                  >
                    {u.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {/* WHAT IS NOT ON SCREEN. The seed is one page; saying so is the
              difference between "not here" and "not shown". */}
          {!busy && q.trim().length < 2 && total > seed.length && (
            <p className="text-xs text-muted-foreground">
              Showing {seed.length} of {total.toLocaleString()} — type at least two letters to search the rest.
            </p>
          )}
          {!busy && q.trim().length >= 2 && list.length === 0 && !failed && (
            <p className="text-xs text-muted-foreground">Nobody here matches &ldquo;{q.trim()}&rdquo;.</p>
          )}
        </>
      )}
    </div>
  );
}
