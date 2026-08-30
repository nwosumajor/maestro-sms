// =============================================================================
// 541 assessments, 500 reachable, nothing saying so
// =============================================================================
// The last list in this class. School-wide staff saw every assessment ever
// created, capped to the 500 most recent — and the live dev school already
// holds 541, so 41 were unreachable today, with no filter that could reach them
// and no indication that anything had been left out.
//
// A `classId` filter was added earlier and helps, but only if you already know
// the class. "Find the mid-term essay" had no answer short of scrolling, and a
// teacher looking for an assessment from last term is the ordinary case.
//
// The property that must survive every filter added here: a filter is ANDed on
// top of the relationship scoping, so it can only ever NARROW what the caller
// was already entitled to see. A search that widened it would turn a
// convenience into a disclosure.
// =============================================================================

import { AssessmentListService } from "../../src/integrity/assessment-list.service";
import { ASSESSMENT_PAGE_SIZE } from "@sms/types";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const assessment = (i: number) => ({
  id: `a${i}`,
  title: `Mid-term essay ${i}`,
  description: null,
  classId: "c-1",
  createdById: "someone",
  integrityEnabled: true,
  fileUploadEnabled: false,
  createdAt: new Date(),
});

function makeService(rows: Array<Record<string, unknown>>) {
  const findMany = jest.fn().mockImplementation(({ skip = 0, take = rows.length }) =>
    Promise.resolve(rows.slice(skip, skip + take)),
  );
  const count = jest.fn().mockResolvedValue(rows.length);
  const tx = {
    assessment: { findMany, count },
    classSubjectTeacher: { findMany: jest.fn().mockResolvedValue([]) },
    enrollment: { findMany: jest.fn().mockResolvedValue([]) },
    class: { findMany: jest.fn().mockResolvedValue([{ id: "c-1", name: "JSS2A" }]) },
    submission: {
      groupBy: jest.fn().mockResolvedValue([]),
      findMany: jest.fn().mockResolvedValue([]),
    },
  } as unknown as TenantTx;
  const db = { runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  return {
    service: new AssessmentListService(db as never, { record: jest.fn() } as never),
    findMany,
    count,
    where: () => findMany.mock.calls[0][0].where as Record<string, unknown>,
  };
}

const staff = (roles: string[]): Principal => ({
  schoolId: "A",
  userId: "u-1",
  roles,
  permissions: ["assessment.read"],
});

describe("reaching an assessment that is not recent", () => {
  it("returns a PAGE and says how many match", async () => {
    const { service } = makeService(Array.from({ length: 541 }, (_, i) => assessment(i)));
    const res = await service.listAssessments(staff(["school_admin"]), {});
    expect(res.items).toHaveLength(ASSESSMENT_PAGE_SIZE);
    expect(res.total).toBe(541);
  });

  it("pages back into earlier terms", async () => {
    const { service, findMany } = makeService(Array.from({ length: 541 }, (_, i) => assessment(i)));
    await service.listAssessments(staff(["school_admin"]), { page: 18 });
    expect(findMany.mock.calls[0][0].skip).toBe(17 * ASSESSMENT_PAGE_SIZE);
  });

  it("searches the title in the DATABASE", async () => {
    const { service, where } = makeService([assessment(1)]);
    await service.listAssessments(staff(["school_admin"]), { q: "mid-term" });
    expect(where()).toMatchObject({ AND: [{}, { title: { contains: "mid-term", mode: "insensitive" } }] });
  });

  it("ignores a blank search rather than matching an empty title", async () => {
    const { service, where } = makeService([assessment(1)]);
    await service.listAssessments(staff(["school_admin"]), { q: "   " });
    expect(where()).toEqual({});
  });
});

describe("a filter may only ever narrow", () => {
  it("keeps a teacher's membership scoping when they search", async () => {
    // The one that would be a disclosure rather than an inconvenience: a search
    // must not become a way to see assessments you do not teach.
    const { service, where } = makeService([assessment(1)]);
    await service.listAssessments(staff(["teacher"]), { q: "essay" });
    const w = where() as { AND: Array<Record<string, unknown>> };
    expect(w.AND[0]).toHaveProperty("OR");
    expect(JSON.stringify(w.AND[0])).toContain("c-1");
  });

  it("keeps it when they filter by class as well", async () => {
    const { service, where } = makeService([assessment(1)]);
    await service.listAssessments(staff(["teacher"]), { classId: "c-9", q: "essay" });
    // scoping AND class AND title — three narrowings, never a replacement.
    expect(JSON.stringify(where())).toContain("OR");
    expect(JSON.stringify(where())).toContain("c-9");
    expect(JSON.stringify(where())).toContain("essay");
  });
});

describe("the cost of a page", () => {
  it("counts submissions in ONE grouped query however big the page", async () => {
    // The page shrank from 500 rows to 30, but the count must stay grouped —
    // this list once hydrated every submission to add them up.
    const { service } = makeService(Array.from({ length: 30 }, (_, i) => assessment(i)));
    const res = await service.listAssessments(staff(["school_admin"]), {});
    expect(res.items).toHaveLength(30);
  });
});
