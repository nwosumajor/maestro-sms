/**
 * Four screens repeated a read on a timer and all four kept the old data when
 * the read failed — `if (res.ok) setData(...)`, so the screen simply stopped
 * moving. That is indistinguishable from a screen with nothing new on it, and
 * these are exactly the screens whose point is that something IS changing.
 *
 * Measured on the sharpest of them: a live quiz polls every 1.5 s per player
 * and one CLASS is over the school's request budget — 21% of refreshes refused
 * at forty players, 39% at sixty. A school's own wifi does it for free.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
const HOOK = read("lib/use-polled.ts");

describe("a screen that stopped refreshing says so", () => {
  // ONE definition. Four hand-rolled copies of one loop is how four of them
  // came to share one hole.
  it("is defined once and re-exported rather than copied", () => {
    expect(HOOK).toMatch(/export function usePolled<T>\(/);
    const playUi = read("components/game/play-ui.tsx");
    expect(playUi).toMatch(/import \{ usePolled \} from "@\/lib\/use-polled"/);
    expect(playUi).not.toMatch(/export function usePolled/);
  });

  it.each([
    ["components/exam/ExamDayBoard.tsx", /stopped refreshing/],
    ["components/transport/TransportOps.tsx", /stopped refreshing/],
  ])("%s polls through the shared hook and says when it is stale", (file, says) => {
    const src = read(file);
    expect(src).toMatch(/from "@\/lib\/use-polled"/);
    expect(src).toMatch(/stale \} = usePolled|refresh: load, stale \} = usePolled/);
    expect(src).toMatch(says);
    // and no hand-rolled loop is left beside it
    expect(src).not.toMatch(/setInterval\((?:load|tick)/);
  });

  // THE BUS MAP is a statement about where children are, so it says what the
  // positions ARE rather than only that something failed.
  it("the fleet map says the positions are not current", () => {
    expect(read("components/transport/TransportOps.tsx"))
      .toMatch(/not where the vehicles are now/);
  });
});

describe("the gate code expires by its own clock", () => {
  const SRC = read("components/hr/AttendanceAdmin.tsx");

  // STRONGER THAN CATCHING A FAILED FETCH: a slept laptop, a throttled tab and
  // a refused request all end with a code on the glass that is past its window,
  // and only the clock catches all three.
  it("hides a code once its own window has run out", () => {
    expect(SRC).toMatch(/const codeLive = Boolean\(code\) && nowMs < codeExpiresAt/);
    expect(SRC).toMatch(/showDisplay && codeLive && code &&/);
  });

  // The display's idea of "still valid" must not drift from the server's idea
  // of "still accepted" — `verifyTotp(secret, code, 1, ...)` allows ±1 step.
  it("matches the server's step and its one-step tolerance", () => {
    expect(SRC).toMatch(/const KIOSK_STEP_MS = 30_000;/);
    expect(SRC).toMatch(/code\.until \+ KIOSK_STEP_MS/);
  });

  // A FAILED REFRESH DOES NOT BLANK IT: the code on screen is still valid until
  // its own window runs out, and throwing it away early would stop clock-ins
  // that would have worked.
  it("does not discard a still-valid code on a failed refresh", () => {
    const a = SRC.indexOf("const tick = async () => {");
    const body = SRC.slice(a, SRC.indexOf("\n    };", a));
    expect(body).toMatch(/if \(r\.ok\) \{/);
    expect(body).not.toMatch(/else[\s\S]{0,40}setCode\(null\)/);
  });

  // NOT A BLANK PANEL. A display showing nothing reads as "the kiosk is off"
  // and sends staff looking for an administrator.
  it("says which of the two states it is in", () => {
    expect(SRC).toMatch(/No current code\./);
    expect(SRC).toMatch(/lost touch with the server/);
    expect(SRC).toMatch(/rather than retyping the old one/);
  });

  // The server computed `secondsRemaining` and this screen threw it away, so a
  // member of staff could not tell one second from twenty-nine.
  it("shows the countdown the server was already sending", () => {
    expect(SRC).toMatch(/valid for \{secondsLeft\}s/);
    expect(SRC).toMatch(/secondsRemaining \* 1000/);
  });
});
