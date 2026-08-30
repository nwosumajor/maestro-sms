/**
 * THE CLASS TEACHER'S REMARK IS THE CLASS TEACHER'S.
 *
 * `setClassTeacherRemark` and `setTraits` both refused with "Only the pupil's
 * class teacher or a school administrator may…" and both authorised on
 * `teachesStudent` — the UNION of supervising a class and teaching one subject
 * to it. So a class's eleven subject teachers could each perform an act the
 * refusal reserved for one of them, and both surfaces state a rule the code did
 * not enforce.
 *
 * It is not only a permission a subject teacher should not have had. The remark
 * is ONE column keyed on (pupil, term) and a rating is ONE row per (pupil,
 * term, trait), so writing is an OVERWRITE of somebody else's signed judgement
 * about a child, with the card then attributing it to whoever wrote last.
 * Measured live before the fix: a class teacher's remark replaced by a subject
 * teacher's and re-signed with their name, no history, nothing to say so.
 *
 * The two are tested together on purpose. Fixing one and leaving its sibling is
 * the defect class this repo keeps recording, and these two are the same rule
 * in almost the same words.
 */
import { ForbiddenException } from "@nestjs/common";
import { classTeacherOnlyRefusal, supervisesStudent } from "../../src/common/teaches";

type Row = Record<string, unknown>;

/** A tiny store that answers the caller's own `where`, so a query that stops
 *  filtering fails rather than being handed a fixed answer. */
function tx(opts: {
  enrolments: Array<{ studentId: string; classId: string; status: string }>;
  classes: Array<{ id: string; name: string; supervisorId: string | null }>;
  offerings: Array<{ classId: string; teacherId: string }>;
  users?: Array<{ id: string; name: string }>;
}) {
  const match = (row: Row, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([k, v]) => {
      const actual = row[k];
      if (v && typeof v === "object" && "in" in (v as Record<string, unknown>)) {
        return ((v as { in: unknown[] }).in ?? []).includes(actual);
      }
      return actual === v;
    });
  const find = (rows: Row[], where: Record<string, unknown>) => rows.filter((r) => match(r, where));
  return {
    enrollment: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => find(opts.enrolments as Row[], where),
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        find(opts.enrolments as Row[], where)[0] ?? null,
    },
    class: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => find(opts.classes as Row[], where),
      findFirst: async ({ where }: { where: Record<string, unknown> }) => find(opts.classes as Row[], where)[0] ?? null,
    },
    classSubjectTeacher: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => find(opts.offerings as Row[], where),
    },
    user: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        find((opts.users ?? []) as Row[], where)[0] ?? null,
    },
  } as never;
}

const PUPIL = "pupil-1";
const FORM = "class-a";
const CLASS_TEACHER = "ct-1";
const SUBJECT_TEACHER = "st-1";
const STRANGER = "other-1";

const world = tx({
  enrolments: [{ studentId: PUPIL, classId: FORM, status: "ACTIVE" }],
  classes: [{ id: FORM, name: "SS1A", supervisorId: CLASS_TEACHER }],
  offerings: [{ classId: FORM, teacherId: SUBJECT_TEACHER }],
  users: [{ id: CLASS_TEACHER, name: "James Adams" }],
});

describe("who may write the class teacher's remark", () => {
  it("the class teacher of the pupil's class may", async () => {
    await expect(supervisesStudent(world, CLASS_TEACHER, PUPIL)).resolves.toBe(true);
  });

  it("a SUBJECT teacher of that same class may NOT — the defect this exists for", async () => {
    await expect(supervisesStudent(world, SUBJECT_TEACHER, PUPIL)).resolves.toBe(false);
  });

  it("somebody with no link to the pupil may not", async () => {
    await expect(supervisesStudent(world, STRANGER, PUPIL)).resolves.toBe(false);
  });

  it("a class teacher of ANOTHER class may not", async () => {
    const two = tx({
      enrolments: [{ studentId: PUPIL, classId: FORM, status: "ACTIVE" }],
      classes: [
        { id: FORM, name: "SS1A", supervisorId: CLASS_TEACHER },
        { id: "class-b", name: "SS1B", supervisorId: "ct-2" },
      ],
      offerings: [],
    });
    await expect(supervisesStudent(two, "ct-2", PUPIL)).resolves.toBe(false);
  });

  it("supervision follows ACTIVE enrolment only — a pupil promoted out is not theirs", async () => {
    const left = tx({
      enrolments: [{ studentId: PUPIL, classId: FORM, status: "PROMOTED" }],
      classes: [{ id: FORM, name: "SS1A", supervisorId: CLASS_TEACHER }],
      offerings: [],
    });
    await expect(supervisesStudent(left, CLASS_TEACHER, PUPIL)).resolves.toBe(false);
  });
});

