#!/usr/bin/env node
/**
 * Generates API.md from the controllers.
 *
 * WHY THIS EXISTS: API.md carried a hand-written table and a footer claiming it
 * was "generated from the NestJS controllers". It was not, and it had rotted —
 * it documented 351 of 901 routes under a headline claiming 634. A reference
 * missing forty per cent of the surface is worse than no reference, because the
 * absence of a route reads as the route not existing.
 *
 * The route inventory comes from the SHARED extractor (`test/support/api-routes`)
 * via `scripts/api-doc.gen.spec.ts` — never a second walker of its own.
 *
 * Each route's PURPOSE comes from, in order:
 *   1. `scripts/api-doc-purposes.json` — curated prose. Seeded from the
 *      hand-written API.md so no sentence anybody wrote was lost, and the place
 *      to improve a description that reads poorly.
 *   2. the handler's own doc comment (its first sentence).
 *   3. the handler's name, humanised — honest, and a prompt to write a comment.
 *
 * Run: pnpm --filter @sms/api build:api-doc
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(here, "..");
const repoRoot = path.resolve(apiRoot, "..", "..");
const dataFile = path.join(repoRoot, "node_modules", ".cache", "api-doc-data.json");

fs.mkdirSync(path.dirname(dataFile), { recursive: true });
execFileSync(
  "npx",
  ["jest", "--roots", "./scripts", "--testRegex", "api-doc\\.gen\\.spec\\.ts$", "--silent"],
  { cwd: apiRoot, env: { ...process.env, API_DOC_DATA: dataFile }, stdio: "inherit" },
);

const routes = JSON.parse(fs.readFileSync(dataFile, "utf8"));
const purposes = JSON.parse(fs.readFileSync(path.join(here, "api-doc-purposes.json"), "utf8"));

/** Human section titles. A directory with no entry falls back to its own name. */
const SECTIONS = {
  foundation: "Foundation, auth & session",
  public: "Public surface (no authentication)",
  health: "Health & metrics",
  observability: "Health & metrics",
  security: "Security, MFA & privilege elevation",
  operator: "Super-admin operator console (platform owner)",
  billing: "Subscription billing & add-ons",
  payments: "Payment rails (card, mobile money, webhooks)",
  fees: "Fees, invoices & the ledger",
  admin: "School administration",
  admissions: "Admissions",
  sis: "Student information (profile, contacts, medical)",
  lms: "Learning management (classes, enrolment, content)",
  gradebook: "Gradebook & marks",
  reportcards: "Report cards",
  attendance: "Attendance registers",
  timetable: "Timetable, cover & availability",
  exam: "Exam logistics (sittings, seating, invigilation)",
  cbt: "CBT exam hall",
  integrity: "Assessment integrity",
  scholarship: "Scholarships (platform-sponsored)",
  hr: "HR, payroll & staff lifecycle",
  workflow: "Approval workflow engine",
  approvals: "Approvals (aggregated queue)",
  documents: "Document vault & supplied documents",
  certificate: "Certificates & ID cards",
  library: "Library",
  hostel: "Boarding & hostels",
  transport: "Transport & fleet",
  discipline: "Student discipline",
  meeting: "Parent-teacher meetings",
  communication: "Messaging & the school calendar",
  announcements: "Announcements",
  notifications: "Notifications & preferences",
  analytics: "Analytics",
  dashboard: "Dashboard",
  directory: "School directory",
  search: "Global search",
  privacy: "Privacy, NDPR/GDPR & retention",
  legal: "Legal acceptance",
  parent: "Parent & family",
  alumni: "Alumni",
  branding: "Branding",
  feedback: "Feedback",
  task: "Tasks",
  form: "Forms",
  poll: "Polls",
  discussion: "Discussion groups",
  group: "School-group console (multi-campus)",
  game: "Games & competitions",
};
const ORDER = ["foundation", "public", "health", "observability", "security", "operator"];

