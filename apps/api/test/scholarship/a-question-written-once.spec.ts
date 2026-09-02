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
          ? library.filter((q) => args.where!.id!.in.includes(q.id as string))
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
      s.createLibraryQuestion(P, { subject: "Maths", text: "x", options: ["a", "b"], answerIndex: 4 }),
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
