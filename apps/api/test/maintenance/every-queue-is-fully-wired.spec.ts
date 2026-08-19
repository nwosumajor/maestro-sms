// =============================================================================
// A background queue needs three things, and missing one is silent
// =============================================================================
// Every scheduled job in this platform is three separate pieces:
//
//   a SCHEDULER   that adds the repeatable job (InjectQueue)
//   a PROCESSOR   that consumes it (@Processor)
//   a REGISTRATION in some module (BullModule.registerQueue)
//
// Miss the processor and jobs pile up in Redis with nothing to run them. Miss
// the registration and Nest cannot resolve the scheduler's queue — that one at
// least fails loudly at boot. Miss the scheduler and the processor simply waits
// for work that is never queued.
//
// None of these shows up in a unit test of the service, because the service is
// fine; it is the wiring that is absent. And the jobs affected are the ones
// nobody watches: dunning, retention, reconciliation, the sweep that removes a
// declined family's documents. A queue that never runs looks exactly like a
// queue with nothing to do.
//
// This platform has learnt the same lesson twice from the other direction —
// sweeps that returned a quiet zero when they had not run at all — and this is
// the compile-time half of it.
// =============================================================================

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "../../src");

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });

const files = walk(SRC).filter((p) => !p.includes(".spec."));
const sources = files.map((p) => ({ path: p.slice(SRC.length + 1), text: readFileSync(p, "utf8") }));
const all = sources.map((s) => s.text).join("\n");

/** Every exported `*QUEUE*` constant and the channel name it stands for. */
const queues = sources.flatMap(({ path, text }) =>
  [...text.matchAll(/export const (\w*QUEUE\w*)\s*=\s*"([^"]+)"/g)].map((m) => ({
    constant: m[1],
    channel: m[2],
    declaredIn: path,
  })),
);

describe("the queues this platform runs", () => {
  it("finds them all — a matcher that finds none would pass every test below", () => {
    // The guard against a vacuous suite: if the declaration style changes and
    // this stops matching, every assertion after it becomes trivially true.
    expect(queues.length).toBeGreaterThanOrEqual(15);
  });

  it("gives each a distinct channel, so two jobs cannot land in one queue", () => {
    const channels = queues.map((q) => q.channel);
    expect(new Set(channels).size).toBe(channels.length);
  });

  it.each(queues.map((q) => [q.constant] as const))("%s has something that SCHEDULES work", (constant) => {
    expect(all).toMatch(new RegExp(`InjectQueue\\(${constant}\\)`));
  });

  it.each(queues.map((q) => [q.constant] as const))("%s has a processor to CONSUME it", (constant) => {
    // The silent one: without this, jobs accumulate in Redis and the sweep
    // simply never happens.
    expect(all).toMatch(new RegExp(`@Processor\\(${constant}\\)`));
  });

  it.each(queues.map((q) => [q.constant] as const))("%s is REGISTERED by a module", (constant) => {
    // registerQueue takes a list, and several modules pass more than one across
    // several lines — so this looks for the constant inside the call rather than
    // immediately after `name:`. A stricter pattern reported two false
    // positives on exactly that shape.
    const registered = sources.some(({ text }) =>
      [...text.matchAll(/registerQueue\(([\s\S]{0,400}?)\)/g)].some(([, args]) =>
        new RegExp(`name:\\s*${constant}\\b`).test(args),
      ),
    );
    expect(registered).toBe(true);
  });
});
