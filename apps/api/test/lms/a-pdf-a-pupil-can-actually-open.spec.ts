// =============================================================================
// The material a pupil could not open, and the confirm that checked nothing
// =============================================================================
// Attaching a PDF to a weekly material promises, in three separate places, that
// "pupils can open it in the browser" — the picker's refusal, the helper text
// under the control, and the presign's own 400. The download then presigned
// `attachment` + `application/octet-stream`, so every pupil got a file saved to
// disk and nothing rendered. A promise the product makes on the screen and
// breaks on the click.
//
// Serving it inline is only safe if the server knows what the bytes ARE, and it
// did not: `confirmUpload` set `fileUploaded: true` on the caller's word alone.
// Three things go wrong there, and all three are invisible to the teacher:
//
//   1. THE BYTES NEVER ARRIVED. A failed PUT, or a browser closed mid-upload,
//      still ended with "Attached. Pupils see it once this material is
//      published." Pupils then got a refusal from storage on the one button the
//      feature exists for. The storage provider carries the note for exactly
//      this case, written for the Vault; this module was built without it.
//   2. THE SIZE WAS A NUMBER THE CALLER SENT. `sizeBytes` is checked at
//      presign, against nothing.
//   3. THE TYPE WAS A CLAIM. The browser-side `file.type` check is friction.
//
// So the fix is a pair: validate the bytes on confirm, and only then serve the
// file as what it was validated to be.
// =============================================================================

import { BadRequestException } from "@nestjs/common";
import { LmsContentService } from "../../src/lms/lms-content.service";

const PDF = Buffer.from("%PDF-1.7\nnot really a document, but it starts like one");
const NOT_PDF = Buffer.from("<html><script>alert(1)</script></html>");

const teacher = {
  schoolId: "S",
  userId: "t-1",
  roles: ["teacher"],
  permissions: ["lms.content.write", "lms.content.read"],
};

function makeService(opts: { bytes?: Buffer | null; fileUploaded?: boolean } = {}) {
  const row = {
    id: "c-1",
    schoolId: "S",
    classId: "cls-1",
    type: "MATERIAL",
    status: "DRAFT",
    title: "Week 3 notes",
    authorId: "t-1",
    fileKey: "lms/S/c-1/123_notes.pdf",
    fileName: "notes.pdf",
    fileUploaded: opts.fileUploaded ?? false,
    subjectId: "sub-1",
    termId: "term-1",
  };

  const update = jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...row, ...data }));
  const tx = {
    lmsContent: { findFirst: jest.fn(async () => row), update },
    // The teacher-of-class scope resolves through several collaborators. A
    // double that answers only the ones the happy path happens to touch fails
    // in a way that reads as a code fault rather than a fixture one.
    classSubjectTeacher: {
      findFirst: jest.fn(async () => ({ id: "cst" })),
      findMany: jest.fn(async () => [{ classId: "cls-1" }]),
    },
    class: {
      findFirst: jest.fn(async () => ({ id: "cls-1", supervisorId: "t-1" })),
      findMany: jest.fn(async () => [{ id: "cls-1", supervisorId: "t-1" }]),
    },
    enrollment: {
      findFirst: jest.fn(async () => ({ id: "e-1" })),
      findMany: jest.fn(async () => [{ studentId: "s-1", classId: "cls-1" }]),
    },
    user: {
      findFirst: jest.fn(async () => ({ name: "A Teacher" })),
      findMany: jest.fn(async () => [{ id: "t-1", name: "A Teacher" }]),
    },
    auditLog: { create: jest.fn() },
  } as never;

  const storage = {
    presignUpload: jest.fn(async () => ({ url: "https://put", expiresInSeconds: 60 })),
    presignDownload: jest.fn(async () => ({ url: "https://get", expiresInSeconds: 60 })),
    download: jest.fn(async () => ("bytes" in opts ? opts.bytes : PDF)),
    upload: jest.fn(),
    exists: jest.fn(async () => true),
  };

  const db = {
    runAsTenant: <T,>(_c: unknown, fn: (t: unknown) => Promise<T>) => fn(tx),
    runAsTenantReadOnly: <T,>(_c: unknown, fn: (t: unknown) => Promise<T>) => fn(tx),
  };

  const svc = new LmsContentService(
    db as never,
    { record: jest.fn() } as never,
    { createRequest: jest.fn(), submit: jest.fn(), onFinalized: jest.fn() } as never,
    { enqueue: jest.fn(), enqueueMany: jest.fn(), notifyPermissionHolders: jest.fn() } as never,
    storage as never,
    { recordForContent: jest.fn(), onFinalized: jest.fn() } as never,
  );
  return { svc, storage, update, tx };
}

describe("confirming an upload checks the bytes, not the caller's word", () => {
  it("REFUSES when nothing arrived, and leaves the material unattached", async () => {
    const { svc, update } = makeService({ bytes: null });
    await expect(svc.confirmUpload(teacher as never, "c-1")).rejects.toBeInstanceOf(BadRequestException);
    // Not marked attached — so the teacher can simply choose the file again
    // rather than having to recreate the material.
    expect(update).not.toHaveBeenCalled();
  });

  it("REFUSES a file that is not a PDF, whatever it claimed to be", async () => {
    const { svc, update } = makeService({ bytes: NOT_PDF });
    await expect(svc.confirmUpload(teacher as never, "c-1")).rejects.toBeInstanceOf(BadRequestException);
    expect(update).not.toHaveBeenCalled();
  });

  it("REFUSES bytes past the cap, which the presign could only take on trust", async () => {
    const big = Buffer.concat([PDF, Buffer.alloc(26 * 1024 * 1024)]);
    const { svc, update } = makeService({ bytes: big });
    await expect(svc.confirmUpload(teacher as never, "c-1")).rejects.toBeInstanceOf(BadRequestException);
    expect(update).not.toHaveBeenCalled();
  });

  it("accepts a real PDF and marks it attached", async () => {
    const { svc, update } = makeService({ bytes: PDF });
    await svc.confirmUpload(teacher as never, "c-1");
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { fileUploaded: true } }));
  });
});

describe("the download opens in the browser, as the product says it does", () => {
  it("presigns it INLINE as a PDF, not as an attachment", async () => {
    const { svc, storage } = makeService({ fileUploaded: true });
    await svc.downloadUrl(teacher as never, "c-1");
    expect(storage.presignDownload).toHaveBeenCalledWith(
      expect.objectContaining({ inline: "application/pdf" }),
    );
  });

  it("NAMES the type it vouches for, rather than passing a flag", async () => {
    // The whole safety argument is that the server established what these bytes
    // are. A boolean `inline: true` would let a caller ask for inline serving
    // without saying what it had checked — and the S3 branch would then fall
    // back to the object's stored type, which came off the presigned PUT and is
    // the uploader's claim. That is the stored-XSS this module has a write-up
    // for, reintroduced.
    const { svc, storage } = makeService({ fileUploaded: true });
    await svc.downloadUrl(teacher as never, "c-1");
    const arg = (storage.presignDownload.mock.calls as unknown as Array<[{ inline?: unknown }]>)[0][0];
    expect(typeof arg.inline).toBe("string");
  });
});
