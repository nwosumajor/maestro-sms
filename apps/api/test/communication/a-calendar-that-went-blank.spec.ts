// =============================================================================
// Five years of finished clubs, and a calendar showing nothing
// =============================================================================
// `listEvents` reads candidate rows `startsAt ASC, take: 500`, then expands each
// recurring series across the requested window. The candidate predicate was:
//
//     OR: [
//       { recurrence: "NONE", startsAt: { gte: from - 30d } },
//       { NOT: { recurrence: "NONE" } },          <- no lower bound at all
//     ]
//
// So EVERY recurring series ever created stayed a candidate for ever, including
// ones whose `recurrenceUntil` passed years ago. Ordered oldest-first, the dead
// series were fetched FIRST, each expanded to zero occurrences, and the budget
// was gone before the query reached anything current.
//
// Measured live on a five-year secondary — 600 weekly clubs, each run for one
// academic year and ended, plus 10 real events inside the window:
//
//     600 dead series -> 0 occurrences    calendar BLANK
//     495 dead series -> 5 occurrences    half the term missing, silently
//     480 dead series -> 10 occurrences   correct
//
// The middle row is the dangerous one. A blank screen at least looks broken; a
// calendar that has quietly dropped half of what the school put in it does not,
// and nothing on the page said a row had been left out.
//
// A series that ended before the window opened cannot produce an occurrence in
// it, so it must never occupy a candidate slot. That is the fix — and because a
// full page and a complete page were indistinguishable, the read now fetches one
// row past the cap and REPORTS truncation.
// =============================================================================

import { EventsService } from "../../src/communication/events.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const head: Principal = {
  schoolId: "A", userId: "head", roles: ["principal"],
  permissions: ["event.read", "event.write"],
};

const DAY = 86_400_000;
const now = Date.now();

type Row = {
  id: string; title: string; description: string | null;
  startsAt: Date; endsAt: Date | null; allDay: boolean; audience: string;
  recurrence: string; recurrenceDays: string[]; recurrenceUntil: Date | null;
  provider: string | null; joinUrl: string | null; createdById: string;
};

/** 600 weekly clubs, each run for an academic year and ENDED. */
const DEAD: Row[] = Array.from({ length: 600 }, (_, i) => {
  const start = new Date(now - (1800 - (i % 5) * 360) * DAY);
  return {
    id: `dead-${i}`, title: `Club ${i}`, description: null,
    startsAt: start, endsAt: new Date(start.getTime() + 3_600_000),
    allDay: false, audience: "ALL",
    recurrence: "WEEKLY", recurrenceDays: ["MON"],
    recurrenceUntil: new Date(start.getTime() + 300 * DAY),
    provider: null, joinUrl: null, createdById: "head",
  };
});

/** This term's actual events — what a school opens the calendar to see. */
const LIVE: Row[] = Array.from({ length: 10 }, (_, i) => {
  const start = new Date(now + (i + 1) * 3 * DAY);
  return {
    id: `live-${i}`, title: `Speech Day ${i}`, description: null,
    startsAt: start, endsAt: new Date(start.getTime() + 7_200_000),
    allDay: false, audience: "ALL",
    recurrence: "NONE", recurrenceDays: [], recurrenceUntil: null,
    provider: null, joinUrl: null, createdById: "head",
  };
});

/** An open-ended weekly assembly: no `until`, so it must ALWAYS qualify. */
const OPEN_ENDED: Row = {
  id: "assembly", title: "Assembly", description: null,
  startsAt: new Date(now - 900 * DAY), endsAt: new Date(now - 900 * DAY + 1_800_000),
  allDay: false, audience: "ALL",
  recurrence: "WEEKLY", recurrenceDays: ["MON"], recurrenceUntil: null,
  provider: null, joinUrl: null, createdById: "head",
};

