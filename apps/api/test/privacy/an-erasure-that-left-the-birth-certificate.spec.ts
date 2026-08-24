// =============================================================================
// The right to erasure reached the homework and not the birth certificate
// =============================================================================
// `reviewErasure` erased `Submission.fileKey` — assignment uploads — and nothing
// else. A child's birth certificate, immunisation record and passport photograph
// are supplied through `DocumentSubmission`, and they stayed in object storage
// while the request was marked APPROVED and the audit row said the files had
// been erased.
//
// Two ways those attach to one child, and BOTH are needed:
//
//   STUDENT                keyed directly on the pupil
//   ADMISSION_APPLICATION  keyed on the application, which carries
//                          `convertedStudentId` once the pupil is enrolled
//
// No other path reached them either. The declined-applicant sweep purges
// REJECTED applications on a timer, so an ENROLLED pupil's supplied documents
// were covered by nothing at all — not the sweep, not the erasure.
//
// LATENT, NOT LIVE, and worth saying: `document_submission` has no rows on this
// database, so no real erasure has under-delivered yet. It would have gone wrong
// the first time a school used the supplied-documents flow, and the evidence
// would have been a regulator's question the school answered wrongly in good
// faith, using its own audit log.
//
// WHAT IS KEPT IS NOW COUNTED. Document Vault entries — report cards, receipts,
// certificates — are the SCHOOL's record of the pupil and are deliberately
// retained, on the same reasoning as the submission row and the grade. That is a
// defensible decision and a bad secret, so the audit row states how many remain
// and why. Same rule the exeat sweep and the alumni broadcast follow: report
// what you did NOT do.
// =============================================================================

import { PrivacyService } from "../../src/privacy/privacy.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const STUDENT = "aaaaaaaa-0000-4000-8000-000000000001";

function makeService(opts: {
  submissionFiles?: string[];
  suppliedByStudent?: string[];
  suppliedByApplication?: string[];
  applications?: string[];
  vaultDocs?: number;
} = {}) {
  const deleted: string[] = [];
  const submissionUpdate = jest.fn().mockResolvedValue({ count: 0 });
  const suppliedUpdate = jest.fn().mockResolvedValue({ count: 0 });
  const key = (k: string) => ({ id: `id-${k}`, storageKey: k });

  const tx = {
    erasureRequest: {
      findFirst: jest.fn().mockResolvedValue({ id: "er-1", studentId: STUDENT, status: "PENDING" }),
      update: jest.fn().mockResolvedValue({ id: "er-1", status: "APPROVED" }),
    },
    submission: {
      findMany: jest.fn().mockResolvedValue((opts.submissionFiles ?? []).map((k) => ({ id: `s-${k}`, fileKey: k }))),
      updateMany: submissionUpdate,
    },
    admissionApplication: {
      findMany: jest.fn().mockResolvedValue((opts.applications ?? []).map((a) => ({ id: a }))),
    },
    documentSubmission: {
      findMany: jest.fn(({ where }: { where: { OR: Array<{ subjectKind: string }> } }) => {
        const kinds = where.OR.map((o) => o.subjectKind);
        const out = [
          ...(kinds.includes("STUDENT") ? (opts.suppliedByStudent ?? []) : []),
          ...(kinds.includes("ADMISSION_APPLICATION") ? (opts.suppliedByApplication ?? []) : []),
        ];
        return Promise.resolve(out.map(key));
      }),
      updateMany: suppliedUpdate,
    },
    document: { count: jest.fn().mockResolvedValue(opts.vaultDocs ?? 0) },
  } as unknown as TenantTx;

  const svc = Object.create(PrivacyService.prototype) as PrivacyService;
  const audit: Array<Record<string, unknown>> = [];
  Object.assign(svc, {
    db: { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) },
    storage: { delete: jest.fn(async (k: string) => { deleted.push(k); }) },
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
  });
  (svc as unknown as { log: unknown }).log = jest.fn(
    async (_tx: unknown, _p: unknown, _action: string, _id: string, meta: Record<string, unknown>) => {
      audit.push(meta);
    },
  );
  return { svc, tx, deleted, audit, suppliedUpdate };
}

