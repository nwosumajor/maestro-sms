// =============================================================================
// DocumentsService — presign flow, scoping, audited download (in-memory fakes)
// =============================================================================

import { DocumentsService } from "../../src/documents/documents.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

interface Fakes {
  docRow?: Record<string, unknown> | null;
  parentLink?: { id: string } | null;
  taughtClasses?: { classId: string }[];
  enrolledForStudent?: { id: string } | null;
}

function makeService(f: Fakes) {
  const created = { id: "doc-1", storageKey: "schools/s/documents/doc-1/file", contentType: "application/pdf" };
  const tx = {
    document: {
      create: jest.fn().mockResolvedValue(created),
      findFirst: jest.fn().mockResolvedValue(f.docRow === undefined ? null : f.docRow),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...created, ...f.docRow, ...data }),
      ),
      delete: jest.fn().mockResolvedValue({}),
    },
    parentChild: {
      findFirst: jest.fn().mockResolvedValue(f.parentLink ?? null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    classTeacher: { findMany: jest.fn().mockResolvedValue(f.taughtClasses ?? []) },
    enrollment: {
      findFirst: jest.fn().mockResolvedValue(f.enrolledForStudent ?? null),
      findMany: jest.fn().mockResolvedValue([]),
    },
  } as unknown as TenantTx;

  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const storage = {
    presignUpload: jest.fn().mockResolvedValue({ url: "https://up", expiresInSeconds: 900 }),
    presignDownload: jest.fn().mockResolvedValue({ url: "https://down", expiresInSeconds: 900 }),
    delete: jest.fn().mockResolvedValue(undefined),
  };
  const notifications = { enqueue: jest.fn().mockResolvedValue({ id: "n-1" }) };
  const service = new DocumentsService(db as never, audit as never, storage as never, notifications as never);
  return { service, tx, audit, storage, notifications };
}

const principal = (roles: string[], userId = "u-1"): Principal => ({
  schoolId: "school-A",
  userId,
  roles,
  permissions: [],
});

describe("DocumentsService", () => {
  it("create returns a presigned upload URL and audits", async () => {
    const { service, storage, audit } = makeService({});
    const res = await service.createDocument(principal(["school_admin"]), {
      studentId: "stu-1",
      type: "REPORT_CARD",
      title: "Term 1 Report",
      contentType: "application/pdf",
    });
    expect(res.upload.url).toBe("https://up");
    expect(storage.presignUpload).toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "document.create" }),
      expect.anything(),
    );
  });

  it("download is access-checked and audited, and returns a presigned GET URL", async () => {
    const { service, storage, audit } = makeService({
      docRow: { id: "doc-1", studentId: "kid-1", status: "UPLOADED", storageKey: "k", title: "Report" },
      parentLink: { id: "link-1" },
    });
    const res = await service.getDownloadUrl(principal(["parent"]), "doc-1");
    expect(res.download.url).toBe("https://down");
    expect(storage.presignDownload).toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "document.download" }),
      expect.anything(),
    );
  });

  it("a parent cannot download another family's document (404)", async () => {
    const { service } = makeService({
      docRow: { id: "doc-1", studentId: "not-mine", status: "UPLOADED", storageKey: "k", title: "x" },
      parentLink: null,
    });
    await expect(service.getDownloadUrl(principal(["parent"]), "doc-1")).rejects.toThrow(/not found/i);
  });

  it("a teacher can access a document of a student they teach", async () => {
    const { service } = makeService({
      docRow: { id: "doc-1", studentId: "stu-1", status: "UPLOADED", storageKey: "k", title: "x" },
      taughtClasses: [{ classId: "c-1" }],
      enrolledForStudent: { id: "e-1" },
    });
    await expect(service.getDocument(principal(["teacher"]), "doc-1")).resolves.toMatchObject({ id: "doc-1" });
  });

  it("confirming a REPORT_CARD notifies guardians", async () => {
    const { service, notifications, tx } = makeService({
      docRow: { id: "doc-1", studentId: "stu-1", type: "REPORT_CARD", status: "PENDING" },
    });
    (tx.parentChild.findMany as jest.Mock).mockResolvedValue([{ parentId: "mum-1" }]);
    await service.confirmUpload(principal(["school_admin"]), "doc-1");
    expect(notifications.enqueue).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ recipientId: "mum-1", type: "DOCUMENT_AVAILABLE" }),
    );
  });

  it("a non-staff caller cannot create a school-level (no student) document", async () => {
    const { service } = makeService({});
    await expect(
      service.createDocument(principal(["teacher"]), {
        type: "OTHER",
        title: "Policy",
        contentType: "application/pdf",
      }),
    ).rejects.toThrow(/cannot create/i);
  });
});