function makeService(rows: Row[]) {
  // Models the predicate the service actually sends: the `startsAt` bound, the
  // audience, and the recurring branch's `recurrenceUntil` clause. A double
  // that ignored the last one would pass against the defect.
  const match = (where: Record<string, unknown>) => {
    const lte = (where.startsAt as { lte?: Date } | undefined)?.lte;
    const aud = where.audience as string | undefined;
    const or = (where.OR ?? []) as Array<Record<string, unknown>>;
    return rows.filter((r) => {
      if (lte && r.startsAt > lte) return false;
      if (aud && r.audience !== aud) return false;
      if (or.length === 0) return true;
      return or.some((c) => {
        if (c.recurrence === "NONE") {
          if (r.recurrence !== "NONE") return false;
          const gte = (c.startsAt as { gte?: Date } | undefined)?.gte;
          return gte ? r.startsAt >= gte : true;
        }
        if (c.NOT) {
          if (r.recurrence === "NONE") return false;
          const inner = (c.OR ?? []) as Array<Record<string, unknown>>;
          if (inner.length === 0) return true;
          return inner.some((u) => {
            if ("recurrenceUntil" in u && u.recurrenceUntil === null) return r.recurrenceUntil === null;
            const gte = (u.recurrenceUntil as { gte?: Date } | undefined)?.gte;
            return gte ? r.recurrenceUntil !== null && r.recurrenceUntil >= gte : true;
          });
        }
        return false;
      });
    });
  };

  const tx = {
    schoolEvent: {
      findMany: jest.fn(async ({ where, take }: Record<string, never>) => {
        const out = [...match(where)].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
        return take ? out.slice(0, take as number) : out;
      }),
    },
  } as unknown as TenantTx;

  return new EventsService(
    {
      runAsTenant: <T,>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
      runAsTenantReadOnly: <T,>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    } as never,
    { record: jest.fn() } as never,
  );
}

describe("a school five years of finished clubs deep", () => {
  it("STILL SHOWS this term's events — the calendar that went blank", async () => {
    const r = await makeService([...DEAD, ...LIVE]).listEvents(head);
    const speech = r.items.filter((e) => e.title.startsWith("Speech Day"));
    expect(speech).toHaveLength(10);
  });

  it("does not spend the candidate budget on series that ended years ago", async () => {
    // The property: a dead series contributes nothing, so it must not be read.
    const r = await makeService([...DEAD, ...LIVE]).listEvents(head);
    expect(r.items.some((e) => e.title.startsWith("Club"))).toBe(false);
    expect(r.truncated).toBe(false);
  });

  it("keeps an OPEN-ENDED series, which has no `until` to be past", async () => {
    // The filter must exclude finished series WITHOUT excluding the weekly
    // assembly that has simply never been given an end date.
    const r = await makeService([...DEAD, OPEN_ENDED, ...LIVE]).listEvents(head);
    expect(r.items.some((e) => e.title === "Assembly")).toBe(true);
  });

  it("keeps a series that is STILL RUNNING, whose `until` is ahead", async () => {
    const running: Row = {
      ...OPEN_ENDED, id: "running", title: "Choir",
      recurrenceUntil: new Date(now + 200 * DAY),
    };
    const r = await makeService([...DEAD, running, ...LIVE]).listEvents(head);
    expect(r.items.some((e) => e.title === "Choir")).toBe(true);
  });
});

describe("and it never drops a row in silence", () => {
  it("REPORTS truncation when the window really does hold more", async () => {
    // 600 LIVE one-off events inside the window, past the 500 candidate cap.
    const many: Row[] = Array.from({ length: 600 }, (_, i) => ({
      ...LIVE[0], id: `many-${i}`, title: `Event ${i}`,
      startsAt: new Date(now + (i % 100) * DAY),
      endsAt: new Date(now + (i % 100) * DAY + 3_600_000),
    }));
    const r = await makeService(many).listEvents(head);
    expect(r.truncated).toBe(true);
  });

  it("says nothing was dropped when nothing was", async () => {
    // A flag that is always true is a banner nobody reads.
    const r = await makeService(LIVE).listEvents(head);
    expect(r.truncated).toBe(false);
    expect(r.items).toHaveLength(10);
  });
});
