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

describe("a physical exam can be written and printed", () => {
  // The composer was gated on ONLINE_CBT, so an owner running a PHYSICAL exam
  // could not write its questions at all — while the API accepted them the
  // whole time and nothing printed them. The two modes differ in how the paper
  // reaches a candidate, not in how it is written.
  it("offers the composer for a physical programme too", () => {
    expect(src).toMatch(/pr\.examMode === "ONLINE_CBT" \|\| pr\.examMode === "PHYSICAL"/);
    // Both halves: the toggle that opens it and the panel it opens.
    const matches = src.match(/pr\.examMode === "ONLINE_CBT" \|\| pr\.examMode === "PHYSICAL"/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  // ONE LINK PER SUBJECT. The papers are derived from the questions' subjects,
  // so a single "print" would staple two different exams together.
  it("offers a print link per subject, and the key as its own link", () => {
    expect(src).toMatch(/paper\.pdf\$\{subj \? `\?subject=/);
    expect(src).toMatch(/answer-key\.pdf\$\{subj \? `\?subject=/);
    expect(src).toMatch(/new Set\(paper\.map\(\(q\) => q\.subject \?\? ""\)\)/);
  });

  it("marks the key as what it is, rather than a second plain link", () => {
    expect(src).toMatch(/not for candidates/i);
  });

  // A programme with no questions must not offer a print that would 400.
  it("offers nothing to print until there are questions", () => {
    expect(src).toMatch(/paper !== null && paper\.length > 0 && \(/);
  });
});

describe("the reusable question library", () => {
  it("is offered on the console, with subject and search filters", () => {
    expect(src).toContain("Question library");
    expect(src).toMatch(/scholarships\/questions\?\$\{qs\.toString\(\)\}/);
    expect(src).toMatch(/Filter the library by subject/);
    expect(src).toMatch(/Search the library/);
  });

  // Only subjects the library ACTUALLY holds, so a picker can never offer an
  // empty one.
  it("offers only the subjects the library holds", () => {
    expect(src).toMatch(/lib\.subjects\.map/);
  });

  // A paper holds COPIES, so the click that copies has to say so — an owner
  // who believes a later edit will propagate will not re-check the paper.
  it("says at the click that a copy will not change later", () => {
    expect(src).toMatch(/copied onto the paper, so later edits here will not change it/);
  });

  it("says what deleting from the library does NOT affect", () => {
    expect(src).toMatch(/Papers already built from it are unaffected/);
  });

  // REPORT WHAT WAS NOT ADDED. "added 3" over a selection of 5 reads as
  // complete, and the two left behind are the ones somebody has to look at.
  it("reports the questions already on the paper rather than only the added ones", () => {
    expect(src).toMatch(/already on it/);
  });

  it("does not read the library until it is opened", () => {
    expect(src).toMatch(/if \(libOpen\) void loadLibrary\(\)/);
  });

  // A failed read must not read as "the library is empty" — that invites an
  // owner to retype questions they already have.
  it("distinguishes a failed read from an empty library", () => {
    expect(src).toMatch(/do not treat it as empty/i);
    expect(src).toMatch(/The library is empty/);
  });
});
