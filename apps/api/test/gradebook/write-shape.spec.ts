// =============================================================================
// A mock will accept a column that does not exist
// =============================================================================
// `applyComponents` computes the four marks, the total, the letter — and
// `complete`, a DERIVED flag saying whether every component has been marked.
// All three write paths did this:
//
//   const data = { ...scored, gradedById, gradedAt };
//   tx.subjectResult.upsert({ create: { ...data }, update: { ...data } })
//
// `complete` is not a column on `subject_result`. Prisma rejects the whole
// upsert, so EVERY save of a mark answered 500 — the single most-used write in
// the gradebook, broken outright.
//
// It shipped because the unit suite mocks the upsert:
//
//   const upsert = jest.fn(({ create, update }) => ...)
//
// A jest.fn() accepts any object. It cannot know `complete` is not a column, so
// the tests asserted the marks were right and passed while the write could not
// execute at all. The mock proved the arithmetic and said nothing about whether
// Prisma would take it.
//
// The fix for the test is not "use a real database everywhere" — it is to check
// the written FIELD SET against the generated schema, which is exact, needs no
// database, and catches every member of this class: a renamed column, a field
// left behind by a migration, a computed value that leaked into a write.
// =============================================================================

import { Prisma } from "@sms/db";
import { TermResultService } from "../../src/gradebook/term-result.service";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Every scalar column Prisma will accept for a model. */
function columnsOf(model: string): Set<string> {
  const m = Prisma.dmmf.datamodel.models.find((x) => x.name === model);
  if (!m) throw new Error(`no such model: ${model}`);
  return new Set(m.fields.map((f) => f.name));
}

describe("subject_result", () => {
  const cols = columnsOf("SubjectResult");

  it("has no `complete` column — it is derived on read", () => {
    // Stated explicitly, because the whole defect was believing otherwise. A
    // stored flag would also go stale the moment a component was filled in.
    expect(cols.has("complete")).toBe(false);
    expect(cols.has("total")).toBe(true);
    expect(cols.has("grade")).toBe(true);
  });

  it("the write paths strip the computed flag before handing data to Prisma", () => {
    const src = readFileSync(join(__dirname, "../../src/gradebook/term-result.service.ts"), "utf8");
    const spreads = src.match(/const data = \{ \.\.\.[A-Za-z]+, gradedById/g) ?? [];
    expect(spreads.length).toBeGreaterThan(0);
    // Every one of them must spread the STRIPPED object, never `scored` itself.
    expect(src).not.toMatch(/const data = \{ \.\.\.scored, gradedById/);
    expect(src.match(/const \{ complete: _complete, \.\.\.persisted \} = scored;/g) ?? []).toHaveLength(
      spreads.length,
    );
  });
});

describe("what applyComponents actually produces", () => {
  // The behavioural half: run the real function and compare its keys to the
  // schema, so this test keeps working if the write paths are refactored.
  it("returns the flag alongside the columns, so it MUST be stripped", () => {
    const proto = TermResultService.prototype as unknown as {
      applyComponents: (c: object, p?: unknown) => Record<string, unknown>;
    };
    const scored = proto.applyComponents.call(Object.create(TermResultService.prototype), {
      exam: 50,
      midterm: 15,
      assignment: 8,
      classNote: 9,
    });

    const cols = columnsOf("SubjectResult");
    const notColumns = Object.keys(scored).filter((k) => !cols.has(k));
    // Exactly one non-column, and we know which: if another appears, whoever
    // added it has to decide whether it is persisted or stripped.
    expect(notColumns).toEqual(["complete"]);
  });
});
