// =============================================================================
// IntegrityService — file-upload submission flow unit tests
// =============================================================================
// Proves the teacher-toggled file answer: presign refuses when the assessment has
// fileUploadEnabled=false; the owner gets a presigned PUT/GET; a non-owner reviewer
// (teacher of the class) may download while a stranger gets 404; submit accepts a
// FILE-only answer (no text) once a file is uploaded.

import { BadRequestException, NotFoundException } from "@nestjs/common";
import { IntegrityService } from "../../src/integrity/integrity.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

function make(opts: {
  submission?: Record<string, unknown> | null;
  assessment?: Record<string, unknown> | null;
  classTeacher?: Record<string, unknown> | null;
}) {
  const update = jest.fn((a: { data: Record<string, unknown> }) => Promise.resolve({ id: "sub", ...a.data }));
  const tx = {
    submission: { findFirst: jest.fn().mockResolvedValue(opts.submission ?? null), update },
    assessment: { findFirst: jest.fn().mockResolvedValue(opts.assessment ?? null) },
    // One definition of who teaches a class (common/teaches.ts) reads the
    // class SUPERVISOR and the subject offerings too — every real TenantTx
    // answers all three.
    // HONOURS THE WHERE: teacher-1 is the CLASS TEACHER of c1 and a stranger
    // is not. A stub answering every caller with the class makes everyone a
    // teacher, which is the opposite of what this suite tests.
    class: {
      findMany: jest.fn(({ where }: { where?: { supervisorId?: string } } = {}) =>
        Promise.resolve(where?.supervisorId === "teacher-1" ? [{ id: "c1" }] : []),
      ),
    },
    classSubjectTeacher: { findMany: jest.fn().mockResolvedValue([]) },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const queue = { add: jest.fn().mockResolvedValue(undefined) };
  const storage = {
    presignUpload: jest.fn().mockResolvedValue({ url: "PUT-URL", expiresInSeconds: 60 }),
    presignDownload: jest.fn().mockResolvedValue({ url: "GET-URL", expiresInSeconds: 60 }),
    delete: jest.fn(),
  };
  const service = new IntegrityService(db as never, audit as never, { hasIntegrityConsent: jest.fn() } as never, queue as never, storage as never, undefined);
  return { service, update, storage };
}

const ctx: TenantContext = { schoolId: "A", userId: "student-1" };
const ownSub = (over: Record<string, unknown> = {}) => ({ id: "sub", schoolId: "A", assessmentId: "a1", studentId: "student-1", status: "IN_PROGRESS", fileKey: null, fileUploaded: false, fileName: null, content: null, ...over });

describe("IntegrityService file-upload submissions", () => {
  it("refuses a presign when the assessment has file upload disabled", async () => {
    const { service } = make({ submission: ownSub(), assessment: { fileUploadEnabled: false } });
    await expect(service.presignSubmissionFile(ctx, "sub", { fileName: "a.pdf", contentType: "application/pdf" })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("presigns a PUT for the owner when file upload is enabled", async () => {
    const { service, update, storage } = make({ submission: ownSub(), assessment: { fileUploadEnabled: true } });
    const res = await service.presignSubmissionFile(ctx, "sub", { fileName: "answer.pdf", contentType: "application/pdf" });
    expect(res.url).toBe("PUT-URL");
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ fileName: "answer.pdf", fileUploaded: false }) }));
    expect(storage.presignUpload).toHaveBeenCalled();
  });

  it("a non-owner who teaches the class can download; a stranger gets 404", async () => {
    const teacher: Principal = { schoolId: "A", userId: "teacher-1", roles: ["teacher"], permissions: [] };
    const stranger: Principal = { schoolId: "A", userId: "rando", roles: ["teacher"], permissions: [] };
    const sub = ownSub({ studentId: "student-1", fileKey: "k", fileUploaded: true, fileName: "answer.pdf" });

    const ok = make({ submission: sub, assessment: { createdById: "x", classId: "c1" }, classTeacher: { id: "ct" } });
    await expect(ok.service.downloadSubmissionFile(teacher, "sub")).resolves.toMatchObject({ url: "GET-URL" });

    const no = make({ submission: sub, assessment: { createdById: "x", classId: "c1" }, classTeacher: null });
    await expect(no.service.downloadSubmissionFile(stranger, "sub")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("submit accepts a file-only answer (no text) once a file is uploaded", async () => {
    const { service, update } = make({ submission: ownSub({ fileUploaded: true }), assessment: { fileUploadEnabled: true } });
    await service.submit(ctx, "sub", "");
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "SUBMITTED" }) }));
  });

  it("submit rejects an empty answer when there is no text and no file", async () => {
    const { service } = make({ submission: ownSub({ fileUploaded: false }), assessment: { fileUploadEnabled: true } });
    await expect(service.submit(ctx, "sub", "   ")).rejects.toBeInstanceOf(BadRequestException);
  });
});
