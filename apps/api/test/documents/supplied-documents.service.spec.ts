// =============================================================================
// Who may handle whose paperwork, and what a confirmed upload actually is
// =============================================================================
// Two properties carry this module.
//
// AUTHORITY IS SPLIT BY SIDE OF THE SCHOOL, and the SERVICE is the only place
// that decides — a route decorator cannot see which side a request is about,
// because that is a property of the subject, not of the route.
//
//   a pupil's  -> student.profile.write  (principal / school_admin / junior_admin)
//   a staff's  -> hr.write               (principal / school_admin / hr_clerk / hr_manager)
//
// An HR clerk has no business verifying a child's birth certificate, and a
// registrar none verifying a teacher's licence. Reusing permissions that already
// exist is deliberate: a new one needs the seed re-run against every live
// database before the endpoint works at all.
//
// The first attempt gated the controller on document.write, which reads as safe
// and is wrong twice over: HR roles do not hold it, so the people who own staff
// onboarding were locked out of their own half; and a teacher does hold it, so
// the gate admitted somebody it should not. Both are pinned below.
//
// A CONFIRMED UPLOAD MEANS BYTES EXIST AND ARE WHAT THEY CLAIM. The file travels
// browser→bucket through a presigned URL, so confirm is the first and only
// moment the API can look at it. Absent bytes, an oversized file and a
// mislabelled one are three different answers, and only one of them leaves the
// row reusable.
// =============================================================================

import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { SuppliedDocumentsService } from "../../src/documents/supplied-documents.service";
import { MAX_UPLOAD_BYTES } from "@sms/types";

const PDF = Buffer.from("%PDF-1.7\nrest of a document");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const HTML = Buffer.from("<script>alert(document.domain)</script>");

const registrar = {
  userId: "reg-1",
  schoolId: "school-1",
  roles: ["school_admin"],
  permissions: ["document.write", "student.profile.write"],
} as never;

// A REAL hr_clerk: note the absence of document.write, which is exactly what
// the first version of the controller demanded of them.
const hr = {
  userId: "hr-1",
  schoolId: "school-1",
  roles: ["hr_clerk"],
  permissions: ["hr.write"],
} as never;

const teacher = {
  userId: "t-1",
  schoolId: "school-1",
  roles: ["teacher"],
  permissions: ["document.write"],
} as never;

type Row = Record<string, unknown>;

