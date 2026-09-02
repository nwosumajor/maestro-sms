/**
 * A failed poll is not "nothing changed".
 *
 * `usePolled` swallowed every non-ok response, so a screen whose refreshes were
 * being refused simply stopped moving — indistinguishable from a game where
 * nothing is happening, on screens where the whole point is that something is.
 *
 * MEASURED on the running stack, driving the real limiter with real pupils of
 * one school at the live quiz's own 1,500 ms cadence:
 *
 *     30 players   1,167 req/min    0% refused
 *     40 players   1,551 req/min   21% refused
 *     60 players   2,318 req/min   39% refused
 *
 * A live quiz stops being reliable at about thirty-one pupils, which is a
 * class — and the host advanced the question while the pupils' screens did not.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const UI = readFileSync(path.join(process.cwd(), "components/game/play-ui.tsx"), "utf8");
// RE-ANCHORED: `usePolled` moved to `lib/use-polled.ts` when three other screens
// turned out to share its hole, so the rule now lives there. The gate follows
// the code rather than pinning where it happened to be.
const HOOK = readFileSync(path.join(process.cwd(), "lib/use-polled.ts"), "utf8");
const bodyOf = (src: string, name: string) => {
  const a = src.indexOf(name);
  expect(a).toBeGreaterThan(-1);
  return src.slice(a, src.indexOf("\n}", a));
};

describe("a screen that says it stopped moving", () => {
  it("reports a failed refresh instead of keeping the old data quietly", () => {
    for (const [src, hook] of [
      [HOOK, "export function usePolled<T>("],
      [UI, "  const refresh = React.useCallback(async () => {\n    const res = await fetch(`/api/sms/${restPath}`"],
    ] as const) {
      const body = bodyOf(src, hook);
      expect(body).toMatch(/setStale\(true\)/);
      expect(body).toMatch(/setStale\(false\)/);
    }
  });

  // A network failure and a refusal are the same fact to the screen: it does
  // not have the current state. An unhandled rejection would stop the loop.
  it("treats a thrown fetch as a failed refresh, not a crash", () => {
    expect((UI + HOOK).match(/\.catch\(\(\) => null\)/g) ?? []).toHaveLength(2);
  });

  // A poll that meets a rate limit and retries immediately is part of the
  // reason it is being limited.
  it("backs off when refused, and recovers when it stops being refused", () => {
    const body = bodyOf(HOOK, "export function usePolled<T>(");
    expect(body).toMatch(/wait = ok \? intervalMs : Math\.min\(wait \* 2, 10_000\)/);
    // and the loop is a self-scheduling timeout, not a fixed interval that
    // cannot slow down
    expect(body).not.toMatch(/setInterval\(/);
  });

  // THREE STATES. "Polling" said the same thing whether the polls were getting
  // through or being refused, and the second is precisely when a player needs
  // to know.
  it("the live indicator distinguishes polling from not updating", () => {
    const dot = bodyOf(UI, "export function LiveDot(");
    expect(dot).toMatch(/Not updating/);
    expect(dot).toMatch(/live \? "live" : stale \? "stale" : "polling"/);
  });

  // EVERY POLLED SCREEN, not only the class-sized ones: "my opponent has not
  // moved" and "my screen is frozen" are the same picture on a chess board too.
  it.each([
    "QuizPlay", "TypingPlay", "ChessPlay", "CheckersPlay", "HangmanPlay",
  ])("%s tells the player when it has stopped updating", (name) => {
    const src = readFileSync(path.join(process.cwd(), `components/game/${name}.tsx`), "utf8");
    expect(src).toMatch(/refresh, stale \} = usePolled/);
    expect(src).toMatch(/stale && \(/);
    expect(src).toMatch(/stopped updating/);
  });

  it.each(["DuelPlay", "RacePlay", "LeagueView", "UltimatePlay"])(
    "%s passes the stale state to its live indicator", (name) => {
      const src = readFileSync(path.join(process.cwd(), `components/game/${name}.tsx`), "utf8");
      expect(src).toMatch(/<LiveDot live=\{live\} stale=\{stale\}/);
    },
  );
});
