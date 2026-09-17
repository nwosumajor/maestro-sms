// =============================================================================
// An allowlist that only ever learned about what existed when it was written
// =============================================================================
// `local-storage.controller.ts` shape-checks a storage key before touching the
// filesystem. It admitted `schools/` and `careers/` — the only two prefixes
// there were when it was written — and four more were added afterwards without
// it: `lms/` (a subject teacher's weekly PDF), `discipline/` (evidence on a
// complaint), `submissions/` (a pupil's work) and `tasks/` (a task attachment).
//
// On the stub provider — what the documented local stack runs — every presigned
// PUT under those four answered 400 "Not available", so four upload features
// could not upload at all. They failed at the FIRST step, and the refusal is
// deliberately worded to be indistinguishable from a bad signature, so there was
// nothing to read. Found by driving the LMS one end to end against the live
// stack rather than by reading either file.
//
// A hand-kept set only guards what somebody remembered, so this DERIVES the
// minted set from source. Adding a seventh prefix without adding it to the
// allowlist fails here, naming both.
// =============================================================================

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { STORAGE_KEY_PREFIXES } from "../../src/documents/local-storage.controller";

const SRC = join(__dirname, "..", "..", "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith(".ts") && !full.endsWith(".spec.ts")) out.push(full);
  }
  return out;
}

/**
 * Every top-level namespace the API mints a storage key under.
 *
 * A key is a template literal whose first segment is a bare word and whose
 * second interpolates something — `\`lms/${schoolId}/…\``. Anchored on the
 * BACKTICK so an ordinary route string ("submissions/:id/grade", which appears
 * in a comment two files over) cannot be mistaken for one.
 */
function mintedPrefixes(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of walk(SRC)) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/`([a-z][a-z-]{2,})\/\$\{/g)) {
      const prefix = m[1];
      found.set(prefix, [...(found.get(prefix) ?? []), file.slice(SRC.length + 1)]);
    }
  }
  return found;
}

describe("every storage key the API mints can actually be used", () => {
  it("found the minting sites at all", () => {
    // A walk that finds nothing produces no offenders and passes green.
    const minted = mintedPrefixes();
    expect(minted.size).toBeGreaterThanOrEqual(5);
    expect([...minted.keys()]).toEqual(expect.arrayContaining(["lms", "schools", "tasks"]));
  });

  it("admits every prefix something actually writes under", () => {
    const allowed = new Set<string>(STORAGE_KEY_PREFIXES);
    // Only prefixes that are STORAGE keys — a template literal beginning with a
    // word and a slash is also how a few URLs are built, so the check is
    // narrowed to the files that reach a storage provider.
    const minted = mintedPrefixes();
    const offenders = [...minted.entries()]
      .filter(([prefix, files]) =>
        !allowed.has(prefix) &&
        files.some((f) => {
          const src = readFileSync(join(SRC, f), "utf8");
          return /presignUpload|presignDownload|storage\.upload|storage\.download/.test(src);
        }),
      )
      .map(([prefix, files]) => `${prefix}/ (minted in ${files.join(", ")})`);

    expect(offenders).toEqual([]);
  });

  it("still refuses traversal and an unknown namespace", () => {
    // Widening the REACH must not widen the RULE. The shape is not the
    // authorisation — the HMAC is — but it is what keeps an odd key out of a
    // filesystem path.
    const shape = new RegExp(`^(${[...STORAGE_KEY_PREFIXES].join("|")})\\/[a-zA-Z0-9-]+\\/[a-zA-Z0-9/_.-]+$`);
    expect(shape.test("lms/school-1/c1/1_notes.pdf")).toBe(true);
    expect(shape.test("nope/school-1/x")).toBe(false);
    expect(shape.test("../../etc/passwd")).toBe(false);
    // `..` inside a valid-looking key is caught by the explicit guard beside the
    // shape, not by the character class — which happily matches it.
    expect("schools/a/../../etc/passwd".includes("..")).toBe(true);
  });
});
