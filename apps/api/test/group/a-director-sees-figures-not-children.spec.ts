// =============================================================================
// The group console is a cross-tenant surface, and it holds
// =============================================================================
// A proprietor who owns several schools reads all of them from one page. That
// makes it the riskiest read in the platform: RLS is deliberately bypassed (the
// whole point is to cross the boundary), so every control here is application
// code, and a mistake is a disclosure between two schools that are otherwise
// strangers.
//
// Audited it end to end and found NOTHING WRONG. Directorship gates every read;
// a supplied groupId is matched against the caller's own directorships; the
// per-campus drill-down checks the schoolId belongs to a group they direct and
// 404s rather than 403s; the reads are audited in the director's own tenant; the
// CSV is built from the same overview() call, so it cannot diverge from the
// screen in either authorization or trail; and management is operator-gated with
// step-up.
//
// This file exists for the ONE property a future change is most likely to break
// without noticing: the console reports FIGURES, never people. "Top five debtors"
// or "pupils absent today" would each be a natural-sounding feature request and
// each would put one school's children in front of another school's proprietor.
// Nothing in the type system says no; this does.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(__dirname, "../../src/group/group.service.ts"), "utf8");

/**
 * The body of one method.
 *
 * Walks the PARAMETER LIST to its closing paren before looking for the opening
 * brace. A first version took the first `{` after the signature, which in
 * `overview(p, opts: { groupId?: string } = {})` is the parameter's own type —
 * so every assertion below ran against a fragment of a type annotation and
 * three of them passed anyway. The length check at the bottom of this file is
 * what caught it.
 */
function methodBody(name: string): string {
  const m = new RegExp(`\\n  (?:private |async |private async )?${name}\\s*\\(`).exec(SRC);
  if (!m) throw new Error(`method ${name} not found — this gate is reading the wrong file`);
  let i = m.index + m[0].length - 1; // at the "(" of the parameter list
  let parens = 0;
  for (; i < SRC.length; i += 1) {
    if (SRC[i] === "(") parens += 1;
    else if (SRC[i] === ")" && --parens === 0) break;
  }
  const open = SRC.indexOf("{", i);
  let depth = 0;
  for (let j = open; j < SRC.length; j += 1) {
    if (SRC[j] === "{") depth += 1;
    else if (SRC[j] === "}" && --depth === 0) return SRC.slice(open, j);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

/** What a director can reach. Management methods are operator-only and DO read
 *  director identities, legitimately — they are not in this list. */
const DIRECTOR_FACING = ["overview", "schoolDetail", "overviewCsv"];

describe("what a director's own reads touch", () => {
  it.each(DIRECTOR_FACING)("%s reads no person's row at all", (name) => {
    const body = methodBody(name);
    // Not "no PII fields" — no person TABLE. A pupil's identity cannot leak from
    // a query that never reaches for one, and this stays true when somebody adds
    // a column later.
    expect(body).not.toMatch(/\.user\.(findMany|findFirst|findUnique)/);
    expect(body).not.toMatch(/\.studentProfile\./);
    expect(body).not.toMatch(/\.enrollment\.findMany/);
    expect(body).not.toMatch(/\.payment\.findMany/);
    expect(body).not.toMatch(/\.invoice\.findMany/);
  });

  it.each(DIRECTOR_FACING)("%s is audited", (name) => {
    // A cross-tenant read that leaves no trace is the one nobody can investigate
    // afterwards. overviewCsv inherits its entry by calling overview().
    const body = methodBody(name);
    expect(body).toMatch(/this\.logRead\(|this\.overview\(/);
  });

  it("the CSV is built from the same call the screen renders", () => {
    // So an export can never show more than the page, in data or in trail — the
    // classic place a scoping rule gets re-implemented and drifts.
    expect(methodBody("overviewCsv")).toMatch(/await this\.overview\(p, opts\)/);
  });
});

describe("who the figures are for", () => {
  it("overview refuses a non-director with 404, not 403", () => {
    // 403 would confirm that groups exist and that this person is not in one.
    const body = methodBody("overview");
    expect(body).toMatch(/directorships\.length === 0\) throw new NotFoundException/);
  });

  it("overview honours a supplied groupId only if the caller directs it", () => {
    // The same rule as a supplied studentId elsewhere: an id in the request is a
    // request, not a fact.
    const body = methodBody("overview");
    expect(body).toMatch(/directorships\.find\(\(d\) => d\.groupId === opts\.groupId\)/);
    expect(body).toMatch(/if \(!chosen\) throw new NotFoundException/);
  });

  it("the drill-down checks the CAMPUS is in a group they direct", () => {
    // Without this, any director could read any school in the platform by id —
    // the one mistake on this surface that would be a true cross-tenant breach.
    const body = methodBody("schoolDetail");
    expect(body).toMatch(/directorships\.find\(\(d\) => d\.group\.members\.some\(\(m\) => m\.schoolId === schoolId\)\)/);
    expect(body).toMatch(/if \(!owning\) throw new NotFoundException/);
  });

  it("checks it BEFORE reading the school", () => {
    const body = methodBody("schoolDetail");
    expect(body.indexOf("if (!owning)")).toBeLessThan(body.indexOf("client.school.findFirst"));
  });
});

describe("the gate is reading real code", () => {
  it("finds the methods and they are not empty", () => {
    // A brace-matcher that silently returned "" would pass every assertion above.
    for (const name of [...DIRECTOR_FACING, "setDirectors"]) {
      expect(methodBody(name).length).toBeGreaterThan(200);
    }
  });

  it("confirms the management methods DO read people, so the split is real", () => {
    // setDirectors resolves staff by email on purpose. If this stopped being
    // true the list above would be excluding nothing and proving nothing.
    expect(methodBody("setDirectors")).toMatch(/client\.user\.findMany/);
  });
});
