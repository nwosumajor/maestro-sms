// =============================================================================
// An unauthenticated write endpoint on the internet that accepts files
// =============================================================================
// A parent has no account, so the link they are sent IS the credential. Assume
// it leaks: forwarded to a WhatsApp group, left in a shared inbox, read off a
// screen. Everything below is what makes that survivable.
//
// The property the whole surface is designed around: A LEAKED LINK MUST NOT
// PUBLISH A CHILD'S BIRTH CERTIFICATE. It can send files in; it can never read
// one back. Bytes are served only on the authenticated, audited staff route.
//
// And the subject comes out of the SIGNATURE, never out of the request — the
// same rule the platform applies to school_id (Golden Rule #3). There is no
// route here that takes an application id.
// =============================================================================

import { BadRequestException, NotFoundException } from "@nestjs/common";
import { mintDocumentUploadToken, verifyDocumentUploadToken } from "../../src/documents/document-upload-token";
import { mintInviteToken } from "../../src/auth/invite";
import { SuppliedDocumentsService } from "../../src/documents/supplied-documents.service";
import { MAX_SUBMISSIONS_PER_SUBJECT, MAX_UPLOAD_BYTES } from "@sms/types";

const SCHOOL = "11111111-1111-1111-1111-111111111111";
const APP = "22222222-2222-2222-2222-222222222222";
const OTHER_APP = "33333333-3333-3333-3333-333333333333";

const PDF = Buffer.from("%PDF-1.7 a document");
const HTML = Buffer.from("<script>alert(1)</script>");

beforeAll(() => {
  process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "test-secret-for-upload-tokens";
});

type Row = Record<string, unknown>;

