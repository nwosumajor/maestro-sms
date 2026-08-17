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

  it("escapes angle brackets rather than emitting them as markup", () => {
    // The post-mortem template contains `<short title>` and `<name>`. Emitted
    // raw, a browser swallows them as unknown tags and the template silently
    // loses its placeholders.
    const generated = readFileSync(generatedPath, "utf8");
    expect(generated).toContain("&lt;short title&gt;");
  });
});
