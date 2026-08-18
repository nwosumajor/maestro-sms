// =============================================================================
// What a family or a new member of staff still owes the school
// =============================================================================
// The outstanding list is DERIVED — requirements minus what has arrived — and
// never stored. A stored per-person checklist drifts the moment the school edits
// its requirements, and a registrar then works from a list that no longer says
// what the school actually asks for. Switching a requirement off has to stop it
// being outstanding everywhere, at once, and this is what makes that true.
//
// These are the rules every screen in the module will read, so they are pinned
// before any of it is built.
// =============================================================================

import {
  outstandingRequirements,
  submissionProgress,
  defaultRequirements,
  SATISFYING_STATUSES,
  type SubmissionStatus,
} from "@sms/types";

const req = (id: string, opts: Partial<{ mandatory: boolean; active: boolean }> = {}) => ({
  id,
  key: id,
  label: id,
  mandatory: opts.mandatory ?? true,
  active: opts.active ?? true,
});

const sub = (requirementId: string | null, status: SubmissionStatus) => ({ requirementId, status });

describe("what is still outstanding", () => {
  it("counts a requirement nothing has arrived for", () => {
    const out = outstandingRequirements([req("birth_cert"), req("photo")], [sub("photo", "UPLOADED")]);
    expect(out.map((r) => r.id)).toEqual(["birth_cert"]);
  });

  it("treats an UPLOADED file as satisfying, before anyone has checked it", () => {
    // Deliberate: the family has done their part. Chasing them again while the
    // file sits unverified in the office is how a school loses their goodwill.
    expect(outstandingRequirements([req("a")], [sub("a", "UPLOADED")])).toEqual([]);
  });

  it("does NOT let a REJECTED file satisfy anything", () => {
    // The failure this prevents: a photograph of somebody's thumb marked
    // received, and a pupil enrolled with no birth certificate on file.
    expect(outstandingRequirements([req("a")], [sub("a", "REJECTED")]).map((r) => r.id)).toEqual(["a"]);
  });

  it("lets a WAIVED requirement close", () => {
    // A birth certificate lost in a flood, with a sworn declaration accepted
    // instead, is an ordinary week in a school office. Without this the list
    // can never reach zero and stops being read at all.
    expect(outstandingRequirements([req("a")], [sub("a", "WAIVED")])).toEqual([]);
  });

  it("ignores a PENDING upload — the bytes may never arrive", () => {
    // PENDING means a presigned URL was handed out. The browser may have closed
    // mid-upload; nothing has been confirmed to exist.
    expect(outstandingRequirements([req("a")], [sub("a", "PENDING")]).map((r) => r.id)).toEqual(["a"]);
  });

  it("drops a requirement the school has switched off", () => {
    expect(outstandingRequirements([req("a", { active: false }), req("b")], [])).toEqual([
      expect.objectContaining({ id: "b" }),
    ]);
  });

  it("ignores a file supplied outside the asked-for list", () => {
    // "Anything else you think we should see" is welcome, and satisfies nothing.
    expect(outstandingRequirements([req("a")], [sub(null, "VERIFIED")]).map((r) => r.id)).toEqual(["a"]);
  });

  it("agrees with the statuses it publishes as satisfying", () => {
    // The constant and the behaviour must not drift apart.
    for (const status of SATISFYING_STATUSES) {
      expect(outstandingRequirements([req("a")], [sub("a", status)])).toEqual([]);
    }
  });
});

describe("the summary a dashboard shows", () => {
  it("counts only MANDATORY gaps as chaseable", () => {
    const p = submissionProgress([req("a"), req("b", { mandatory: false })], []);
    expect(p).toMatchObject({ required: 2, satisfied: 0, missingMandatory: 1 });
  });

  it("is COMPLETE while only optional items are missing", () => {
    // An optional immunisation record must not keep a pupil's file looking
    // unfinished for ever — that is how staff learn to ignore the indicator.
    const p = submissionProgress([req("a"), req("b", { mandatory: false })], [sub("a", "VERIFIED")]);
    expect(p.complete).toBe(true);
    expect(p.satisfied).toBe(1);
  });

  it("is not complete while a mandatory one is missing", () => {
    expect(submissionProgress([req("a")], []).complete).toBe(false);
  });

  it("is complete for a school that asks for nothing", () => {
    expect(submissionProgress([], []).complete).toBe(true);
  });

  it("does not count switched-off requirements as required", () => {
    const p = submissionProgress([req("a", { active: false })], []);
    expect(p).toMatchObject({ required: 0, missingMandatory: 0, complete: true });
  });
});

describe("the list a school starts with", () => {
  it("asks for little, and marks most of it optional", () => {
    // A long mandatory list at admission is how a school ends up holding
    // documents it never looks at, and how a family gives up half way.
    const student = defaultRequirements("STUDENT_ADMISSION");
    expect(student.length).toBeLessThanOrEqual(6);
    expect(student.filter((r) => r.mandatory).length).toBeLessThanOrEqual(2);
  });

  it("gives both flows distinct, non-empty keys", () => {
    for (const scope of ["STUDENT_ADMISSION", "STAFF_ONBOARDING"] as const) {
      const keys = defaultRequirements(scope).map((r) => r.key);
      expect(keys.length).toBeGreaterThan(0);
      expect(new Set(keys).size).toBe(keys.length);
      expect(keys.every((k) => /^[a-z0-9_]+$/.test(k))).toBe(true);
    }
  });

  it("marks the staff documents that expire", () => {
    // A teaching licence and an ID both run out; the reminder path already
    // exists for staff_document.expiresAt and this is what feeds it.
    const staff = defaultRequirements("STAFF_ONBOARDING");
    expect(staff.filter((r) => r.needsExpiry).map((r) => r.key).sort()).toEqual([
      "identity_document",
      "teaching_licence",
    ]);
  });
});
