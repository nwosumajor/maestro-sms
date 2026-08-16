// =============================================================================
// Four places that counted, then inserted
// =============================================================================
// A capacity check is a read followed by a write, and on its own that is a race:
// two callers both read "there is one place left" and both take it. The codebase
// already knew this and had solved it eight times — hostel allocation locks the
// ROOM row before counting beds, the invoice ledger locks the INVOICE before
// posting, the ring and race games lock the GAME. The comment on the hostel one
// spells the reasoning out.
//
// Four capacity checks never got it:
//
//   class enrolment      a class of thirty could end up with more
//   class promotion      two batches landing on one class both fit
//   transport route      two pupils take the last seat on the bus
//   appointment slot     two parents book the last half-hour
//
// The class one is not hypothetical: the bulk enrolment form added in #223 sends
// a whole staged list in ONE request, so a double-click is two batches of
// twenty-four arriving together, each seeing an empty class of thirty. That form
// made an existing race easy to hit, which is a good reason to fix it in the
// same breath.
//
// The meeting file is worth its own note: its header said the slot was "claimed
// atomically — an optimistic capacity check under updateMany semantics", and the
// code underneath was a plain count-then-insert. A file that says it is safe is
// a file nobody re-reads. The header now describes what is actually there.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = (rel: string) => readFileSync(join(__dirname, "../../src", rel), "utf8");
const LMS = SRC("lms/lms.service.ts");
const PROMOTION = SRC("lms/promotion.service.ts");
const TRANSPORT = SRC("transport/transport.service.ts");
const MEETING = SRC("meeting/meeting.service.ts");
const HOSTEL = SRC("hostel/hostel.service.ts");

/** The lock must come BEFORE the count it protects, or it protects nothing. */
function locksBeforeCounting(src: string, anchor: string, table: string, counted: string): boolean {
  const from = src.indexOf(anchor);
  if (from < 0) return false;
  const window = src.slice(from, from + 1400);
  const lock = window.indexOf(`FROM "${table}"`);
  const count = window.indexOf(counted);
  return lock > -1 && count > -1 && lock < count;
}

describe("every capacity check locks the contended row first", () => {
  it("class enrolment locks the class", () => {
    expect(locksBeforeCounting(LMS, "private async assertCapacity(", "class", "enrollment.count")).toBe(true);
  });

  it("class promotion locks the class", () => {
    expect(locksBeforeCounting(PROMOTION, "capacity: true, name: true", "class", "enrollment.count")).toBe(true);
  });

  it("a transport route locks the route", () => {
    expect(locksBeforeCounting(TRANSPORT, "Seat availability:", "transport_route", "transportAssignment.count")).toBe(true);
  });

  it("an appointment slot locks the slot", () => {
    expect(locksBeforeCounting(MEETING, 'kind ?? "APPOINTMENT") === "APPOINTMENT"', "meeting_slot", "meetingBooking.count")).toBe(
      true,
    );
  });

  it("the pattern they follow is the hostel one, unchanged", () => {
    expect(locksBeforeCounting(HOSTEL, "Serialize concurrent allocations", "hostel_room", "hostelAllocation.count")).toBe(true);
  });
});

describe("what deliberately stays unlocked", () => {
  it("a class with NO capacity takes no lock", () => {
    // Unlimited means there is nothing to serialise, and locking every enrolment
    // into every uncapped class would be contention bought for nothing.
    const fn = LMS.slice(LMS.indexOf("private async assertCapacity("), LMS.indexOf("private async assertCapacity(") + 1600);
    expect(fn.indexOf("return; // unlimited")).toBeLessThan(fn.indexOf("FOR UPDATE"));
  });

  it("a BRIEFING slot still claims nothing", () => {
    // Two thousand parents answering one whole-school notice must not serialise
    // into a queue — the existing comment explains it, and this keeps it true.
    const book = MEETING.slice(MEETING.indexOf("async book("), MEETING.indexOf("async book(") + 3000);
    const guard = book.indexOf('=== "APPOINTMENT"');
    const lock = book.indexOf('FROM "meeting_slot"');
    expect(guard).toBeGreaterThan(-1);
    expect(lock).toBeGreaterThan(guard); // inside the appointment branch, not before it
  });

  it("a route with no stated capacity takes no lock", () => {
    expect(TRANSPORT).toMatch(/if \(capacity > 0\) \{\s*await tx\.\$executeRaw/);
  });
});

describe("the comment that described a guard which was not there", () => {
  it("no longer claims an updateMany claim the code never made", () => {
    expect(MEETING).not.toMatch(/optimistic capacity check under updateMany semantics prevents/);
  });

  it("says what is actually there", () => {
    expect(MEETING).toMatch(/locked FOR UPDATE before the capacity count/);
  });
});
