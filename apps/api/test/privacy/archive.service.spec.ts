// =============================================================================
// The year archive — what makes it usable in ten years, and safe today
// =============================================================================
// Its whole purpose is to answer a question nobody has asked yet, long after the
// people and the software have moved on. That imposes properties an ordinary
// export does not have:
//
//   • SALARIES ARE DECRYPTED INTO IT. Field encryption uses a key that may be
//     rotated or lost in a decade; an archive of ciphertext is unreadable
//     precisely when it is needed. The artifact is gated hard instead.
//   • IT SAYS WHEN IT IS INCOMPLETE. A capped section is named in the manifest,
//     because an archive believed to be whole is worse than one known to be partial.
//   • IT IS CHECKSUMMED. An archive someone could have altered is worth little in
//     an investigation, so the hash is recorded and handed back on retrieval.
//   • THE DOWNLOAD IS AUDITED BEFORE THE LINK EXISTS. Once a presigned URL is
//     minted the fetch can happen anywhere; the record of who asked cannot wait
//     on whether they went through with it.
// =============================================================================

import { createHash } from "node:crypto";
import { SchoolArchiveService } from "../../src/privacy/archive.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const SCHOOL = "s-1";
const head: Principal = {
  schoolId: SCHOOL,
  userId: "u-head",
  roles: ["principal"],
  permissions: ["privacy.archive.manage"],
};

function makeService(over: { rows?: Record<string, unknown[]>; employees?: unknown[] } = {}) {
  const rows = over.rows ?? {};
  const table = (name: string) => ({
    findMany: jest.fn(async ({ skip = 0, take = 1000 }: { skip?: number; take?: number }) =>
      (rows[name] ?? []).slice(skip, skip + take),
    ),
  });
  const created: Array<Record<string, unknown>> = [];
  const tx = {
    user: table("user"),
    studentProfile: table("studentProfile"),
    enrollment: table("enrollment"),
    attendanceRecord: table("attendanceRecord"),
    subjectResult: table("subjectResult"),
    invoice: table("invoice"),
    workflowRequest: table("workflowRequest"),
    auditLog: table("auditLog"),
    employee: { findMany: jest.fn(async () => over.employees ?? []) },
    payrollRun: table("payrollRun"),
    schoolArchive: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: "a-1", createdAt: new Date("2026-08-02"), ...data };
      }),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue({
        id: "a-1", storageKey: "schools/s-1/archives/x.json", checksum: "abc123", label: "2025/2026",
      }),
    },
  } as unknown as TenantTx;

  const db = {
    runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const uploads: Array<{ key: string; body: Buffer }> = [];
  const storage = {
    upload: jest.fn(async (a: { key: string; body: Buffer }) => void uploads.push(a)),
    presignDownload: jest.fn().mockResolvedValue({ url: "https://signed.example/x" }),
  };
  const svc = new SchoolArchiveService(db as never, audit as never, storage as never);
  return { svc, tx, audit, storage, uploads, created };
}

const bundleOf = (uploads: Array<{ body: Buffer }>) => JSON.parse(uploads[0].body.toString("utf8"));

