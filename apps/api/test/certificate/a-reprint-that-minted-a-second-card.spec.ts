// =============================================================================
// CertificateService.issue — a reprint reprints; it does not mint a second card
// =============================================================================
// `issueForClass` promises, in its own words, that a pupil who already holds a
// certificate type is "skipped, never re-serialled", because "a certificate is a
// document a school stands behind". The console's documented flow then walks
// straight past that promise: it bulk-registers a class and PRINTS each card by
// POSTing to `issue` with no title and no body — which created a fresh row with a
// fresh serial, every press.
//
// Measured live on a class of 20 before the fix: bulk-register, and each pupil
// held one card; press print, and that pupil held two with different serials;
// press again, three. The serial the bulk run registered was printed on nothing,
// and `history` — the surface a school verifies a document against — listed
// several serials for one physical card with no way to tell which was real.
//
// Two properties are pinned here:
//   1. a plain reprint reuses the registered certificate and its serial;
//   2. a caller who names a DIFFERENT award still gets a distinct certificate.
// Plus the serial generator itself, whose two copies had drifted apart.
// =============================================================================

import { CertificateService } from "../../src/certificate/certificate.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const staff: Principal = { schoolId: "A", userId: "issuer", roles: ["school_admin"], permissions: ["certificate.issue"] };

/** A tx double that models the CONTRACT: certificates persist between calls. */
function harness(seed: Array<{ subjectId: string; type: string; serial: string; createdAt: Date }> = []) {
  const rows = [...seed];
  const audit: Array<{ action: string; entityId: string }> = [];
  const tx = {
    user: {
      findFirst: jest.fn().mockResolvedValue({
        id: "s1", name: "Adaeze Okafor", email: "a@x.school", uniqueId: "STU-001",
        roles: [{ role: { name: "student" } }],
      }),
      findMany: jest.fn().mockResolvedValue([
        { id: "s1", name: "Adaeze" },
        { id: "s2", name: "Bello" },
        { id: "s3", name: "Chidi" },
      ]),
    },
    school: { findFirst: jest.fn().mockResolvedValue({ name: "St Andrews", address: "1 Road" }) },
    class: { findFirst: jest.fn().mockResolvedValue({ id: "c1", name: "JSS2B" }) },
    schoolBranding: { findFirst: jest.fn().mockResolvedValue(null) },
    enrollment: {
      findFirst: jest.fn().mockResolvedValue({ status: "ACTIVE" }),
      findMany: jest.fn().mockResolvedValue([{ studentId: "s1" }, { studentId: "s2" }, { studentId: "s3" }]),
    },
    studentProfile: { findFirst: jest.fn().mockResolvedValue({ admissionNumber: "SA/001" }) },
    invoice: { findMany: jest.fn().mockResolvedValue([]), aggregate: jest.fn().mockResolvedValue({ _sum: {} }) },
    payment: { findMany: jest.fn().mockResolvedValue([]) },
    bookLoan: { findMany: jest.fn().mockResolvedValue([]) },
    issuedCertificate: {
      findFirst: jest.fn(async ({ where }: { where: { subjectId: string; type: string } }) =>
        rows.filter((r) => r.subjectId === where.subjectId && r.type === where.type)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0] ?? null,
      ),
      findMany: jest.fn(async ({ where }: { where?: { subjectId?: { in: string[] }; type?: string } } = {}) =>
        rows.filter(
          (r) =>
            (where?.subjectId?.in ? where.subjectId.in.includes(r.subjectId) : true) &&
            (where?.type ? r.type === where.type : true),
        ),
      ),
      create: jest.fn(async ({ data }: { data: { subjectId: string; type: string; serial: string } }) => {
        // UNIQUE(serial), as the database now enforces it.
        if (rows.some((r) => r.serial === data.serial)) throw new Error("duplicate serial");
        rows.push({ ...data, createdAt: new Date() });
        return data;
      }),
      createMany: jest.fn(async ({ data }: { data: Array<{ subjectId: string; type: string; serial: string }> }) => {
        for (const d of data) rows.push({ ...d, createdAt: new Date() });
        return { count: data.length };
      }),
    },
  };
  const db = {
    runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx as unknown as TenantTx),
    runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx as unknown as TenantTx),
  };
  const svc = new CertificateService(
    db as never,
    { record: jest.fn(async (e: { action: string; entityId: string }) => { audit.push(e); }) } as never,
    { getLogoBytes: jest.fn().mockResolvedValue(null) } as never,
  );
  return { svc, tx, rows, audit };
}

