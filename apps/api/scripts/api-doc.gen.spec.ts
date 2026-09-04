/**
 * Data extraction for `pnpm --filter @sms/api build:api-doc`.
 *
 * This is NOT part of the test suite: it lives outside jest's `roots`
 * (`src`, `test`), so an ordinary run never picks it up. The build script
 * invokes it explicitly. It exists as a spec because the ONE answer to
 * "what routes does this API declare" is `test/support/api-routes.ts`, which
 * is TypeScript — and `api-routes.spec.ts` fails the build if any file outside
 * that module hand-rolls a second route walker. So the generator borrows the
 * shared extractor rather than growing an eighth copy of it.
 */
import fs from "node:fs";
import path from "node:path";
import { apiRoutes } from "../test/support/api-routes";
import * as types from "@sms/types";

/** `ADMIN_PERMISSIONS.RBAC_MANAGE` -> `"rbac.manage"`, via the real constant. */
function resolvePermission(identifier: string): string {
  const [objectName, ...rest] = identifier.split(".");
  const bag = (types as Record<string, unknown>)[objectName];
  if (bag && typeof bag === "object") {
    const value = (bag as Record<string, unknown>)[rest.join(".")];
    if (typeof value === "string") return value;
  }
  // Unresolvable (a literal, or a constant that is not exported from the
  // barrel): show what the source says rather than dropping the gate.
  return identifier;
}

/** The first sentence of the handler's doc comment, if it carries one. */
function docSentence(block: string): string | null {
  const comments = [...block.matchAll(/\/\*\*([\s\S]*?)\*\//g)];
  if (comments.length === 0) return null;
  const text = comments[comments.length - 1][1]
    .split("\n")
    .map((line) => line.replace(/^\s*\*ic?\s?/, "").replace(/^\s*\*\s?/, "").trim())
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  const sentence = text.split(/(?<=[.!?])\s+(?=[A-Z(])/)[0].trim();
  return sentence.replace(/\|/g, "\\|") || null;
}

it("writes the route inventory the API reference is generated from", () => {
  const routes = apiRoutes();
  expect(routes.length).toBeGreaterThan(500);

  const moduleOf = new Map<string, string | null>();
  const rows = routes.map((r) => {
    if (!moduleOf.has(r.file)) {
      const src = fs.readFileSync(r.file, "utf8");
      const m = src.match(/@RequireModule\(\s*MODULES\.([A-Z_0-9]+)/);
      const key = m?.[1];
      const value = key
        ? ((types.MODULES as unknown as Record<string, string>)[key] ?? key.toLowerCase())
        : null;
      moduleOf.set(r.file, value);
    }
    // A route-level @RequireModule overrides the class-level one.
    const own = r.block.match(/@RequireModule\(\s*MODULES\.([A-Z_0-9]+)/);
    const ownValue = own
      ? ((types.MODULES as unknown as Record<string, string>)[own[1]] ?? own[1].toLowerCase())
      : null;
    const handler = r.body.match(/\n\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/)?.[1] ?? "";
    return {
      method: r.method,
      path: r.path,
      dir: r.file.split(`${path.sep}src${path.sep}`)[1].split(path.sep)[0],
      file: r.file.split(`${path.sep}src${path.sep}`)[1],
      permissions: r.permissions.map(resolvePermission),
      stepUp: r.stepUp,
      isPublic: r.isPublic,
      module: ownValue ?? moduleOf.get(r.file) ?? null,
      doc: docSentence(r.block),
      handler,
    };
  });

  const out = process.env.API_DOC_DATA ?? "/tmp/api-doc-data.json";
  fs.writeFileSync(out, JSON.stringify(rows, null, 0));
  // eslint-disable-next-line no-console
  console.log(`api-doc: ${rows.length} routes -> ${out}`);
});
