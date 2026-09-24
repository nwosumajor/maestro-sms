// Renders the operational runbooks from docs/*.md into bundled HTML modules.
//
// WHY GENERATE, AND WHY FROM THE MARKDOWN
//
// The runbooks are read under pressure, at three in the morning, by someone who
// may not have opened the repository. They deserve to be a page in the product
// rather than a file on GitHub. But the discipline this codebase already keeps —
// "when a fix changes operational behaviour, update the runbook in the SAME PR"
// — points at the .md files. So the markdown stays the single source of truth
// and this produces the readable copy. A hand-written HTML twin would be a
// second document to remember, and the one nobody remembered would be the one
// somebody trusted at three in the morning.
//
// Embedded as a module for the same reason as the onboarding manual: `fs` reads
// of files outside the Next build trace are not reliable in a standalone image.
//
// Re-run after editing a runbook:  pnpm --filter @sms/web build:runbooks
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { parseMarkdown, inlineRuns } from "./markdown-blocks.mjs";
import { renderRunbookPdf } from "./runbook-pdf.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const webRoot = join(here, "..");

/** The onboarding manual's stylesheet, reused verbatim so the runbooks look like
 *  part of the same product and there is only ever one stylesheet to maintain. */
function manualStyle() {
  const manual = readFileSync(join(repoRoot, "docs", "ONBOARDING-MANUAL.html"), "utf8");
  const start = manual.indexOf("<style");
  const end = manual.indexOf("</style>") + "</style>".length;
  if (start === -1 || end === -1) throw new Error("build-runbooks: could not find the manual's <style> block");
  return manual.slice(start, end);
}

const escapeHtml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Inline runs -> HTML. The PDF emitter styles the SAME runs instead of tagging
 *  them, which is what keeps the two outputs honest about the same source. */
function inlineHtml(src) {
  return inlineRuns(src)
    .map((r) => {
      const text = escapeHtml(r.text);
      if (r.code) return `<code>${text}</code>`;
      if (r.bold) return `<strong>${text}</strong>`;
      if (r.href) return `<a href="${escapeHtml(r.href)}">${text}</a>`;
      return text;
    })
    .join("");
}

/** Blocks -> the HTML page. */
function toHtml(blocks) {
  const out = [];
  for (const b of blocks) {
    switch (b.type) {
      case "heading":
        out.push(
          b.level === 1
            ? `<h1>${inlineHtml(b.text)}</h1>`
            : `<h${b.level} id="${b.id}">${inlineHtml(b.text)}</h${b.level}>`,
        );
        break;
      case "para":
        out.push(`<p>${inlineHtml(b.text)}</p>`);
        break;
      case "code":
        out.push(`<pre><code>${escapeHtml(b.text)}</code></pre>`);
        break;
      case "list": {
        const tag = b.ordered ? "ol" : "ul";
        const start = b.ordered && b.start > 1 ? ` start="${b.start}"` : "";
        out.push(`<${tag}${start}>${b.items.map((i) => `<li>${inlineHtml(i)}</li>`).join("")}</${tag}>`);
        break;
      }
      case "table": {
        const head = b.head
          ? `<thead><tr>${b.head.map((c) => `<th>${inlineHtml(c)}</th>`).join("")}</tr></thead>`
          : "";
        const body = `<tbody>${b.rows
          .map((r) => `<tr>${r.map((c) => `<td>${inlineHtml(c)}</td>`).join("")}</tr>`)
          .join("")}</tbody>`;
        out.push(`<table>${head}${body}</table>`);
        break;
      }
      case "quote":
        out.push(`<blockquote>${inlineHtml(b.text)}</blockquote>`);
        break;
      case "rule":
        out.push("<hr />");
        break;
      default:
        break;
    }
  }
  return out.join("\n");
}

const DOCS = [
  {
    key: "incident",
    file: "RUNBOOK-INCIDENT-RESPONSE.md",
    title: "Incident response",
    eyebrow: "Operations runbook",
    lede: "Severity, triage, the per-symptom playbooks, rollback, and the post-mortem that follows.",
    meta: ["For: on-call and platform staff", "Read before you need it", "Source: docs/RUNBOOK-INCIDENT-RESPONSE.md"],
  },
  {
    key: "migration",
    file: "RUNBOOK-SCHOOL-MIGRATION.md",
    title: "School migration",
    eyebrow: "Onboarding runbook",
    lede: "Moving a school off its old system: what to migrate, what to archive, and the order that keeps it recoverable.",
    meta: ["For: whoever runs the migration", "Read before the first call, not the first upload", "Source: docs/RUNBOOK-SCHOOL-MIGRATION.md"],
  },
  {
    key: "backup",
    file: "RUNBOOK-BACKUP-RESTORE.md",
    title: "Backup & restore",
    eyebrow: "Operations runbook",
    lede: "What is backed up, how far back you can go, and the drill that proves a restore actually works.",
    meta: ["For: on-call and platform staff", "Run the drill on a schedule", "Source: docs/RUNBOOK-BACKUP-RESTORE.md"],
  },
];