const title = (dir) =>
  SECTIONS[dir] ??
  dir
    .replace(/\.controller\.ts$/, "")
    .replace(/[-_]/g, " ")
    .replace(/^./, (c) => c.toUpperCase());

/**
 * A handler name, read as a sentence. A bare generic verb ("list", "get") says
 * nothing on its own, so it is given the resource it acts on, taken from the
 * path — "List" becomes "List disputes". Anything more specific than a generic
 * verb already carries its own meaning and is left alone.
 */
const GENERIC_VERB = /^(list|get|create|update|edit|remove|delete|patch|index|find|all|one|read|show|view|set|save|add|post|put)$/i;
function humanise(handler, routePath) {
  const words = handler
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
  if (!words) return "—";
  const sentence = words.replace(/^./, (c) => c.toUpperCase());
  if (!GENERIC_VERB.test(handler)) return sentence;
  const resource = routePath
    .split("/")
    .filter((seg) => seg && !seg.startsWith(":"))
    .pop();
  if (!resource) return sentence;
  return `${sentence} — ${resource.replace(/[-_.]/g, " ")}`;
}

function gate(r) {
  const parts = [];
  if (r.isPublic) parts.push("🌐 public");
  for (const p of r.permissions) parts.push(`🔑 \`${p}\``);
  if (r.module) parts.push(`📦 \`${r.module}\``);
  if (r.stepUp) parts.push("⬆️ step-up");
  return parts.length ? parts.join(" · ") : "(auth)";
}

function purposeOf(r) {
  const curated = purposes[`${r.method} ${r.path}`];
  if (curated) return curated;
  if (r.doc) return r.doc.length > 220 ? `${r.doc.slice(0, 217).trimEnd()}…` : r.doc;
  return humanise(r.handler, r.path);
}

// Group by section title, then merge rows that share a path so a resource reads
// as one line ("GET · PUT /x") the way the hand-written reference did.
const bySection = new Map();
for (const r of routes) {
  const key = title(r.dir);
  if (!bySection.has(key)) bySection.set(key, []);
  bySection.get(key).push(r);
}

const rank = (dir) => {
  const i = ORDER.indexOf(dir);
  return i === -1 ? ORDER.length : i;
};
const firstDirOf = new Map();
for (const r of routes) if (!firstDirOf.has(title(r.dir))) firstDirOf.set(title(r.dir), r.dir);
const sections = [...bySection.keys()].sort((a, b) => {
  const ra = rank(firstDirOf.get(a));
  const rb = rank(firstDirOf.get(b));
  return ra !== rb ? ra - rb : a.localeCompare(b);
});