describe("a reprint reprints", () => {
  it("REUSES the registered certificate and its serial — three presses, one card", async () => {
    const { svc, rows } = harness();
    await svc.issue(staff, { type: "ID_CARD", subjectId: "s1" });
    expect(rows).toHaveLength(1);
    const serial = rows[0].serial;

    await svc.issue(staff, { type: "ID_CARD", subjectId: "s1" });
    await svc.issue(staff, { type: "ID_CARD", subjectId: "s1" });

    // The pupil holds ONE card, and every reprint carried the SAME serial.
    expect(rows).toHaveLength(1);
    expect(rows[0].serial).toBe(serial);
  });

  it("reprints the serial the BULK run registered, so the class register matches the cards", async () => {
    const { svc, rows } = harness();
    await svc.issueForClass(staff, { classId: "c1", type: "ID_CARD" });
    // issueForClass's own stubs: three pupils, one of whom we then print.
    const registered = rows.find((r) => r.subjectId === "s1");
    expect(registered).toBeDefined();

    await svc.issue(staff, { type: "ID_CARD", subjectId: "s1" });
    const held = rows.filter((r) => r.subjectId === "s1" && r.type === "ID_CARD");
    expect(held).toHaveLength(1);
    expect(held[0].serial).toBe(registered!.serial);
  });

  it("records a reprint AS a reprint — a document still left the building", async () => {
    const { svc, audit } = harness();
    await svc.issue(staff, { type: "ID_CARD", subjectId: "s1" });
    await svc.issue(staff, { type: "ID_CARD", subjectId: "s1" });
    expect(audit.map((a) => a.action)).toEqual(["certificate.issue", "certificate.reprint"]);
    // Both name the same document.
    expect(new Set(audit.map((a) => a.entityId)).size).toBe(1);
  });

  it("a DIFFERENT award is still its own certificate with its own serial", async () => {
    const { svc, rows } = harness();
    await svc.issue(staff, { type: "MERIT", subjectId: "s1", title: "Best in Mathematics" });
    await svc.issue(staff, { type: "MERIT", subjectId: "s1", title: "Best in Science" });
    const merits = rows.filter((r) => r.type === "MERIT");
    expect(merits).toHaveLength(2);
    expect(new Set(merits.map((r) => r.serial)).size).toBe(2);
  });
});

describe("the serial generator", () => {
  // The two paths generated a serial SEPARATELY and had drifted: the bulk path
  // used a uuid and carried the comment explaining why, while the single-issue
  // path — the one that prints the document — still used a 4-character
  // Math.random suffix, a space 2,557x smaller drawn from a non-CSPRNG.
  const suffix = (s: string) => s.split("-").pop() ?? "";

  it("gives BOTH paths the same shape of suffix", async () => {
    const single = harness();
    await single.svc.issue(staff, { type: "ID_CARD", subjectId: "s1" });
    const fromIssue = suffix(single.rows[0].serial);

    const bulk = harness();
    await bulk.svc.issueForClass(staff, { classId: "c1", type: "ID_CARD" });
    const fromBulk = suffix(bulk.rows[0].serial);

    expect(fromIssue).toHaveLength(fromBulk.length);
    // Anchored to the PROPERTY (8 hex characters of CSPRNG), not to the text of
    // either implementation.
    expect(fromIssue).toMatch(/^[0-9A-F]{8}$/);
    expect(fromBulk).toMatch(/^[0-9A-F]{8}$/);
  });

  it("does not collide across a bulk insert, where Date.now() is identical", async () => {
    const { svc, rows } = harness();
    await svc.issueForClass(staff, { classId: "c1", type: "COMPLETION" });
    expect(new Set(rows.map((r) => r.serial)).size).toBe(rows.length);
  });
});
