// =============================================================================
// Content is narrowed to the subjects a pupil OFFERS
// =============================================================================
// Class enrolment is not the same thing as offering a subject. A Physics
// handout tagged to the class was shown to every pupil in it, including those
// who never took Physics.
//
// The fail-OPEN cases carry as much weight as the filtering ones: a school that
// does not use subject selection must be completely unaffected. Narrowing on
// absent data would hide every tagged material from every pupil — a far worse
// failure than showing one handout too many — so those tests are not padding.
//
// The tx fake EVALUATES the where. This is a filter, and the one thing a mock
// must not do is answer the same way regardless of it.
// =============================================================================

import { NotFoundException } from "@nestjs/common";
import { LmsContentService } from "../../src/lms/lms-content.service";
import type { Principal, TenantTx } from "../../src/integrity/integrity.foundation";

const pupil = { userId: "stu1", schoolId: "s1", roles: ["student"], permissions: [] } as unknown as Principal;
const teacher = { userId: "t1", schoolId: "s1", roles: ["teacher"], permissions: [] } as unknown as Principal;

type Row = { id: string; subjectId: string | null; title: string };

const CONTENT: Row[] = [
  { id: "c-phys", subjectId: "phys", title: "Physics handout" },
  { id: "c-lit", subjectId: "lit", title: "Literature notes" },
  { id: "c-general", subjectId: null, title: "Class notice" },
];

function harness(opts: {
  currentTerm?: boolean;
  selection?: { status: string; subjectIds: unknown } | null;
  staff?: boolean;
}) {
  /** Applies the service's own OR clause to the fixture, so deleting the clause
   *  changes what comes back. */
  const matches = (where: Record<string, unknown>, r: Row) => {
    const or = where.OR as Array<Record<string, unknown>> | undefined;
    if (!or) return true;
    return or.some((c) => {
      if ("subjectId" in c && c.subjectId === null) return r.subjectId === null;
      const inList = (c.subjectId as { in?: string[] } | undefined)?.in;
      return inList ? r.subjectId !== null && inList.includes(r.subjectId) : false;
    });
  };

  const tx = {
    term: {
      findFirst: jest.fn().mockResolvedValue(opts.currentTerm === false ? null : { id: "term1" }),
    },
    subjectSelection: {
      findFirst: jest.fn((args: { where: { status?: string } }) => {
        const sel = opts.selection;
        if (!sel) return Promise.resolve(null);
        // Honour the status filter — only APPROVED selections may narrow.
        if (args.where.status && args.where.status !== sel.status) return Promise.resolve(null);
        return Promise.resolve({ subjectIds: sel.subjectIds });
      }),
    },
    lmsContent: {
      findMany: jest.fn((args: { where: Record<string, unknown> }) =>
        Promise.resolve(
          CONTENT.filter((r) => matches(args.where, r)).map((r) => ({
            ...r,
            classId: "cls1",
            type: "MATERIAL",
            status: "PUBLISHED",
            authorId: "t1",
            body: {},
            createdAt: new Date(),
          })),
        ),
      ),
    },
    enrollment: { findMany: jest.fn().mockResolvedValue([{ classId: "cls1" }]), findFirst: jest.fn().mockResolvedValue({ id: "e1" }) },
    class: { findMany: jest.fn().mockResolvedValue([{ id: "cls1", name: "JSS2" }]), findFirst: jest.fn().mockResolvedValue({ id: "cls1" }) },
    classTeacher: { findFirst: jest.fn().mockResolvedValue(opts.staff ? { id: "ct1" } : null) },
    classSubjectTeacher: { findFirst: jest.fn().mockResolvedValue(opts.staff ? { id: "o1" } : null) },
    parentChild: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null) },
    lmsProgress: { findMany: jest.fn().mockResolvedValue([]) },
    user: { findMany: jest.fn().mockResolvedValue([{ id: "t1", name: "Teacher" }]) },
  } as unknown as TenantTx;

  const db = {
    runAsTenant: <T>(_c: unknown, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    runAsTenantReadOnly: <T>(_c: unknown, fn: (t: TenantTx) => Promise<T>) => fn(tx),
  };
  const svc = new LmsContentService(
    db as never,
    { record: jest.fn().mockResolvedValue(undefined) } as never,
    { create: jest.fn(), review: jest.fn() } as never,
    { enqueue: jest.fn(), enqueueMany: jest.fn() } as never,
    { presignDownload: jest.fn(), presignUpload: jest.fn() } as never,
    { getStudentSessionReport: jest.fn() } as never,
  );
  return { svc, tx };
}

