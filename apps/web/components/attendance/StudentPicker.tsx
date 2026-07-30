"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

type Student = { id: string; name: string };

/** Above this many students the chip wall stops being usable and becomes a search. */
const CHIP_LIMIT = 12;
/** Never render more than this many results at once. */
const RESULT_CAP = 60;

/**
 * Pick a student whose attendance to view.
 *
 * The page used to render EVERY student as a chip — and `/students` is uncapped for
 * whole-school staff, so a school admin got the entire school as a wall of buttons.
 * A parent with two children was fine; an admin with 900 pupils was not.
 *
 * So the shape follows the list: a handful stays a row of chips (fastest thing
 * possible for a parent), anything more becomes a filter. Filtering is local to the
 * already-loaded list, so typing costs nothing.
 */
export function StudentPicker({ students, selectedId }: { students: Student[]; selectedId?: string }) {
  const router = useRouter();
  const [q, setQ] = React.useState("");

  const matches = React.useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return students.slice(0, RESULT_CAP);
    return students.filter((s) => s.name.toLowerCase().includes(needle)).slice(0, RESULT_CAP);
  }, [students, q]);

  if (students.length <= 1) return null;

  // Small family: chips are quicker than anything with a text box in it.
  if (students.length <= CHIP_LIMIT) {
    return (
      <div className="flex flex-wrap gap-2">
        {students.map((s) => (
          <button
            key={s.id}
            onClick={() => router.push(`/attendance?studentId=${s.id}`)}
            className={`rounded-md border px-3 py-1.5 text-sm font-medium transition-colors ${
              s.id === selectedId ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-accent"
            }`}
          >
            {s.name}
          </button>
        ))}
      </div>
    );
  }

  const selected = students.find((s) => s.id === selectedId);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          placeholder={`Search ${students.length} students…`}
          className="w-64 rounded-md border bg-background p-1.5 text-sm"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {selected && (
          <span className="text-sm text-muted-foreground">
            showing <span className="font-medium text-foreground">{selected.name}</span>
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {matches.map((s) => (
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
        {matches.length === 0 && <span className="text-sm text-muted-foreground">No student matches “{q}”.</span>}
      </div>
      {/* Say when the list is truncated. Silently showing 60 of 900 would read as
          "that pupil isn't here". */}
      {!q && students.length > RESULT_CAP && (
        <p className="text-xs text-muted-foreground">
          Showing the first {RESULT_CAP} of {students.length} — search to narrow.
        </p>
      )}
    </div>
  );
}