const controller: Principal = {
  schoolId: "A", userId: "dpo-1", roles: ["school_admin"], permissions: ["privacy.erasure.review"],
};
const approve = (svc: PrivacyService) => svc.reviewErasure(controller, "er-1", "APPROVED");

describe("what an approved erasure actually removes", () => {
  it("erases the assignment uploads it always did", async () => {
    const t = makeService({ submissionFiles: ["homework.pdf"] });
    await approve(t.svc);
    expect(t.deleted).toContain("homework.pdf");
  });

  it("ALSO erases documents supplied against the pupil directly", async () => {
    const t = makeService({ suppliedByStudent: ["immunisation.pdf"] });
    await approve(t.svc);
    expect(t.deleted).toContain("immunisation.pdf");
  });

  it("ALSO erases what the family supplied at admission", async () => {
    // Reached through `convertedStudentId` — the link that exists precisely so
    // the application and the enrolled pupil are not orphans of each other.
    const t = makeService({ applications: ["app-1"], suppliedByApplication: ["birth-certificate.pdf"] });
    await approve(t.svc);
    expect(t.deleted).toContain("birth-certificate.pdf");
  });

  it("clears the row's pointers as well as the bytes", async () => {
    // A key left behind on a row whose object is gone is a broken record; a key
    // gone while the object remains is an unfindable, unerasable file.
    const t = makeService({ suppliedByStudent: ["x.pdf"] });
    await approve(t.svc);
    expect(t.suppliedUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { storageKey: null, originalName: null, contentType: null, sizeBytes: null } }),
    );
  });

  it("does not look for admission documents when there is no application", async () => {
    // An empty `in: []` would match nothing, but asking is still a query per
    // erasure for the common case of a pupil enrolled by hand.
    const t = makeService({ suppliedByStudent: ["x.pdf"] });
    await approve(t.svc);
    const where = (t.tx.documentSubmission.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where.OR).toHaveLength(1);
    expect(where.OR[0]).toMatchObject({ subjectKind: "STUDENT", subjectId: STUDENT });
  });
});

describe("what it keeps, and whether it says so", () => {
  it("counts the school records it deliberately retains", async () => {
    // Report cards, receipts and certificates are the SCHOOL's record, kept on
    // the same reasoning as the submission row and the grade.
    const t = makeService({ vaultDocs: 7 });
    await approve(t.svc);
    expect(t.audit[0]).toMatchObject({ retainedVaultDocuments: 7 });
  });

  it("says WHY they were retained, not merely how many", async () => {
    const t = makeService({ vaultDocs: 7 });
    await approve(t.svc);
    expect(t.audit[0].retainedReason).toMatch(/school record/i);
  });

  it("distinguishes the two things it erased, rather than one total", async () => {
    // "3 files erased" cannot answer "was my child's birth certificate deleted".
    const t = makeService({ submissionFiles: ["h.pdf"], suppliedByStudent: ["a.pdf", "b.pdf"] });
    await approve(t.svc);
    expect(t.audit[0]).toMatchObject({ erasedSubmissionFiles: 1, erasedSuppliedDocuments: 2 });
  });

  it("records no retention reason when nothing was retained", async () => {
    const t = makeService({ vaultDocs: 0 });
    await approve(t.svc);
    expect(t.audit[0]).toMatchObject({ retainedVaultDocuments: 0, retainedReason: null });
  });
});

describe("a REJECTED request", () => {
  it("erases nothing at all", async () => {
    const t = makeService({ submissionFiles: ["h.pdf"], suppliedByStudent: ["a.pdf"] });
    await t.svc.reviewErasure(controller, "er-1", "REJECTED");
    expect(t.deleted).toEqual([]);
  });
});
