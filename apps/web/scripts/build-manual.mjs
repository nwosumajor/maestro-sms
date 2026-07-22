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

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const src = join(repoRoot, "docs", "ONBOARDING-MANUAL.html");
const out = join(here, "..", "app", "manual", "manual-html.ts");

const html = readFileSync(src, "utf8");

const banner = `// GENERATED FILE — do not edit by hand.
// Source: docs/ONBOARDING-MANUAL.html
// Regenerate: pnpm --filter @sms/web build:manual
/* eslint-disable */

export const MANUAL_HTML = ${JSON.stringify(html)};
`;

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, banner, "utf8");
console.log(`build-manual: ${html.length} chars -> app/manual/manual-html.ts`);