const titles = (rows: Array<{ title: string }>) => rows.map((r) => r.title).sort();

describe("a pupil sees only the subjects they offer", () => {
  it("hides a subject they did not take, keeps untagged class material", async () => {
    const { svc } = harness({ selection: { status: "APPROVED", subjectIds: ["phys"] } });
    const rows = await svc.listContent(pupil, "cls1");
    expect(titles(rows)).toEqual(["Class notice", "Physics handout"]);
  });

  it("untagged material is ALWAYS visible", async () => {
    // subjectId was optional long before this filter existed, so every
    // pre-existing row is untagged. Narrowing those away would empty the page.
    const { svc } = harness({ selection: { status: "APPROVED", subjectIds: ["nothing-matches"] } });
    const rows = await svc.listContent(pupil, "cls1");
    expect(titles(rows)).toEqual(["Class notice"]);
  });
});

describe("it fails OPEN wherever the school has not made a choice", () => {
  it("no subject selection at all -> sees everything", async () => {
    const { svc } = harness({ selection: null });
    expect(titles(await svc.listContent(pupil, "cls1"))).toHaveLength(3);
  });

  it("a selection still awaiting approval does NOT narrow", async () => {
    // Acting on an unapproved choice would enforce a decision nobody has made.
    const { svc } = harness({ selection: { status: "PENDING_ADMIN", subjectIds: ["phys"] } });
    expect(titles(await svc.listContent(pupil, "cls1"))).toHaveLength(3);
  });

  it("no current term -> sees everything", async () => {
    const { svc } = harness({ currentTerm: false, selection: { status: "APPROVED", subjectIds: ["phys"] } });
    expect(titles(await svc.listContent(pupil, "cls1"))).toHaveLength(3);
  });

  it("an approved selection naming nothing does NOT hide everything", async () => {
    const { svc } = harness({ selection: { status: "APPROVED", subjectIds: [] } });
    expect(titles(await svc.listContent(pupil, "cls1"))).toHaveLength(3);
  });
});

describe("staff are never narrowed", () => {
  it("a teacher of the class sees every subject", async () => {
    // Staff need the whole picture to teach and to review it.
    const { svc } = harness({ staff: true, selection: { status: "APPROVED", subjectIds: ["phys"] } });
    expect(titles(await svc.listContent(teacher, "cls1"))).toHaveLength(3);
  });
});

describe("the item read and the PDF download honour the same rule", () => {
  const row = {
    id: "c-lit",
    classId: "cls1",
    subjectId: "lit",
    status: "PUBLISHED",
    type: "MATERIAL",
    authorId: "t1",
    body: {},
    fileKey: "k",
    fileName: "notes.pdf",
    fileUploaded: true,
  };

  it("404s a pupil opening a subject they do not offer", async () => {
    // Hiding a row from the list while still serving it by id would make the
    // filter cosmetic for anyone holding a link.
    const { svc, tx } = harness({ selection: { status: "APPROVED", subjectIds: ["phys"] } });
    (tx as unknown as { lmsContent: { findFirst: jest.Mock } }).lmsContent.findFirst = jest
      .fn()
      .mockResolvedValue(row);
    await expect(svc.getContent(pupil, "c-lit")).rejects.toThrow(NotFoundException);
  });

  it("allows the pupil who does offer it", async () => {
    const { svc, tx } = harness({ selection: { status: "APPROVED", subjectIds: ["lit"] } });
    (tx as unknown as { lmsContent: { findFirst: jest.Mock } }).lmsContent.findFirst = jest
      .fn()
      .mockResolvedValue(row);
    await expect(svc.getContent(pupil, "c-lit")).resolves.toBeDefined();
  });
});

