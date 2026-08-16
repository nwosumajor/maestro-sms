// =============================================================================
// Skills and behaviour — the affective half of the report card
// =============================================================================
// A Nigerian report card carries twenty behavioural and psychomotor traits in
// four groups, each rated 1–5 by the class teacher, printed beside the marks.
// The platform stored none of it.
//
// The design follows from what these are NOT. They are not marks:
//
//   * never averaged into an academic total — "obedience 4" and "mathematics 81"
//     are different kinds of statement about a child;
//   * always somebody's judgement, so the row carries `ratedById` and every
//     write is audited (Golden Rule #8: a human decision, recorded, never
//     computed);
//   * correction-friendly, so the row updates in place. A teacher who means 4
//     and clicks 1 on a child's honesty must be able to put it right, which is
//     why rls/107 grants UPDATE where the ledgers do not.
//
// The catalogue is a DATA TABLE in @sms/types, not columns and not an enum:
// schools disagree about the list, and adding "Leadership" must not be a
// migration.
// =============================================================================

import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { TRAIT_GROUPS, TRAIT_KEYS, TRAIT_SCALE, isTraitKey, traitLabel } from "@sms/types";
import { StudentTraitService } from "../../src/reportcards/student-trait.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const teacher: Principal = { schoolId: "S", userId: "teach-1", roles: ["teacher"], permissions: ["grade.write"] };
const head: Principal = { schoolId: "S", userId: "head-1", roles: ["principal"], permissions: ["grade.write"] };
const stranger: Principal = { schoolId: "S", userId: "other-1", roles: ["teacher"], permissions: ["grade.write"] };
const pupil: Principal = { schoolId: "S", userId: "stu-1", roles: ["student"], permissions: ["grade.read"] };

function makeService(opts: { teaches?: boolean; existing?: Array<{ traitKey: string; score: number }> } = {}) {
  const { teaches = true, existing = [] } = opts;
  const upserts: Array<{ traitKey: string; score: number; ratedById: string }> = [];
  const audits: Array<{ action: string; metadata?: Record<string, unknown> }> = [];
  const tx = {
    enrollment: { findMany: jest.fn(async () => [{ classId: "c-1" }]) },
    class: { findFirst: jest.fn(async () => (teaches ? { id: "c-1" } : null)) },
    classSubjectTeacher: { findFirst: jest.fn(async () => null) },
    parentChild: { findFirst: jest.fn(async () => null) },
    term: { findFirst: jest.fn(async () => ({ id: "t-1" })) },
    user: { findFirst: jest.fn(async () => ({ name: "A Teacher" })), findMany: jest.fn(async () => []) },
    studentTraitRating: {
      findMany: jest.fn(async () =>
        existing.map((e) => ({ ...e, ratedById: "teach-1", ratedAt: new Date("2026-08-01T00:00:00.000Z") })),
      ),
      upsert: jest.fn(async (a: { create: { traitKey: string; score: number; ratedById: string } }) => {
        upserts.push(a.create);
        return a.create;
      }),
    },
  } as unknown as TenantTx;
  const db = {
    runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
  };
  const audit = {
    record: jest.fn(async (e: { action: string; metadata?: Record<string, unknown> }) => {
      audits.push(e);
    }),
  };
  return { service: new StudentTraitService(db as never, audit as never), upserts, audits, tx };
}

describe("the catalogue", () => {
  it("is four groups of five, as the printed format has", () => {
    expect(TRAIT_GROUPS).toHaveLength(4);
    expect(TRAIT_KEYS).toHaveLength(20);
  });

  it("has a 1–5 scale in words, because a bare number means nothing to a parent", () => {
    expect(TRAIT_SCALE.map((r) => r.score)).toEqual([5, 4, 3, 2, 1]);
    for (const r of TRAIT_SCALE) expect(r.label.length).toBeGreaterThan(10);
  });

  it("prints a retired trait's key rather than losing the rating", () => {
    // A school that drops "Dexterity" must not break last year's report cards.
    expect(traitLabel("dexterity")).toBe("Dexterity (musical & art materials)");
    expect(traitLabel("somethingRetired")).toBe("somethingRetired");
    expect(isTraitKey("somethingRetired")).toBe(false);
  });
});