describe("producing an archive", () => {
  it("stores a checksummed object and records the hash", async () => {
    const { svc, uploads, created } = makeService();
    const out = await svc.create(head, { label: "2025/2026" });
    const expected = createHash("sha256").update(uploads[0].body).digest("hex");
    expect(out.checksum).toBe(expected);
    expect(created[0].checksum).toBe(expected);
    expect(created[0].sizeBytes).toBe(uploads[0].body.length);
  });

  it("DECRYPTS staff salaries into the bundle, and drops the ciphertext", async () => {
    // Ciphertext in a ten-year archive is unreadable exactly when it is needed,
    // because the key may be long rotated. The plaintext goes in and the artifact
    // is gated instead — which is why the download is step-up'd too.
    const { svc, uploads } = makeService({
      employees: [{ id: "e-1", userId: "u-1", salaryEnc: "cipher", phoneEnc: "cipher2" }],
    });
    await svc.create(head, { label: "2025/2026" });
    const staff = bundleOf(uploads).staff[0];
    expect(Object.keys(staff)).not.toContain("salaryEnc");
    expect(Object.keys(staff)).not.toContain("phoneEnc");
    expect(staff).toHaveProperty("salary");
    expect(staff).toHaveProperty("phone");
  });

  it("renames an EMPTY encrypted field too, so the shape is consistent", async () => {
    // A null that kept its `Enc` suffix would leave two shapes for one field, and
    // a reader in ten years cannot tell "empty" from "still encrypted".
    const { svc, uploads } = makeService({
      employees: [{ id: "e-1", salaryEnc: "cipher", phoneEnc: null, addressEnc: "" }],
    });
    await svc.create(head, { label: "2025/2026" });
    const staff = bundleOf(uploads).staff[0];
    expect(Object.keys(staff).filter((k) => k.endsWith("Enc"))).toEqual([]);
    expect(staff.phone).toBeNull();
    expect(staff.address).toBeNull();
  });

  it("says so in the manifest, loudly, that it holds staff PII", async () => {
    // Whoever opens this in a decade must know what is in it BEFORE forwarding it.
    const { svc, uploads, created } = makeService();
    await svc.create(head, { label: "2025/2026" });
    expect(String(bundleOf(uploads).manifest.contains)).toMatch(/salaries/i);
    expect(created[0].containsHrPii).toBe(true);
  });

  it("NAMES a section it had to truncate", async () => {
    // An archive believed to be complete is worse than one known to be partial.
    const { svc, uploads } = makeService({
      rows: { attendanceRecord: Array.from({ length: 200_500 }, (_, i) => ({ id: i })) },
    });
    await svc.create(head, { label: "2025/2026" });
    expect(bundleOf(uploads).manifest.truncatedSections).toContain("attendance");
  });

  it("reports every section's row count, so an empty archive is visible", async () => {
    const { svc, uploads, created } = makeService({
      rows: { user: [{ id: "st-1" }, { id: "st-2" }], invoice: [{ id: "i-1" }] },
    });
    await svc.create(head, { label: "2025/2026" });
    expect(bundleOf(uploads).manifest.sectionCounts).toMatchObject({ students: 2, invoices: 1, attendance: 0 });
    expect(created[0].sections).toMatchObject({ students: 2 });
  });

  it("audits the creation with counts, never with contents", async () => {
    const { svc, audit } = makeService({
      employees: [{ id: "e-1", salaryEnc: "cipher" }],
      rows: { user: [{ id: "st-1", name: "A Pupil" }] },
    });
    await svc.create(head, { label: "2025/2026" });
    const entry = (audit.record as jest.Mock).mock.calls[0][0];
    expect(entry.action).toBe("privacy.archive.create");
    expect(JSON.stringify(entry.metadata)).not.toContain("A Pupil");
    expect(entry.metadata).toMatchObject({ label: "2025/2026" });
  });

  it("refuses a blank label — it is how a human finds this in ten years", async () => {
    const { svc } = makeService();
    await expect(svc.create(head, { label: "   " })).rejects.toThrow(/label/i);
  });
});

describe("retrieving one", () => {
  it("audits BEFORE minting the link", async () => {
    // Once the URL exists the download can happen anywhere and we will not see
    // it. The record of who asked cannot depend on them going through with it.
    const order: string[] = [];
    const { svc, audit, storage } = makeService();
    (audit.record as jest.Mock).mockImplementation(async () => void order.push("audit"));
    (storage.presignDownload as jest.Mock).mockImplementation(async () => {
      order.push("presign");
      return { url: "https://signed.example/x" };
    });
    await svc.download(head, "a-1");
    expect(order).toEqual(["audit", "presign"]);
  });

  it("hands back the checksum, so the bytes can be proven unaltered", async () => {
    const { svc } = makeService();
    await expect(svc.download(head, "a-1")).resolves.toMatchObject({ checksum: "abc123" });
  });

  it("404s an archive that is not this school's", async () => {
    const { svc, tx } = makeService();
    (tx.schoolArchive.findFirst as jest.Mock).mockResolvedValue(null);
    await expect(svc.download(head, "someone-elses")).rejects.toThrow(/not found/i);
  });
});
