// =============================================================================
// The leaver gate was on the door nothing used
// =============================================================================
// A school may withhold a leaver's academic documents — transcript, report
// card, certificate — until the family has settled what they owe, and the
// principal releases them. `getDownloadUrl` applied that gate, under a comment
// making the argument for it:
//
//     "every artefact the gate blocks at issue was already retrievable through
//      a second door ... A control with another way round it is not a control."
//
// `streamFile` was the second door. And it is the door the product uses: the
// web's download button calls `/documents/:id/file`, not the presigned-URL
// route, so the gate was applied only where nothing called it.
//
// Reproduced against the running stack — one exited pupil, documents
// unreleased, the family asking for the same report card:
//
//     /download  403  "has left the school and their documents ... not released"
//     /file      200  35 bytes of the withheld report card
//
// Both doors now ask one function. The types stay narrow on purpose: a RECEIPT
// is a financial record the family is entitled to whatever they owe, and
// withholding personal data over a debt is unlawful rather than firm.
// =============================================================================

import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { DocumentsService } from "../../src/documents/documents.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

function makeService(doc: { type: string; studentId: string | null }, student: Record<string, unknown> | null) {
  const download = jest.fn().mockResolvedValue(Buffer.from("%PDF-1.4 bytes"));
  const presignDownload = jest.fn().mockResolvedValue({ url: "https://signed", expiresAt: new Date() });
  const tx = {
    user: { findFirst: jest.fn().mockResolvedValue(student) },
  } as unknown as TenantTx;
  const svc = Object.create(DocumentsService.prototype) as DocumentsService;
  Object.assign(svc, {
    db: { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) },
    audit: { record: jest.fn() },
    storage: { download, presignDownload },
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
  });
  const row = { id: "d-1", status: "UPLOADED", storageKey: "k", title: "t.pdf", contentType: "application/pdf", ...doc };
  (svc as unknown as { requireVisible: unknown }).requireVisible = jest.fn().mockResolvedValue(row);
  (svc as unknown as { log: unknown }).log = jest.fn().mockResolvedValue(undefined);
  return { svc, download, presignDownload };
}

const family: Principal = { schoolId: "A", userId: "mum", roles: ["parent"], permissions: ["document.read"] };
const WITHHELD = { id: "kid-1", status: "EXITED", docsReleasedAt: null, name: "Demo Student" };
const RELEASED = { id: "kid-1", status: "EXITED", docsReleasedAt: new Date(), name: "Demo Student" };
const ON_ROLL = { id: "kid-1", status: "ACTIVE", docsReleasedAt: null, name: "Demo Student" };

describe("a withheld leaver's report card", () => {
  it("is refused by the byte-stream door", async () => {
    // The door the web's download button actually calls.
    const { svc, download } = makeService({ type: "REPORT_CARD", studentId: "kid-1" }, WITHHELD);
    await expect(svc.streamFile(family, "d-1")).rejects.toThrow(ForbiddenException);
    expect(download).not.toHaveBeenCalled();
  });

  it("is refused by the presigned-URL door", async () => {
    const { svc, presignDownload } = makeService({ type: "REPORT_CARD", studentId: "kid-1" }, WITHHELD);
    await expect(svc.getDownloadUrl(family, "d-1")).rejects.toThrow(ForbiddenException);
    expect(presignDownload).not.toHaveBeenCalled();
  });

  it("refuses before the bytes are read, not after", async () => {
    // A gate that fetches the object first has already paid for the leak on any
    // storage that logs or bills per read.
    const { svc, download } = makeService({ type: "CERTIFICATE", studentId: "kid-1" }, WITHHELD);
    await expect(svc.streamFile(family, "d-1")).rejects.toThrow(ForbiddenException);
    expect(download).not.toHaveBeenCalled();
  });
});

describe("what the gate deliberately does not touch", () => {
  it("hands over a RECEIPT to the same family", async () => {
    // A financial record the family is entitled to whatever they owe.
    // Withholding personal data over a debt is unlawful rather than firm.
    const { svc, download } = makeService({ type: "RECEIPT", studentId: "kid-1" }, WITHHELD);
    await expect(svc.streamFile(family, "d-1")).resolves.toMatchObject({ filename: "t.pdf" });
    expect(download).toHaveBeenCalled();
  });

  it("hands over a report card for a pupil still on roll", async () => {
    // Report cards go out every term; nothing here should touch that.
    const { svc } = makeService({ type: "REPORT_CARD", studentId: "kid-1" }, ON_ROLL);
    await expect(svc.streamFile(family, "d-1")).resolves.toMatchObject({ filename: "t.pdf" });
  });

  it("hands it over once the principal has released it", async () => {
    const { svc } = makeService({ type: "REPORT_CARD", studentId: "kid-1" }, RELEASED);
    await expect(svc.streamFile(family, "d-1")).resolves.toMatchObject({ filename: "t.pdf" });
  });

  it("ignores a document belonging to no pupil", async () => {
    // A school-wide policy PDF has no leaver to gate on.
    const { svc } = makeService({ type: "REPORT_CARD", studentId: null }, null);
    await expect(svc.streamFile(family, "d-1")).resolves.toMatchObject({ filename: "t.pdf" });
  });
});

describe("the two doors", () => {
  it("ask the SAME function, so they cannot drift apart again", () => {
    const src = require("node:fs").readFileSync(
      require("node:path").join(__dirname, "../../src/documents/documents.service.ts"),
      "utf8",
    ) as string;
    const calls = src.match(/await this\.assertReleasable\(tx, d\)/g) ?? [];
    expect(calls).toHaveLength(2);
    // And the check itself exists in exactly one place.
    expect(src.match(/assertDocumentsReleasable\(tx, d\.studentId\)/g) ?? []).toHaveLength(1);
  });

  it("still refuses a document that was never uploaded", async () => {
    const { svc } = makeService({ type: "REPORT_CARD", studentId: "kid-1" }, ON_ROLL);
    (svc as unknown as { requireVisible: jest.Mock }).requireVisible.mockResolvedValue({
      id: "d-1",
      status: "PENDING",
      studentId: "kid-1",
      type: "REPORT_CARD",
    });
    await expect(svc.streamFile(family, "d-1")).rejects.toThrow(NotFoundException);
  });
});
