"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

/**
 * Roster search that navigates, so the SERVER does the narrowing.
 *
 * Deliberately a navigation rather than client-side filtering: the roster list is
 * bounded now, so a name outside the current page cannot be found by filtering what
 * the browser already has — it has to be fetched. Filtering locally would look like
 * it worked and quietly fail to find people.
 */
export function StudentSearch({ initial }: { initial: string }) {
  const router = useRouter();
  const [q, setQ] = React.useState(initial);

  const submit = (value: string) => {
    const next = value.trim();
    router.push(next ? `/students?q=${encodeURIComponent(next)}` : "/students");
  };

  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        submit(q);
      }}
    >
      <input
        placeholder="Search by name…"
        className="w-56 rounded-md border bg-background p-1.5 text-sm"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {initial && (
        <button
          type="button"
          className="text-xs text-muted-foreground underline hover:text-foreground"
          onClick={() => {
            setQ("");
            submit("");
          }}
        >
          clear
        </button>
      )}
    </form>
  );
}
