/**
 * The served runbooks must not lag the runbooks.
 *
 * `app/runbooks/runbook-html.ts` is GENERATED from docs/RUNBOOK-*.md. The
 * markdown stays the single source of truth, because the discipline this
 * codebase already keeps — "when a fix changes operational behaviour, update the
 * runbook in the SAME PR" — points at those files.
 *
 * The failure this guards against is specific and quiet: someone corrects a
 * procedure in the markdown, does not regenerate, and the copy served inside the
 * product goes on describing the old one. Nobody notices, because the page still
 * renders perfectly. And it is read at three in the morning by whoever is on
 * call, who has no reason to doubt it. A runbook that lags reality is worse than
 * no runbook at all, precisely because it is trusted.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { join } from "node:path";

const webRoot = join(__dirname, "..", "..");
const generatedPath = join(webRoot, "app", "runbooks", "runbook-html.ts");

describe("the runbooks served inside the app", () => {
  it("match the markdown they are generated from", () => {
    const before = readFileSync(generatedPath, "utf8");
    // Regenerate into the same place and compare. Re-running the real generator
    // is the only check that cannot itself drift from it.
    execFileSync("node", [join(webRoot, "scripts", "build-runbooks.mjs")], { stdio: "pipe" });
    const after = readFileSync(generatedPath, "utf8");
    if (before !== after) {
      throw new Error(
        "app/runbooks/runbook-html.ts is STALE — /runbooks would serve an out-of-date procedure.\n" +
          "Fix: pnpm --filter @sms/web build:runbooks (the file has just been regenerated for you; commit it).",
      );
    }
  });

  it("carry both books, with their headings and their commands intact", () => {
    // A converter that silently dropped content would pass the staleness check
    // above, because it would drop it consistently.
    const generated = readFileSync(generatedPath, "utf8");
    for (const key of ["incident", "backup"]) {
      expect(generated).toContain(`"${key}":`);
    }
    expect(generated).toMatch(/<h2 id=/);
    expect(generated).toMatch(/<pre><code>/);
    expect(generated).toMatch(/<table>/);
  });

  it("never lets a shell comment become a heading", () => {
    // Both runbooks are largely shell, and `# Sanity check ...` inside a bash
    // fence is a comment. A converter that treated fences as ordinary text would
    // turn commands into section titles and mangle the ones being copied.
    const generated = readFileSync(generatedPath, "utf8");
    // Anchored to the START of the heading: "4.4 Getting a shell / a psql
    // session" is a real heading that merely mentions a command, and an
    // unanchored match would fail on it — a test that cries wolf gets deleted.
    expect(generated).not.toMatch(/<h[123][^>]*>(aws |psql |docker |export |pg_restore|curl |kubectl )/);
  });

  it("carries a real PDF for each runbook, not a promise of one", () => {
    const generated = readFileSync(generatedPath, "utf8");
    for (const key of ["incident", "backup"]) {
      const m = new RegExp(`"${key}": \\{ title: ".*?", html: ".*?", pdfBase64: "([A-Za-z0-9+/=]+)"`, "s").exec(
        generated,
      );
      expect([key, m !== null]).toEqual([key, true]);
      const bytes = Buffer.from(m![1], "base64");
      // A real PDF, produced from the same parse as the page.
      expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
      expect(bytes.subarray(-6).toString("latin1")).toContain("%%EOF");
      expect(bytes.length).toBeGreaterThan(5000);
    }
  });

  it("states a page count the document actually has", () => {
    // The footer sits below the bottom margin, and pdfkit answers text that does
    // not fit by ADDING A PAGE — so writing twelve footers produced twenty-four
    // pages, each claiming "of 12". Wrong about the one fact a page number
    // exists to state.
    //
    // The footer text lives in a DEFLATED content stream, so it has to be
    // inflated to be read. The first version of this test searched the raw
    // bytes, found nothing, and passed — vacuously, and it went on passing when
    // the bug was put back. A test that cannot fail is worse than no test.
    const generated = readFileSync(generatedPath, "utf8");
    const m = /"incident": \{ title: ".*?", html: ".*?", pdfBase64: "([A-Za-z0-9+/=]+)"/s.exec(generated);
    const bytes = Buffer.from(m![1], "base64");

    const pageObjects = (bytes.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    expect(pageObjects).toBeGreaterThan(1);

    let declared = 0;
    let i = 0;
    for (;;) {
      const start = bytes.indexOf("\nstream", i);
      if (start === -1) break;
      let from = start + 7;
      while (bytes[from] === 0x0d || bytes[from] === 0x0a) from += 1;
      const end = bytes.indexOf("endstream", from);
      if (end === -1) break;
      i = end + 9;
      let text: string;
      try {
        text = inflateSync(bytes.subarray(from, end)).toString("latin1");
      } catch {
        continue;
      }
      // pdfkit writes runs as hex strings inside TJ arrays.
      const decoded = [...text.matchAll(/<([0-9A-Fa-f]+)>/g)]
        .map((h) => Buffer.from(h[1], "hex").toString("latin1"))
        .join("");
      const hit = /page \d+ of (\d+)/.exec(decoded);
      if (hit) {
        declared = Number(hit[1]);
        break;
      }
    }

    expect(declared).toBeGreaterThan(0); // the footer must be findable at all
    expect(declared).toBe(pageObjects);
  });

  it("transliterates characters the built-in fonts cannot encode", () => {
    // The standard PDF fonts are WinAnsi. An arrow outside it does not vanish —
    // it prints as garbage, which turned "CloudFront -> ALB" into nonsense in an
    // architecture note.
    const src = readFileSync(join(webRoot, "scripts", "runbook-pdf.mjs"), "utf8");
    expect(src).toMatch(/TRANSLITERATE/);
    for (const cp of ["u2192", "u20a6"]) expect(src).toContain(cp);
  });

  it("escapes angle brackets rather than emitting them as markup", () => {
    // The post-mortem template contains `<short title>` and `<name>`. Emitted
    // raw, a browser swallows them as unknown tags and the template silently
    // loses its placeholders.
    const generated = readFileSync(generatedPath, "utf8");
    expect(generated).toContain("&lt;short title&gt;");
  });
});
