"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

type Student = { id: string; name: string };

/** A family-sized list stays a row of chips — fastest possible for a parent. */
const CHIP_LIMIT = 12;
/** Never render more than this many results at once. */
const RESULT_CAP = 60;

/**
 * Pick a student whose attendance to view.
 *
 * Two rewrites, and the second one matters at scale. It began as EVERY student
 * rendered as a chip; that became a local filter over the loaded list. But the
 * roster list is now bounded (it had to be — it was uncapped only so a dashboard
 * tile could count it), so a local filter searches a PAGE of the register and
 * silently cannot find anyone outside it. At 3,000 pupils that is 2,500 children
 * who simply do not exist as far as this control is concerned, with nothing on
 * screen to say so.
 *
 * So above chip size it queries the SERVER (`?q=`, SEARCH_CAP-bounded). A parent
 * still pays nothing: with a handful of children the chips render and no request is
 * ever made.
 */
export function StudentPicker({
  students,
  selectedId,
  total,
}: {
  students: Student[];
  selectedId?: string;
  /** Whole-roster count, so the control can say what it is NOT showing. */
  total?: number;
}) {
  const router = useRouter();
  const [q, setQ] = React.useState("");
  const [results, setResults] = React.useState<Student[] | null>(null);
  const [busy, setBusy] = React.useState(false);

  const small = students.length <= CHIP_LIMIT && (total ?? students.length) <= CHIP_LIMIT;

  React.useEffect(() => {
    if (small) return;
    const needle = q.trim();
    if (!needle) {
      setResults(null);
      return;
    }
    let live = true;
    // Debounced: typing a name is one request, not one per keystroke.
    const t = setTimeout(async () => {
      setBusy(true);
      const res = await fetch(`/api/sms/students?q=${encodeURIComponent(needle)}`);
      if (!live) return;
      setResults(res.ok ? ((await res.json()) as Student[]) : []);
      setBusy(false);
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, small]);

  if (students.length <= 1 && !total) return null;

  const chip = (s: Student) => (
    <button
      key={s.id}
      onClick={() => router.push(`/attendance?studentId=${s.id}`)}
      className={`rounded-md border px-3 py-1.5 text-sm font-medium transition-colors ${
        s.id === selectedId ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-accent"
      }`}
    >
      {s.name}
    </button>
  );

  // A family: chips, no network, nothing to search.
  if (small) return <div className="flex flex-wrap gap-2">{students.map(chip)}</div>;

  const shown = results ?? students.slice(0, RESULT_CAP);
  const selected = [...students, ...(results ?? [])].find((s) => s.id === selectedId);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          placeholder={total ? `Search ${total.toLocaleString()} students…` : "Search students…"}
          className="w-64 rounded-md border bg-background p-1.5 text-sm"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {busy && <span className="text-xs text-muted-foreground">Searching…</span>}
        {selected && !q && (
          <span className="text-sm text-muted-foreground">
            showing <span className="font-medium text-foreground">{selected.name}</span>
          </span>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {shown.map((s) => (
          <button
            key={s.id}
            onClick={() => router.push(`/attendance?studentId=${s.id}`)}
            className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
              s.id === selectedId ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-accent"
            }`}
          >
            {s.name}
          </button>
        ))}
        {!busy && shown.length === 0 && (
          <span className="text-sm text-muted-foreground">No student matches “{q.trim()}”.</span>
        )}
      </div>

      {/* Say what is NOT shown. Silently listing 60 of 3,000 is how a teacher
          concludes a pupil has been removed from the school. */}
      {!q && total != null && total > shown.length && (
        <p className="text-xs text-muted-foreground">
          Showing {shown.length} of {total.toLocaleString()} — search by name to reach the rest.
        </p>
      )}
    </div>
  );
}
