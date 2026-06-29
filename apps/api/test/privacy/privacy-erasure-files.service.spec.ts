// =============================================================================
// PrivacyService.reviewErasure — submission-file erasure (NDPR compliance)
// =============================================================================
// Proves that an APPROVED right-to-erasure deletes the subject's uploaded
// submission FILES from object storage (minors' PII not covered by the integrity-
// telemetry retention sweep) and nulls the keys; a REJECTED request touches no
// files; deletion is best-effort (a storage failure doesn't fail the request).

import { PrivacyService } from "../../src/privacy/privacy.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

function make(opts: { withFiles?: { id: string; fileKey: string }[]; storageThrows?: boolean }) {
  const updateMany = jest.fn().mockResolvedValue({ count: opts.withFiles?.length ?? 0 });
  const tx = {
    erasureRequest: {
      findFirst: jest.fn().mockResolvedValue({ id: "er1", studentId: "stu-1", status: "PENDING" }),
      update: jest.fn((a: { data: Record<string, unknown> }) => Promise.resolve({ id: "er1", ...a.data })),
    },
    submission: {
      findMany: jest.fn().mockResolvedValue(opts.withFiles ?? []),
      updateMany,
    },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const del = jest.fn(() => (opts.storageThrows ? Promise.reject(new Error("s3 down")) : Promise.resolve()));
  const storage = { presignUpload: jest.fn(), presignDownload: jest.fn(), delete: del };
  return { service: new PrivacyService(db as never, audit as never, storage as never), del, updateMany };
}

const reviewer: Principal = { schoolId: "A", userId: "ctrl", roles: ["school_admin"], permissions: ["privacy.erasure.review"] };

describe("PrivacyService erasure file deletion", () => {
  it("APPROVED erasure deletes each submission file and nulls the keys", async () => {
    const { service, del, updateMany } = make({ withFiles: [{ id: "s1", fileKey: "k1" }, { id: "s2", fileKey: "k2" }] });
    await service.reviewErasure(reviewer, "er1", "APPROVED");
    expect(del).toHaveBeenCalledWith("k1");
    expect(del).toHaveBeenCalledWith("k2");
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { fileKey: null, fileName: null, fileUploaded: false } }),
    );
  });

  it("REJECTED erasure deletes no files", async () => {
    const { service, del, updateMany } = make({ withFiles: [{ id: "s1", fileKey: "k1" }] });
    await service.reviewErasure(reviewer, "er1", "REJECTED");
    expect(del).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("a storage failure is best-effort (the request still resolves)", async () => {
    const { service } = make({ withFiles: [{ id: "s1", fileKey: "k1" }], storageThrows: true });
    await expect(service.reviewErasure(reviewer, "er1", "APPROVED")).resolves.toBeDefined();
  });
});
