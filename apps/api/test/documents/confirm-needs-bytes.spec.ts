// =============================================================================
// Telling a family a document is ready, before it exists
// =============================================================================
// The Vault has two upload paths. `upload-bytes` sends the file through the API,
// which writes it and only then flips the document to UPLOADED — that one has
// always been safe, because the bytes are in hand.
//
// `confirm` completes the OTHER path: a presigned PUT, which happens between the
// browser and the bucket where the API cannot see it. It took the client's word
// for it. So an upload that silently failed — a dropped connection, a client
// bug, a retry that never happened — produced:
//
//   * a document recorded as UPLOADED,
//   * guardians notified that a report card or certificate was ready,
//   * and a download that 404s when the family clicks it.
//
// The record asserted one thing and the bucket held another, and the family was
// the one who found out. It now HEADs the object first, which is the only way
// the API can know.
//
// (The web does not use this path at all — it uses create -> upload-bytes — and
// the surface registry's claim that DocumentUpload.tsx called it was wrong. The
// endpoint is live and authenticated regardless, so the hole was real whether or
// not the product walked through it.)
// =============================================================================

import { BadRequestException, NotFoundException } from "@nestjs/common";
import { DocumentsService } from "../../src/documents/documents.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const staff: Principal = {
  schoolId: "S",
  userId: "u-staff",
  roles: ["school_admin"],
  permissions: ["document.write", "document.read"],
};

const DOC = {
  id: "d1",
  schoolId: "S",
  studentId: "stu-1",
  type: "REPORT_CARD",
  title: "Third Term report card",
  storageKey: "schools/S/documents/d1/third-term-report-card",
  contentType: "application/pdf",
  status: "PENDING",
  sizeBytes: null,
};

function makeService(opts: { exists?: boolean; doc?: Record<string, unknown> | null } = {}) {
  const updates: Array<Record<string, unknown>> = [];
  const tx = {
    document: {
      findFirst: jest.fn(async () => (opts.doc === undefined ? DOC : opts.doc)),
      update: jest.fn(async (a: { data: Record<string, unknown> }) => {
        updates.push(a.data);
        return { ...DOC, ...a.data };
      }),
    },
    parentChild: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null) },
    enrollment: { findMany: jest.fn(async () => []) },
    user: { findFirst: jest.fn(async () => ({ name: "A Pupil" })), findMany: jest.fn(async () => []) },
  } as unknown as TenantTx;

  const storage = { exists: jest.fn(async () => opts.exists ?? true) };
  const notified: string[] = [];
  const notifications = {
    enqueueMany: jest.fn(async (_c: unknown, ids: string[]) => {
      notified.push(...ids);
      return { created: ids.length, failed: 0 };
    }),
    enqueue: jest.fn(async () => undefined),
  };
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const audit = { record: jest.fn(async () => undefined) };

  const svc = new DocumentsService(
    db as never, audit as never, storage as never, notifications as never,
  );
  return { svc, storage, updates, notified, tx };
}

describe("confirming a presigned upload", () => {
  it("HEADs the object before believing the client", async () => {
    const { svc, storage } = makeService({ exists: true });
    await svc.confirmUpload(staff, "d1");
    expect(storage.exists).toHaveBeenCalledWith(DOC.storageKey);
  });

  it("marks the document available when the bytes really arrived", async () => {
    const { svc, updates } = makeService({ exists: true });
    await svc.confirmUpload(staff, "d1");
    expect(updates[0]).toMatchObject({ status: "UPLOADED" });
  });

  it("REFUSES when the bytes never arrived", async () => {
    const { svc } = makeService({ exists: false });
    await expect(svc.confirmUpload(staff, "d1")).rejects.toBeInstanceOf(BadRequestException);
  });

  it("says what went wrong and what to do about it", async () => {
    // "Bad request" sends somebody to support. "The upload did not complete,
    // try again" is a thing they can act on without leaving the page.
    const { svc } = makeService({ exists: false });
    await expect(svc.confirmUpload(staff, "d1")).rejects.toThrow(/upload did not complete/i);
  });

  it("leaves the document PENDING rather than half-confirming it", async () => {
    const { svc, updates } = makeService({ exists: false });
    await expect(svc.confirmUpload(staff, "d1")).rejects.toBeInstanceOf(BadRequestException);
    expect(updates).toEqual([]);
  });

  it("does not notify a single guardian about a document that is not there", async () => {
    // The consequence that reaches a family. A parent told their child's report
    // card is ready, clicking it, and getting nothing is worse than not being
    // told yet.
    const { svc, notified } = makeService({ exists: false });
    await expect(svc.confirmUpload(staff, "d1")).rejects.toBeInstanceOf(BadRequestException);
    expect(notified).toEqual([]);
  });

  it("still refuses a document that does not exist at all", async () => {
    const { svc, storage } = makeService({ doc: null });
    await expect(svc.confirmUpload(staff, "d1")).rejects.toBeInstanceOf(NotFoundException);
    // And does not go asking the bucket about a key it never had.
    expect(storage.exists).not.toHaveBeenCalled();
  });
});

describe("the storage contract", () => {
  const SRC = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "../../src/documents/s3-storage.provider.ts"),
    "utf8",
  ) as string;

  it("asks S3 with HEAD, not by downloading the file", () => {
    // The answer is one bit and a report card can be megabytes.
    expect(SRC).toMatch(/HeadObjectCommand/);
  });

  it("distinguishes 'not there' from 'the bucket would not answer'", () => {
    // Reporting a permissions failure as "absent" would tell an uploader their
    // file is missing when the truth is that the API cannot see the bucket —
    // different faults, different fixes, and only one of them is theirs.
    const fn = SRC.slice(SRC.indexOf("async exists("), SRC.indexOf("async delete("));
    expect(fn).toMatch(/status === 404/);
    expect(fn).toMatch(/throw err/);
  });
});