function build(opts: { status?: string; submissions?: Row[]; bytes?: Buffer | null } = {}) {
  const submissions: Row[] = opts.submissions ?? [];
  const requirements: Row[] = [
    { id: "req-1", appliesTo: "STUDENT_ADMISSION", key: "birth_certificate", label: "Birth certificate", description: null, mandatory: true, needsExpiry: false, sequence: 0, active: true },
  ];
  const deleted: string[] = [];
  const audits: string[] = [];
  const tx = {
    admissionApplication: {
      findFirst: ({ where }: { where: { id: string } }) =>
        Promise.resolve(where.id === APP ? { childName: "Chidi Okafor", status: opts.status ?? "ACCEPTED" } : null),
    },
    documentRequirement: {
      findMany: () => Promise.resolve(requirements),
      findFirst: ({ where }: { where: { id: string } }) => Promise.resolve(requirements.find((r) => r.id === where.id) ?? null),
    },
    documentSubmission: {
      findMany: ({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(submissions.filter((s) => s.subjectId === where.subjectId)),
      findFirst: ({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(
          submissions.find((s) => s.id === where.id && (where.subjectId === undefined || s.subjectId === where.subjectId)) ?? null,
        ),
      count: ({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(submissions.filter((s) => s.subjectId === where.subjectId).length),
      create: ({ data }: { data: Row }) => {
        submissions.push({ ...data, createdAt: new Date() });
        return Promise.resolve(data);
      },
      update: ({ where, data }: { where: { id: string }; data: Row }) => {
        const row = submissions.find((s) => s.id === where.id)!;
        Object.assign(row, data);
        return Promise.resolve(row);
      },
    },
    user: { findMany: () => Promise.resolve([]) },
  };
  const db = {
    runAsTenant: (_c: unknown, fn: (t: unknown) => Promise<unknown>) => fn(tx),
    runAsTenantReadOnly: (_c: unknown, fn: (t: unknown) => Promise<unknown>) => fn(tx),
  };
  const storage = {
    presignUpload: ({ key }: { key: string }) => Promise.resolve({ url: `https://bucket/${key}`, expiresInSeconds: 900 }),
    download: () => Promise.resolve(opts.bytes === undefined ? PDF : opts.bytes),
    delete: (key: string) => { deleted.push(key); return Promise.resolve(); },
  };
  const audit = { record: (e: { action: string }) => { audits.push(e.action); return Promise.resolve(); } };
  const svc = new SuppliedDocumentsService(db as never, audit as never, storage as never,
    // The school's day, for the expiry rule. A real TenantTx always resolves
    // one; a stub without it models something the platform cannot produce.
    { todayInTx: async () => new Date("2026-08-29T00:00:00.000Z") } as never);
  return { svc, submissions, deleted, audits, subject: { applicationId: APP, schoolId: SCHOOL } };
}

describe("the token itself", () => {
  it("round-trips the application it speaks for", () => {
    const t = mintDocumentUploadToken(APP, SCHOOL);
    expect(verifyDocumentUploadToken(t)).toEqual({ applicationId: APP, schoolId: SCHOOL });
  });

  it("refuses a session or invite token replayed here", () => {
    // The purpose is what keeps the token families apart on one shared secret.
    expect(verifyDocumentUploadToken(mintInviteToken(APP, SCHOOL))).toBeNull();
  });

  it("refuses a forged, empty or nonsense token with the SAME answer", () => {
    // One null for every failure: which check failed is information, and the
    // person asking is unauthenticated.
    expect(verifyDocumentUploadToken(undefined)).toBeNull();
    expect(verifyDocumentUploadToken("")).toBeNull();
    expect(verifyDocumentUploadToken("not.a.token")).toBeNull();
    expect(verifyDocumentUploadToken(`${mintDocumentUploadToken(APP, SCHOOL)}x`)).toBeNull();
  });

  it("refuses one signed with a different secret", () => {
    const jwt = require("jsonwebtoken") as typeof import("jsonwebtoken");
    const forged = jwt.sign({ sub: APP, school_id: SCHOOL, purpose: "docupload" }, "not-the-secret", { algorithm: "HS256" });
    expect(verifyDocumentUploadToken(forged)).toBeNull();
  });
});

describe("what a family can see", () => {
  it("shows what is still wanted, and the school's reason for a refusal", async () => {
    const { svc } = build({
      submissions: [
        { id: "s-1", subjectId: APP, subjectKind: "ADMISSION_APPLICATION", requirementId: "req-1", status: "REJECTED", rejectedReason: "The page is cut off.", storageKey: null, createdAt: new Date() },
      ],
    });
    const view = await svc.publicChecklist({ applicationId: APP, schoolId: SCHOOL });
    expect(view.childName).toBe("Chidi Okafor");
    expect(view.outstanding.map((r) => r.key)).toEqual(["birth_certificate"]);
    expect(view.submitted[0]).toMatchObject({ status: "REJECTED", rejectedReason: "The page is cut off." });
  });

  it("never hands back a storage key or anything that could fetch bytes", async () => {
    // THE property. A leaked link must not publish a child's birth certificate.
    const { svc } = build({
      submissions: [{ id: "s-1", subjectId: APP, subjectKind: "ADMISSION_APPLICATION", requirementId: "req-1", status: "UPLOADED", storageKey: "schools/x/submissions/s-1", contentType: "application/pdf", createdAt: new Date(), uploadedAt: new Date() }],
    });
    const view = await svc.publicChecklist({ applicationId: APP, schoolId: SCHOOL });
    const serialised = JSON.stringify(view);
    expect(serialised).not.toContain("storageKey");
    expect(serialised).not.toContain("schools/x/submissions");
    // Not even the submission id: there is nothing a family can do with one,
    // and it is one less handle to point at anything.
    expect(serialised).not.toContain("s-1");
  });

  it("hides an upload that never completed", async () => {
    const { svc } = build({
      submissions: [{ id: "s-1", subjectId: APP, subjectKind: "ADMISSION_APPLICATION", requirementId: "req-1", status: "PENDING", storageKey: "k", createdAt: new Date() }],
    });
    const view = await svc.publicChecklist({ applicationId: APP, schoolId: SCHOOL });
    expect(view.submitted).toHaveLength(0);
  });

  it("says nothing at all about a rejected application", async () => {
    // 404 for both "wrong application" and "we said no" — a token holder must
    // not be able to tell the difference.
    const { svc } = build({ status: "REJECTED" });
    await expect(svc.publicChecklist({ applicationId: APP, schoolId: SCHOOL })).rejects.toBeInstanceOf(NotFoundException);
  });

  it("404s an application that is not this school's", async () => {
    const { svc } = build();
    await expect(svc.publicChecklist({ applicationId: OTHER_APP, schoolId: SCHOOL })).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("sending a file in", () => {
  it("files it against the token's application, with no uploader", async () => {
    const { svc, submissions } = build();
    const ticket = await svc.publicStartUpload({ applicationId: APP, schoolId: SCHOOL }, {
      requirementId: "req-1",
      filename: "birth-cert.pdf",
      contentType: "application/pdf",
    });
    expect(ticket.maxBytes).toBe(MAX_UPLOAD_BYTES);
    expect(submissions[0]).toMatchObject({
      subjectId: APP,
      subjectKind: "ADMISSION_APPLICATION",
      status: "PENDING",
      // A parent has no account; this is what the nullable column is for.
      uploadedByUserId: null,
    });
  });

  it("refuses a type nobody should be sending", async () => {
    const { svc } = build();
    await expect(
      svc.publicStartUpload({ applicationId: APP, schoolId: SCHOOL }, { filename: "x.html", contentType: "text/html" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("bounds how much one link may pile up", async () => {
    // Rate limiting slows a valid token down; this is what stops it filling the
    // bucket over a week.
    const submissions = Array.from({ length: MAX_SUBMISSIONS_PER_SUBJECT }, (_, i) => ({
      id: `s-${i}`, subjectId: APP, subjectKind: "ADMISSION_APPLICATION", status: "UPLOADED", createdAt: new Date(),
    })) as Row[];
    const { svc } = build({ submissions });
    await expect(
      svc.publicStartUpload({ applicationId: APP, schoolId: SCHOOL }, { filename: "a.pdf", contentType: "application/pdf" }),
    ).rejects.toThrow(/as many documents as it can hold/);
  });

  it("will not upload against a rejected application", async () => {
    const { svc } = build({ status: "REJECTED" });
    await expect(
      svc.publicStartUpload({ applicationId: APP, schoolId: SCHOOL }, { filename: "a.pdf", contentType: "application/pdf" }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("confirming what arrived", () => {
  const pending = () => [{
    id: "s-1", subjectId: APP, subjectKind: "ADMISSION_APPLICATION", requirementId: "req-1",
    storageKey: "schools/x/submissions/s-1", contentType: "application/pdf", status: "PENDING", createdAt: new Date(),
  } as Row];

  it("accepts a real PDF and records it against the SYSTEM actor", async () => {
    const { svc, submissions, audits } = build({ submissions: pending(), bytes: PDF });
    await expect(svc.publicConfirm({ applicationId: APP, schoolId: SCHOOL }, "s-1")).resolves.toEqual({ status: "UPLOADED" });
    expect(submissions[0]).toMatchObject({ status: "UPLOADED", contentType: "application/pdf" });
    // There is no user to attribute it to, and a file landing on a child's
    // application is worth a record either way.
    expect(audits).toContain("document.submission.upload.public");
  });

  it("refuses bytes that are not what they claimed, and throws them away", async () => {
    const { svc, submissions, deleted } = build({ submissions: pending(), bytes: HTML });
    await expect(svc.publicConfirm({ applicationId: APP, schoolId: SCHOOL }, "s-1")).rejects.toThrow(/not a PDF/i);
    expect(submissions[0]).toMatchObject({ status: "REJECTED", storageKey: null });
    expect(deleted).toHaveLength(1);
  });

  it("leaves the row PENDING when nothing arrived, so the family can retry", async () => {
    const { svc, submissions } = build({ submissions: pending(), bytes: null });
    await expect(svc.publicConfirm({ applicationId: APP, schoolId: SCHOOL }, "s-1")).rejects.toThrow(/not received/i);
    expect(submissions[0].status).toBe("PENDING");
  });

  it("cannot confirm a submission belonging to another application", async () => {
    // A valid link for one child, pointed at another child's upload id. The
    // query is constrained by the token's subject, so there is nothing to find.
    const rows = pending();
    rows[0].subjectId = OTHER_APP;
    const { svc } = build({ submissions: rows, bytes: PDF });
    await expect(svc.publicConfirm({ applicationId: APP, schoolId: SCHOOL }, "s-1")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("cannot be replayed to re-open a decided submission", async () => {
    const rows = pending();
    rows[0].status = "VERIFIED";
    const { svc } = build({ submissions: rows, bytes: PDF });
    await expect(svc.publicConfirm({ applicationId: APP, schoolId: SCHOOL }, "s-1")).rejects.toBeInstanceOf(BadRequestException);
  });
});