const METHOD_ORDER = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const lines = [];
lines.push("# API Reference — School Management System");
lines.push("");
lines.push(
  `Every HTTP endpoint the NestJS API (\`apps/api\`) declares: **${routes.length} routes across ${new Set(routes.map((r) => r.file)).size} controllers.**`,
);
lines.push("");
lines.push(
  "> **This file is GENERATED** — `pnpm --filter @sms/api build:api-doc`. Do not hand-edit it; a route added to a controller appears here on the next run, and `api-doc-is-current.spec.ts` fails the build if it has not been. To improve a description, edit `apps/api/scripts/api-doc-purposes.json` or write a doc comment on the handler.",
);
lines.push("");
lines.push("## Conventions");
lines.push("");
lines.push(
  "- **Base URL:** the API is stateless and mounted at the service root (e.g. `http://localhost:3001`). The Next.js web app reaches it through a same-origin BFF proxy (`/api/sms/*` for authed calls, `/api/public/*` for public ones) which injects the Bearer token server-side.",
);
lines.push(
  '- **Auth:** every non-public request carries a Bearer JWT (HS256, `algorithms: ["HS256"]` pinned) minted by the Auth.js layer at login; it holds `userId`, `school_id`, `roles`, `permissions`. The API **verifies** it on every request and never issues sessions. A token minted for another purpose — an invite link, a password reset, a step-up, a signed upload — is refused as a session bearer.',
);
lines.push(
  "- **Tenant isolation (3 layers):** JWT `school_id` claim → NestJS `PermissionGuard` → Postgres Row-Level Security. Cross-tenant access returns **404, not 403** (never leak existence).",
);
lines.push("- **Every mutation is audit-logged** (actor, action, entity, `school_id`, timestamp).");
lines.push(
  "- **Rate limiting:** `POST /auth/login` is 10/min/IP and the public read surface 60/min. Gateway webhooks and the biometric ingestion endpoint are deliberately UNLIMITED — a 429 turns a burst of real payments into a retry storm, and a mobile-money callback is delivered once, so refusing it loses the payment.",
);
lines.push(
  "- **Responses are `private, no-store`** and vary on `Cookie`; the public surface deliberately does not, since it is identical for every caller.",
);
lines.push("");
lines.push("### Gate legend");
lines.push("");
lines.push("| Symbol | Meaning |");
lines.push("|---|---|");
lines.push("| 🌐 **public** | `@Public()` — no authentication |");
lines.push(
  "| 🔑 **perm** | `@RequirePermission(...)` — the fine-grained permission checked by the guard and backstopped by RLS. Several listed means ANY one of them suffices. |",
);
lines.push(
  "| 📦 **module** | `@RequireModule(...)` — the school's subscription must include the module, else **404**. Resolved BEFORE the permission check. |",
);
lines.push(
  "| ⬆️ **step-up** | `@RequireStepUp()` — a fresh 5-minute re-auth token is required (`x-stepup` header) |",
);
lines.push("| (auth) | authenticated, with no further gate |");
lines.push("");

for (const section of sections) {
  const rows = bySection.get(section);
  const byPath = new Map();
  for (const r of rows) {
    if (!byPath.has(r.path)) byPath.set(r.path, []);
    byPath.get(r.path).push(r);
  }
  lines.push("---");
  lines.push("");
  lines.push(`## ${section}`);
  lines.push("");
  lines.push("| Method | Path | Gate | Purpose |");
  lines.push("|---|---|---|---|");
  for (const p of [...byPath.keys()].sort()) {
    const group = byPath
      .get(p)
      .sort((a, b) => METHOD_ORDER.indexOf(a.method) - METHOD_ORDER.indexOf(b.method));
    // Only merge methods that share a gate AND a purpose; otherwise a reader
    // cannot tell which verb the gate belongs to.
    const buckets = new Map();
    for (const r of group) {
      const k = `${gate(r)} ${purposeOf(r)}`;
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(r);
    }
    for (const bucket of buckets.values()) {
      const methods = bucket.map((r) => r.method).join(" · ");
      lines.push(`| ${methods} | \`${p}\` | ${gate(bucket[0])} | ${purposeOf(bucket[0])} |`);
    }
  }
  lines.push("");
}

lines.push("---");
lines.push("");
lines.push("## Realtime (WebSocket — not HTTP)");
lines.push("");
lines.push("The `GameSocketGateway` runs `ws` on the same HTTP server under `/ws/*`:");
lines.push("");
lines.push("- `/ws/duel` · `/ws/ring` · `/ws/race` · `/ws/arena` — in-memory game transport.");
lines.push(
  "- `/ws/watch?mode={duel|ring|race|league|ultimate}&gameId=…` — durable, RLS-scoped, viewer-redacted spectator bridge; re-reads the same view the mode's HTTP GET returns.",
);
lines.push("");
lines.push(
  "Handshake auth: HS256 `?token=` minted by the web BFF (`GET /api/ws-ticket`). The school's status is re-checked at the handshake AND on every push, so a suspended tenant's open socket stops receiving state rather than running until it happens to reconnect.",
);
lines.push("");

fs.writeFileSync(path.join(repoRoot, "API.md"), `${lines.join("\n")}\n`);
console.log(`build-api-doc: ${routes.length} routes / ${sections.length} sections -> API.md`);