function build(opts: { submissions?: Row[]; requirements?: Row[]; bytes?: Buffer | null } = {}) {
  const requirements: Row[] = opts.requirements ?? [
    { id: "req-1", appliesTo: "STUDENT_ADMISSION", key: "birth_certificate", label: "Birth certificate", description: null, mandatory: true, needsExpiry: false, sequence: 0, active: true },
  ];
  const submissions: Row[] = opts.submissions ?? [];
  const deleted: string[] = [];
  const audits: string[] = [];

  const documents: Row[] = [];
  const staffDocuments: Row[] = [];
  const tx = {
    admissionApplication: {
      findFirst: ({ where }: { where: { id: string } }) =>
        Promise.resolve(where.id === "app-1" ? { id: "app-1", childName: "Chidi" } : null),
    },
    document: { create: ({ data }: { data: Row }) => { documents.push(data); return Promise.resolve(data); } },
    staffDocument: { create: ({ data }: { data: Row }) => { staffDocuments.push(data); return Promise.resolve(data); } },
    documentRequirement: {
      findMany: ({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(requirements.filter((r) => (where.appliesTo ? r.appliesTo === where.appliesTo : true) && (where.active === undefined || r.active === where.active))),
      findFirst: ({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(requirements.find((r) => (where.id ? r.id === where.id : true) && (where.key ? r.key === where.key : true)) ?? null),
      create: ({ data }: { data: Row }) => {
        const row = { ...data, id: `req-${requirements.length + 1}` };
        requirements.push(row);
        return Promise.resolve(row);
      },
      update: ({ where, data }: { where: { id: string }; data: Row }) => {
        const row = requirements.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        return Promise.resolve(row);
      },
    },
    documentSubmission: {
      findMany: () => Promise.resolve(submissions),
      findFirst: ({ where }: { where: { id: string } }) =>
        Promise.resolve(submissions.find((s) => s.id === where.id) ?? null),
      create: ({ data }: { data: Row }) => {
        const row = { ...data, id: (data.id as string) ?? `sub-${submissions.length + 1}`, createdAt: new Date() };
        submissions.push(row);
        return Promise.resolve(row);
      },
      update: ({ where, data }: { where: { id: string }; data: Row }) => {
        const row = submissions.find((s) => s.id === where.id)!;
        Object.assign(row, data);
        return Promise.resolve(row);
      },
      updateMany: ({ where, data }: { where: Record<string, unknown>; data: Row }) => {
        const hit = submissions.filter((s) => s.subjectKind === where.subjectKind && s.subjectId === where.subjectId);
        hit.forEach((r) => Object.assign(r, data));
        return Promise.resolve({ count: hit.length });
      },
    },
    user: {
      findMany: () => Promise.resolve([]),
      findFirst: ({ where }: { where: { id: string } }) =>
        Promise.resolve(where.id === "stu-1" ? { id: "stu-1" } : null),
    },
  };

  const db = {
    runAsTenant: (_c: unknown, fn: (t: unknown) => Promise<unknown>) => fn(tx),
    runAsTenantReadOnly: (_c: unknown, fn: (t: unknown) => Promise<unknown>) => fn(tx),
  };

  const storage = {
    presignUpload: () => Promise.resolve({ url: "https://bucket/put", expiresInSeconds: 900 }),
    download: () => Promise.resolve(opts.bytes === undefined ? PDF : opts.bytes),
    delete: (key: string) => {
      deleted.push(key);
      return Promise.resolve();
    },
  };

  const audit = {
    record: (entry: { action: string }) => {
      audits.push(entry.action);
      return Promise.resolve();
    },
  };

  const svc = new SuppliedDocumentsService(db as never, audit as never, storage as never);
  return { svc, submissions, requirements, deleted, audits, documents, staffDocuments };
}

describe("who may handle whose paperwork", () => {
  it("lets a registrar manage a pupil's admission documents", async () => {
    const { svc } = build();
    await expect(svc.listRequirements(registrar, "STUDENT_ADMISSION")).resolves.toHaveLength(1);
  });

  it("refuses the registrar a member of staff's documents", async () => {
    const { svc } = build();
    await expect(svc.checklist(registrar, "STAFF", "u-1")).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("refuses HR a pupil's documents", async () => {
    // The other half of the split: HR is refused the student side outright.
    const { svc } = build();
    await expect(svc.checklist(hr, "ADMISSION_APPLICATION", "app-1")).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("refuses a teacher both, despite document.write", async () => {
    const { svc } = build();
    await expect(svc.checklist(teacher, "ADMISSION_APPLICATION", "app-1")).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.checklist(teacher, "STAFF", "u-1")).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("lets an HR clerk manage the STAFF side", async () => {
    // The bug this pins, found by calling the API as an hr_clerk rather than by
    // reading it: the controller used to gate on document.write, which HR roles
    // do not hold — so the people who own staff onboarding were refused their
    // own half of the module, while a teacher (who does hold it) sailed through.
    const { svc } = build({ requirements: [] });
    await expect(svc.listRequirements(hr, "STAFF_ONBOARDING")).resolves.toEqual([]);
    await expect(svc.checklist(hr, "STAFF", "u-1")).resolves.toBeTruthy();
    await expect(svc.seedDefaults(hr, "STAFF_ONBOARDING")).resolves.toMatchObject({ existing: 0 });
  });

  it("treats an applicant as the staff side and a pupil as the student side", async () => {
    const { svc } = build({ requirements: [] });
    await expect(svc.checklist(hr, "APPLICANT", "cand-1")).resolves.toBeTruthy();
    await expect(svc.checklist(registrar, "STUDENT", "stu-1")).resolves.toBeTruthy();
  });

  it("rejects a subject kind it does not know", async () => {
    const { svc } = build();
    await expect(svc.checklist(registrar, "SOMEBODY_ELSE", "x")).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("handing out an upload ticket", () => {
  it("refuses a type nobody should be sending", async () => {
    const { svc } = build();
    await expect(
      svc.startUpload(registrar, { subjectKind: "ADMISSION_APPLICATION", subjectId: "app-1", filename: "x.html", contentType: "text/html" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("writes the row BEFORE the bytes are asked for", async () => {
    // The bytes go browser→bucket where the API cannot see them. Without a row
    // written first there is nothing to confirm against, and a half-finished
    // upload leaves an object nothing knows about.
    const { svc, submissions } = build();
    const ticket = await svc.startUpload(registrar, {
      subjectKind: "ADMISSION_APPLICATION",
      subjectId: "app-1",
      requirementId: "req-1",
      filename: "cert.pdf",
      contentType: "application/pdf",
    });
    expect(ticket.uploadUrl).toContain("https://");
    expect(ticket.maxBytes).toBe(MAX_UPLOAD_BYTES);
    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toMatchObject({ status: "PENDING", id: ticket.submissionId });
  });

  it("will not file a pupil's document against a staff requirement", async () => {
    const { svc } = build({
      requirements: [{ id: "req-staff", appliesTo: "STAFF_ONBOARDING", key: "cv", label: "CV", mandatory: true, needsExpiry: false, sequence: 0, active: true }],
    });
    await expect(
      svc.startUpload(registrar, { subjectKind: "ADMISSION_APPLICATION", subjectId: "app-1", requirementId: "req-staff", filename: "a.pdf", contentType: "application/pdf" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("confirming that an upload really arrived", () => {
  const pending = () => [{
    id: "sub-1",
    subjectKind: "ADMISSION_APPLICATION",
    subjectId: "app-1",
    requirementId: "req-1",
    storageKey: "schools/school-1/submissions/sub-1",
    contentType: "application/pdf",
    status: "PENDING",
    createdAt: new Date(),
  } as Row];

  it("accepts a real PDF and records what the BYTES are", async () => {
    const { svc, submissions } = build({ submissions: pending(), bytes: PDF });
    const dto = await svc.confirmUpload(registrar, "sub-1");
    expect(dto.status).toBe("UPLOADED");
    expect(submissions[0]).toMatchObject({ contentType: "application/pdf", sizeBytes: PDF.length });
  });

  it("accepts a photograph, because that is what parents send", async () => {
    const rows = pending();
    rows[0].contentType = "image/png";
    const { svc, submissions } = build({ submissions: rows, bytes: PNG });
    await svc.confirmUpload(registrar, "sub-1");
    expect(submissions[0]).toMatchObject({ status: "UPLOADED", contentType: "image/png" });
  });

  it("leaves the row PENDING when no bytes arrived, so the ticket still works", async () => {
    // The ordinary failure: a browser closed mid-upload. Refusing it must not
    // burn the row, or the family has to start again.
    const { svc, submissions } = build({ submissions: pending(), bytes: null });
    await expect(svc.confirmUpload(registrar, "sub-1")).rejects.toBeInstanceOf(BadRequestException);
    expect(submissions[0].status).toBe("PENDING");
  });

  it("refuses a file whose bytes are not what it claimed, and throws the bytes away", async () => {
    // A content type is a claim by a member of the public. This is the only
    // moment the API can check it.
    const { svc, submissions, deleted } = build({ submissions: pending(), bytes: HTML });
    await expect(svc.confirmUpload(registrar, "sub-1")).rejects.toThrow(/not a PDF/i);
    expect(submissions[0]).toMatchObject({ status: "REJECTED", storageKey: null });
    expect(deleted).toHaveLength(1);
  });

  it("refuses a file over the size cap and throws the bytes away", async () => {
    const huge = Buffer.concat([PDF, Buffer.alloc(MAX_UPLOAD_BYTES)]);
    const { svc, submissions, deleted } = build({ submissions: pending(), bytes: huge });
    await expect(svc.confirmUpload(registrar, "sub-1")).rejects.toThrow(/larger than/i);
    expect(submissions[0].status).toBe("REJECTED");
    expect(deleted).toHaveLength(1);
  });

  it("cannot be confirmed twice", async () => {
    const { svc } = build({ submissions: pending(), bytes: PDF });
    await svc.confirmUpload(registrar, "sub-1");
    await expect(svc.confirmUpload(registrar, "sub-1")).rejects.toBeInstanceOf(BadRequestException);
  });

  it("404s for a submission belonging to another school", async () => {
    // RLS scopes the read, so a foreign id simply is not there — and the answer
    // must not distinguish that from a wrong id.
    const { svc } = build({ submissions: [] });
    await expect(svc.confirmUpload(registrar, "someone-elses")).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("deciding on what arrived", () => {
  const uploaded = () => [{
    id: "sub-1",
    subjectKind: "ADMISSION_APPLICATION",
    subjectId: "app-1",
    requirementId: "req-1",
    storageKey: "k",
    contentType: "application/pdf",
    status: "UPLOADED",
    createdAt: new Date(),
  } as Row];

  it("records WHO verified it, not merely that it was verified", async () => {
    const { svc, submissions } = build({ submissions: uploaded() });
    const dto = await svc.decide(registrar, "sub-1", { status: "VERIFIED" });
    expect(dto.status).toBe("VERIFIED");
    expect(submissions[0]).toMatchObject({ verifiedById: "reg-1" });
    expect(submissions[0].verifiedAt).toBeInstanceOf(Date);
  });

  it("insists on a reason for a rejection", async () => {
    // Without one the family cannot act, and will send the same file again.
    const { svc } = build({ submissions: uploaded() });
    await expect(svc.decide(registrar, "sub-1", { status: "REJECTED" })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.decide(registrar, "sub-1", { status: "REJECTED", reason: "  " })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("keeps the reason where the family will see it", async () => {
    const { svc, submissions } = build({ submissions: uploaded() });
    await svc.decide(registrar, "sub-1", { status: "REJECTED", reason: "The page is cut off — please resend." });
    expect(submissions[0]).toMatchObject({ status: "REJECTED", rejectedReason: "The page is cut off — please resend." });
  });

  it("will not judge a file that has not arrived", async () => {
    const rows = uploaded();
    rows[0].status = "PENDING";
    const { svc } = build({ submissions: rows });
    await expect(svc.decide(registrar, "sub-1", { status: "VERIFIED" })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("clears the rejection reason when a resubmission is accepted", async () => {
    const rows = uploaded();
    rows[0].rejectedReason = "was blurry";
    const { svc, submissions } = build({ submissions: rows });
    await svc.decide(registrar, "sub-1", { status: "VERIFIED" });
    expect(submissions[0].rejectedReason).toBeNull();
  });
});

describe("waiving something that will never arrive", () => {
  it("records a decision, with no file and a reason", async () => {
    const { svc, submissions } = build();
    const dto = await svc.waive(registrar, {
      subjectKind: "ADMISSION_APPLICATION",
      subjectId: "app-1",
      requirementId: "req-1",
      reason: "Certificate lost in the flood; sworn declaration accepted.",
    });
    expect(dto.status).toBe("WAIVED");
    expect(submissions[0]).toMatchObject({ status: "WAIVED", verifiedById: "reg-1" });
    expect(submissions[0].storageKey).toBeUndefined();
  });

  it("insists on a reason", async () => {
    const { svc } = build();
    await expect(
      svc.waive(registrar, { subjectKind: "ADMISSION_APPLICATION", subjectId: "app-1", requirementId: "req-1", reason: " " }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("closes the outstanding list", async () => {
    const { svc } = build();
    await svc.waive(registrar, { subjectKind: "ADMISSION_APPLICATION", subjectId: "app-1", requirementId: "req-1", reason: "Accepted a declaration instead." });
    const list = await svc.checklist(registrar, "ADMISSION_APPLICATION", "app-1");
    expect(list.outstanding).toHaveLength(0);
    expect(list.progress.complete).toBe(true);
  });
});

describe("adopting the platform's starting list", () => {
  it("fills an empty list", async () => {
    const { svc, requirements } = build({ requirements: [] });
    const r = await svc.seedDefaults(registrar, "STUDENT_ADMISSION");
    expect(r.created).toBeGreaterThan(0);
    expect(requirements).toHaveLength(r.created);
  });

  it("never duplicates or overwrites what a school has curated", async () => {
    // The button exists to fill an empty list, not to reset one somebody has
    // spent time on.
    const { svc, requirements } = build({
      requirements: [{ id: "req-1", appliesTo: "STUDENT_ADMISSION", key: "birth_certificate", label: "OUR OWN WORDING", description: null, mandatory: false, needsExpiry: false, sequence: 0, active: true }],
    });
    await svc.seedDefaults(registrar, "STUDENT_ADMISSION");
    const first = requirements.length;
    await svc.seedDefaults(registrar, "STUDENT_ADMISSION");
    expect(requirements).toHaveLength(first);
    expect(requirements.find((r) => r.key === "birth_certificate")).toMatchObject({
      label: "OUR OWN WORDING",
      mandatory: false,
    });
  });

  it("is refused to somebody from the other side of the school", async () => {
    const { svc } = build({ requirements: [] });
    await expect(svc.seedDefaults(hr, "STUDENT_ADMISSION")).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe("reading the bytes back", () => {
  it("audits every download — these are a child's identity papers", async () => {
    const { svc, audits } = build({
      submissions: [{ id: "sub-1", subjectKind: "ADMISSION_APPLICATION", subjectId: "app-1", storageKey: "k", contentType: "application/pdf", originalName: "cert.pdf", status: "VERIFIED", createdAt: new Date() } as Row],
      bytes: PDF,
    });
    const out = await svc.file(registrar, "sub-1");
    expect(out.filename).toBe("cert.pdf");
    expect(audits).toContain("document.submission.download");
  });

  it("404s a waiver, which has no file by definition", async () => {
    const { svc } = build({
      submissions: [{ id: "sub-1", subjectKind: "ADMISSION_APPLICATION", subjectId: "app-1", storageKey: null, status: "WAIVED", createdAt: new Date() } as Row],
    });
    await expect(svc.file(registrar, "sub-1")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("refuses somebody from the other side of the school", async () => {
    const { svc } = build({
      submissions: [{ id: "sub-1", subjectKind: "ADMISSION_APPLICATION", subjectId: "app-1", storageKey: "k", status: "VERIFIED", createdAt: new Date() } as Row],
      bytes: PDF,
    });
    await expect(svc.file(hr, "sub-1")).rejects.toBeInstanceOf(ForbiddenException);
  });
});

// -----------------------------------------------------------------------------
// Following a person from applicant to pupil, or candidate to colleague
// -----------------------------------------------------------------------------
// A promotion changes who a file BELONGS to. The storage key is reused, so a
// child's birth certificate exists once in the bucket however many records
// point at it — copying bytes would mean two objects to protect, two to purge
// and two chances to keep one after the other was deleted.
// -----------------------------------------------------------------------------

describe("promoting an application onto a pupil", () => {
  const arrived = (status: string, id = "s-1") => ({
    id, subjectKind: "ADMISSION_APPLICATION", subjectId: "app-1", requirementId: "req-1",
    storageKey: `schools/x/${id}`, contentType: "application/pdf", originalName: "cert.pdf",
    sizeBytes: 1234, status, createdAt: new Date(),
  } as Row);

  it("puts what arrived into the pupil's vault, reusing the same object", async () => {
    const { svc, documents } = build({ submissions: [arrived("VERIFIED")] });
    await expect(svc.promoteApplication(registrar, "app-1", "stu-1")).resolves.toEqual({ promoted: 1 });
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({ studentId: "stu-1", storageKey: "schools/x/s-1", status: "UPLOADED" });
  });

  it("moves the submissions to the pupil, so the history follows too", async () => {
    const { svc, submissions } = build({ submissions: [arrived("VERIFIED")] });
    await svc.promoteApplication(registrar, "app-1", "stu-1");
    expect(submissions[0]).toMatchObject({ subjectKind: "STUDENT", subjectId: "stu-1" });
  });

  it("carries neither a PENDING upload nor a REJECTED one into the vault", async () => {
    // A PENDING upload never completed and a REJECTED one was refused. Putting
    // either on a pupil's permanent record would say something untrue about it.
    const { svc, documents } = build({
      submissions: [arrived("PENDING", "s-1"), arrived("REJECTED", "s-2"), arrived("UPLOADED", "s-3")],
    });
    await expect(svc.promoteApplication(registrar, "app-1", "stu-1")).resolves.toEqual({ promoted: 1 });
    expect(documents.map((d) => d.storageKey)).toEqual(["schools/x/s-3"]);
  });

  it("404s an application or a pupil that is not this school's", async () => {
    const { svc } = build({ submissions: [] });
    await expect(svc.promoteApplication(registrar, "someone-elses", "stu-1")).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.promoteApplication(registrar, "app-1", "not-a-pupil")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("is refused to somebody from the staff side of the school", async () => {
    const { svc } = build({ submissions: [] });
    await expect(svc.promoteApplication(hr, "app-1", "stu-1")).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe("promoting a candidate into a member of staff", () => {
  it("carries the CV that convert() used to orphan", async () => {
    const { svc, submissions, staffDocuments } = build({ submissions: [] });
    const tx = (await (svc as unknown as { db: { runAsTenant: (c: unknown, f: (t: unknown) => Promise<unknown>) => Promise<unknown> } }).db.runAsTenant({}, async (t) => t)) as never;
    const out = await svc.promoteApplicantInTx(tx, {
      schoolId: "school-1", actorId: "hr-1", applicantId: "cand-1", userId: "u-9",
      cvKey: "careers/school-1/abc.pdf", cvName: "ada-cv.pdf",
    });
    expect(out.cvCarried).toBe(true);
    // Visible to the checklist...
    expect(submissions[0]).toMatchObject({ subjectKind: "STAFF", subjectId: "u-9", storageKey: "careers/school-1/abc.pdf", status: "UPLOADED", uploadedByUserId: null });
    // ...and to HR's own document list.
    expect(staffDocuments).toHaveLength(1);
  });

  it("moves anything else the candidate sent onto the member of staff", async () => {
    const { svc, submissions } = build({
      submissions: [{ id: "s-1", subjectKind: "APPLICANT", subjectId: "cand-1", requirementId: null, storageKey: "k", status: "UPLOADED", createdAt: new Date() } as Row],
    });
    const tx = (await (svc as unknown as { db: { runAsTenant: (c: unknown, f: (t: unknown) => Promise<unknown>) => Promise<unknown> } }).db.runAsTenant({}, async (t) => t)) as never;
    const out = await svc.promoteApplicantInTx(tx, { schoolId: "school-1", actorId: "hr-1", applicantId: "cand-1", userId: "u-9", cvKey: null });
    expect(out).toMatchObject({ promoted: 1, cvCarried: false });
    expect(submissions[0]).toMatchObject({ subjectKind: "STAFF", subjectId: "u-9" });
  });

  it("is a no-op for a candidate who sent nothing", async () => {
    const { svc, staffDocuments } = build({ submissions: [] });
    const tx = (await (svc as unknown as { db: { runAsTenant: (c: unknown, f: (t: unknown) => Promise<unknown>) => Promise<unknown> } }).db.runAsTenant({}, async (t) => t)) as never;
    await expect(
      svc.promoteApplicantInTx(tx, { schoolId: "school-1", actorId: "hr-1", applicantId: "cand-1", userId: "u-9", cvKey: null }),
    ).resolves.toEqual({ promoted: 0, cvCarried: false });
    expect(staffDocuments).toHaveLength(0);
  });
});
