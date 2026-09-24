/**
 * A numbered step in a runbook must render as the number it was written with.
 *
 * The runbooks are served in the product and as a PDF, both from ONE parse
 * (`scripts/markdown-blocks.mjs`). That parser read a list item as a single
 * LINE. These documents wrap their steps, so a step's second line fell out of
 * the list as a separate paragraph, the next step opened a NEW list, and a
 * numbered procedure rendered as "1. 1. 1." — 39 of them across the three
 * runbooks. It also only knew a code fence in column 0, so the commands inside
 * a step were printed as running text with raw backticks: seven of them,
 * including the isolation-probe command in the SEV-1 tenant-breach playbook.
 *
 * Every page still rendered, and every test that asked whether the served copy
 * MATCHED the markdown passed, because it did — it matched a wrong parse.
 *
 * Drives the REAL parser over the REAL runbooks, as a child process the way
 * `runbook-freshness` drives the build script.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const webRoot = join(__dirname, "..", "..");
const docs = join(webRoot, "..", "..", "docs");
const RUNBOOKS = ["RUNBOOK-INCIDENT-RESPONSE.md", "RUNBOOK-BACKUP-RESTORE.md", "RUNBOOK-SCHOOL-MIGRATION.md"];

type Block =
  | { type: "list"; ordered: boolean; start: number; items: string[] }
  | { type: "para" | "quote"; text: string }
  | { type: "code"; text: string }
  | { type: string };

function parse(file: string): Block[] {
  const script = `
    import { parseMarkdown } from ${JSON.stringify(join(webRoot, "scripts", "markdown-blocks.mjs"))};
    import { readFileSync } from "node:fs";
    process.stdout.write(JSON.stringify(parseMarkdown(readFileSync(${JSON.stringify(join(docs, file))}, "utf8")).blocks));
  `;
  return JSON.parse(execFileSync("node", ["--input-type=module", "-e", script], { encoding: "utf8" }));
}

/** Top-level numbered steps as WRITTEN, in document order, outside code fences. */
function writtenSteps(md: string): number[] {
  const out: number[] = [];
  let inFence = false;
  for (const line of md.split("\n")) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    else if (!inFence) {
      const m = line.match(/^(\d+)\.\s+/);
      if (m) out.push(Number(m[1]));
    }
  }
  return out;
}

describe.each(RUNBOOKS)("%s", (file) => {
  const md = readFileSync(join(docs, file), "utf8");
  const blocks = parse(file);

  it("renders every numbered step with the number it was written with", () => {
    const written = writtenSteps(md);
    const rendered = blocks
      .filter((b): b is Extract<Block, { type: "list" }> => b.type === "list" && (b as { ordered?: boolean }).ordered === true)
      .flatMap((b) => b.items.map((_, n) => b.start + n));
    expect(written.length).toBeGreaterThan(0); // a walk that finds nothing must not pass
    expect(rendered).toEqual(written);
  });

  it("never leaks a code fence into running text", () => {
    const text = blocks.flatMap((b) =>
      b.type === "list" ? (b as { items: string[] }).items : "text" in b && b.type !== "code" ? [(b as { text: string }).text] : [],
    );
    expect(text.filter((t) => t.includes("```"))).toEqual([]);
  });

  it("keeps a wrapped step's second line inside the step", () => {
    const lines = md.split("\n");
    const items = blocks.flatMap((b) => (b.type === "list" ? (b as { items: string[] }).items : []));
    const orphans: string[] = [];
    let inFence = false;
    for (let n = 0; n < lines.length - 1; n += 1) {
      if (/^\s*```/.test(lines[n])) inFence = !inFence;
      if (inFence) continue;
      const next = lines[n + 1];
      if (/^(\d+\.|[-*])\s+/.test(lines[n]) && /^\s{2,}\S/.test(next) && !/^\s*(\d+\.|[-*])\s+|^\s*```/.test(next)) {
        const tail = next.trim();
        if (!items.some((t) => t.includes(tail))) orphans.push(`line ${n + 2}: ${tail}`);
      }
    }
    expect(orphans).toEqual([]);
  });
});

it("gives a list that a code block interrupted its written start in the served page", () => {
  const generated = readFileSync(join(webRoot, "app", "runbooks", "runbook-html.ts"), "utf8");
  // §11.2 of the migration runbook: step 4 follows step 3's code block.
  expect(generated).toMatch(/<ol start=\\"4\\">/);
});
