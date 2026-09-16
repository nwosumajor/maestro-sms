"use client";

import * as React from "react";

export type PickedStudent = { id: string; name: string };

/**
 * Pick a student by typing, not by loading the school.
 *
 * Five pages each fetched the ENTIRE roster to populate a dropdown — /admin,
 * /students, /certificates, /documents and /classes. A 900-pupil school moved 900
 * rows five times so that four `<select>` elements had options. The list endpoint
 * has supported `?q=` (server-side, SEARCH_CAP-bounded) all along; nothing used it.
 *
 * `seed` is the small set a page may already hold (a class roster, a parent's
 * children). When it covers the need, no request is made at all — a parent with two
 * children should never wait on a network round trip to pick one of them.
 */
export function StudentPicker({
  value,
  onChange,
  seed = [],
  placeholder = "Search students…",
  className = "",
  disabled,
}: {
  value: string;
  onChange: (id: string, student?: PickedStudent) => void;
  seed?: PickedStudent[];
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}) {
  const [q, setQ] = React.useState("");
  const [results, setResults] = React.useState<PickedStudent[] | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [open, setOpen] = React.useState(false);

  /**
   * WHO IS PICKED — REMEMBERED, not re-derived.
   *
   * `selected` used to be looked up in `[...seed, ...results]` on every render.
   * Choosing clears the query, which clears `results`, so a pupil found by
   * SEARCHING the server (i.e. anyone not in the page's small seed) vanished
   * from the control the instant they were chosen: the field showed its
   * placeholder again and the form looked empty while `value` held a perfectly
   * good id. On enrolment that means enrolling a pupil you can no longer see the
   * name of; the sibling `PeoplePicker` keeps its chosen people in state and
   * shows them first, and says so in a comment — these two were never swept.
   *
   * Held in state, and re-derived ONLY as a fallback (a parent may set `value`
   * from outside, e.g. a saved draft), so it survives both the cleared query and
   * a re-render.
   */
  const [picked, setPicked] = React.useState<PickedStudent | null>(null);
  const selected = React.useMemo(() => {
    if (picked && picked.id === value) return picked;
    return [...seed, ...(results ?? [])].find((s) => s.id === value) ?? null;
  }, [picked, seed, results, value]);

  // A parent clearing the field must clear the remembered name with it.
  React.useEffect(() => {
    if (!value) setPicked(null);
  }, [value]);

  React.useEffect(() => {
    const needle = q.trim();
    if (!needle) {
      setResults(null);
      return;
    }
    // Local first: if the seed already answers it, do not ask the server.
    const local = seed.filter((s) => s.name.toLowerCase().includes(needle.toLowerCase()));
    if (local.length > 0) {
      setResults(local);
      return;
    }
    // Debounced, so typing a name is one request rather than one per keystroke.
    let live = true;
    const t = setTimeout(async () => {
      setBusy(true);
      const res = await fetch(`/api/sms/students?q=${encodeURIComponent(needle)}`);
      if (!live) return;
      setResults(res.ok ? ((await res.json()) as PickedStudent[]) : []);
      setBusy(false);
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, seed]);

  const list = results ?? seed.slice(0, 20);

  return (
    <div className={`relative ${className}`}>
      {/* THE CHOICE IS TEXT, NOT A PLACEHOLDER. A placeholder is grey, reads as
          "nothing here yet", and disappears the moment somebody types — so even
          when it resolved, the field looked empty. The name now sits above the
          box and stays put. */}
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
        // Blur is delayed so a click on a result registers before the list closes.
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

      {open && (q.trim() || seed.length > 0) && (
        <ul className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-md border bg-card shadow-lg">
          {busy && <li className="px-3 py-2 text-xs text-muted-foreground">Searching…</li>}
          {!busy &&
            list.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  className={`block w-full px-3 py-1.5 text-left text-sm hover:bg-accent ${
                    s.id === value ? "text-primary" : ""
                  }`}
                  onClick={() => {
                    setPicked(s);
                    onChange(s.id, s);
                    setQ("");
                    setOpen(false);
                  }}
                >
                  {s.name}
                </button>
              </li>
            ))}
          {!busy && list.length === 0 && (
            <li className="px-3 py-2 text-xs text-muted-foreground">
              {q.trim() ? `No student matches “${q.trim()}”.` : "Type to search."}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
