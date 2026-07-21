"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { SearchHitDto, SearchResultDto, Serialized } from "@sms/types";

const KIND_LABEL: Record<string, string> = { student: "Student", staff: "Staff", class: "Class", invoice: "Invoice" };

// In-tenant "jump to" omnibox in the app header. Debounced; results are already
// permission- and relationship-scoped server-side. Keyboard: ↑/↓ to move,
// Enter to open, Esc to close.
export function GlobalSearch() {
  const router = useRouter();
  const [q, setQ] = React.useState("");
  const [hits, setHits] = React.useState<Serialized<SearchHitDto>[]>([]);
  const [open, setOpen] = React.useState(false);
  const [active, setActive] = React.useState(0);
  const boxRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (q.trim().length < 2) {
      setHits([]);
      return;
    }
    const id = setTimeout(async () => {
      const res = await fetch(`/api/sms/search?q=${encodeURIComponent(q)}`, { cache: "no-store" });
      if (res.ok) {
        const data = (await res.json()) as Serialized<SearchResultDto>;
        setHits(data.hits);
        setActive(0);
        setOpen(true);
      }
    }, 250);
    return () => clearTimeout(id);
  }, [q]);

  React.useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const go = (h: Serialized<SearchHitDto>) => {
    setOpen(false);
    setQ("");
    router.push(h.href);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, hits.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter" && hits[active]) {
      go(hits[active]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div ref={boxRef} className="relative hidden md:block">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={onKey}
        onFocus={() => q.trim().length >= 2 && setOpen(true)}
        placeholder="Search students, staff, classes, invoices…"
        className="h-8 w-64 rounded-full border border-border/70 bg-background/60 px-3 text-sm outline-none focus:w-80 focus:border-primary/60"
      />
      {open && hits.length > 0 && (
        <div className="absolute right-0 z-40 mt-1 w-80 overflow-hidden rounded-lg border bg-card shadow-lg">
          {hits.map((h, i) => (
            <button
              key={`${h.kind}-${h.id}`}
              onClick={() => go(h)}
              onMouseEnter={() => setActive(i)}
              className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm ${i === active ? "bg-primary/10" : ""}`}
            >
              <span className="min-w-0">
                <span className="block truncate font-medium">{h.title}</span>
                {h.subtitle && <span className="block truncate text-xs text-muted-foreground">{h.subtitle}</span>}
              </span>
              <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[0.65rem] text-muted-foreground">
                {KIND_LABEL[h.kind] ?? h.kind}
              </span>
            </button>
          ))}
        </div>
      )}
      {open && q.trim().length >= 2 && hits.length === 0 && (
        <div className="absolute right-0 z-40 mt-1 w-80 rounded-lg border bg-card px-3 py-2 text-sm text-muted-foreground shadow-lg">
          No matches.
        </div>
      )}
    </div>
  );
}
