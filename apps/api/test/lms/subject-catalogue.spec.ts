// =============================================================================
// Subject catalogue — a template that is COPIED, never a shared row
// =============================================================================
// The rules these defend, in the order they would hurt if broken:
//
//   • the catalogue follows the school's COUNTRY — offering "English Language"
//     to a school in Dakar is worse than offering nothing, because people accept
//     defaults
//   • picking an entry creates the SCHOOL'S OWN row; `catalogueCode` is the only
//     link back, so a rename never crosses a tenant boundary
//   • every code resolves to a concept, or cross-school comparison is built on
//     strings that only look the same

import {
  DEFAULT_CURRICULUM,
  SUBJECT_CATALOGUES,
  SUBJECT_CONCEPTS,
  SUBJECT_GROUPS,
  SUBJECT_STAGES,
  catalogueSubjectName,
  curriculumForCountry,
  subjectCatalogueFor,
} from "@sms/types";

describe("the catalogue follows the region", () => {
  it("gives a francophone country French subject names", () => {
    const sn = subjectCatalogueFor("SN");
    const names = sn.map((s) => s.displayName);
    expect(names).toContain("Mathématiques");
    expect(names).toContain("Histoire-Géographie");
    expect(names).not.toContain("English Language");
  });

  it("gives Nigeria its own curriculum, not the international default", () => {
    expect(curriculumForCountry("NG")).toBe("NG");
    const ng = subjectCatalogueFor("NG").map((s) => s.code);
    // The WASSCE trade subjects are the tell: a generic list has none of them.
    expect(ng).toContain("CATER");
    expect(ng).toContain("FMTH");
  });

  it("maps every francophone country to the French curriculum", () => {
    for (const c of ["SN", "CI", "ML", "BJ", "BF", "TG", "NE", "CM", "GA", "CD", "MA", "TN"]) {
      expect(curriculumForCountry(c)).toBe("FR");
    }
  });

  it("falls back to a USABLE list for an unmapped country, not an empty one", () => {
    // An empty catalogue sends the school back to typing everything by hand,
    // which is the problem this exists to solve.
    const unknown = subjectCatalogueFor("ZZ");
    expect(curriculumForCountry("ZZ")).toBe(DEFAULT_CURRICULUM);
    expect(unknown.length).toBeGreaterThan(10);
  });

  it("covers every stage from pre-primary to senior secondary", () => {
    for (const stage of SUBJECT_STAGES) {
      const ng = subjectCatalogueFor("NG", stage);
      expect(`${stage}:${ng.length > 0}`).toBe(`${stage}:true`);
    }
  });

  it("narrows to the stage asked for", () => {
    const senior = subjectCatalogueFor("NG", "SENIOR_SECONDARY");
    const primary = subjectCatalogueFor("NG", "PRIMARY");
    expect(senior.length).toBeGreaterThan(primary.length);
    for (const s of primary) expect(s.stages).toContain("PRIMARY");
  });
});

describe("the concept registry is what makes schools comparable", () => {
  it("resolves every catalogue code to a known concept", () => {
    // A code with no concept is a string that only LOOKS like a key — two
    // schools could carry it meaning different things.
    const orphans: string[] = [];
    for (const [key, cat] of Object.entries(SUBJECT_CATALOGUES)) {
      for (const s of cat.subjects) if (!SUBJECT_CONCEPTS[s.code]) orphans.push(`${key}:${s.code}`);
    }
    expect(orphans).toEqual([]);
  });

  it("uses the SAME code for the same subject across curricula", () => {
    // The whole point: a Senegalese "Mathématiques" and a Nigerian
    // "Mathematics" must be one row in a cross-school report.
    const fr = subjectCatalogueFor("SN").find((s) => s.displayName === "Mathématiques");
    const ng = subjectCatalogueFor("NG").find((s) => s.displayName === "Mathematics");
    expect(fr?.code).toBe("MTH");
    expect(ng?.code).toBe("MTH");
  });

  it("falls back to the concept's canonical name when a catalogue gives none", () => {
    expect(catalogueSubjectName({ code: "PHY", stages: ["SENIOR_SECONDARY"], group: "Sciences" })).toBe("Physics");
    expect(catalogueSubjectName({ code: "PHY", name: "Physique", stages: ["SENIOR_SECONDARY"], group: "Sciences" })).toBe("Physique");
  });

  it("has no duplicate code within one curriculum", () => {
    for (const [key, cat] of Object.entries(SUBJECT_CATALOGUES)) {
      const codes = cat.subjects.map((s) => s.code);
      expect(`${key}:${codes.length}`).toBe(`${key}:${new Set(codes).size}`);
    }
  });

  it("gives every entry a known group and at least one stage", () => {
    for (const [key, cat] of Object.entries(SUBJECT_CATALOGUES)) {
      for (const s of cat.subjects) {
        expect(`${key}:${s.code}:${SUBJECT_GROUPS.includes(s.group)}`).toBe(`${key}:${s.code}:true`);
        expect(`${key}:${s.code}:${s.stages.length > 0}`).toBe(`${key}:${s.code}:true`);
      }
    }
  });

  it("is comprehensive enough to be worth using", () => {
    // A list that stops at the core ten sends everyone back to free text for
    // exactly the subjects that vary most between schools.
    expect(Object.keys(SUBJECT_CONCEPTS).length).toBeGreaterThan(80);
    expect(SUBJECT_CATALOGUES.NG.subjects.length).toBeGreaterThan(40);
  });
});

