// =============================================================================
// Three pupils in a room with one place, reported as a clean import
// =============================================================================
// A class carries a `capacity`, and the product refuses an enrolment that would
// overfill it. That rule was written at FOUR of the seven doors into an ACTIVE
// enrolment, and written TWICE — `LmsService.assertCapacity` and a hand-copied
// block inside `PromotionService.enrollInto`, each correct, each with its own
// wording. Three doors enforced nothing at all.
//
// Measured live against the running stack, on ONE class, a minute apart:
//
//     POST /classes/:id/enrollments     409   "Class is at capacity (1)"
//     POST /admin/import/students       201   {"created":3,"skipped":0,"errors":[]}
//
// and the class then held three ACTIVE enrolments against a capacity of 1, with
// nothing on the response, in the log, or on the screen to say so. The teacher
// finds out when the children arrive.
//
// `AdmissionsService.convertToPupil` was the same and matters more: it is the
// ORDINARY route a school admits a pupil by, and it enrolled into whatever
// `input.classId` it was handed. `StudentImportService` had a third shape —
// it checks, but against headroom read in an EARLIER read-only transaction, so
// two approvers deciding two batches into one class both saw the same free
// places and both took them.
//
// THIS GATE COMPUTES ITS OWN SET. A hand-kept list of enrolment writers is a
// list of the ones somebody remembered, which is the defect it exists for: the
// rule survived at the doors people were looking at. It walks the API source
// for every write that can leave an enrolment ACTIVE and fails on one whose
// method cannot reach the shared guard.
// =============================================================================

import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { API_SRC, walkTs, methodBody } from "../support/sweep-services";
import { stripComments } from "../support/strip-comments";

/**
 * The body of a DECLARED method, not of a call to one.
 *
 * `methodBody` finds the first `name(` in the file, and `this.enrollInto(` is a
 * match — so asking for `enrollInto` returned the body of whatever encloses the
 * CALL, and this gate reported five correctly-guarded doors as unguarded. A
 * declaration is a class member: two-space indent, start of line, no dot.
 */
function declBody(src: string, name: string): string | null {
  const decl = new RegExp(`^\\s{2}(?:private\\s+|public\\s+|protected\\s+)?(?:async\\s+)?${name}\\s*\\(`, "m").exec(src);
  if (!decl) return null;
  return methodBody(src.slice(decl.index), name);
}

/** The one definition every door must reach. */
const GUARDS = ["assertClassCapacity", "classHeadroom"];

interface Door {
  file: string;
  method: string;
  body: string;
  /** The write itself, for a failure message that names the line. */
  call: string;
}

/**
 * Every write that can leave an enrolment ACTIVE.
 *
 * `status` defaults to "ACTIVE" in the schema, so a `create` that names no
 * status IS an active enrolment — the shape both unguarded doors had. A write
 * that explicitly sets some other status is a CLOSURE (exit, transfer,
 * graduation) and takes no place, so it is not a door.
 */
function doors(): Door[] {
  const out: Door[] = [];
  for (const file of walkTs(API_SRC)) {
    if (file.endsWith(".spec.ts")) continue;
    const src = stripComments(readFileSync(file, "utf8"));
    const re = /\benrollment\.(create|createMany|update|updateMany|upsert)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      // The call's own argument object, to read the status it writes.
      const seg = src.slice(m.index, m.index + 600);
      const setsOther = /status:\s*"(?!ACTIVE)[A-Z_]+"/.test(seg);
      if (setsOther) continue;
      // Which method encloses it: the nearest method header above the call.
      const before = src.slice(0, m.index);
      const names = [...before.matchAll(/^\s{2}(?:private\s+|public\s+|protected\s+)?(?:async\s+)?([a-zA-Z_][\w]*)\s*\(/gm)];
      const method = names.length ? names[names.length - 1][1] : "(top level)";
      const body = declBody(src, method) ?? seg;
      out.push({ file: relative(API_SRC, file), method, body, call: m[1] });
    }
  }
  return out;
}

/** True if the method reaches a capacity guard, following ONE hop through a
 *  same-file private helper — `assertCapacity` delegates, and a gate that
 *  refused to follow it would demand the guard be inlined at every door. */
function reachesGuard(d: Door, srcOf: Map<string, string>): boolean {
  if (GUARDS.some((g) => d.body.includes(g))) return true;
  const src = srcOf.get(d.file)!;
  for (const callee of [...d.body.matchAll(/this\.([a-zA-Z_][\w]*)\s*\(/g)].map((x) => x[1])) {
    const b = declBody(src, callee);
    if (b && GUARDS.some((g) => b.includes(g))) return true;
  }
  return false;
}

describe("every door into a class checks it has room", () => {
  const found = doors();
  const srcOf = new Map(found.map((d) => [d.file, stripComments(readFileSync(`${API_SRC}/${d.file}`, "utf8"))]));

  it("found the enrolment writers to check — a walk that finds nothing passes green", () => {
    // The failure this guards against is a renamed model or a moved directory
    // silently emptying the set, which reports no offenders and looks like a pass.
    expect(found.length).toBeGreaterThanOrEqual(6);
    expect(new Set(found.map((d) => d.file)).size).toBeGreaterThanOrEqual(4);
  });

  it("reaches the shared guard from every one of them", () => {
    const unguarded = found
      .filter((d) => !reachesGuard(d, srcOf))
      .map((d) => `${d.file} → ${d.method}() (enrollment.${d.call})`);
    expect(unguarded).toEqual([]);
  });

  it("and the guard is ONE definition, not a copy per door", () => {
    // A control written six times is right five times: this rule already
    // existed twice, with two different messages, and the second copy is how
    // `PromotionService` came to be correct while three siblings were not.
    //
    // The LOCK is the part that cannot be re-derived casually, so it is what is
    // counted: exactly one file in the API may take `FOR UPDATE` on a class row.
    const takesClassLock = walkTs(API_SRC)
      .filter((f) => !f.endsWith(".spec.ts"))
      .filter((f) => /FOR UPDATE/.test(stripComments(readFileSync(f, "utf8"))) &&
                     /"class"\s+WHERE/.test(stripComments(readFileSync(f, "utf8"))))
      .map((f) => relative(API_SRC, f));
    expect(takesClassLock).toEqual(["common/class-capacity.ts"]);
  });
});