describe("recording ratings", () => {
  it("saves the whole set in one act, with one audit row", async () => {
    // Twenty separate saves would be twenty audit rows for one sitting.
    const { service, upserts, audits } = makeService();
    await service.setTraits(teacher, "stu-1", "t-1", [
      { traitKey: "obedience", score: 4 },
      { traitKey: "honesty", score: 5 },
    ]);
    expect(upserts).toHaveLength(2);
    expect(audits.filter((a) => a.action === "reportcard.traits.set")).toHaveLength(1);
  });

  it("stamps WHO rated the child", async () => {
    const { service, upserts } = makeService();
    await service.setTraits(teacher, "stu-1", "t-1", [{ traitKey: "obedience", score: 4 }]);
    expect(upserts[0].ratedById).toBe("teach-1");
  });

  it("audits the traits touched but NOT the scores", async () => {
    // The scores are on the record; an audit line is not the place to restate a
    // judgement about a child.
    const { service, audits } = makeService();
    await service.setTraits(teacher, "stu-1", "t-1", [{ traitKey: "obedience", score: 1 }]);
    const entry = audits.find((a) => a.action === "reportcard.traits.set");
    expect(entry?.metadata).toMatchObject({ traits: ["obedience"] });
    expect(JSON.stringify(entry?.metadata)).not.toContain('"score"');
  });

  it("refuses a trait the catalogue does not define", async () => {
    // Otherwise it prints as a bare key on a child's report card and nobody
    // knows where it came from.
    const { service } = makeService();
    await expect(service.setTraits(teacher, "stu-1", "t-1", [{ traitKey: "vibes", score: 4 }])).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("refuses a score outside 1–5", async () => {
    const { service } = makeService();
    for (const score of [0, 6, 2.5]) {
      await expect(
        service.setTraits(teacher, "stu-1", "t-1", [{ traitKey: "obedience", score }]),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it("refuses the same trait twice in one submission", async () => {
    const { service } = makeService();
    await expect(
      service.setTraits(teacher, "stu-1", "t-1", [
        { traitKey: "obedience", score: 4 },
        { traitKey: "obedience", score: 2 },
      ]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("refuses a term that does not exist", async () => {
    const { service, tx } = makeService();
    (tx.term.findFirst as jest.Mock).mockResolvedValueOnce(null);
    await expect(service.setTraits(teacher, "stu-1", "t-1", [{ traitKey: "obedience", score: 4 }])).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe("who may record them", () => {
  it("a teacher of the pupil's class", async () => {
    const { service } = makeService({ teaches: true });
    await expect(service.setTraits(teacher, "stu-1", "t-1", [{ traitKey: "honesty", score: 4 }])).resolves.toBeDefined();
  });

  it("a school administrator, without a teaching relationship", async () => {
    const { service } = makeService({ teaches: false });
    await expect(service.setTraits(head, "stu-1", "t-1", [{ traitKey: "honesty", score: 4 }])).resolves.toBeDefined();
  });

  it("nobody else", async () => {
    const { service } = makeService({ teaches: false });
    await expect(
      service.setTraits(stranger, "stu-1", "t-1", [{ traitKey: "honesty", score: 4 }]),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe("who may read them", () => {
  it("the pupil themselves", async () => {
    const { service } = makeService({ teaches: false, existing: [{ traitKey: "obedience", score: 4 }] });
    const out = await service.getTraits(pupil, "stu-1", "t-1");
    expect(out.ratings).toEqual([{ traitKey: "obedience", score: 4 }]);
  });

  it("names the rater, so the judgement belongs to somebody", async () => {
    const { service } = makeService({ existing: [{ traitKey: "obedience", score: 4 }] });
    const out = await service.getTraits(teacher, "stu-1", "t-1");
    expect(out.ratedByName).toBe("A Teacher");
    expect(out.ratedAt).not.toBeNull();
  });

  it("an unrelated teacher gets 404, not 403", async () => {
    const { service } = makeService({ teaches: false });
    await expect(service.getTraits(stranger, "stu-1", "t-1")).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("what the report card does with them", () => {
  const PDF = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "../../src/reportcards/reportcard.service.ts"),
    "utf8",
  ) as string;

  it("prints them in their groups, with the scale spelled out", () => {
    expect(PDF).toMatch(/Skills and behaviour/);
    expect(PDF).toMatch(/TRAIT_SCALE\.map\(\(r\) => `\$\{r\.score\} = \$\{r\.label\}`\)/);
  });

  it("never folds them into an academic total", () => {
    // The one thing that must not happen: a behavioural rating changing a mark.
    const total = PDF.slice(PDF.indexOf("const totalTermScore"), PDF.indexOf("const totalTermScore") + 200);
    expect(total).not.toMatch(/trait/i);
  });
});
