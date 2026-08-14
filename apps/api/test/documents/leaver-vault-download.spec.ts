// =============================================================================
// The withheld document was one door away
// =============================================================================
// A school may hold a leaver's academic documents until the family settles what
// they owe; the principal releases them. That gate ran at ISSUE — generating a
// report card, issuing a certificate — and both are refused for a withheld
// leaver.
//
// But generating a report card also FILES a copy in the Document Vault, so the
// family could retrieve the previous term's copy through the vault and get the
// same artefact the gate had just refused. A control with another way round it
// is not a control.
//
// SCOPE, and it is the point: only the ACADEMIC types the gate itself names —
// report card, certificate, transcript. A RECEIPT is a financial record the
// family is entitled to whatever they owe, and withholding personal data over a
// debt is unlawful rather than merely firm. The gate draws that line explicitly
// for the data-protection export, and this keeps it.
// =============================================================================

import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DocumentsService } from "../../src/documents/documents.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const parent: Principal = {
  schoolId: "school-A",
  userId: "parent-1",
  roles: ["parent"],
  permissions: ["document.read"],
};

function makeService(doc: { type: string; studentId: string | null }, student: {
  status: string;
  docsReleasedAt: Date | null;
}) {
  const presign = jest.fn().mockResolvedValue({ url: "https://x/y", expiresInSeconds: 900 });
  const tx = {
    document: { findFirst: jest.fn().mockResolvedValue({ id: "d-1", status: "UPLOADED", storageKey: "k", title: "t", ...doc }) },
    // The leaver gate's own lookup.
    user: { findFirst: jest.fn().mockResolvedValue({ ...student, name: "A Leaver" }) },
    // assertCanAccessStudent uses findFirst (the parent link); the listing path
    // uses findMany. The stub answers both so the scoping check passes and the
    // LEAVER gate is what these cases actually exercise.
    parentChild: {
      findFirst: jest.fn().mockResolvedValue({ id: "link-1" }),
      findMany: jest.fn().mockResolvedValue([{ studentId: "pupil-1" }]),
    },
    classTeacher: { findMany: jest.fn().mockResolvedValue([]) },
    enrollment: { findMany: jest.fn().mockResolvedValue([]) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const service = new DocumentsService(
    db as never,
    { record: jest.fn() } as never,
    { presignDownload: presign, presignUpload: jest.fn() } as never,
    { enqueue: jest.fn() } as never,
  );
  return { service, presign };
}

const WITHHELD = { status: "EXITED", docsReleasedAt: null };
const RELEASED = { status: "EXITED", docsReleasedAt: new Date() };
const STILL_HERE = { status: "ACTIVE", docsReleasedAt: null };

describe("a withheld leaver's academic documents", () => {
  it.each([["REPORT_CARD"], ["CERTIFICATE"], ["TRANSCRIPT"]])(
    "%s cannot be downloaded from the vault",
    async (type) => {
      const { service, presign } = makeService({ type, studentId: "pupil-1" }, WITHHELD);
      await expect(service.getDownloadUrl(parent, "d-1")).rejects.toBeInstanceOf(ForbiddenException);
      // And no URL is minted — a presigned link is a bearer token; refusing after
      // handing one out would refuse nothing.
      expect(presign).not.toHaveBeenCalled();
    },
  );

  it("a RECEIPT still can", async () => {
    // A financial record the family is entitled to whatever they owe.
    const { service, presign } = makeService({ type: "RECEIPT", studentId: "pupil-1" }, WITHHELD);
    await expect(service.getDownloadUrl(parent, "d-1")).resolves.toBeDefined();
    expect(presign).toHaveBeenCalled();
  });

  it("OTHER still can — that is where a data-protection export lands", async () => {
    const { service } = makeService({ type: "OTHER", studentId: "pupil-1" }, WITHHELD);
    await expect(service.getDownloadUrl(parent, "d-1")).resolves.toBeDefined();
  });
});

describe("everyone else is unaffected", () => {
  it("a pupil still at the school downloads their report card", async () => {
    // Report cards go out every term; nothing here may touch that.
    const { service } = makeService({ type: "REPORT_CARD", studentId: "pupil-1" }, STILL_HERE);
    await expect(service.getDownloadUrl(parent, "d-1")).resolves.toBeDefined();
  });

  it("a leaver whose documents were RELEASED downloads them", async () => {
    const { service } = makeService({ type: "REPORT_CARD", studentId: "pupil-1" }, RELEASED);
    await expect(service.getDownloadUrl(parent, "d-1")).resolves.toBeDefined();
  });

  it("a document with no student attached is not gated", async () => {
    // School-level documents have no leaver to check.
    const { service } = makeService({ type: "REPORT_CARD", studentId: null }, WITHHELD);
    // Staff-wide check applies instead; a parent gets 404-not-403 as before.
    await expect(service.getDownloadUrl(parent, "d-1")).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("the gate is applied at every door", () => {
  const SRC = join(__dirname, "../../src");
  it("issue AND retrieval both call it", () => {
    // Three callers now: report card, certificate, vault download. A fourth way
    // to obtain an academic artefact would need one too.
    const callers = ["reportcards/reportcard.service.ts", "certificate/certificate.service.ts", "documents/documents.service.ts"];
    for (const f of callers) {
      expect(readFileSync(join(SRC, f), "utf8")).toMatch(/assertDocumentsReleasable\(/);
    }
  });

  it("the vault gates only the academic types", () => {
    const src = readFileSync(join(SRC, "documents/documents.service.ts"), "utf8");
    expect(src).toMatch(/const GATED_ON_RELEASE = new Set\(\["REPORT_CARD", "CERTIFICATE", "TRANSCRIPT"\]\)/);
    // Named explicitly so adding RECEIPT here is a visible decision, not a slip.
    expect(src).not.toMatch(/GATED_ON_RELEASE = new Set\(\[[^\]]*"RECEIPT"/);
  });
});
