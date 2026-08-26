// =============================================================================
// A document the school erased, still reported as in hand
// =============================================================================
// The right-to-erasure approval was made to reach supplied documents — a child's
// birth certificate, immunisation record, passport photograph — and it does:
// the storage key, the original name and the bytes all go.
//
// What it did NOT do was tell the CONSUMING side. The row kept `status:
// UPLOADED`, and `SATISFYING_STATUSES` treats that as "the school has it". So
// after a school erased a birth certificate at a family's request, its own
// paperwork screen went on reporting the requirement as satisfied — measured
// live — while clicking the row answered "This submission has no file".
//
// Two surfaces disagreeing about one fact, and nobody would ever be asked for
// the document again.
// =============================================================================

import {
  SATISFYING_STATUSES,
  SUBMISSION_STATUSES,
  outstandingRequirements,
  submissionProgress,
} from "@sms/types";

const requirement = {
  id: "req-1",
  key: "birth_certificate",
  label: "Birth certificate",
  mandatory: true,
  active: true,
};

describe("a document erased is not a document held", () => {
  it("has a status of its own, distinct from never having been sent", () => {
    // REJECTED means the school looked and refused it; PENDING means the upload
    // never finished. Neither describes a file the school had and gave up.
    expect(SUBMISSION_STATUSES).toContain("ERASED");
  });

  it("does not satisfy the requirement it once satisfied", () => {
    expect(SATISFYING_STATUSES).not.toContain("ERASED");

    const held = outstandingRequirements([requirement], [
      { requirementId: "req-1", status: "UPLOADED" as const },
    ]);
    expect(held).toEqual([]);

    const erased = outstandingRequirements([requirement], [
      { requirementId: "req-1", status: "ERASED" as const },
    ]);
    expect(erased.map((r) => r.key)).toEqual(["birth_certificate"]);
  });

  it("stops the paperwork reading COMPLETE for a file that is gone", () => {
    const before = submissionProgress([requirement], [
      { requirementId: "req-1", status: "UPLOADED" as const },
    ]);
    expect(before).toMatchObject({ complete: true, missingMandatory: 0 });

    const after = submissionProgress([requirement], [
      { requirementId: "req-1", status: "ERASED" as const },
    ]);
    expect(after).toMatchObject({ complete: false, missingMandatory: 1 });
  });
});
