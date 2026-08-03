/* eslint-disable no-console -- reason: a developer tool, run by hand */
// =============================================================================
// Seed / refresh the API surface registry.
//   pnpm --filter @sms/api exec ts-node test/surface/generate-registry.ts
//
// Auto-classifies what can be PROVEN, and leaves everything else UNCLASSIFIED
// for a human. It never invents a classification it cannot justify: an entry a
// person has not looked at is worth nothing as evidence.
//
// Re-running preserves existing decisions — it only adds new routes and drops
// ones that no longer exist.
// =============================================================================

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { extractRoutes, extractWebRefs, extractWebShapes, normalisePath } from "./extract";

const API_SRC = join(__dirname, "..", "..", "src");
const WEB_DIR = join(__dirname, "..", "..", "..", "web");
const REGISTRY = join(__dirname, "api-surface.registry.json");

type Kind = "ui" | "system" | "gap" | "UNCLASSIFIED";
interface Entry { kind: Kind; note: string }

/**
 * Routes that are reachable by design without any UI. Pattern-matched because
 * the reason is structural, not per-endpoint — a gateway webhook is a webhook
 * whatever it is called.
 */
const SYSTEM_RULES: Array<{ re: RegExp; note: string }> = [
  { re: /^GET \/health/, note: "liveness probe — infrastructure, not a screen" },
  { re: /^GET \/metrics/, note: "Prometheus scrape — token-gated, not a screen" },
  { re: /\/webhook/, note: "gateway callback — the caller is the payment provider" },
  { re: /\/callback\//, note: "rail callback — the caller is the payment provider" },
  { re: /^POST \/public\//, note: "public intake (applications, careers, invites) — its own unauthenticated pages" },
  { re: /^GET \/public\//, note: "public read (plan pricing, directory) — consumed by marketing pages" },
  { re: /\/(run|reminders\/run|recovery\/run|dunning\/run)$/, note: "manual trigger for a SCHEDULED job — ops/runbook surface, not day-to-day UI" },
  { re: /^GET \/ws-ticket/, note: "websocket handshake token — used by the live-play sockets" },
];

function main() {
  const routes = extractRoutes(API_SRC);
  const webRefs = extractWebRefs(WEB_DIR);
  const webShapes = extractWebShapes(WEB_DIR);
  const prev: Record<string, Entry> = existsSync(REGISTRY)
    ? JSON.parse(readFileSync(REGISTRY, "utf8")).routes
    : {};

  const out: Record<string, Entry> = {};
  let kept = 0, ui = 0, system = 0, unknown = 0;
  for (const r of routes) {
    // A decision already made by a human always wins.
    if (prev[r.key] && prev[r.key].kind !== "UNCLASSIFIED") {
      out[r.key] = prev[r.key];
      kept++;
      continue;
    }
    const rule = SYSTEM_RULES.find((s) => s.re.test(r.key));
    if (rule) { out[r.key] = { kind: "system", note: rule.note }; system++; continue; }
    if (webRefs.has(normalisePath(r.path))) {
      out[r.key] = { kind: "ui", note: "referenced by a literal path in apps/web" };
      ui++;
      continue;
    }
    // Reached by a path the web BUILDS at runtime. Weaker evidence than a
    // literal, so the note says which shape justified it.
    const shape = [...webShapes].find(
      (sh) => normalisePath(r.path) === sh || normalisePath(r.path).startsWith(sh.replace(/\/$/, "") + "/"),
    );
    if (shape) {
      out[r.key] = { kind: "ui", note: `reached via a runtime-built path (web builds "${shape}")` };
      ui++;
      continue;
    }
    out[r.key] = { kind: "UNCLASSIFIED", note: "" };
    unknown++;
  }

  const dropped = Object.keys(prev).filter((k) => !out[k]);
  writeFileSync(
    REGISTRY,
    JSON.stringify(
      { generatedFrom: `${routes.length} routes`, routes: Object.fromEntries(Object.entries(out).sort()) },
      null,
      2,
    ) + "\n",
  );
  console.log(`routes: ${routes.length}`);
  console.log(`  kept (already decided): ${kept}`);
  console.log(`  auto: ui=${ui} system=${system}`);
  console.log(`  UNCLASSIFIED (need a human): ${unknown}`);
  if (dropped.length) console.log(`  dropped (route gone): ${dropped.length}`);
}
main();
