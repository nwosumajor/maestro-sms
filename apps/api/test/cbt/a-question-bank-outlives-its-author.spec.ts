// =============================================================================
// The teacher leaves; the question bank stays
// =============================================================================
// A subject teacher writes a CBT question bank over several terms and then
// resigns. Does the school still have it?
//
// YES, and the reason is worth stating because it is structural rather than
// lucky: **bank visibility is decided by the READER's role, never by the bank's
// author.** `listBanks` returns every bank in the school to anyone school-wide
// or holding `cbt.review`; `getBankQuestions` shows the questions to the same
// people; `canTouchBank` returns true for school-wide roles before it looks at
// authorship at all. Principal and school_admin hold both `cbt.manage` and
// `cbt.review` and are both in SCHOOL_WIDE_ROLES.
//
// Nothing on the read path joins the author's `user` row, so `status = EXITED`
// cannot hide a bank — and there is no foreign key from `createdById` to `user`
// at all, so even a hard-deleted account could not cascade one away. Exit does
// not delete anyway: it sets a status and keeps the record.
//
// AND THE NEXT TEACHER INHERITS IT. A bank must name its subject, and a teacher
// sees banks for the subjects they teach — so whoever picks up the subject picks
// up the bank, with no administrative act at all.
//
// These are exactly the properties a later tidy-up would break without meaning
// to: adding `assertStillHere` to a read path, or joining the author to show a
// name, would each quietly remove a school's own exam material. Hence this file.
// =============================================================================

import { CbtService } from "../../src/cbt/cbt.service";
import { CBT_PERMISSIONS } from "@sms/types";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const GONE = "teacher-who-left";
const BANK = { id: "bank-1", name: "Physics SS2 — mechanics", subject: "Physics", subjectId: "sub-physics", createdById: GONE };

function makeService() {
  const bankFindMany = jest.fn().mockResolvedValue([{ ...BANK, createdAt: new Date() }]);
  const tx = {
    cbtQuestionBank: {
      findMany: bankFindMany,
      findFirst: jest.fn().mockResolvedValue(BANK),
    },
    cbtQuestion: {
      groupBy: jest.fn().mockResolvedValue([{ bankId: "bank-1", _count: { id: 42 } }]),
      findMany: jest.fn().mockResolvedValue([
        { id: "q1", prompt: "State Newton's second law", choices: ["a", "b"], answerIndex: 0, type: "MCQ", level: null, topic: null, maxMarks: 1, markGuide: null },
      ]),
    },
    classSubjectTeacher: { findMany: jest.fn().mockResolvedValue([]) },
    $queryRaw: jest.fn().mockResolvedValue([]),
  } as unknown as TenantTx;
  const svc = Object.create(CbtService.prototype) as CbtService;
  Object.assign(svc, {
    db: {
      runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
      runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    },
    audit: { record: jest.fn() },
  });
  (svc as unknown as { ctx: unknown }).ctx = (p: Principal) => ({ schoolId: p.schoolId, userId: p.userId });
  return { svc, tx, bankFindMany };
}

const who = (roles: string[], permissions: string[], userId = "someone-else"): Principal => ({
  schoolId: "A",
  userId,
  roles,
  permissions,
});

const PRINCIPAL = who(["principal"], [CBT_PERMISSIONS.CBT_MANAGE, CBT_PERMISSIONS.CBT_REVIEW], "principal-1");
const ADMIN = who(["school_admin"], [CBT_PERMISSIONS.CBT_MANAGE, CBT_PERMISSIONS.CBT_REVIEW], "admin-1");
const HEAD = who(["head_teacher"], [CBT_PERMISSIONS.CBT_REVIEW], "head-1");

describe("after the author has left the school", () => {
  it("the principal still lists the bank", async () => {
    const t = makeService();
    await expect(t.svc.listBanks(PRINCIPAL)).resolves.toEqual([expect.objectContaining({ id: "bank-1", questionCount: 42 })]);
  });

  it("the school admin still lists it", async () => {
    const t = makeService();
    await expect(t.svc.listBanks(ADMIN)).resolves.toHaveLength(1);
  });

  it("the head teacher, who only reviews, still lists it", async () => {
    const t = makeService();
    await expect(t.svc.listBanks(HEAD)).resolves.toHaveLength(1);
  });

  it("leadership reads it UNFILTERED — no author or status condition at all", async () => {
    // The property, asserted on the QUERY rather than inferred from the stub:
    // a `where` naming the creator, or joining `user`, is how this would break.
    const t = makeService();
    await t.svc.listBanks(PRINCIPAL);
    expect(t.bankFindMany.mock.calls[0][0].where).toEqual({});
  });

  it("and can still open the questions", async () => {
    const t = makeService();
    const out = await t.svc.getBankQuestions(PRINCIPAL, "bank-1");
    expect(out.questions).toHaveLength(1);
  });

  it("and can still EDIT it — school-wide short-circuits before authorship", async () => {
    const t = makeService();
    const canTouch = (t.svc as unknown as {
      canTouchBank: (tx: TenantTx, p: Principal, b: { createdById: string; subjectId: string | null }) => Promise<boolean>;
    }).canTouchBank;
    await expect(canTouch.call(t.svc, t.tx, PRINCIPAL, BANK)).resolves.toBe(true);
    await expect(canTouch.call(t.svc, t.tx, ADMIN, BANK)).resolves.toBe(true);
  });
});

describe("the teacher who takes the subject over", () => {
  it("inherits the bank with no administrative act", async () => {
    // A bank must name its subject precisely so this works: access follows the
    // SUBJECT, so the next teacher of Physics sees the Physics bank.
    const t = makeService();
    (t.tx.classSubjectTeacher.findMany as jest.Mock).mockResolvedValue([{ subjectId: "sub-physics" }]);
    const successor = who(["teacher"], [CBT_PERMISSIONS.CBT_MANAGE], "new-teacher");
    await t.svc.listBanks(successor);
    const where = t.bankFindMany.mock.calls[0][0].where as { OR: Array<Record<string, unknown>> };
    expect(where.OR).toContainEqual({ subjectId: { in: ["sub-physics"] } });
  });

  it("but a teacher of a DIFFERENT subject does not", async () => {
    const t = makeService();
    (t.tx.classSubjectTeacher.findMany as jest.Mock).mockResolvedValue([{ subjectId: "sub-history" }]);
    const other = who(["teacher"], [CBT_PERMISSIONS.CBT_MANAGE], "history-teacher");
    await t.svc.listBanks(other);
    const where = t.bankFindMany.mock.calls[0][0].where as { OR: Array<Record<string, unknown>> };
    expect(where.OR).toContainEqual({ subjectId: { in: ["sub-history"] } });
    expect(where.OR).not.toContainEqual({ subjectId: { in: ["sub-physics"] } });
  });
});

describe("what the database itself guarantees", () => {
  it("has no foreign key from a bank's author to the user table", async () => {
    // So even a hard-deleted account could not cascade a bank away. Exit does
    // not delete — it sets a status — but this is the belt behind that brace.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { readdirSync } = await import("node:fs");
    const dir = join(__dirname, "../../../../packages/db/prisma/migrations");
    const sql = readdirSync(dir)
      .map((d) => {
        try {
          return readFileSync(join(dir, d, "migration.sql"), "utf8");
        } catch {
          return "";
        }
      })
      .join("\n");
    const cascades = sql.match(/cbt_question_bank[\s\S]{0,200}?createdById[\s\S]{0,120}?ON DELETE CASCADE/gi) ?? [];
    expect(cascades).toEqual([]);
  });
});
