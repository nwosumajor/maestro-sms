// =============================================================================
// The web asserts a response shape; nothing checked it against the API
// =============================================================================
// `apiGet<T>(path)` is an ASSERTION about the wire, not a check of it. When
// `GET /workflows` and `GET /assessments` changed from an array to
// `{ items, total, page, pageSize }`, the producer, the DTO and the consumer all
// compiled — the consumer's `<WorkflowRow[]>` was simply a claim, and nothing on
// either side is in a position to contradict it.
//
// `/admin` and `/assessments/:id` then threw for every role that could open
// them, and 3,602 green API tests plus a clean web typecheck said nothing. The
// per-role route smoke caught it, which is fine except that the smoke is a
// browser-driven run somebody has to remember, and this is a comparison of two
// strings.
//
// So: for every `apiGet<W>("/path")` in the web whose route has an explicit
// `Promise<A>` on the API handler, W and A must agree about being a LIST. That
// is the mismatch that actually happened and the one a reader cannot see,
// because each side looks perfectly reasonable alone.
//
// Deliberately narrow. It does not compare field by field — the DTO already
// does that for the API, `Serialized<T>` does it for the web, and a structural
// comparison across two type systems would be a great deal of machinery to
// catch less than this does.
// =============================================================================

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { normalisePath } from "./extract";

const API_SRC = join(__dirname, "../../src");
const WEB_DIR = join(__dirname, "../../../web");

/** Handlers whose declared return type is deliberately not comparable. */
const NOT_COMPARED: Record<string, string> = {};

function files(dir: string, pred: (f: string) => boolean, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === ".next") continue;
    const f = join(dir, e);
    if (statSync(f).isDirectory()) files(f, pred, out);
    else if (pred(f)) out.push(f);
  }
  return out;
}

const isList = (t: string) => /\[\]\s*$/.test(t.trim()) || /^Array</.test(t.trim());

/** "GET /path" -> the handler's declared return type, where one is written. */
function apiReturnTypes(): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of files(API_SRC, (f) => f.endsWith(".controller.ts"))) {
    const src = readFileSync(file, "utf8");
    const prefix = /@Controller\(\s*["'`]([^"'`]*)["'`]\s*\)/.exec(src)?.[1] ?? "";
    // A @Get decorator, then (skipping other decorators) the method signature.
    for (const m of src.matchAll(/@Get\(\s*(?:["'`]([^"'`]*)["'`])?\s*\)([\s\S]{0,600}?)\)\s*:\s*Promise<([^>]+(?:<[^>]*>)?[^>]*)>/g)) {
      const sub = m[1] ?? "";
      const ret = m[3];
      // Only the first signature after the decorator, never one further down.
      if (/@(Get|Post|Put|Patch|Delete)\(/.test(m[2])) continue;
      const path = normalisePath("/" + [prefix, sub].filter(Boolean).join("/"));
      out.set(`GET ${path}`, ret.trim());
    }
  }
  return out;
}

/** Every `apiGet<T>("/path")` the web writes. */
function webAssertions(): Array<{ type: string; path: string; file: string }> {
  const out: Array<{ type: string; path: string; file: string }> = [];
  for (const file of files(WEB_DIR, (f) => /\.tsx?$/.test(f) && !f.endsWith(".d.ts"))) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/\bapiGet<([^>]+(?:<[^>]*>)?[^>]*)>\s*\(\s*[`"']([^`"']+)[`"']/g)) {
      out.push({ type: m[1].trim(), path: normalisePath(m[2]), file: file.slice(WEB_DIR.length + 1) });
    }
  }
  return out;
}

describe("the shape the web asserts and the shape the API declares", () => {
  const api = apiReturnTypes();
  const web = webAssertions();
  const mismatches: string[] = [];
  let compared = 0;

  for (const w of web) {
    const declared = api.get(`GET ${w.path}`);
    if (!declared) continue; // no annotation, or a path this crude matcher missed
    if (`GET ${w.path}` in NOT_COMPARED) continue;
    compared += 1;
    // `Serialized<X>` and `X` agree about being a list; unwrap before asking.
    const unwrap = (t: string) => t.replace(/^Serialized<([\s\S]*)>$/, "$1").trim();
    if (isList(unwrap(w.type)) !== isList(unwrap(declared))) {
      mismatches.push(`${w.file}: apiGet<${w.type}>("${w.path}") but the API returns ${declared}`);
    }
  }

  it("agree about whether the response is a list", () => {
    expect(mismatches).toEqual([]);
  });

  it("reports how much it covers", () => {
    // eslint-disable-next-line no-console -- the gate's coverage is the point
    console.log(`wire-shape gate: compared ${compared} of ${web.length} apiGet call sites against ${api.size} annotated GET handlers`);
    expect(compared).toBeGreaterThan(0);
  });

  it("actually compared something", () => {
    // A matcher that silently matches nothing would pass for ever. This is the
    // gate's own blind spot, made visible: if it drops toward zero, the
    // extraction has broken rather than the code having become perfect.
    expect(compared).toBeGreaterThan(20);
  });
});
