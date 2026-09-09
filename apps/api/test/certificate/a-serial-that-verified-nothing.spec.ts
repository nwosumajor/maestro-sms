// =============================================================================
// The serial printed on every certificate, and the two things it could not do
// =============================================================================
// Every certificate this product renders carries, along its foot:
//
//   "Serial CERT-… · Issued 9 September 2026 · Authenticity may be verified
//    with the issuing school by quoting the serial number."
//
// It could not be. Nothing in the product accepted a serial — no route, no
// service method, no screen. The only way to see one was
// `history/:subjectId`, which needs the pupil's id, and somebody checking a
// document they have been handed has the serial and not the identity. That is
// the whole case verification exists for.
//
// And the document the serial named could not be reprinted. Measured live on a
// pupil awarded "Best in Science" and later "Best in Mathematics", the issuer
// needing a replacement copy had exactly two moves and both were wrong:
//   - Generate with the title still in the box -> a THIRD registry row for one
//     physical award;
//   - Generate with the boxes cleared -> the serial of "Best in Science" reused
//     on a GENERIC merit certificate that does not mention the award, silently
//     choosing the older of the two.
//
// So the register and the paper disagreed, and the serial that was supposed to
// settle it identified both.
// =============================================================================

import { inflateSync } from "node:zlib";
import { CertificateService } from "../../src/certificate/certificate.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const staff: Principal = { schoolId: "A", userId: "issuer", roles: ["principal"], permissions: ["certificate.issue"] };

type Row = {
  id: string;
  subjectId: string;
  type: string;
  serial: string;
  title: string | null;
  body: string | null;
  createdAt: Date;
  issuedById?: string;
};

