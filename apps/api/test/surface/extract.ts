// =============================================================================
// The API surface, extracted from source — shared by the generator and the gate
// =============================================================================
// This exists because certainty about "does every endpoint have a way to reach
// it" cannot come from pattern-matching the web. Paths there are built at
// runtime — `postSms(`payments/${id}/${action}`)` — so no static analysis can
// resolve them. What CAN be known for certain is:
//
//   • the complete list of routes the API serves (parsed here), and
//   • a committed decision about each one (the registry).
//
// Certainty comes from someone having looked at each route once. The gate is
// what keeps that true afterwards.
// =============================================================================

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface ApiRoute {
  /** "GET /fees/:id" — the stable key used by the registry. */
  key: string;
  method: string;
  path: string;
  /** Source file, so a reviewer can open the thing being classified. */
  file: string;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".controller.ts")) out.push(full);
  }
  return out;
}

/**
 * Normalise a path so `/fees/:id` and `/fees/:invoiceId` compare equal.
 *
 * STRIPS THE QUERY STRING. The web fetches `/operator/tenants?page=${n}`, and
 * comparing that to the route `/operator/tenants` fails on the query alone —
 * which made a page everyone uses every day look unreachable.
 */
export function normalisePath(p: string): string {
  return (
    "/" +
    p
      .split("?")[0]
      .split("#")[0]
      .replace(/\$\{[^}]*\}/g, ":p")
      .replace(/:[A-Za-z_]\w*/g, ":p")
      .split("/")
      .filter(Boolean)
      .join("/")
  );
}

/**
 * Every route the API serves.
 *
 * ONE FILE CAN DECLARE MORE THAN ONE @Controller, and two do: the public
 * careers board lives beside the HR recruitment controller, and the public
 * biometric intake beside HR attendance — deliberately, so those routes sit at
 * /public/* outside their module's prefix and gate. Taking the FIRST
 * @Controller in the file as the prefix for every route in it therefore filed
 * `GET /public/careers/:slug` under `GET /hr/recruitment/:p`, and the registry
 * ended up asserting two routes that do not exist while three that do — all of
 * them PUBLIC and unauthenticated — went unaccounted for. Exactly the routes a
 * surface gate is most for.
 *
 * So the prefix is resolved by POSITION: each route decorator belongs to the
 * last @Controller declared above it.
 */
export function extractRoutes(srcDir: string): ApiRoute[] {
  const routes: ApiRoute[] = [];
  for (const file of walk(srcDir)) {
    const src = readFileSync(file, "utf8");
    const controllers = [...src.matchAll(/@Controller\(\s*(?:["'`]([^"'`]*)["'`])?/g)].map((c) => ({
      at: c.index ?? 0,
      base: c[1] ?? "",
    }));
    /** The prefix of the nearest @Controller ABOVE this decorator. */
    const baseFor = (at: number) => {
      let base = "";
      for (const c of controllers) {
        if (c.at > at) break;
        base = c.base;
      }
      return base;
    };
    // Handles @Get(), @Get("x"), and decorators split across lines.
    for (const m of src.matchAll(/@(Get|Post|Put|Patch|Delete|All)\(\s*(?:["'`]([^"'`]*)["'`])?\s*\)/g)) {
      const method = m[1].toUpperCase();
      const path = normalisePath([baseFor(m.index ?? 0), m[2] ?? ""].filter(Boolean).join("/"));
      routes.push({ key: `${method} ${path}`, method, path, file: file.slice(srcDir.length + 1) });
    }
  }
  // Two decorators can produce the same key (the mobile-money callback is POST
  // and PUT on one path, by design). Dedupe on the key.
  const seen = new Map<string, ApiRoute>();
  for (const r of routes) if (!seen.has(r.key)) seen.set(r.key, r);
  return [...seen.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Every API path the web references with a LITERAL string.
 *
 * Deliberately incomplete, and that is the point: it proves reachability, it
 * cannot disprove it. A route missing here may still be reached by a
 * runtime-built path. Used only to AUTO-CLASSIFY the easy majority so the human
 * review is small — never to declare a gap.
 */
export function extractWebRefs(webDir: string): Set<string> {
  const refs = new Set<string>();
  const files: string[] = [];
  const walkWeb = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === ".next") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walkWeb(full);
      else if (/\.tsx?$/.test(full)) files.push(full);
    }
  };
  walkWeb(webDir);

  // `[^(\n]*` after the helper name absorbs any generic — including nested ones
  // like `<Serialized<Dto>[]>`, which an `<[^>]*>` pattern truncates. That single
  // bug hid 90 real references and made an earlier audit wildly over-report.
  const pats = [
    /\bapiGet[^(\n]*\(\s*["'`]([^"'`]+)/g,
    /\bpostSms[^(\n]*\(\s*["'`]([^"'`]+)/g,
    /\bsendSms[^(\n]*\(\s*["'`][A-Z]+["'`]\s*,\s*["'`]([^"'`]+)/g,
    /\bsendWithStepUp[^(\n]*\(\s*["'`][A-Z]+["'`]\s*,\s*["'`]([^"'`]+)/g,
    /\bpostWithStepUp[^(\n]*\(\s*["'`]([^"'`]+)/g,
    /\busePaged[^(\n]*\(\s*["'`]([^"'`]+)/g,
    /\/api\/sms\/([^"'`)\s?]+)/g,
  ];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const p of pats) for (const m of src.matchAll(p)) refs.add(normalisePath(m[1]));
  }
  return refs;
}

/**
 * The path SHAPES the web builds at runtime, e.g. `payments/${id}/${action}`
 * becomes "/payments/:p/:p".
 *
 * This is what makes the dynamic case classifiable with evidence rather than by
 * assumption. A shape proves the web constructs paths of that form; a route
 * matching one is reachable even though its literal never appears in source.
 * Weaker than a literal, and recorded as such in the registry note.
 */
export function extractWebShapes(webDir: string): Set<string> {
  const shapes = new Set<string>();
  const files: string[] = [];
  const walkWeb = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === ".next") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walkWeb(full);
      else if (/\.tsx?$/.test(full)) files.push(full);
    }
  };
  walkWeb(webDir);
  const pats = [
    /\bpostSms[^(\n]*\(\s*`([^`]+)`/g,
    /\bsendSms[^(\n]*\(\s*["'`][A-Z]+["'`]\s*,\s*`([^`]+)`/g,
    /\bsendWithStepUp[^(\n]*\(\s*["'`][A-Z]+["'`]\s*,\s*`([^`]+)`/g,
    /\bapiGet[^(\n]*\(\s*`([^`]+)`/g,
    /\bpostWithStepUp[^(\n]*\(\s*`([^`]+)`/g,
    /\busePaged[^(\n]*\(\s*`([^`]+)`/g,
  ];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const p of pats) {
      for (const m of src.matchAll(p)) {
        shapes.add(
          "/" +
            m[1]
              .split("/")
              .filter(Boolean)
              .map((seg) => (seg.includes("${") ? ":p" : seg))
              .join("/"),
        );
      }
    }
  }
  return shapes;
}
