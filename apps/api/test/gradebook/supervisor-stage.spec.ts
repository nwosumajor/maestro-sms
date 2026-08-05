// =============================================================================
// supervisorStage — did stage 1 actually happen?
// =============================================================================
// A class with no supervisor sends a subject selection straight to
// PENDING_ADMIN. That fail-open is deliberate — a pupil must never be stranded
// by an unconfigured class — but it was INVISIBLE: PENDING_ADMIN looked
// identical whether a form teacher had passed it or whether there was never a
// form teacher, and the difference is whether the person about to approve is
// the second check or the only one.
//
// Derived, never stored, so it cannot drift from the row it describes.
// =============================================================================

import { supervisorStage } from "@sms/types";

const row = (over: Partial<{ status: string; supervisorId: string | null; supervisorActedById: string | null }> = {}) => ({
  status: "PENDING_ADMIN",
  supervisorId: "sup1",
  supervisorActedById: "sup1",
  ...over,
});

describe("supervisorStage", () => {
  it("PENDING while it sits in the supervisor's queue", () => {
    expect(supervisorStage(row({ status: "PENDING_SUPERVISOR", supervisorActedById: null }))).toBe("PENDING");
  });

  it("PASSED when the named supervisor acted", () => {
    expect(supervisorStage(row())).toBe("PASSED");
  });

  it("SKIPPED when the class had no supervisor at submission", () => {
    expect(supervisorStage(row({ supervisorId: null, supervisorActedById: null }))).toBe("SKIPPED_NO_SUPERVISOR");
  });

  it("SKIPPED when a supervisor was named but never acted", () => {
    // The supervisor can change after submission. The row then carries a name
    // that never reviewed anything — reporting that as PASSED would credit a
    // check nobody performed, which is worse than reporting none at all.
    expect(supervisorStage(row({ supervisorId: "sup1", supervisorActedById: null }))).toBe("SKIPPED_NO_SUPERVISOR");
  });

  it("reports the stage on a finished selection too", () => {
    // The audit question "was this two-eyes or one?" is asked AFTER approval far
    // more often than during it.
    expect(supervisorStage(row({ status: "APPROVED" }))).toBe("PASSED");
    expect(supervisorStage(row({ status: "APPROVED", supervisorId: null, supervisorActedById: null }))).toBe(
      "SKIPPED_NO_SUPERVISOR",
    );
  });

  it("a REJECTED selection still says who checked it", () => {
    expect(supervisorStage(row({ status: "REJECTED" }))).toBe("PASSED");
  });

  it("nobody named, yet somebody recorded as acting -> SKIPPED, not PASSED", () => {
    // Inconsistent data: no supervisor on the class, but an acted-by id. It
    // should not be reachable, which is exactly why the answer matters — the
    // safe reading of a contradiction is "no check happened", never "a check
    // happened". Without this case the `!supervisorId` branch is untested and
    // deleting it changes nothing, which is how a guard quietly becomes dead.
    expect(supervisorStage(row({ supervisorId: null, supervisorActedById: "someone" }))).toBe(
      "SKIPPED_NO_SUPERVISOR",
    );
  });
});
