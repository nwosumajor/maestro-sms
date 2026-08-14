// =============================================================================
// PrivacyService.collectStudentBundle — completeness is DECLARED, not assumed
// =============================================================================
// The bundle answers a right-of-access request. It used to cap notification
// history at 100 SILENTLY: the recipient could not tell a complete record from
// a clipped one, and it was the only capped section while attendance beside it
// already shipped every row.
//
// Completeness is now the caller's choice — the per-pupil export passes no
// limit, the operator's 1,000-pupil bulk dump does — and the bundle states
// which it is.
// =============================================================================

import { PrivacyService } from "../../src/privacy/privacy.service";
import type { TenantTx } from "../../src/integrity/integrity.foundation";

const notification = (i: number) => ({ id: `n-${i}`, recipientId: "stu-1", createdAt: new Date() });

function makeTx(notificationCount: number) {
  const findMany = jest.fn().mockImplementation(({ take }: { take?: number } = {}) => {
    const all = Array.from({ length: notificationCount }, (_, i) => notification(i));
    return Promise.resolve(take ? all.slice(0, take) : all);
  });
  return {
    tx: {
      user: { findFirst: jest.fn().mockResolvedValue({ id: "stu-1", name: "Ada", email: "a@s", createdAt: new Date() }) },
      studentProfile: { findFirst: jest.fn().mockResolvedValue({ id: "prof-1" }) },
      emergencyContact: { findMany: jest.fn().mockResolvedValue([]) },
      medicalRecord: { findFirst: jest.fn().mockResolvedValue(null) },
      enrollment: { findMany: jest.fn().mockResolvedValue([]) },
      attendanceRecord: { findMany: jest.fn().mockResolvedValue([]) },
      invoice: { findMany: jest.fn().mockResolvedValue([]) },
      document: { findMany: jest.fn().mockResolvedValue([]) },
      notification: { findMany },
      // GRADES are part of the bundle: a pupil's published results are their own
      // personal data, and the bundle omitted them while reporting complete.
      subjectResult: {
        findMany: jest.fn().mockResolvedValue([
          { id: "r-1", subjectId: "sub-1", termId: "t-1", total: 82, grade: "A", status: "PUBLISHED" },
        ]),
      },
    } as unknown as TenantTx,
    findMany,
  };
}

const svc = () => new PrivacyService({} as never, { record: jest.fn() } as never, {} as never);

describe("collectStudentBundle coverage", () => {
  it("the right-of-access path is COMPLETE — no cap is applied at all", async () => {
    const { tx, findMany } = makeTx(250);
    const b = await svc().collectStudentBundle(tx, "stu-1", { schoolId: "A", includeMedical: true });
    expect(b.notifications).toHaveLength(250); // was silently 100
    expect(findMany.mock.calls[0][0].take).toBeUndefined();
    expect(b.coverage.complete).toBe(true);
    expect(b.coverage.note).toMatch(/complete and untruncated/i);
  });

  it("the bulk path bounds the history AND says so", async () => {
    const { tx } = makeTx(250);
    const b = await svc().collectStudentBundle(tx, "stu-1", {
      schoolId: "A",
      includeMedical: true,
      notificationLimit: 100,
    });
    expect(b.notifications).toHaveLength(100);
    expect(b.coverage.complete).toBe(false);
    expect(b.coverage.note).toMatch(/limited to the 100 most recent/i);
  });

  // A flag that cries wolf gets ignored. A limit that was never reached means
  // this IS everything, so the bundle may still call itself complete.
  it("a limit that was NOT reached still reports complete", async () => {
    const { tx } = makeTx(12);
    const b = await svc().collectStudentBundle(tx, "stu-1", {
      schoolId: "A",
      includeMedical: true,
      notificationLimit: 100,
    });
    expect(b.notifications).toHaveLength(12);
    expect(b.coverage.complete).toBe(true);
  });

  // "medical": "(not included)" is ambiguous on its own — no record, or no
  // permission to read one? The flag follows the PERMISSION.
  it("distinguishes 'no permission to read medical' from 'no medical record'", async () => {
    const { tx } = makeTx(1);
    const denied = await svc().collectStudentBundle(tx, "stu-1", { schoolId: "A", includeMedical: false });
    expect(denied.coverage.medicalIncluded).toBe(false);
    expect(denied.coverage.note).toMatch(/not a statement that the pupil has no medical record/i);

    const allowed = await svc().collectStudentBundle(tx, "stu-1", { schoolId: "A", includeMedical: true });
    expect(allowed.coverage.medicalIncluded).toBe(true);
  });
});

describe("what the bundle declares about itself", () => {
  it("carries the pupil's published grades", async () => {
    // Added after the bundle was found to omit them entirely while its coverage
    // block said `complete: true` — which a recipient reads as "everything".
    const { tx } = makeTx(1);
    const b = await svc().collectStudentBundle(tx, "stu-1", { schoolId: "A", includeMedical: true });
    expect(b.grades).toHaveLength(1);
  });

  it("lists its sections and its exclusions", async () => {
    const { tx } = makeTx(1);
    const b = await svc().collectStudentBundle(tx, "stu-1", { schoolId: "A", includeMedical: true });
    expect(b.coverage.sections).toContain("grades");
    // The omission that is DELIBERATE is named, with a reason and a next step,
    // rather than being indistinguishable from an oversight.
    expect(b.coverage.excluded.map((e) => e.section)).toContain("integritySignals");
    expect(b.coverage.excluded[0].reason).toMatch(/data controller/);
  });
});
