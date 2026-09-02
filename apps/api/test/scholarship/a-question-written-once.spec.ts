/**
 * A programme's paper lives inline on the programme, and that is right: a paper
 * that has been sat must never change under the candidates who sat it. The cost
 * was that nothing survived the programme — a question written for last year's
 * exam had to be typed again this year, and a correction reached only the one
 * paper it was typed into.
 *
 * So the library is something papers are assembled FROM, never a set of
 * references a paper points AT. Copying is the whole semantics.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { ScholarshipAdminService } from "../../src/scholarship/scholarship-admin.service";

const P = { userId: "op", schoolId: "plat", roles: ["super_admin"], permissions: [] } as never;

function svc(opts: { library?: Array<Record<string, unknown>>; paper?: unknown[] | null } = {}) {
  const library = opts.library ?? [];
  const audits: Array<{ action: string; meta: Record<string, unknown> }> = [];
  let written: unknown[] | null = null;
  const db = {
    scholarshipQuestion: {
      // HONOURS take/skip. A stub that returns everything however it is asked
      // models a database that cannot page, and the paging assertion would pass
      // against a service that had stopped paging — the harness trap this repo
      // records repeatedly.
      findMany: async (
        args: { where?: { id?: { in: string[] } }; take?: number; skip?: number; distinct?: string[] } = {},
      ) => {
        if (args.distinct) {
          const seen = new Set<string>();
          return library.filter((q) => !seen.has(q.subject as string) && seen.add(q.subject as string));
        }
        const rows = args.where?.id
          ? library
              .filter((q) => args.where!.id!.in.includes(q.id as string))
              // Every real client returns the BANK when the copy path includes
              // it — a stub without one models a question belonging to nothing,
              // which the schema forbids. READY is the ordinary case; the draft
              // case is exercised on its own below.
              .map((q) => ({ ...q, bank: { name: q.subject, status: "READY" } }))
          : library;
        const from = args.skip ?? 0;
        return args.take === undefined ? rows.slice(from) : rows.slice(from, from + args.take);
      },
      findFirst: async ({ where }: { where: { id: string } }) => library.find((q) => q.id === where.id) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => ({ id: "new", createdAt: new Date(), ...data }),
      update: async ({ data }: { data: Record<string, unknown> }) => ({
        id: "q1",
        createdAt: new Date(),
        ...library[0],
        ...data,
      }),
      deleteMany: async ({ where }: { where: { id: string } }) => ({
        count: library.some((q) => q.id === where.id) ? 1 : 0,
      }),
    },
    scholarshipQuestionBank: {
      // A question belongs to a BANK, and the bank decides its subject — every
      // real client has this lookup on the create path.
      findFirst: async () => ({ id: "b1", subjectName: "Maths", status: "DRAFT" }),
    },
    scholarshipProgram: {
      findFirst: async () => (opts.paper === null ? null : { examQuestions: opts.paper ?? [] }),
      update: async ({ data }: { data: { examQuestions: unknown[] } }) => {
        written = data.examQuestions;
        return {};
      },
    },
    $queryRaw: async () => [{ n: BigInt(library.length) }],
  };
  const s = Object.create(ScholarshipAdminService.prototype) as ScholarshipAdminService;
  Object.assign(s, {
    client: () => db,
    auditOwn: async (_p: unknown, action: string, _id: string, meta: Record<string, unknown>) => {
      audits.push({ action, meta });
    },
  });
  return { s, audits, paperWritten: () => written };
}

const Q = (id: string, subject: string, text: string) => ({
  id,
  subject,
  text,
  options: ["a", "b", "c"],
  answerIndex: 1,
  note: null,
  createdAt: new Date(),
});

describe("copying a library question onto a paper", () => {
  it("copies the question, not a reference to it", async () => {
    const { s, paperWritten } = svc({ library: [Q("q1", "Maths", "Which is prime?")] });
    const out = await s.copyLibraryToProgram(P, "prog", ["q1"]);
    expect(out).toEqual({ added: 1, skipped: 0 });
    // The COPY carries the text, options, answer and subject — everything the
    // paper needs to stand on its own.
    expect(paperWritten()).toEqual([
      { text: "Which is prime?", options: ["a", "b", "c"], answerIndex: 1, subject: "Maths" },
    ]);
  });

  it("APPENDS rather than replacing what is already on the paper", async () => {
    const existing = [{ text: "Old", options: ["x", "y"], answerIndex: 0, subject: "English" }];
    const { s, paperWritten } = svc({ library: [Q("q1", "Maths", "New")], paper: existing });
    await s.copyLibraryToProgram(P, "prog", ["q1"]);
    // A copy that wiped the paper would be a destructive action behind a button
    // that reads "add".
    expect(paperWritten()).toHaveLength(2);
    expect((paperWritten() as Array<{ text: string }>)[0].text).toBe("Old");
  });

  // Copying the same question twice gives a candidate the same question twice.
  it("skips a question already on the paper, and says how many", async () => {
    const existing = [{ text: "Which is prime?", options: ["a", "b", "c"], answerIndex: 1, subject: "Maths" }];
    const { s, paperWritten } = svc({ library: [Q("q1", "Maths", "Which is prime?")], paper: existing });
    const out = await s.copyLibraryToProgram(P, "prog", ["q1"]);
    expect(out).toEqual({ added: 0, skipped: 1 });
    // Nothing was written at all — not a rewrite with the same contents.
    expect(paperWritten()).toBeNull();
  });

  // The whole selection, never the recognised part: an operator building a
  // paper and handed fewer questions than they picked would not know which.
  it("refuses the whole selection when one question no longer exists", async () => {
    const { s, paperWritten } = svc({ library: [Q("q1", "Maths", "A")] });
    await expect(s.copyLibraryToProgram(P, "prog", ["q1", "gone"])).rejects.toThrow(/no longer exist/);
    expect(paperWritten()).toBeNull();
  });

  it("404s a programme that does not exist", async () => {
    const { s } = svc({ library: [Q("q1", "Maths", "A")], paper: null });
    await expect(s.copyLibraryToProgram(P, "nope", ["q1"])).rejects.toThrow(NotFoundException);
  });

  it("audits what was added and what was skipped", async () => {
    const existing = [{ text: "A", options: ["a", "b", "c"], answerIndex: 1, subject: "Maths" }];
    const { s, audits } = svc({ library: [Q("q1", "Maths", "A"), Q("q2", "Maths", "B")], paper: existing });
    await s.copyLibraryToProgram(P, "prog", ["q1", "q2"]);
    expect(audits[0]).toMatchObject({
      action: "scholarship.library.copy",
      meta: { requested: 2, added: 1, skipped: 1 },
    });
  });
});

describe("a library question's meaning is checked, not just its shape", () => {
  // The boundary bounds the SHAPE; an answerIndex past the last option is a
  // question nobody can get right, and it would be copied onto a paper and mark
  // every candidate wrong.
  it("refuses an answer that is not one of the options", async () => {
    const { s } = svc();
    await expect(
      s.createLibraryQuestion(P, { bankId: "b1", text: "x", options: ["a", "b"], answerIndex: 4 }),
    ).rejects.toThrow(BadRequestException);
  });

  // On UPDATE the two halves can arrive separately — shortening the options
  // without moving the answer is the realistic way to create that state.
  it("checks the answer against the options as they will BE after an edit", async () => {
    const { s } = svc({ library: [{ ...Q("q1", "Maths", "x"), options: ["a", "b", "c", "d"], answerIndex: 3 }] });
    await expect(s.updateLibraryQuestion(P, "q1", { options: ["a", "b"] })).rejects.toThrow(BadRequestException);
  });

  it("404s a question that does not exist", async () => {
    const { s } = svc();
    await expect(s.updateLibraryQuestion(P, "nope", { text: "x" })).rejects.toThrow(NotFoundException);
    await expect(s.deleteLibraryQuestion(P, "nope")).rejects.toThrow(NotFoundException);
  });
});

describe("browsing the library", () => {
  it("pages, and says there is more without counting the whole library", async () => {
    const many = Array.from({ length: 60 }, (_, i) => Q(`q${i}`, "Maths", `Q${i}`));
    const { s } = svc({ library: many });
    const page = await s.listLibrary(P, {});
    // 51 fetched, 50 returned — one past the page is the only honest way to say
    // "there is more" without paying for a full count.
    expect(page.items).toHaveLength(50);
    expect(page.hasMore).toBe(true);
  });

  it("offers only subjects the library actually holds", async () => {
    const { s } = svc({ library: [Q("q1", "Maths", "A"), Q("q2", "English", "B")] });
    const page = await s.listLibrary(P, {});
    expect(page.subjects.sort()).toEqual(["English", "Maths"]);
  });

  it("audits the read — the rows carry answer keys", async () => {
    const { s, audits } = svc({ library: [Q("q1", "Maths", "A")] });
    await s.listLibrary(P, {});
    expect(audits.map((a) => a.action)).toContain("scholarship.library.read");
  });
});

// =============================================================================
// A BANK is the unit an owner writes and the unit a paper draws on.
//
// The two states are the whole control: a DRAFT is being written and papers
// cannot draw on it; a READY bank is finished and cannot be added to without
// deliberately reopening it. Without that, "Save bank" is a label rather than
// a control, and a paper could be built from half a bank.
// =============================================================================
function bankSvc(opts: {
  banks?: Array<Record<string, unknown>>;
  questions?: Array<Record<string, unknown>>;
} = {}) {
  const banks = opts.banks ?? [];
  const questions = opts.questions ?? [];
  const audits: Array<{ action: string; meta: Record<string, unknown> }> = [];
  const created: Array<Record<string, unknown>> = [];
  const db = {
    scholarshipQuestionBank: {
      findFirst: async ({ where }: { where: { id: string } }) => {
        const b = banks.find((x) => x.id === where.id);
        return b ? { _count: { questions: questions.filter((q) => q.bankId === b.id).length }, ...b } : null;
      },
      // HONOURS take/skip, like its sibling above: a stub that pages by
      // ignoring the arguments would pass against a service that stopped.
      findMany: async (args: { take?: number; skip?: number; distinct?: string[] } = {}) => {
        if (args.distinct) return banks;
        const from = args.skip ?? 0;
        const rows = banks.map((b) => ({
          _count: { questions: questions.filter((q) => q.bankId === b.id).length },
          ...b,
        }));
        return args.take === undefined ? rows.slice(from) : rows.slice(from, from + args.take);
      },
      count: async () => banks.length,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: "nb", createdAt: new Date(), updatedAt: new Date(), status: "DRAFT", _count: { questions: 0 }, ...data };
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const b = banks.find((x) => x.id === where.id);
        if (!b) throw new Error("not found");
        Object.assign(b, data);
        return { ...b, updatedAt: new Date(), _count: { questions: questions.filter((q) => q.bankId === b.id).length } };
      },
      deleteMany: async ({ where }: { where: { id: string } }) => ({
        count: banks.some((b) => b.id === where.id) ? 1 : 0,
      }),
    },
    scholarshipQuestion: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: "nq", createdAt: new Date(), ...data };
      },
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        questions
          .filter((q) => where.id.in.includes(q.id as string))
          .map((q) => ({ ...q, bank: banks.find((b) => b.id === q.bankId) })),
      count: async () => questions.length,
    },
    scholarshipProgram: {
      findFirst: async () => ({ examQuestions: [] }),
      update: async () => ({}),
    },
  };
  const s = Object.create(ScholarshipAdminService.prototype) as ScholarshipAdminService;
  Object.assign(s, {
    client: () => db,
    auditOwn: async (_p: unknown, action: string, _id: string, meta: Record<string, unknown>) => {
      audits.push({ action, meta });
    },
  });
  return { s, audits, created };
}

const BANK = (id: string, status: string, name = "Mathematics") => ({
  id,
  name,
  subjectCode: "MTH",
  subjectName: name,
  status,
  createdAt: new Date(),
  updatedAt: new Date(),
});

describe("writing a question bank", () => {
  // The subject comes from the shared catalogue, so "Mathematics" means the
  // same thing to schools on different curricula.
  it("refuses a subject that is not in the catalogue", async () => {
    const { s } = bankSvc();
    await expect(s.createBank(P, { subjectCode: "NOT-A-SUBJECT" })).rejects.toThrow(BadRequestException);
  });

  it("names the bank for its subject unless the owner says otherwise", async () => {
    const { s, created } = bankSvc();
    await s.createBank(P, { subjectCode: "MTH" });
    expect(created[0].name).toBe(created[0].subjectName);
    const two = bankSvc();
    await two.s.createBank(P, { subjectCode: "MTH", name: "Junior paper 1" });
    expect(two.created[0].name).toBe("Junior paper 1");
    // The CODE is stored beside the name, because the name is what a person
    // reads and the code is what makes two banks comparable.
    expect(two.created[0].subjectCode).toBe("MTH");
  });

  // A READY bank is a finished paper. Adding to one silently would change what
  // a programme draws on after somebody declared it done.
  it("refuses a question added to a saved bank, and names the way out", async () => {
    const { s } = bankSvc({ banks: [BANK("b1", "READY")] });
    await expect(
      s.createLibraryQuestion(P, { bankId: "b1", text: "2+2?", options: ["3", "4"], answerIndex: 1 }),
    ).rejects.toThrow(/Reopen it/);
  });

  // ONE PLACE says what subject a question is. Two would be two places to
  // disagree, and the paper is derived from the question's subject.
  it("takes the question's subject from the bank, never from the caller", async () => {
    const { s, created } = bankSvc({ banks: [BANK("b1", "DRAFT", "Chemistry")] });
    await s.createLibraryQuestion(P, {
      bankId: "b1",
      text: "H2O?",
      options: ["water", "acid"],
      answerIndex: 0,
    } as never);
    expect(created[0].subject).toBe("Chemistry");
    expect(created[0].bankId).toBe("b1");
  });

  it("404s a bank that does not exist", async () => {
    const { s } = bankSvc();
    await expect(
      s.createLibraryQuestion(P, { bankId: "nope", text: "x", options: ["a", "b"], answerIndex: 0 }),
    ).rejects.toThrow(NotFoundException);
  });

  // An empty bank is not a paper. Anything else may be saved: 60-100 is
  // guidance on the screen, and refusing at 59 would invent a rule nobody set.
  it("refuses to save an empty bank and accepts a short one", async () => {
    const empty = bankSvc({ banks: [BANK("b1", "DRAFT")] });
    await expect(empty.s.saveBank(P, "b1")).rejects.toThrow(/at least one question/);

    const short = bankSvc({
      banks: [BANK("b1", "DRAFT")],
      questions: [{ id: "q1", bankId: "b1" }],
    });
    expect((await short.s.saveBank(P, "b1")).status).toBe("READY");
  });

  it("reopens a saved bank so it can be corrected", async () => {
    const { s } = bankSvc({ banks: [BANK("b1", "READY")], questions: [{ id: "q1", bankId: "b1" }] });
    expect((await s.reopenBank(P, "b1")).status).toBe("DRAFT");
    // and it can then be added to again
    await expect(
      s.createLibraryQuestion(P, { bankId: "b1", text: "x", options: ["a", "b"], answerIndex: 0 }),
    ).resolves.toBeDefined();
  });

  // COUNTED, never loaded: a hundred questions per bank across a page of
  // twenty-five is 2,500 rows shipped through the ORM to render a number.
  it("counts a bank's questions in the database rather than loading them", async () => {
    const src = readFileSync(
      path.join(__dirname, "../../src/scholarship/scholarship-admin.service.ts"),
      "utf8",
    );
    const a = src.indexOf("async listBanks(");
    const list = src.slice(a, src.indexOf("\n  private bankDto", a));
    expect(list).toMatch(/_count: \{ select: \{ questions: true \} \}/);
    expect(list).not.toMatch(/include: \{ questions:/);
  });

  it("pages the bank list", async () => {
    const many = Array.from({ length: 30 }, (_, i) => BANK(`b${i}`, "DRAFT"));
    const { s } = bankSvc({ banks: many });
    const page = await s.listBanks(P, {});
    expect(page.items).toHaveLength(25);
    expect(page.hasMore).toBe(true);
  });
});

describe("a paper may only draw on a finished bank", () => {
  // THE POINT OF "Save bank". A paper built from a bank still being written is
  // built from whatever happened to exist that afternoon.
  it("refuses questions from a draft bank, naming it", async () => {
    const { s } = bankSvc({
      banks: [BANK("b1", "DRAFT")],
      questions: [{ id: "q1", bankId: "b1", subject: "Mathematics", text: "t", options: ["a", "b"], answerIndex: 0, note: null }],
    });
    await expect(s.copyLibraryToProgram(P, "prog", ["q1"])).rejects.toThrow(/Mathematics/);
    await expect(s.copyLibraryToProgram(P, "prog", ["q1"])).rejects.toThrow(/Save the bank/);
  });

  it("copies from a saved bank", async () => {
    const { s } = bankSvc({
      banks: [BANK("b1", "READY")],
      questions: [{ id: "q1", bankId: "b1", subject: "Mathematics", text: "t", options: ["a", "b"], answerIndex: 0, note: null }],
    });
    await expect(s.copyLibraryToProgram(P, "prog", ["q1"])).resolves.toEqual({ added: 1, skipped: 0 });
  });
});
