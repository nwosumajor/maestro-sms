// =============================================================================
// One route extractor, because six of them disagreed
// =============================================================================
// Six gates each grew their own copy of "walk the controllers and work out what
// routes exist". Five took the FIRST `@Controller` in a file as the prefix for
// every route in it — and three files declare two controllers, so four routes
// were filed under a path nobody can call:
//
//   POST /public/careers/:slug/apply    was read as  POST /hr/recruitment/:slug/apply
//   POST /public/biometric/:slug/events was read as  POST /hr/attendance/:slug/events
//   GET  /students/profile-reviews      was read as  GET  /students/:studentId/profile-reviews
//
// That is not only a wrong label. `every-mutation-leaves-a-trail` carries NAMED
// EXEMPTIONS keyed on the route, and one of them was written against the
// fictional `POST /hr/recruitment/:slug/apply` — it matched only because the
// extractor was broken in the same direction as the exemption. Two bugs
// cancelling out is worse than either alone: the exemption list is the record of
// which mutations deliberately go unaudited, and it named a route that does not
// exist while a real public write went by under a borrowed name.
//
// The fail-OPEN direction is the one that matters. `POST /hr/recruitment/:slug/
// apply` is a plausible authenticated route. The day somebody adds it for real
// it would arrive pre-exempted from the audit gate by an entry written years
// earlier for an unrelated public endpoint, and nothing would say so.
//
// `public-routes-are-rate-limited` already resolved this correctly — it was
// written after the mis-keying bit once, on the biometric endpoint. Fixing the
// gate where it hurt and leaving five siblings is the same defect this codebase
// keeps finding in its own application code, committed in the gates themselves.
//
// Permissions are returned SPLIT. `@RequirePermission(A, B)` grants access on
// either, and reading the argument list as one opaque string made such a route
// compare equal to nothing but itself — so a route could be exempted from a
// consistency gate by adding a second permission to its decorator.
// =============================================================================

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const API_SRC = join(__dirname, "../../src");

const ROUTE = /@(Get|Post|Put|Patch|Delete|All)\(\s*(?:["'`]([^"'`]*)["'`])?\s*\)/g;
const CONTROLLER = /@Controller\(\s*(?:["'`]([^"'`]*)["'`])?\s*\)/g;

export interface ApiRoute {
  /** "POST /public/careers/:slug/apply" — method and full path, the key gates use. */
  key: string;
  method: string;
  path: string;
  /** Absolute file the route is declared in. */
  file: string;
  /**
   * The decorator RUN this route sits in — every decorator and comment attached
   * to it, above and below. Ask this about `@Public`, `@RequirePermission`,
   * `@RequireStepUp`, `@RequireModule`.
   */
  block: string;
  /**
   * This route's decorator through to the next route's — the handler body.
   * Ask this about what the handler CALLS. Deliberately separate from `block`:
   * one question is about decorators, which may be written above the route, and
   * the other is about code, which is always below it.
   */
  body: string;
  /** Each argument of @RequirePermission, split; `[]` when the route has none. */
  permissions: string[];
  stepUp: boolean;
  isPublic: boolean;
}

export function walkControllers(dir: string = API_SRC): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walkControllers(p));
    else if (entry.endsWith(".controller.ts")) out.push(p);
  }
  return out;
}

/**
 * The prefix of the controller a given offset belongs to — the NEAREST
 * `@Controller` at or above it, not the first in the file.
 */
export function controllerPrefixAt(src: string, index: number): string {
  let prefix = "";
  for (const m of src.matchAll(CONTROLLER)) {
    if (m.index! > index) break;
    prefix = m[1] ?? "";
  }
  return prefix;
}

export function joinRoute(prefix: string, suffix: string): string {
  return ("/" + [prefix, suffix].filter(Boolean).join("/")).replace(/\/+/g, "/");
}

/** Every HTTP route the API declares, each resolved against its OWN controller. */

/**
 * The whole decorator run a route decorator sits in — walking UP through
 * decorators, comments and blank lines, and DOWN through decorators and
 * comments.
 *
 * // GOTCHA, and my own first version had it: taking "this decorator to the
 * next route" reads only what is written BELOW. `@Public()` is written ABOVE
 * `@Post(...)` in every controller that has one, so a block anchored at the
 * route decorator reported `isPublic: false` for the public careers intake, the
 * biometric ingestion and the payment webhook — the three routes any gate
 * asking about public routes exists to look at. Decorator ORDER is a style
 * choice a reader makes freely; a gate that depends on it is a gate that goes
 * quiet when somebody reorders two lines.
 */
function decoratorRun(lines: string[], line: number): string {
  const isDecoratorish = (t: string) =>
    t.startsWith("@") || t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
  const run: string[] = [lines[line]];
  for (let j = line - 1; j >= 0; j--) {
    const t = lines[j].trim();
    if (!(isDecoratorish(t) || t === "")) break;
    run.unshift(lines[j]);
  }
  for (let k = line + 1; k < lines.length; k++) {
    const t = lines[k].trim();
    if (!isDecoratorish(t)) break;
    run.push(lines[k]);
  }
  return run.join("\n");
}

export function apiRoutes(dir: string = API_SRC): ApiRoute[] {
  const out: ApiRoute[] = [];
  for (const file of walkControllers(dir)) {
    const src = readFileSync(file, "utf8");
    const lines = src.split("\n");
    // Offset of the first character of each line, so a regex index over the
    // whole file can be resolved back to a line.
    const lineAt: number[] = [];
    { let n = 0; for (const l of lines) { lineAt.push(n); n += l.length + 1; } }
    const lineOf = (index: number): number => {
      let lo = 0, hi = lineAt.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineAt[mid] <= index) lo = mid; else hi = mid - 1; }
      return lo;
    };
    const hits = [...src.matchAll(ROUTE)];
    for (const [i, m] of hits.entries()) {
      const block = decoratorRun(lines, lineOf(m.index!));
      const body = src.slice(m.index!, hits[i + 1]?.index ?? src.length);
      const args = /@RequirePermission\(([^)]*)\)/.exec(block)?.[1] ?? "";
      const method = m[1].toUpperCase();
      const path = joinRoute(controllerPrefixAt(src, m.index!), m[2] ?? "");
      out.push({
        key: `${method} ${path}`,
        method,
        path,
        file,
        block,
        body,
        permissions: args.split(",").map((a) => a.trim()).filter(Boolean),
        stepUp: /@RequireStepUp\(/.test(block),
        isPublic: /@Public\(\)/.test(block),
      });
    }
  }
  return out;
}
