"use client";

import * as React from "react";

export type PickedUser = { id: string; name: string; email?: string };

/**
 * Pick a staff member or guardian by typing, not by enumerating the school.
 *
 * The sibling of StudentPicker, for the other half of the directory. The classes
 * page fetched `/users?kind=parent` — every guardian in the school, name and email —
 * on every load, purely so one `<select>` had options. In a 3,000-pupil school that
 * is thousands of rows shipped to render a control most visits never touch, and the
 * list silently capped, so the guardian you wanted might not be in it at all.
 *
 * `seed` is the small set a page already holds. When it answers the query, no
 * request is made.
 */
export function UserPicker({
  value,
  onChange,
  kind,
  seed = [],
  placeholder = "Search people…",
  className = "",
  disabled,
}: {
  value: string;
  onChange: (id: string, user?: PickedUser) => void;
  /** Narrows the directory server-side, so a staff picker never shows guardians. */
  kind: "staff" | "teacher" | "parent";
  seed?: PickedUser[];
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}) {
  // A DEFAULT `[]` IS A NEW ARRAY ON EVERY RENDER, and `seed` sits in the search
  // effect's dependency list — so the effect re-ran on every render and its own
  // cleanup could discard the fetch already in flight. Frozen once here.
  const seedRef = React.useRef(seed);
  if (seed.length !== seedRef.current.length || seed.some((u, i) => u.id !== seedRef.current[i]?.id)) {
    seedRef.current = seed;
  }
  const stableSeed = seedRef.current;

  const [q, setQ] = React.useState("");
  const [results, setResults] = React.useState<PickedUser[] | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [open, setOpen] = React.useState(false);

  /**
   * WHO IS PICKED — REMEMBERED, not re-derived. Same fix, same reason, same
   * commit as `StudentPicker`: choosing clears the query, which clears
   * `results`, so anybody found by SEARCHING rather than sitting in the page's
   * seed vanished from the control the instant they were chosen. Swept together
   * because fixing one and leaving the other is how this class survives.
   */
  const [picked, setPicked] = React.useState<PickedUser | null>(null);
  const selected = React.useMemo(() => {
    if (picked && picked.id === value) return picked;
    return [...stableSeed, ...(results ?? [])].find((u) => u.id === value) ?? null;
  }, [picked, stableSeed, results, value]);

  React.useEffect(() => {
    if (!value) setPicked(null);
  }, [value]);

  React.useEffect(() => {
    const needle = q.trim();
    if (!needle) {
      // A BLANK BOX IS NOT A LIST. With no seed this control showed NOTHING
      // until the user guessed a name — an open input where a list belongs, on
      // a form whose whole job is "choose a colleague". Opening it now loads the
      // first page of the directory, so the common case is picking from what is
      // offered rather than recalling how somebody's name is spelled.
      if (!open || stableSeed.length > 0) {
        setResults(null);
        return;
      }
      let alive = true;
      setBusy(true);
      void fetch(`/api/sms/users?kind=${kind}`)
        .then(async (res) => {
          if (!alive) return;
          setResults(res.ok ? ((await res.json()) as PickedUser[]) : []);
        })
        .finally(() => { if (alive) setBusy(false); });
      return () => { alive = false; };
    }
    const local = stableSeed.filter((u) => u.name.toLowerCase().includes(needle.toLowerCase()));
    if (local.length > 0) {
      setResults(local);
      return;
    }
    // Debounced: typing a name is one request, not one per keystroke.
    let live = true;
    const t = setTimeout(async () => {
      setBusy(true);
      const res = await fetch(`/api/sms/users?kind=${kind}&q=${encodeURIComponent(needle)}`);
      if (!live) return;
      setResults(res.ok ? ((await res.json()) as PickedUser[]) : []);
      setBusy(false);
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, stableSeed, kind, open]);

  const list = results ?? stableSeed.slice(0, 20);

  return (
    <div className={`relative ${className}`}>
      {/* The choice is TEXT, not a placeholder — see StudentPicker. */}
      {selected && (
        <p className="mb-1 truncate text-sm font-medium" title={selected.name}>
          {selected.name}
        </p>
      )}
      <input
        disabled={disabled}
        placeholder={selected ? "Search to change…" : placeholder}
        aria-label={selected ? `Selected: ${selected.name}. Search to change.` : placeholder}
        className="w-full rounded-md border bg-background p-1.5 text-sm"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        // Delayed so a click on a result lands before the list closes.
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {selected && !q && (
        <button
          type="button"
          className="absolute right-2 top-1.5 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => {
            setPicked(null);
            onChange("");
            setQ("");
          }}
        >
          clear
        </button>
      )}

      {open && (q.trim() || stableSeed.length > 0 || (results?.length ?? 0) > 0 || busy) && (
        <ul className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-md border bg-card shadow-lg">
          {busy && <li className="px-3 py-2 text-xs text-muted-foreground">Searching…</li>}
          {!busy &&
            list.map((u) => (
              <li key={u.id}>
                <button
                  type="button"
                  className={`block w-full px-3 py-1.5 text-left text-sm hover:bg-accent ${
                    u.id === value ? "text-primary" : ""
                  }`}
                  onClick={() => {
                    setPicked(u);
                    onChange(u.id, u);
                    setQ("");
                    setOpen(false);
                  }}
                >
                  {u.name}
                  {u.email && <span className="ml-2 text-xs text-muted-foreground">{u.email}</span>}
                </button>
              </li>
            ))}
          {!busy && list.length === 0 && (
            <li className="px-3 py-2 text-xs text-muted-foreground">
              {q.trim() ? `Nobody matches “${q.trim()}”.` : "Type to search."}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
