// =============================================================================
// Proving an absence by searching a blob for a short number
// =============================================================================
// `expect(JSON.stringify(x)).not.toContain("5")` looks like it proves the five
// is gone. It proves no digit 5 appears anywhere in the serialised object —
// including inside the capture timestamp, a UUID, a page count, or a price that
// has nothing to do with the property.
//
// This codebase has made and fixed the same mistake three times:
//
//   retention-coverage   `not.toContain("99")`  — failed on `…45.990Z`
//   reportcard-pdf       `not.toContain("57")`  — failed under full-suite
//                                                 parallelism, passed on a
//                                                 re-run, so the next person
//                                                 spent their time proving
//                                                 their change innocent
//   scholarship signals  `not.toContain("5")`   — failed on `…23.856Z`,
//                                                 written an hour after the
//                                                 second one was fixed
//
// Each was a FALSE ALARM, which is the loud direction. The quiet direction is
// worse and the same shape: the value IS present, written differently — "1,234"
// against a search for "1234" — so the test passes while the thing it names
// leaked.
//
// The fix in every case was the same: assert the FIELD, by name. Which is why
// this is a gate rather than a note somebody is supposed to remember, having
// been written down and then repeated by the person who wrote it down.
// =============================================================================

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * EVERY test tree in the monorepo, not just this one.
 *
 * The gate lived in apps/api and scanned only apps/api/test — so the same defect
 * recurred just outside its reach. `packages/game-transport`'s duel spec
 * asserted `JSON.stringify(frame)` did not contain the secret "1234", over a
 * frame carrying `randomUUID()` ids in which "1234" is an ordinary hex
 * substring: about 0.045% per id and ~0.8% per run, which is roughly one red CI
 * in every 125 pushes on a test that is not wrong about anything. It duly failed
 * on an accessibility commit that touched no game code.
 *
 * A gate that covers one directory is a gate the next instance is written
 * outside.
 */
const ROOTS = [
  join(__dirname, ".."),                       // apps/api/test
  join(__dirname, "../../../../packages"),     // packages/*/src/**.spec.ts
  join(__dirname, "../../../web"),             // apps/web/**/__tests__
];

/**
 * Short numeric needles that earn their place, each with the reason.
 *
 * A LONG literal is a different thing: "600000" inside a base64 ciphertext, or
 * "50.00" as a formatted amount, is specific enough that a coincidental match is
 * not a realistic worry. This gate is about the short ones.
 */
const ALLOWED: Record<string, string> = {};

/** Fewer characters than this and a numeric needle is mostly noise. */
const MIN_NEEDLE = 4;

function specs(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    // node_modules holds SYMLINKED workspace packages, so every package's specs
    // appear again under each dependent — the same file reported two or three
    // times under names nobody can open.
    if (e === "node_modules" || e === "dist" || e === ".next") continue;
    const f = join(dir, e);
    if (statSync(f).isDirectory()) specs(f, out);
    else if (f.endsWith(".spec.ts")) out.push(f);
  }
  return out;
}

describe("an absence is asserted on the field, not by searching for a number", () => {
  const offenders: string[] = [];

  const REPO = join(__dirname, "../../../..");
  for (const file of ROOTS.flatMap((r) => specs(r))) {
    const rel = file.slice(REPO.length + 1);
    const all = readFileSync(file, "utf8").split("\n");
    all.forEach((line, i) => {
        // PROSE IS NOT CODE. Both this file's own header and the comment in
        // retention-coverage quote the bad pattern in order to explain it, and
        // a gate that cannot tell an example from an assertion would force
        // every explanation to be written in riddles.
        const code = line.trimStart();
        if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return;
        // Only the NEGATIVE form, and only a numeric needle: a positive
        // `toContain("5")` fails loudly when it is wrong, and a word needle
        // does not collide with a timestamp.
        const m = /\.not\.toContain\((["'`])([0-9][0-9.,]*)\1\)/.exec(line);
        if (!m) return;
        const needle = m[2];
        // LENGTH IS NOT THE WHOLE RISK — the HAYSTACK is.
        //
        // Four characters was treated as specific enough, and
        // `expect(JSON.stringify(frame)).not.toContain("1234")` in the duel spec
        // duly failed in CI: the frame carries randomUUID() ids, 32 hex
        // characters in which "1234" is an ordinary substring (0.045% per id,
        // ~0.8% per run). Searching a whole serialised OBJECT is the risky act,
        // however long the needle, because the object carries ids, timestamps
        // and counts that nobody chose.
        // The subject is usually assigned on an EARLIER line —
        //   const json = JSON.stringify(msg);
        //   expect(json).not.toContain("1234");
        // — which is exactly the form that failed in CI, so a line-local check
        // misses the very case this rule exists for. Follow the variable back.
        const subject = /expect\(\s*([A-Za-z_$][\w$]*)\s*\)/.exec(line)?.[1];
        const near = all.slice(Math.max(0, i - 12), i).join("\n");
        const assignment =
          // Captured to the END OF THE LINE, not just up to `JSON.stringify(`:
          // the sanitising `.replace(` comes AFTER it, so a match that stopped
          // there could never see it and every correct fix looked unsafe.
          subject && new RegExp(`\\b${subject}\\b\\s*=[^=][^\n]*JSON\\.stringify\\([^\n]*`).exec(near)?.[0];
        const wholeObject = /JSON\.stringify\(/.test(line) || !!assignment;
        // SANITISED SUBJECTS ARE FINE. The safe form of this assertion strips
        // the random parts before searching — `JSON.stringify(x).replace(uuid,
        // "<id>")` — and then a short needle means what it says. Recognising
        // that keeps the rule from forcing an allowance onto every correct fix.
        const sanitised = /\.replace\(/.test(assignment ?? (wholeObject ? line : ""));
        if (sanitised) return;
        if (!wholeObject && needle.length >= MIN_NEEDLE) return;
        if (wholeObject && needle.length > 8) return;
        const key = `${rel}:${i + 1}`;
        if (!(key in ALLOWED)) offenders.push(`${key}  not.toContain("${needle}")`);
      });
  }

  it("no spec proves an absence with a needle shorter than four characters", () => {
    expect(offenders).toEqual([]);
  });

  it("every allowance still points at a line that exists", () => {
    // A stale allowance silently widens the rule above — the same failure mode
    // as a stale audit or orphan-method exemption.
    for (const key of Object.keys(ALLOWED)) {
      const [rel, lineNo] = key.split(":");
      const lines = readFileSync(join(join(__dirname, "../../../.."), rel), "utf8").split("\n");
      expect(lines[Number(lineNo) - 1]).toMatch(/\.not\.toContain\(/);
    }
  });
});