/**
 * Print rules the shared stylesheet does not cover, plus the ?print=1 hook.
 *
 * The manual's own @media print block hides the rail and flattens the layout,
 * which these inherit. What it does not know about is the runbooks' shape: they
 * are mostly CODE BLOCKS and TABLES, and a command split across a page break is
 * a command somebody mis-copies at three in the morning.
 *
 * PDF is the BROWSER'S export, deliberately. It renders exactly what is on the
 * screen, from the one stylesheet; a server-side PDF renderer would be a second
 * layout to maintain and — going by every other duplicated artefact in this
 * codebase — the one that quietly drifted.
 */
const PRINT_EXTRAS = `<style>
  @media print {
    pre, table, blockquote { page-break-inside: avoid; }
    h1, h2, h3 { page-break-after: avoid; }
    pre { white-space: pre-wrap; word-break: break-word; }
    a[href^="http"]::after { content: " (" attr(href) ")"; font-size: .8em; word-break: break-all; }
    .printbar { display: none !important; }
  }
  .printbar {
    position: sticky; top: 0; z-index: 20; display: flex; gap: .6rem; align-items: center;
    padding: .5rem .9rem; font-size: .8rem;
    background: var(--rule-soft, #f4f4f5); border-bottom: 1px solid var(--rule, #e4e4e7);
  }
  .printbar button {
    font: inherit; cursor: pointer; padding: .25rem .7rem; border-radius: .4rem;
    border: 1px solid var(--rule, #d4d4d8); background: #fff;
  }
</style>
<div class="printbar">
  <button type="button" onclick="window.print()">Download PDF / print</button>
  <span>Choose &ldquo;Save as PDF&rdquo; as the destination.</span>
</div>
<script>
  // Opened from the Runbooks page's download button.
  if (new URLSearchParams(location.search).get("print") === "1") {
    window.addEventListener("load", function () { window.print(); });
  }
</script>`;

const style = manualStyle();
const modules = [];

for (const doc of DOCS) {
  const md = readFileSync(join(repoRoot, "docs", doc.file), "utf8");
  // ONE parse, two emitters. A construct the parser does not know about is
  // missing from both outputs, visibly, instead of from one of them quietly.
  const { blocks, toc } = parseMarkdown(md);
  const body = toHtml(blocks);
  const pdf = await renderRunbookPdf({
    title: doc.title,
    subtitle: doc.lede,
    source: `docs/${doc.file}`,
    blocks,
  });
  const html = `<title>${doc.title} — MAESTRO-SMS</title>
${style}
${PRINT_EXTRAS}

<header class="masthead">
  <div class="masthead-inner">
    <div class="eyebrow">${doc.eyebrow}</div>
    <h1>${doc.title}</h1>
    <p>${doc.lede}</p>
    <div class="masthead-meta">${doc.meta.map((m) => `<span>${m}</span>`).join("\n      ")}</div>
  </div>
</header>

<div class="shell">
  <nav class="rail" aria-label="Contents">
    <button class="toc-toggle" id="tocToggle" aria-expanded="false" aria-controls="tocList">Contents</button>
    <h2>Contents</h2>
    <ol id="tocList">
${toc.map((t) => `      <li><a href="#${t.id}">${t.text}</a></li>`).join("\n")}
    </ol>
  </nav>
  <main>
${body}
  </main>
</div>
`;
  modules.push({ key: doc.key, html, title: doc.title, pdf });
}

const out = join(webRoot, "app", "runbooks", "runbook-html.ts");
const banner = `// GENERATED FILE — do not edit by hand.
// Source: docs/RUNBOOK-INCIDENT-RESPONSE.md, docs/RUNBOOK-BACKUP-RESTORE.md
// Regenerate: pnpm --filter @sms/web build:runbooks
/* eslint-disable */

export const RUNBOOKS: Record<string, { title: string; html: string; pdfBase64: string }> = {
${modules
  .map(
    (m) =>
      `  ${JSON.stringify(m.key)}: { title: ${JSON.stringify(m.title)}, html: ${JSON.stringify(m.html)}, pdfBase64: ${JSON.stringify(m.pdf.toString("base64"))} },`,
  )
  .join("\n")}
};
`;

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, banner, "utf8");
console.log(
  `build-runbooks: ${modules
    .map((m) => `${m.key} ${m.html.length} chars / ${Math.round(m.pdf.length / 1024)}KB pdf`)
    .join(", ")} -> app/runbooks/runbook-html.ts`,
);
