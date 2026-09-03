/**
 * Asked: how many questions can a candidate see at once, and can they jump to
 * any number? The answers are ALL of them, on one page, and yes — and checking
 * the second one honestly found that it was true of the markup and false of the
 * exam.
 *
 * The navigator and the clock sat at the TOP of a page holding the whole paper.
 * From question thirty of forty a candidate could neither see how long was left
 * nor jump anywhere without scrolling all the way back up.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOM = readFileSync(path.join(process.cwd(), "components/cbt/CbtExamRoom.tsx"), "utf8");
const bodyOf = (name: string) => {
  const a = ROOM.indexOf(name);
  expect(a).toBeGreaterThan(-1);
  const next = ROOM.slice(a + name.length).search(/\n(?:function |export function |const \w+ = React)/);
  return ROOM.slice(a, next === -1 ? ROOM.length : a + name.length + next);
};

describe("the whole paper is on one page", () => {
  // Deliberate, and the reason is recorded: navigating is a scroll, so there is
  // no request mid-exam and nothing to lose. This pins it so a later "let's
  // paginate the paper" cannot land quietly.
  it("renders every question, with no paging", () => {
    expect(ROOM).toMatch(/\{s\.questions\.map\(\(q, i\) => \{/);
    expect(ROOM).not.toMatch(/questions\.slice\(/);
    expect(ROOM).toMatch(/All questions are on one page/);
  });
});

describe("a candidate can move around it", () => {
  // THE FIX. A long page needs its map to travel with the reader.
  it("the navigator travels with the candidate", () => {
    expect(ROOM).toMatch(/<Card className="sticky top-2 z-20/);
  });

  // The two facts a candidate needs mid-paper are in one place.
  it("carries the clock and the progress count with it", () => {
    const nav = ROOM.slice(ROOM.indexOf('className="sticky top-2'));
    expect(nav).toMatch(/<ExamClock deadline=\{s\.deadline\}/);
    expect(nav).toMatch(/\{answered\}\/\{s\.questions\.length\} answered/);
  });

  // Eight numbers are a glance; a hundred are a wall in front of the question
  // being answered.
  it("opens the map on a short paper and collapses it on a long one", () => {
    expect(ROOM).toMatch(/React\.useState\(\(\) => initial\.questions\.length <= 12\)/);
    expect(ROOM).toMatch(/max-h-40 flex-wrap gap-1\.5 overflow-y-auto/);
  });

  it("closes the map when a jump is taken, so it cannot cover the target", () => {
    expect(bodyOf("const jumpTo = (questionId: string) => {")).toMatch(
      /if \(s\.questions\.length > 12\) setMapOpen\(false\)/,
    );
  });

  it("still offers the shortcut to the first unanswered question", () => {
    expect(ROOM).toMatch(/Go to first unanswered/);
    expect(ROOM).toMatch(/jumpTo\(firstPending\.id\)/);
  });

  // Every number is reachable and named, not just drawn.
  it("names each number for a screen reader", () => {
    expect(ROOM).toMatch(/aria-label=\{`Question \$\{i \+ 1\}: \$\{notSaved \? "answered but NOT saved"/);
  });
});

describe("the clock does not repaint the paper", () => {
  // `secondsLeft` was state on the component that renders every question and
  // every option, so a 40-question paper re-rendered ONCE A SECOND for the
  // whole sitting. Nothing about the paper changes between ticks.
  it("ticks inside its own component", () => {
    expect(ROOM).toMatch(/function ExamClock\(\{/);
    const clock = bodyOf("function ExamClock({");
    expect(clock).toMatch(/useCountdown\(deadline\)/);
  });

  it("the exam room holds no per-second value", () => {
    // the only `useCountdown` call is the clock's own
    expect((ROOM.match(/useCountdown\(/g) ?? []).length).toBe(2); // the definition + one call
    expect(ROOM).not.toMatch(/const secondsLeft = useCountdown\(s\.deadline\)/);
  });

  // Auto-submit still happens — it is reported UP from the clock, once.
  it("still submits itself when the time runs out, exactly once", () => {
    const clock = bodyOf("function ExamClock({");
    expect(clock).toMatch(/if \(secondsLeft === 0 && !firedRef\.current\)/);
    expect(ROOM).toMatch(/<ExamClock deadline=\{s\.deadline\} onExpired=\{onExpired\}/);
    expect(bodyOf("const onExpired = React.useCallback(")).toMatch(/submittedRef\.current = true/);
  });
});
