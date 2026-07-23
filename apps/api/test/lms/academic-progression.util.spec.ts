import { pickNextTerm, termHasElapsed, type ProgressionTerm, type ProgressionSession } from "@sms/types";

// Two sessions, three terms each, in creation/chronological order.
const S1: ProgressionSession = { id: "s1", createdAt: "2025-09-01", startDate: "2025-09-01" };
const S2: ProgressionSession = { id: "s2", createdAt: "2026-09-01", startDate: "2026-09-01" };
const SESSIONS = [S2, S1]; // deliberately out of order — the function must sort

const terms = (currentId: string): ProgressionTerm[] => [
  { id: "t1", sessionId: "s1", sequence: 1, isCurrent: currentId === "t1" },
  { id: "t2", sessionId: "s1", sequence: 2, isCurrent: currentId === "t2" },
  { id: "t3", sessionId: "s1", sequence: 3, isCurrent: currentId === "t3" },
  { id: "u1", sessionId: "s2", sequence: 1, isCurrent: currentId === "u1" },
  { id: "u2", sessionId: "s2", sequence: 2, isCurrent: currentId === "u2" },
  { id: "u3", sessionId: "s2", sequence: 3, isCurrent: currentId === "u3" },
];

describe("pickNextTerm", () => {
  it("advances to the next term in the same session", () => {
    expect(pickNextTerm(terms("t1"), SESSIONS)).toEqual({ termId: "t2", sessionId: "s1", newSession: false });
    expect(pickNextTerm(terms("t2"), SESSIONS)).toEqual({ termId: "t3", sessionId: "s1", newSession: false });
  });

  it("crosses into the next session's FIRST term after the last term", () => {
    expect(pickNextTerm(terms("t3"), SESSIONS)).toEqual({ termId: "u1", sessionId: "s2", newSession: true });
  });

  it("returns null at the final term of the last session", () => {
    expect(pickNextTerm(terms("u3"), SESSIONS)).toBeNull();
  });

  it("returns null when there is no current term", () => {
    const none = terms("none");
    expect(pickNextTerm(none, SESSIONS)).toBeNull();
  });

  it("honours an explicit currentTermId over the isCurrent flag", () => {
    expect(pickNextTerm(terms("none"), SESSIONS, "t1")).toEqual({ termId: "t2", sessionId: "s1", newSession: false });
  });

  it("falls back to creation order when NOT every session has a startDate", () => {
    // Mixing one session's startDate with another's createdAt is not a
    // consistent order, so the whole set must fall back to createdAt.
    const s1 = { id: "s1", createdAt: "2025-09-01", startDate: "2025-09-01" };
    const s2 = { id: "s2", createdAt: "2026-09-01" }; // no startDate
    expect(pickNextTerm(terms("t3"), [s2, s1])).toEqual({ termId: "u1", sessionId: "s2", newSession: true });
  });

  it("orders the next session by startDate even when createdAt disagrees", () => {
    const s1 = { id: "s1", createdAt: "2026-01-01", startDate: "2025-09-01" };
    const s2 = { id: "s2", createdAt: "2025-01-01", startDate: "2026-09-01" };
    // startDate says s2 follows s1 (createdAt would wrongly say the opposite).
    expect(pickNextTerm(terms("t3"), [s1, s2])).toEqual({ termId: "u1", sessionId: "s2", newSession: true });
  });
});

describe("termHasElapsed", () => {
  const asOf = new Date("2026-01-15T09:00:00Z");
  it("is false when no end date is set (manual advance only)", () => {
    expect(termHasElapsed(null, asOf)).toBe(false);
    expect(termHasElapsed(undefined, asOf)).toBe(false);
  });
  it("is false on and before the end day (whole end day is still current)", () => {
    expect(termHasElapsed("2026-01-15", asOf)).toBe(false);
    expect(termHasElapsed("2026-01-20", asOf)).toBe(false);
  });
  it("is true once the end day has fully passed", () => {
    expect(termHasElapsed("2026-01-14", asOf)).toBe(true);
    expect(termHasElapsed("2025-12-31", asOf)).toBe(true);
  });
});
