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

// =============================================================================
// A syllabus topic carries its subject onto the content
// =============================================================================
// This is what made the whole scoping rule reachable for the case it exists
// for. A teacher attaching notes to a week of the SS3 Physics plan set
// syllabusItemId and NOTHING else, so the row stayed untagged — and untagged
// means "general class material, always visible". Every pupil in SS3 got the
// Physics handout, including those who never took Physics.

describe("content created against a syllabus topic", () => {
  function createHarness(syllabusSubjectId: string) {
    const created: Array<Record<string, unknown>> = [];
    const tx = {
      subjectSyllabusItem: { findFirst: jest.fn().mockResolvedValue({ syllabusId: "syl1" }) },
      subjectSyllabus: {
        findFirst: jest.fn().mockResolvedValue({ classId: "cls1", subjectId: syllabusSubjectId }),
      },
      classSubjectTeacher: { findFirst: jest.fn().mockResolvedValue({ id: "o1" }) },
      classTeacher: { findFirst: jest.fn().mockResolvedValue({ id: "ct1" }) },
      class: { findFirst: jest.fn().mockResolvedValue({ id: "cls1" }) },
      subject: { findFirst: jest.fn().mockResolvedValue({ id: "phys", name: "Physics" }) },
      term: { findFirst: jest.fn().mockResolvedValue({ id: "term1" }) },
      lmsContent: {
        create: jest.fn((args: { data: Record<string, unknown> }) => {
          created.push(args.data);
          return Promise.resolve({ id: "new", ...args.data, status: "DRAFT", authorId: "t1", body: {} });
        }),
      },
      lmsContentRevision: { create: jest.fn().mockResolvedValue({}), count: jest.fn().mockResolvedValue(0) },
      user: {
        findFirst: jest.fn().mockResolvedValue({ id: "t1", name: "Teacher" }),
        findMany: jest.fn().mockResolvedValue([{ id: "t1", name: "Teacher" }]),
      },
    } as unknown as TenantTx;
    const db = { runAsTenant: <T>(_c: unknown, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
    const svc = new LmsContentService(
      db as never,
      { record: jest.fn().mockResolvedValue(undefined) } as never,
      { create: jest.fn(), review: jest.fn() } as never,
      { enqueue: jest.fn(), enqueueMany: jest.fn() } as never,
      { presignUpload: jest.fn(), presignDownload: jest.fn() } as never,
      { getStudentSessionReport: jest.fn() } as never,
    );
    return { svc, created };
  }

  const base = {
    classId: "cls1",
    type: "MATERIAL" as const,
    title: "Week 3 handout",
    body: { kind: "MATERIAL" as const, description: "Reading" },
  };

  it("INHERITS the subject from the topic", async () => {
    const { svc, created } = createHarness("phys");
    await svc.createContent(teacher, { ...base, syllabusItemId: "item1" });
    expect(created[0]).toMatchObject({ subjectId: "phys", syllabusItemId: "item1" });
  });

  it("an explicit subject still wins over the topic's", async () => {
    // Inheritance fills a blank; it must never override what was actually asked
    // for. Subject WITHOUT a term — that is the access tag. Adding a term would
    // be report-card tagging, which a MATERIAL is still rightly refused.
    const { svc, created } = createHarness("phys");
    await svc.createContent(teacher, { ...base, syllabusItemId: "item1", subjectId: "chem" });
    expect(created[0]).toMatchObject({ subjectId: "chem" });
  });

  it("a MATERIAL still cannot be tagged for the report card", async () => {
    const { svc } = createHarness("phys");
    await expect(
      svc.createContent(teacher, { ...base, subjectId: "phys", termId: "term1" }),
    ).rejects.toThrow(/Only quizzes and assignments/);
  });

  it("no topic and no subject stays untagged — general class material", async () => {
    const { svc, created } = createHarness("phys");
    await svc.createContent(teacher, base);
    expect(created[0]).toMatchObject({ subjectId: null, syllabusItemId: null });
  });
});

// =============================================================================
// A SUBJECT teacher may author — for their own subject only
// =============================================================================
// Assigning someone to teach SS3 Physics writes a classSubjectTeacher row and
// NO ClassTeacher row. The syllabus service reads the offering, so they could
// write the SS3 Physics SYLLABUS — while `canAuthor` read only ClassTeacher, so
// they got "Class not found" creating the lesson notes that hang off it. Same
// person, same class, two different answers to "do you teach here".
//
// Granting authorship is what makes the second rule necessary: the Physics
// teacher must not publish something tagged Literature, nor anything UNTAGGED,
// which reaches pupils who do not take their subject.

describe("a subject teacher with no ClassTeacher row", () => {
  /** What the CLASS offers — a superset of what any one teacher teaches. */
  const CLASS_OFFERS = ["phys", "chem", "lit"];

  function subjectTeacherHarness(taught: string[], existing?: Record<string, unknown>) {
    const created: Array<Record<string, unknown>> = [];
    const tx = {
      // Not class-wide. Only the offerings below.
      classTeacher: { findFirst: jest.fn().mockResolvedValue(null) },
      classSubjectTeacher: {
        // THREE different questions reach this table and they must not share one
        // answer:
        //   { classId, teacherId }            -> do I teach anything here?
        //   { classId, subjectId }            -> does the CLASS offer this?
        //   { classId, teacherId } findMany   -> which subjects are mine?
        // The class offers Literature — taught by somebody else. Answering
        // "not offered" for it hid the rule under test behind a different error.
        findFirst: jest.fn((args: { where: { teacherId?: string; subjectId?: string } }) => {
          const { teacherId, subjectId } = args.where;
          if (teacherId && !subjectId) return Promise.resolve(taught.length > 0 ? { id: "o1" } : null);
          if (subjectId && !teacherId) return Promise.resolve(CLASS_OFFERS.includes(subjectId) ? { id: "o1" } : null);
          return Promise.resolve(subjectId && taught.includes(subjectId) ? { id: "o1" } : null);
        }),
        findMany: jest.fn().mockResolvedValue(taught.map((subjectId) => ({ subjectId }))),
      },
      subjectSyllabusItem: { findFirst: jest.fn().mockResolvedValue({ syllabusId: "syl1" }) },
      subjectSyllabus: { findFirst: jest.fn().mockResolvedValue({ classId: "cls1", subjectId: "phys" }) },
      class: { findFirst: jest.fn().mockResolvedValue({ id: "cls1" }) },
      subject: { findFirst: jest.fn().mockResolvedValue({ id: "phys", name: "ZZ Physics" }) },
      term: { findFirst: jest.fn().mockResolvedValue({ id: "term1" }) },
      lmsContent: {
        findFirst: jest.fn().mockResolvedValue(existing ?? null),
        create: jest.fn((args: { data: Record<string, unknown> }) => {
          created.push(args.data);
          return Promise.resolve({ id: "new", ...args.data, status: "DRAFT", authorId: "t1", body: {} });
        }),
        update: jest.fn((args: { data: Record<string, unknown> }) =>
          Promise.resolve({ ...(existing ?? {}), ...args.data })),
      },
      lmsContentRevision: { create: jest.fn().mockResolvedValue({}), count: jest.fn().mockResolvedValue(0) },
      user: {
        findFirst: jest.fn().mockResolvedValue({ id: "t1", name: "Teacher" }),
        findMany: jest.fn().mockResolvedValue([{ id: "t1", name: "Teacher" }]),
      },
    } as unknown as TenantTx;
    const db = { runAsTenant: <T>(_c: unknown, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
    const svc = new LmsContentService(
      db as never,
      { record: jest.fn().mockResolvedValue(undefined) } as never,
      { create: jest.fn(), review: jest.fn() } as never,
      { enqueue: jest.fn(), enqueueMany: jest.fn() } as never,
      { presignUpload: jest.fn(), presignDownload: jest.fn() } as never,
      { getStudentSessionReport: jest.fn() } as never,
    );
    return { svc, created };
  }

  const base = {
    classId: "cls1",
    type: "MATERIAL" as const,
    title: "Week 3 handout",
    body: { kind: "MATERIAL" as const, description: "Motion under gravity" },
  };

  it("CAN author for the class, via their offering", async () => {
    const { svc, created } = subjectTeacherHarness(["phys"]);
    await svc.createContent(teacher, { ...base, syllabusItemId: "item1" });
    expect(created[0]).toMatchObject({ subjectId: "phys" });
  });

  it("cannot publish for a subject they do not teach", async () => {
    const { svc, created } = subjectTeacherHarness(["phys"]);
    await expect(svc.createContent(teacher, { ...base, subjectId: "lit" })).rejects.toThrow(
      /only publish content for a subject you teach/i,
    );
    expect(created).toHaveLength(0);
  });

  it("CAN publish untagged, addressing the whole class", async () => {
    // Corrected model. A senior class is organised as a stream — SS3 Science is
    // a cohort where everyone offers the science set — so the Physics teacher
    // addressing the class IS addressing their own pupils. Refusing this
    // modelled the class as a mixed group who happen to share some subjects.
    const { svc, created } = subjectTeacherHarness(["phys"]);
    await svc.createContent(teacher, base);
    expect(created[0]).toMatchObject({ subjectId: null });
  });

  it("a teacher of two subjects may use either", async () => {
    const { svc, created } = subjectTeacherHarness(["phys", "chem"]);
    await svc.createContent(teacher, { ...base, subjectId: "chem" });
    expect(created[0]).toMatchObject({ subjectId: "chem" });
  });

  it("cannot RE-TAG an existing draft to a subject they do not teach", async () => {
    // The create guard alone was a hole: make it Physics, then PATCH it to
    // Literature. A guard on one write path and not the other is not a guard.
    const { svc } = subjectTeacherHarness(["phys"], {
      id: "c1",
      classId: "cls1",
      type: "MATERIAL",
      status: "DRAFT",
      authorId: "t1",
      body: {},
      subjectId: "phys",
    });
    await expect(svc.updateContent(teacher, "c1", { subjectId: "lit" })).rejects.toThrow(
      /only publish content for a subject you teach/i,
    );
  });

  it("CAN widen a draft from one subject to the whole class", async () => {
    const { svc } = subjectTeacherHarness(["phys"], {
      id: "c1",
      classId: "cls1",
      type: "MATERIAL",
      status: "DRAFT",
      authorId: "t1",
      body: {},
      subjectId: "phys",
    });
    await expect(svc.updateContent(teacher, "c1", { subjectId: null })).resolves.toBeDefined();
  });
});
