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
import { SYSTEM_ACTOR_ID } from "../../src/billing/billing.constants";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const SCHOOL = "s-1";
const head: Principal = {
  schoolId: SCHOOL,
  userId: "u-head",
  roles: ["principal"],
  permissions: ["privacy.archive.manage"],
};

function makeService(over: { rows?: Record<string, unknown[]>; employees?: unknown[]; terms?: unknown[]; existing?: unknown[] } = {}) {
  const rows = over.rows ?? {};
  const table = (name: string) => ({
    findMany: jest.fn(async ({ skip = 0, take = 1000 }: { skip?: number; take?: number }) =>
      (rows[name] ?? []).slice(skip, skip + take),
    ),
  });
  const created: Array<Record<string, unknown>> = [];
  const tx = {
    // `windowFor` resolves, IN THE TENANT TX, the term or session the archive
    // names — that is what bounds the sections to it instead of dumping the
    // whole school under a term's label.
    term: {
      findFirst: jest.fn(async ({ where }: { where: { id: string } }) => {
        const t = ((over as { terms?: Array<Record<string, unknown>> }).terms ?? []).find((x) => x.id === where.id);
        return t ?? { name: "First Term", startDate: new Date("2025-09-01"), endDate: new Date("2026-01-01") };
      }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    academicSession: {
      findFirst: jest.fn().mockResolvedValue({
        name: "2025/26",
        startDate: new Date("2025-09-01"),
        endDate: new Date("2026-07-31"),
      }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    user: table("user"),
    studentProfile: table("studentProfile"),
    enrollment: table("enrollment"),
    // Attendance is walked BY MONTH now, not by OFFSET — the partition key
    // prunes each read to one partition instead of re-sorting the whole table
    // on every page. The stub answers the month bounds and then returns the
    // rows for the (single) month, which is what the real one does.
    attendanceRecord: {
      aggregate: jest.fn(async () => {
        const all = rows["attendanceRecord"] ?? [];
        return all.length
          ? { _min: { date: new Date("2026-01-05") }, _max: { date: new Date("2026-01-20") } }
          : { _min: { date: null }, _max: { date: null } };
      }),
      findMany: jest.fn(async ({ take = 1000 }: { take?: number }) =>
        (rows["attendanceRecord"] ?? []).slice(0, take),
      ),
    },
    // THE LOOKUPS THAT MAKE THE ARCHIVE READABLE. Every carried row is keyed on
    // opaque UUIDs; without these the school's academic record is a table of
    // scores against identifiers that resolve to nothing. A real TenantTx
    // always has them.
    subject: table("subject"),
    class: table("class"),
    attendanceSession: table("attendanceSession"),
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
  const privileged = {
    client: {
      term: {
        findMany: jest.fn().mockResolvedValue((over as { terms?: unknown[] }).terms ?? []),
        // `windowFor` resolves the term the archive NAMES, so the sections can
        // actually be bounded to it. Answers with dates, like a real term.
        findFirst: jest.fn(async ({ where }: { where: { id: string } }) => {
          const t = ((over as { terms?: Array<Record<string, unknown>> }).terms ?? []).find((x) => x.id === where.id);
          return t ?? { name: "First Term", startDate: new Date("2025-09-01"), endDate: new Date("2026-01-01") };
        }),
      },
      academicSession: {
        findFirst: jest.fn().mockResolvedValue({
          name: "2025/26",
          startDate: new Date("2025-09-01"),
          endDate: new Date("2026-07-31"),
        }),
      },
      schoolArchive: { findMany: jest.fn().mockResolvedValue((over as { existing?: unknown[] }).existing ?? []) },
    },
  };
  const svc = new SchoolArchiveService(db as never, audit as never, storage as never, privileged as never);
  return { svc, tx, audit, storage, uploads, created, privileged };
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

describe("the term sweep — the part a school will actually rely on", () => {
  // A term now needs BOTH dates: the window is what makes the archive about
  // that term rather than about the whole school, which is what every archive
  // silently was before.
  const ended = (id: string, school = SCHOOL) => ({
    id, schoolId: school, name: "First Term", sessionId: "sess-1",
    startDate: new Date("2025-09-01"), endDate: new Date("2026-01-01"),
  });
  /** An ended term nobody gave a start date to. */
  const undated = (id: string, school = SCHOOL) => ({ ...ended(id, school), startDate: null });

  it("archives a term that has ended", async () => {
    const { svc, created } = makeService({ terms: [ended("t-1")] });
    await expect(svc.archiveEndedTerms("SCHEDULED")).resolves.toMatchObject({ scanned: 1, archived: 1 });
    expect(created[0]).toMatchObject({ termId: "t-1", sessionId: "sess-1", label: "First Term" });
  });

  it("SKIPS a term already archived — the sweep runs daily", async () => {
    // Without this every school gains a duplicate archive every single night.
    const { svc, created } = makeService({ terms: [ended("t-1")], existing: [{ termId: "t-1" }] });
    await expect(svc.archiveEndedTerms("SCHEDULED")).resolves.toMatchObject({ archived: 0, skipped: 1 });
    expect(created).toHaveLength(0);
  });

  it("waits out a grace window before archiving", async () => {
    // Late marks and corrections land in the days after a term closes; archiving
    // on the final evening would strand them outside the snapshot.
    const { svc, privileged } = makeService({ terms: [] });
    await svc.archiveEndedTerms("SCHEDULED");
    const where = (privileged.client.term.findMany as jest.Mock).mock.calls[0][0].where;
    const daysAgo = Math.round((Date.now() - where.endDate.lt.getTime()) / 86_400_000);
    expect(daysAgo).toBeGreaterThanOrEqual(5);
  });

  it("attributes the archive to SYSTEM, not to a person", async () => {
    // Nobody clicked it. Putting a name against it would record an act they did
    // not perform, in the one artifact meant to be evidence.
    const { svc, created } = makeService({ terms: [ended("t-1")] });
    await svc.archiveEndedTerms("SCHEDULED");
    expect(created[0].createdById).toBe(SYSTEM_ACTOR_ID);
  });

  it("keeps going when ONE school fails", async () => {
    // A term left unarchived is retried tomorrow; a sweep that dies halfway
    // leaves every school after the failure permanently unarchived.
    const { svc, tx } = makeService({ terms: [ended("t-1", "s-1"), ended("t-2", "s-2")] });
    (tx.schoolArchive.create as jest.Mock)
      .mockRejectedValueOnce(new Error("storage down"))
      .mockResolvedValueOnce({ id: "a-2", createdAt: new Date() });
    await expect(svc.archiveEndedTerms("SCHEDULED")).resolves.toMatchObject({ scanned: 2, archived: 1, skipped: 1 });
  });

  it("is inert without the privileged client", async () => {
    const { svc } = makeService();
    (svc as unknown as { privileged: { client: unknown } }).privileged = { client: null };
    await expect(svc.archiveEndedTerms("SCHEDULED")).resolves.toMatchObject({ scanned: 0, archived: 0 });
  });
});

describe("a term the sweep cannot scope", () => {
  const ended = (id: string) => ({
    id, schoolId: SCHOOL, name: "Undated Term", sessionId: "sess-1",
    startDate: null, endDate: new Date("2026-01-01"),
  });

  it("is REPORTED, not retried and logged every night", async () => {
    // An archive labelled with a term and holding the whole school is the
    // defect this replaces, so it is refused. Counted separately from `skipped`
    // — a sweep that fails on the same rows for ever teaches its reader to
    // ignore it, and "0 archived" with no reason is not an answer.
    const { svc, created } = makeService({ terms: [ended("t-x")] });
    await expect(svc.archiveEndedTerms("SCHEDULED")).resolves.toMatchObject({
      scanned: 0,
      archived: 0,
      undated: 1,
    });
    expect(created).toEqual([]);
  });
});