/** Models the contract: rows persist, and every `where` clause is honoured. */
function harness(seed: Row[] = []) {
  const rows = [...seed];
  const audit: Array<{ action: string; entityId: string; metadata?: unknown }> = [];
  let n = 0;
  const match = (r: Row, where: Record<string, unknown> = {}) =>
    (where.id === undefined || r.id === where.id) &&
    (where.serial === undefined || r.serial === where.serial) &&
    (where.type === undefined || r.type === where.type) &&
    (where.subjectId === undefined ||
      (typeof where.subjectId === "string"
        ? r.subjectId === where.subjectId
        : (where.subjectId as { in: string[] }).in.includes(r.subjectId)));

  const tx = {
    user: {
      findFirst: jest.fn(async ({ where }: { where?: { id?: string } } = {}) =>
        where?.id === "issuer"
          ? { name: "Mrs Bello" }
          : { id: "s1", name: "Adaeze Okafor", email: "a@x.school", uniqueId: "STU-001", roles: [{ role: { name: "student" } }] },
      ),
      findMany: jest.fn().mockResolvedValue([{ id: "s1", name: "Adaeze" }]),
    },
    school: { findFirst: jest.fn().mockResolvedValue({ name: "St Andrews", address: "1 Road" }) },
    class: { findFirst: jest.fn().mockResolvedValue({ id: "c1", name: "JSS2B" }) },
    schoolBranding: { findFirst: jest.fn().mockResolvedValue(null) },
    enrollment: {
      findFirst: jest.fn().mockResolvedValue({ status: "ACTIVE" }),
      findMany: jest.fn().mockResolvedValue([{ studentId: "s1" }]),
    },
    studentProfile: { findFirst: jest.fn().mockResolvedValue(null) },
    invoice: { findMany: jest.fn().mockResolvedValue([]), aggregate: jest.fn().mockResolvedValue({ _sum: {} }) },
    payment: { findMany: jest.fn().mockResolvedValue([]) },
    bookLoan: { findMany: jest.fn().mockResolvedValue([]) },
    issuedCertificate: {
      findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => rows.find((r) => match(r, where)) ?? null),
      findMany: jest.fn(
        async ({ where, orderBy }: { where?: Record<string, unknown>; orderBy?: { createdAt?: "asc" | "desc" } } = {}) => {
          const out = rows.filter((r) => match(r, where));
          if (orderBy?.createdAt) {
            const dir = orderBy.createdAt === "desc" ? -1 : 1;
            out.sort((a, b) => dir * (a.createdAt.getTime() - b.createdAt.getTime()));
          }
          return out;
        },
      ),
      create: jest.fn(async ({ data }: { data: Omit<Row, "id" | "createdAt"> }) => {
        const row: Row = { ...data, id: `c${++n}`, createdAt: new Date(2026, 0, n) };
        rows.push(row);
        return row;
      }),
      createMany: jest.fn(async ({ data }: { data: Array<Omit<Row, "id" | "createdAt">> }) => {
        for (const d of data) rows.push({ ...d, id: `c${++n}`, createdAt: new Date(2026, 0, n) });
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
    { record: jest.fn(async (e: { action: string; entityId: string }) => void audit.push(e)) } as never,
    { getLogoBytes: jest.fn().mockResolvedValue(null) } as never,
  );
  return { svc, rows, audit };
}

const award = (over: Partial<Row> = {}): Row => ({
  id: "seed1", subjectId: "s1", type: "MERIT", serial: "CERT-AAA-111",
  title: "Best in Science", body: "For outstanding work in the sciences.",
  createdAt: new Date("2025-07-14T09:00:00Z"), issuedById: "issuer", ...over,
});

describe("whose certificate is this serial?", () => {
  it("answers with the document the school registered under it", async () => {
    const { svc } = harness([award()]);
    await expect(svc.verify(staff, "CERT-AAA-111")).resolves.toMatchObject({
      serial: "CERT-AAA-111",
      type: "MERIT",
      title: "Best in Science",
      subjectName: "Adaeze Okafor",
      subjectRole: "Student",
      issuedOn: new Date("2025-07-14T09:00:00Z"),
      issuedByName: "Mrs Bello",
    });
  });

  it("404s an unknown serial — and says the same thing for another school's", async () => {
    // RLS has already hidden another school's rows, so both arrive here as "no
    // such row". Distinguishing them would confirm the existence of a
    // certificate to anyone who could guess a serial.
    const { svc } = harness([award()]);
    await expect(svc.verify(staff, "CERT-SOMEONE-ELSE")).rejects.toThrow(/no certificate with that serial/i);
  });

  it("is AUDITED — it names a pupil (Golden Rule #5)", async () => {
    const { svc, audit } = harness([award()]);
    await svc.verify(staff, "CERT-AAA-111");
    expect(audit).toEqual([
      expect.objectContaining({ action: "certificate.verify", entityId: "CERT-AAA-111" }),
    ]);
  });

  it("the history read is audited too — the sibling that was not", async () => {
    // `issue`, `verify` and the scan desk all record theirs. This one names a
    // pupil and the awards they hold and recorded nothing, which is the shape
    // this repo keeps finding: the careful half written, the sibling left.
    const { svc, audit } = harness([award()]);
    await svc.history(staff, "s1");
    expect(audit).toEqual([
      expect.objectContaining({ action: "certificate.history.read", entityId: "s1" }),
    ]);
  });

  it("tolerates spacing and case, because a serial is READ OFF PAPER", async () => {
    const { svc } = harness([award()]);
    await expect(svc.verify(staff, "  cert-aaa-111 ")).resolves.toMatchObject({ serial: "CERT-AAA-111" });
  });
});

describe("reprinting the certificate that was actually issued", () => {
  it("prints the REGISTERED words, not the empty ones the request carried", async () => {
    const { svc, rows } = harness([award()]);
    const out = await svc.issue(staff, { type: "MERIT", subjectId: "s1" });
    // No new row: it is the same certificate.
    expect(rows).toHaveLength(1);
    // ...and the file is named for the serial it reprinted.
    expect(out.filename).toBe("merit-CERT-AAA-111.pdf");
    // The rendered document carries the award's own title.
    expect(out.buffer.length).toBeGreaterThan(1000);
  });

  it("carries the date it was ISSUED, and the award's own words", async () => {
    // A reprint of last year's testimonial stamped with today's date is a
    // different document again, under a serial that says otherwise. Read out of
    // the rendered PDF rather than off the service's return value, because the
    // defect was precisely that the right serial reached a document rendered
    // from the wrong data.
    const { svc } = harness([award()]);
    const out = await svc.issue(staff, { type: "MERIT", subjectId: "s1" });
    const text = textOf(out.buffer);
    expect(text).toContain("14 July 2025");
    expect(text).toContain("BEST IN SCIENCE");
    expect(text).toContain("For outstanding work in the sciences.");
    expect(text).toContain("CERT-AAA-111");
  });

  it("REFUSES to guess when the person holds several of that type, and names them", async () => {
    const { svc } = harness([
      award(),
      award({ id: "seed2", serial: "CERT-BBB-222", title: "Best in Mathematics", createdAt: new Date("2026-03-01") }),
    ]);
    await expect(svc.issue(staff, { type: "MERIT", subjectId: "s1" })).rejects.toThrow(
      /holds 2 MERIT certificates/i,
    );
    // The refusal must carry the way out: both serials, and their awards.
    await expect(svc.issue(staff, { type: "MERIT", subjectId: "s1" })).rejects.toThrow(/Best in Science/);
    await expect(svc.issue(staff, { type: "MERIT", subjectId: "s1" })).rejects.toThrow(/CERT-BBB-222/);
  });

  it("reprints the NAMED one when the caller says which", async () => {
    const { svc, rows } = harness([
      award(),
      award({ id: "seed2", serial: "CERT-BBB-222", title: "Best in Mathematics", createdAt: new Date("2026-03-01") }),
    ]);
    const out = await svc.issue(staff, { type: "MERIT", subjectId: "s1", certificateId: "seed2" });
    expect(out.filename).toBe("merit-CERT-BBB-222.pdf");
    expect(rows).toHaveLength(2); // nothing new was issued
  });

  it("will not print one person's award onto another's document", async () => {
    // The id comes from the request. Checking only that the row EXISTS would
    // let a mistyped id reprint somebody else's certificate under this pupil's
    // name — never trust an id from the body.
    const { svc } = harness([award({ subjectId: "someone-else" })]);
    await expect(svc.issue(staff, { type: "MERIT", subjectId: "s1", certificateId: "seed1" })).rejects.toThrow(
      /not on this school's register/i,
    );
  });

  it("a genuinely NEW award still gets its own certificate and serial", async () => {
    const { svc, rows } = harness([award()]);
    await svc.issue(staff, { type: "MERIT", subjectId: "s1", title: "Best in Mathematics" });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.serial)).size).toBe(2);
  });
});

/** The visible text of a pdfkit document, decoded from its content streams. */
function textOf(pdf: Buffer): string {
  const raw = pdf.toString("latin1");
  let out = "";
  for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    try {
      out += inflateSync(Buffer.from(m[1], "latin1")).toString("latin1");
    } catch {
      /* not a deflate stream — image bytes and the like */
    }
  }
  return [...out.matchAll(/<([0-9a-fA-F]+)>/g)]
    .map((h) => Buffer.from(h[1], "hex").toString("latin1"))
    .join("");
}
