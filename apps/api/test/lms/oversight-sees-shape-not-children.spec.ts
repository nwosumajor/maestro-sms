// =============================================================================
// The board saw every child's name
// =============================================================================
// `board` is read-only oversight. The rule was already written down, in the
// comment above ROSTER_WIDE_ROLES, as a table:
//
//   class.read       -> class list / overview / info      board YES
//   enrollment.read  -> the ROSTER of pupil names,
//                       roster.csv, eligibility           board NO
//
//   "So oversight (board) sees the school's SHAPE — which classes exist, who
//    teaches them, how full they are — and the head of teaching, who already
//    holds enrollment.read, sees who is in them. Minors' names are gated by the
//    grant, not by this set (GR#5)."
//
// The pupil picker checked only the SET. Measured against the running system
// before the fix: GET /students returned 500 pupils by name to board@, and
// /students/count returned 901. The rule was stated, agreed, and then not
// applied by the one endpoint whose entire payload is children's names.
//
// The fix is the second half of that sentence — role AND grant — and NOT moving
// the endpoint's gate to enrollment.read, which is the tidier-looking change:
// `parent` and `student` hold class.read without enrollment.read, so it would
// have refused a parent the picker for their own children.
//
// A COUNT stays on the role alone. It names nobody, it is exactly the "how full
// are they" oversight is for, and routing board into the relationship branch
// would answer "0 students" for a 901-pupil school — a wrong number protects
// nobody and misinforms the people whose job is to notice.
// =============================================================================

import { LmsService } from "../../src/lms/lms.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const PUPILS = [
  { id: "s1", name: "Ada Okoro" },
  { id: "s2", name: "Bola Adeyemi" },
];

function make() {
  const userFindMany = jest.fn().mockResolvedValue(PUPILS);
  const userCount = jest.fn().mockResolvedValue(901);
  const tx = {
    user: { findMany: userFindMany, count: userCount },
    // The relationship branch finds nothing for a caller with no teaching or
    // parental link — which is what board is.
    classSubjectTeacher: { findMany: jest.fn().mockResolvedValue([]) },
    class: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null) },
    parentChild: { findMany: jest.fn().mockResolvedValue([]) },
    enrollment: { findMany: jest.fn().mockResolvedValue([]) },
  } as unknown as TenantTx;
  const s = Object.create(LmsService.prototype) as LmsService;
  Object.assign(s, {
    db: {
      runAsTenant: jest.fn(async (_c: TenantContext, fn: (t: TenantTx) => unknown) => fn(tx)),
      runAsTenantReadOnly: jest.fn(async (_c: TenantContext, fn: (t: TenantTx) => unknown) => fn(tx)),
    },
    audit: { record: jest.fn() },
  });
  return { s, tx, userFindMany, userCount };
}

const BOARD: Principal = {
  schoolId: "A", userId: "board-1", roles: ["board"],
  // The real grant: oversight holds class.read and NOT enrollment.read.
  permissions: ["class.read"],
};
const HEAD: Principal = {
  schoolId: "A", userId: "head-1", roles: ["head_teacher"],
  permissions: ["class.read", "enrollment.read"],
};

describe("read-only oversight", () => {
  it("is not handed the whole school's pupils by name", async () => {
    const { s, userFindMany } = make();
    await expect(s.listStudents(BOARD)).resolves.toEqual([]);
    // Not merely an empty answer — the whole-school query must never run.
    expect(userFindMany).not.toHaveBeenCalled();
  });

  it("still gets the SIZE of the school, which names nobody", async () => {
    // The half that must not over-correct: routing board into the relationship
    // branch would report 0 pupils to the board of a 901-pupil school.
    const { s, userCount } = make();
    await expect(s.countStudents(BOARD)).resolves.toEqual({ students: 901 });
    expect(userCount).toHaveBeenCalled();
  });
});

describe("the head of teaching, who holds the grant", () => {
  it("still sees every pupil by name", async () => {
    // The fix must not cost the roles the rule says YES to.
    const { s, userFindMany } = make();
    await expect(s.listStudents(HEAD)).resolves.toEqual(PUPILS);
    expect(userFindMany).toHaveBeenCalled();
  });
});

describe("the rule, stated once", () => {
  it("the whole-school NAME path needs the role AND the grant", () => {
    const src = require("node:fs").readFileSync(
      require("node:path").join(__dirname, "../../src/lms/lms.service.ts"),
      "utf8",
    ) as string;
    expect(src).toMatch(
      /isRosterWide\(p: Principal\): boolean \{\s*return this\.isSchoolWideStaff\(p\) && p\.permissions\.includes\(LMS_PERMISSIONS\.ENROLLMENT_READ\)/,
    );
  });

  it("a role holding the grant is unaffected — so this gate is about the grant, not the role", async () => {
    // Guards against "fixing" it by dropping board from ROSTER_WIDE_ROLES, which
    // would also take away the class list the rule says board keeps.
    const { s } = make();
    const withGrant: Principal = { ...BOARD, permissions: ["class.read", "enrollment.read"] };
    await expect(s.listStudents(withGrant)).resolves.toEqual(PUPILS);
  });
});