// =============================================================================
// The PDF a teacher attaches
// =============================================================================
// The upload endpoints existed and NOTHING in the web called them, so a teacher
// could not attach a PDF at all — the schema columns, the service and the
// student-side download were all built around a step that was unreachable.
//
// Both checks below are server-side on purpose: the presign hands out a URL
// that writes directly to our bucket, so a browser-side check is a convenience,
// never a control.

describe("attaching a PDF to a material", () => {
  function uploadHarness(row: Record<string, unknown>) {
    const updates: Array<Record<string, unknown>> = [];
    const tx = {
      lmsContent: {
        findFirst: jest.fn().mockResolvedValue(row),
        update: jest.fn((args: { data: Record<string, unknown> }) => {
          updates.push(args.data);
          return Promise.resolve({ ...row, ...args.data });
        }),
      },
      classSubjectTeacher: { findFirst: jest.fn().mockResolvedValue({ id: "o1" }) },
      classTeacher: { findFirst: jest.fn().mockResolvedValue({ id: "ct1" }) },
      class: { findFirst: jest.fn().mockResolvedValue({ id: "cls1" }) },
    } as unknown as TenantTx;
    const presignUpload = jest.fn().mockResolvedValue({ url: "https://storage/put" });
    const db = { runAsTenant: <T>(_c: unknown, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
    const svc = new LmsContentService(
      db as never,
      { record: jest.fn().mockResolvedValue(undefined) } as never,
      { create: jest.fn(), review: jest.fn() } as never,
      { enqueue: jest.fn(), enqueueMany: jest.fn() } as never,
      { presignUpload, presignDownload: jest.fn() } as never,
      { getStudentSessionReport: jest.fn() } as never,
    );
    return { svc, presignUpload, updates };
  }

  const draft = { id: "m1", classId: "cls1", type: "MATERIAL", status: "DRAFT", authorId: "t1", body: {} };
  const pdf = { fileName: "week3.pdf", contentType: "application/pdf", sizeBytes: 1024 };

  it("accepts a PDF and records the pending upload", async () => {
    const { svc, presignUpload, updates } = uploadHarness(draft);
    await expect(svc.presignUpload(teacher, "m1", pdf)).resolves.toEqual({ url: "https://storage/put" });
    expect(presignUpload).toHaveBeenCalled();
    // fileUploaded stays false until confirm — a row claiming a file that never
    // arrived would show pupils a download that 404s.
    expect(updates[0]).toMatchObject({ fileName: "week3.pdf", fileUploaded: false });
  });

  it("refuses anything that is not a PDF", async () => {
    const { svc, presignUpload } = uploadHarness(draft);
    await expect(
      svc.presignUpload(teacher, "m1", { ...pdf, fileName: "sheet.xlsx", contentType: "application/vnd.ms-excel" }),
    ).rejects.toThrow(/Only PDF/);
    expect(presignUpload).not.toHaveBeenCalled();
  });

  it("refuses a file over the size cap", async () => {
    const { svc, presignUpload } = uploadHarness(draft);
    await expect(svc.presignUpload(teacher, "m1", { ...pdf, sizeBytes: 40 * 1024 * 1024 })).rejects.toThrow(/limit is 25 MB/);
    expect(presignUpload).not.toHaveBeenCalled();
  });

  it("refuses once the material is awaiting approval", async () => {
    // Swapping the file under a reviewer would mean they approved something else.
    const { svc } = uploadHarness({ ...draft, status: "PENDING_APPROVAL" });
    await expect(svc.presignUpload(teacher, "m1", pdf)).rejects.toThrow(/locked/i);
  });
});