// =============================================================================
// addSubjectsFromCatalogue — the copy, and what it refuses
// =============================================================================

import { LmsService } from "../../src/lms/lms.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const p: Principal = { schoolId: "A", userId: "u1", roles: ["school_admin"], permissions: ["class.write"] };

function svc(existing: Array<{ name: string; catalogueCode: string | null }>, country = "NG") {
  const created: Array<{ name: string; catalogueCode: string | null; schoolId: string }> = [];
  const tx = {
    subject: {
      findMany: jest.fn().mockResolvedValue(existing),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(({ data }: { data: { name: string; catalogueCode: string | null; schoolId: string } }) => {
        created.push(data);
        return Promise.resolve({ id: `s-${created.length}`, ...data });
      }),
    },
  } as unknown as TenantTx;
  const db = {
    runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const regions = { forSchool: jest.fn().mockResolvedValue({ country }) };
  return { service: new LmsService(db as never, audit as never, regions as never), created };
}

describe("LmsService.addSubjectsFromCatalogue", () => {
  it("creates the school's OWN row, stamped with the concept", async () => {
    // A copy, never a reference: the row carries this school's id, and
    // catalogueCode is the only link back to the shared list.
    const { service, created } = svc([]);
    const out = await service.addSubjectsFromCatalogue(p, ["MTH", "PHY"]);
    expect(out.added).toHaveLength(2);
    expect(created.every((c) => c.schoolId === "A")).toBe(true);
    expect(created.map((c) => c.catalogueCode).sort()).toEqual(["MTH", "PHY"]);
  });

  it("uses the curriculum's OWN name for the subject", async () => {
    const { service, created } = svc([], "SN");
    await service.addSubjectsFromCatalogue(p, ["MTH"]);
    expect(created[0].name).toBe("Mathématiques");
  });

  it("skips a concept already added, and says so, without failing the batch", async () => {
    // Someone ticking twelve boxes, one of which they already have, should get
    // the other eleven — not an error and nothing added.
    const { service, created } = svc([{ name: "Mathematics", catalogueCode: "MTH" }]);
    const out = await service.addSubjectsFromCatalogue(p, ["MTH", "PHY"]);
    expect(out.added.map((a) => a.catalogueCode)).toEqual(["PHY"]);
    expect(out.skipped).toEqual([{ code: "MTH", reason: "already added" }]);
    expect(created).toHaveLength(1);
  });

  it("recognises a concept the school RENAMED, so it is not offered twice", async () => {
    // The rename case is the reason the check is on catalogueCode and not name.
    const { service } = svc([{ name: "Core Mathematics", catalogueCode: "MTH" }]);
    const out = await service.addSubjectsFromCatalogue(p, ["MTH"]);
    expect(out.added).toEqual([]);
    expect(out.skipped[0].reason).toBe("already added");
  });

  it("skips a NAME collision with a subject typed by hand", async () => {
    // A school that typed "Physics" last term must not end up with two.
    const { service } = svc([{ name: "physics", catalogueCode: null }]);
    const out = await service.addSubjectsFromCatalogue(p, ["PHY"]);
    expect(out.added).toEqual([]);
    expect(out.skipped[0].reason).toMatch(/already exists/);
  });

  it("refuses a code from another curriculum rather than silently adding it", async () => {
    // CATER is a Nigerian WASSCE trade subject; a British school asking for it
    // has sent a code from someone else's list.
    const { service, created } = svc([], "GB");
    const out = await service.addSubjectsFromCatalogue(p, ["CATER"]);
    expect(out.added).toEqual([]);
    expect(out.skipped[0].reason).toMatch(/not in this school's catalogue/);
    expect(created).toHaveLength(0);
  });

  it("ignores a repeated code in one request", async () => {
    const { service, created } = svc([]);
    const out = await service.addSubjectsFromCatalogue(p, ["MTH", "MTH"]);
    expect(out.added).toHaveLength(1);
    expect(created).toHaveLength(1);
  });

  it("is idempotent: running the same request twice adds nothing the second time", async () => {
    const { service, created } = svc([]);
    await service.addSubjectsFromCatalogue(p, ["MTH", "PHY", "CHE"]);
    expect(created).toHaveLength(3);
    const again = svc(created.map((c) => ({ name: c.name, catalogueCode: c.catalogueCode })));
    const out = await again.service.addSubjectsFromCatalogue(p, ["MTH", "PHY", "CHE"]);
    expect(out.added).toEqual([]);
    expect(again.created).toHaveLength(0);
  });
});
