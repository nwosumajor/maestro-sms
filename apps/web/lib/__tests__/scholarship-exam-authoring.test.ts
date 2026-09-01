/**
 * The scholarship question composer, and the mark sheet the physical mode
 * needed to be finishable at all.
 *
 * Read from the source because these are the CONTROLS a platform owner uses —
 * the API has always accepted five options and a paper exam has always been
 * selectable, and neither was reachable from a screen.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const SRC = path.join(process.cwd(), "components/operator/ScholarshipAdmin.tsx");
const src = readFileSync(SRC, "utf8");

describe("scholarship exam authoring", () => {
  // The API allows up to six options; the form offered FOUR, so an owner
  // writing a five-option question simply could not.
  it("offers options A to E", () => {
    expect(src).toContain('["a", "b", "c", "d", "e"] as const');
    expect(src).toContain("[q.a, q.b, q.c, q.d, q.e]");
  });

  it("clears every option when a question is added, so E cannot carry over", () => {
    const resets = src.match(/setQ\(\{ text: "", a: "", b: "", c: "", d: "", e: "", answer: 0 \}\)/g) ?? [];
    expect(resets.length).toBeGreaterThan(0);
    // No reset may leave an option behind — a stale E is a wrong question.
    expect(src).not.toMatch(/setQ\(\{ text: "", a: "", b: "", c: "", d: "", answer: 0 \}\)/);
  });

  // Correcting a typo, or a wrong correct-option, used to mean deleting the
  // question and typing it again — which moves it to the end of the paper.
  it("can edit a question in place", () => {
    expect(src).toContain("const editQuestion = async (");
    expect(src).toMatch(/aria-label=\{`Edit question/);
  });

  // `examQuestions` REPLACES the whole set, so an edit must carry every other
  // question back untouched — subject included, or a multi-subject paper
  // collapses into one on the next correction.
  it("carries every other question back on an edit, subject included", () => {
    const body = src.slice(src.indexOf("const editQuestion = async ("));
    const scoped = body.slice(0, body.indexOf("\n  };"));
    expect(scoped).toContain("question.index === index");
    expect(scoped).toContain("subject: question.subject");
    expect(scoped).toContain("answerIndex: question.answerIndex");
  });

  // A failed re-read must not send a truncated paper: replacing the set with
  // what little was read would DELETE every question it could not see.
  it("sends nothing when the paper cannot be re-read", () => {
    const body = src.slice(src.indexOf("const editQuestion = async ("));
    const scoped = body.slice(0, body.indexOf("\n  };"));
    expect(scoped).toMatch(/if \(current === null\)[\s\S]{0,300}return false;/);
  });
});

describe("a physical exam can be marked", () => {
  // A paper exam has no sitting to harvest, so without this the mode dead-ended
  // at the announcement: no score, so no rank, so no school prize on merit.
  it("offers a mark sheet for a PHYSICAL programme", () => {
    expect(src).toMatch(/pr\.examMode === "PHYSICAL"[\s\S]{0,400}Enter marks/);
    expect(src).toContain("scholarships/programs/${programId}/scores");
  });

  it("offers it ONLY for a physical programme", () => {
    // CBT and games are scored from what the candidates actually sat; a second
    // writer of that column would silently disagree with the scripts.
    expect(src).toMatch(/\{showMarks && pr\.examMode === "PHYSICAL" &&/);
  });

  it("sends only the boxes that were filled in", () => {
    expect(src).toMatch(/\.filter\(\(m\) => m\.raw !== ""\)/);
  });

  it("refuses a mark outside 0-100 before the round trip", () => {
    const body = src.slice(src.indexOf("const recordScores = async ("));
    const scoped = body.slice(0, body.indexOf("\n  };"));
    expect(scoped).toMatch(/m\.scorePct < 0 \|\| m\.scorePct > 100/);
    expect(scoped).toMatch(/return false;/);
  });

  // A rejected sheet must keep what was typed, or the operator retypes every
  // mark — the whole reason the entry is worth having.
  it("keeps the typed marks when the server refuses", () => {
    expect(src).toMatch(/if \(ok\) setMarks\(\{\}\)/);
  });

  // Re-opening the sheet must not read as though nothing was entered.
  it("shows what is already recorded", () => {
    expect(src).toMatch(/recorded: \{c\.examScorePct\}%/);
  });

  it("can publish a physical programme's results, now that it can have any", () => {
    expect(src).toMatch(/pr\.examMode === "GAMES" \|\| pr\.examMode === "PHYSICAL"/);
  });
});
