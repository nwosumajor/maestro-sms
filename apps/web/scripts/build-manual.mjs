// Generates apps/web/app/manual/manual-html.ts from the CANONICAL manual at
// docs/ONBOARDING-MANUAL.html.
//
// Why generate instead of reading the file at runtime: the manual is served by a
// route handler, and `fs` reads of files outside the Next build trace are not
// reliably present in a standalone/Docker image. Embedding it as a module makes
// it a normal bundled import that works in every deployment mode.
//
// Re-run after editing the manual:  pnpm --filter @sms/web build:manual
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseManualHtml } from "./html-blocks.mjs";
import { renderRunbookPdf } from "./runbook-pdf.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const src = join(repoRoot, "docs", "ONBOARDING-MANUAL.html");
const out = join(here, "..", "app", "manual", "manual-html.ts");

const html = readFileSync(src, "utf8");

// A REAL PDF, through the same emitter the runbooks use.
//
// The manual is authored as HTML rather than markdown, which is why it was the
// last document still relying on the browser's print export. Parsing it into the
// same block model means all three render through ONE piece of layout code — so
// a fix to how a table breaks across a page fixes it everywhere, and no document
// can quietly diverge from its own page.
const { blocks } = parseManualHtml(html);
const pdf = await renderRunbookPdf({
  title: "School Leader's Manual",
  subtitle: "Running your school on MAESTRO-SMS — from first login to a school that runs itself.",
  source: "docs/ONBOARDING-MANUAL.html",
  blocks,
});

const banner = `// GENERATED FILE — do not edit by hand.
// Source: docs/ONBOARDING-MANUAL.html
// Regenerate: pnpm --filter @sms/web build:manual
/* eslint-disable */

export const MANUAL_HTML = ${JSON.stringify(html)};

/** The same document as a generated PDF — see build-manual.mjs. */
export const MANUAL_PDF_BASE64 = ${JSON.stringify(pdf.toString("base64"))};
`;

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, banner, "utf8");
console.log(`build-manual: ${html.length} chars / ${Math.round(pdf.length / 1024)}KB pdf -> app/manual/manual-html.ts`);
