/**
 * API.md must document EVERY route this API declares.
 *
 * It used to claim it was "generated from the NestJS controllers" and was not:
 * it listed 351 of 901 routes under a headline claiming 634. A reference that
 * is a subset of the surface is worse than no reference at all, because a
 * missing route reads as a route that does not exist — which is exactly the
 * question somebody consults it to answer.
 *
 * It IS generated now (`pnpm --filter @sms/api build:api-doc`), and this is
 * what stops it drifting again: add a route without regenerating and the build
 * fails, naming the route and the command.
 *
 * The gate deliberately does NOT re-run the generator — a test that regenerates
 * the artifact it is checking always passes. It compares the committed file
 * against the shared route extractor, which is the same thing the generator
 * reads.
 */
import fs from "node:fs";
import path from "node:path";
import { apiRoutes } from "../support/api-routes";

const API_MD = path.resolve(__dirname, "..", "..", "..", "..", "API.md");
const REGENERATE = "pnpm --filter @sms/api build:api-doc";

/** Every `METHOD path` the committed reference lists, expanding `GET · PUT` rows. */
function documentedRoutes(markdown: string): Set<string> {
  const found = new Set<string>();
  for (const line of markdown.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 4) continue;
    const methods = cells[0]
      .split("·")
      .map((m) => m.trim())
      .filter((m) => /^(GET|POST|PUT|PATCH|DELETE)$/.test(m));
    if (methods.length === 0) continue;
    const pathCell = cells[1].match(/^`([^`]+)`$/);
    if (!pathCell) continue;
    for (const m of methods) found.add(`${m} ${pathCell[1]}`);
  }
  return found;
}

describe("API.md is current", () => {
  const markdown = fs.readFileSync(API_MD, "utf8");
  const routes = apiRoutes();
  const documented = documentedRoutes(markdown);

  it("finds a believable number of routes on both sides", () => {
    // A walk that reads nothing produces no offenders and passes silently —
    // the failure `a-gate-must-not-pass-by-finding-nothing` exists to forbid.
    expect(routes.length).toBeGreaterThan(500);
    expect(documented.size).toBeGreaterThan(500);
  });

  it("documents every route the API declares", () => {
    const missing = routes
      .map((r) => `${r.method} ${r.path}`)
      .filter((key) => !documented.has(key))
      .sort();
    expect(
      missing.length === 0
        ? []
        : [`${missing.length} route(s) missing from API.md — run \`${REGENERATE}\``, ...missing.slice(0, 25)],
    ).toEqual([]);
  });

  it("lists no route the API no longer declares", () => {
    // The other direction matters just as much: a reference naming an endpoint
    // that was removed sends a reader to build against something that 404s.
    const live = new Set(routes.map((r) => `${r.method} ${r.path}`));
    const stale = [...documented].filter((key) => !live.has(key)).sort();
    expect(
      stale.length === 0
        ? []
        : [`${stale.length} route(s) in API.md no longer exist — run \`${REGENERATE}\``, ...stale.slice(0, 25)],
    ).toEqual([]);
  });

  it("states the real route and controller counts in its headline", () => {
    // A count typed into prose rots the moment a route is added. The generator
    // writes it; this asserts the committed copy still agrees.
    const controllers = new Set(routes.map((r) => r.file)).size;
    const headline = markdown.match(/\*\*(\d+) routes across (\d+) controllers\.\*\*/);
    expect(headline).not.toBeNull();
    expect({ routes: Number(headline?.[1]), controllers: Number(headline?.[2]) }).toEqual({
      routes: routes.length,
      controllers,
    });
  });

  it("says how to regenerate itself, so a reader does not hand-edit it", () => {
    expect(markdown).toContain(REGENERATE);
    expect(markdown).toMatch(/GENERATED/);
  });
});
