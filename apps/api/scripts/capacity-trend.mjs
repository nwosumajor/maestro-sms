#!/usr/bin/env node
// =============================================================================
// capacity-trend — judge one load-test result against the ones before it
// =============================================================================
// The capacity harness (loadtest.mjs) measures; this decides whether the number
// is a REGRESSION. It exists because the harness was run by hand, and a 3.5x
// capacity loss (770 -> 216 req/s) accumulated across months of changes that
// were each individually fine — nobody ran it, so nobody saw the trend.
//
//   node scripts/capacity-trend.mjs --result r.json --history h.jsonl [--accept]
//
// Rules, fixed here rather than tuned per run:
//   - A result is compared only with prior results of the SAME CONFIG (mode,
//     schools, concurrency...). 20 schools says nothing about 5,000.
//   - The bar is the MEDIAN of the last BASELINE_WINDOW comparable runs, and
//     there is no bar until MIN_HISTORY exist: one noisy runner must not become
//     the standard every later run is held to.
//   - FAIL below (1 - MAX_DROP) x the bar, or with errors above MAX_ERROR_PCT
//     (a run that is failing requests is not measuring capacity).
//   - A FAILING result is NOT appended. Appended, each regression would pull the
//     median down, and a slow decline would pass one step at a time — the exact
//     failure this exists to catch.
//   - AND A ROLLING BAR STILL SLIDES. Excluding failures is not enough: a 15%
//     drop per step never trips a 20% bar, and the window follows it down
//     (400 -> 330 -> 270, each a pass). So there is a second, CUMULATIVE check
//     against the HIGH-WATER MARK — the best rolling median since the last
//     rebaseline — at MAX_CUMULATIVE_DROP. A median, not a single run, so one
//     lucky runner cannot set a bar nobody can reach again.
//   - `--accept` means "this is the new normal": it writes a REBASELINE marker
//     and the result, and both checks restart from there. A slowdown somebody
//     has decided to keep is a decision, so it is a flag, and it is recorded.
// =============================================================================

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

export const MAX_DROP = 0.2;
export const MAX_CUMULATIVE_DROP = 0.3;
export const MAX_ERROR_PCT = 1;
export const MIN_HISTORY = 3;
export const BASELINE_WINDOW = 5;

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const resultPath = arg("result");
const historyPath = arg("history");
const accept = process.argv.includes("--accept");
if (!resultPath || !historyPath) {
  console.error("usage: capacity-trend.mjs --result FILE --history FILE [--accept]");
  process.exit(2);
}

const result = JSON.parse(readFileSync(resultPath, "utf8"));
if (typeof result.rps !== "number" || !result.config) {
  console.error(`${resultPath} is not a loadtest --json result (no rps/config)`);
  process.exit(2);
}
const history = existsSync(historyPath)
  ? readFileSync(historyPath, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l))
  : [];

const sameConfig = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const comparable = history.filter((h) => sameConfig(h.config, result.config));
// Everything before the last REBASELINE marker for this config is history, not a bar.
const lastMarker = comparable.map((h) => Boolean(h.rebaseline)).lastIndexOf(true);
const since = comparable.slice(lastMarker + 1).filter((h) => !h.rebaseline);
const prior = since.slice(-BASELINE_WINDOW);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
// The best rolling median since the rebaseline: each window of up to
// BASELINE_WINDOW consecutive runs, once MIN_HISTORY runs exist.
let highWater = null;
for (let i = MIN_HISTORY; i <= since.length; i++) {
  const m = median(since.slice(Math.max(0, i - BASELINE_WINDOW), i).map((h) => h.rps));
  if (highWater === null || m > highWater) highWater = m;
}

const problems = [];
let verdict;
let bar = null;
if (result.errorPct > MAX_ERROR_PCT) {
  problems.push(`${result.errorPct}% of requests failed (limit ${MAX_ERROR_PCT}%) — this run measured errors, not capacity`);
}
if (prior.length < MIN_HISTORY) {
  verdict = `BASELINE ${prior.length + 1}/${MIN_HISTORY} — no bar yet for this config`;
} else {
  bar = median(prior.map((h) => h.rps));
  const floor = bar * (1 - MAX_DROP);
  if (result.rps < floor) {
    problems.push(
      `${result.rps} req/s is ${(100 * (1 - result.rps / bar)).toFixed(0)}% below the median of the last ` +
        `${prior.length} runs (${bar} req/s); the floor is ${floor.toFixed(1)}`,
    );
  }
  if (highWater !== null && result.rps < highWater * (1 - MAX_CUMULATIVE_DROP)) {
    problems.push(
      `${result.rps} req/s is ${(100 * (1 - result.rps / highWater)).toFixed(0)}% below the best rolling median ` +
        `since the last rebaseline (${highWater} req/s) — a decline that passed one step at a time`,
    );
  }
  verdict = `${result.rps} req/s against a median of ${bar} (${prior.length} runs; best ${highWater})`;
}

const failed = problems.length > 0;
const recorded = !failed || accept;
if (recorded) {
  if (failed && accept) {
    appendFileSync(
      historyPath,
      JSON.stringify({ rebaseline: true, at: result.at, config: result.config, reason: problems.join("; ") }) + "\n",
    );
  }
  appendFileSync(historyPath, JSON.stringify(result) + "\n");
}

const lines = [
  `## Capacity: ${failed ? (accept ? "REGRESSION — accepted" : "REGRESSION") : "OK"}`,
  "",
  `- config: \`${JSON.stringify(result.config)}\``,
  `- ${verdict}`,
  `- errors: ${result.errorPct}%, peak DB connections: ${result.peakConns}`,
  ...problems.map((p) => `- **${p}**`),
  `- ${
    !recorded
      ? "NOT recorded (a failing run must not lower the bar; rerun with --accept to make it the new normal)"
      : failed
        ? "ACCEPTED as the new normal: a rebaseline marker was recorded, and both checks restart here"
        : "recorded in the history"
  }`,
  "",
  "| endpoint | reqs | err% | p50 | p95 | p99 |",
  "|---|---:|---:|---:|---:|---:|",
  ...result.endpoints.map((e) => `| ${e.key} | ${e.n} | ${e.errPct} | ${e.p50} | ${e.p95} | ${e.p99} |`),
  "",
  "Recent comparable runs (req/s): " + ([...prior.map((h) => h.rps), result.rps].join(" → ") || "none"),
];
console.log(lines.join("\n"));
if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n", { flag: "a" });
process.exit(failed && !accept ? 1 : 0);