describe("the refusal", () => {
  it("names the class teacher to somebody who teaches the pupil, so they know who to ask", async () => {
    const msg = await classTeacherOnlyRefusal(world, SUBJECT_TEACHER, PUPIL, "write this remark");
    expect(msg).toContain("James Adams");
    expect(msg).toContain("SS1A");
  });

  it("stays GENERIC for somebody with no link — a refusal is not a way to ask who a pupil is", async () => {
    const msg = await classTeacherOnlyRefusal(world, STRANGER, PUPIL, "write this remark");
    expect(msg).not.toContain("James Adams");
    expect(msg).not.toContain("SS1A");
    expect(msg).toContain("class teacher");
  });

  it("says so when the class has NO class teacher, rather than naming nobody", async () => {
    const none = tx({
      enrolments: [{ studentId: PUPIL, classId: FORM, status: "ACTIVE" }],
      classes: [{ id: FORM, name: "SS1A", supervisorId: null }],
      offerings: [{ classId: FORM, teacherId: SUBJECT_TEACHER }],
    });
    const msg = await classTeacherOnlyRefusal(none, SUBJECT_TEACHER, PUPIL, "write this remark");
    expect(msg).toContain("no class teacher yet");
    expect(msg).toContain("SS1A");
  });

  it("is a Forbidden a caller can act on, not a bare status", () => {
    expect(new ForbiddenException("x").getStatus()).toBe(403);
  });
});

/**
 * AND THE CALLERS, because a test on a helper proves nothing about the services
 * that use it — the seam that hid the CBT score and the report-card promotion
 * line in this repo. Bounded to the METHOD by name, never a fixed window: a
 * window one scope too wide fails exactly like one too narrow, and comments are
 * stripped first so the prose explaining this fix cannot make it pass.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "..", "..", "src", "reportcards");

function methodBody(file: string, signature: string): string {
  const raw = readFileSync(join(SRC, file), "utf8");
  const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const start = stripped.indexOf(signature);
  expect(start).toBeGreaterThan(-1);
  // The BODY's brace, not the first one after the name: `setTraits(... ratings:
  // Array<{ traitKey: string }>)` opens a brace inside its own parameter list,
  // and taking that one yielded a 35-character "method". Walk the parameter
  // parens to their match first, then take the next brace.
  let parens = 0;
  let i = stripped.indexOf("(", start);
  for (; i < stripped.length; i++) {
    if (stripped[i] === "(") parens++;
    else if (stripped[i] === ")" && --parens === 0) break;
  }
  let depth = 0;
  i = stripped.indexOf("{", i);
  const from = i;
  for (; i < stripped.length; i++) {
    if (stripped[i] === "{") depth++;
    else if (stripped[i] === "}" && --depth === 0) break;
  }
  const body = stripped.slice(from, i + 1);
  expect(body.length).toBeGreaterThan(120);
  return body;
}

describe.each([
  ["report-card-remark.service.ts", "async setClassTeacherRemark("],
  ["student-trait.service.ts", "async setTraits("],
])("%s %s authorises on SUPERVISION", (file, sig) => {
  it("asks supervisesStudent, and not the teaching union", () => {
    const body = methodBody(file, sig);
    expect(body).toContain("supervisesStudent");
    // The union is what it used to ask, and asking it here is the defect.
    expect(body).not.toMatch(/teachesStudent|teachesThisStudent/);
  });

  it("still lets a school administrator through", () => {
    expect(methodBody(file, sig)).toMatch(/staffWide|STAFF_WIDE/);
  });
});

describe("the READ scope deliberately stays the union", () => {
  it("a subject teacher may still SEE a pupil's remarks and ratings", () => {
    // Narrowing the read too would hide a child's report card from staff who
    // teach them every week — a different question, and this fix does not
    // answer it.
    for (const file of ["report-card-remark.service.ts", "student-trait.service.ts"]) {
      expect(methodBody(file, "assertCanRead(")).toMatch(/teachesStudent|teachesThisStudent/);
    }
  });
});

/**
 * AND THE CAPABILITY THE WEB IS TOLD, which is the half a mutation caught me
 * leaving unguarded: hard-coding either flag to `true` passed every assertion
 * above. The server would still refuse the write — so it is not a hole — but
 * the control would be offered to eleven people per class again and refused for
 * ten of them, which is the screen-level defect this fix exists to remove.
 *
 * Asserted as the SAME question the write asks, not merely as "a flag exists".
 */
describe.each([
  ["report-card-remark.service.ts", "async toDto(", "mayWriteClassTeacherRemark"],
  ["student-trait.service.ts", "async getTraits(", "mayWrite"],
])("%s tells the web the truth", (file, sig, field) => {
  it(`computes ${field} from supervision, never a constant`, () => {
    const body = methodBody(file, sig);
    const line = body.split("\n").find((l) => l.includes(`${field}:`)) ?? "";
    expect(line).not.toMatch(/:\s*(true|false)\s*,/);
    // The flag and the guard must ask one question; a second spelling is how
    // the remark and the ratings drifted apart in the first place.
    expect(body).toContain("supervisesStudent");
  });
});
