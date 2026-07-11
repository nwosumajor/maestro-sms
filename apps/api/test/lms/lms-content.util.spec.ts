// Unit: pure quiz auto-grading + answer-key redaction + video embed normalisation.
import {
  canonicalEmbedUrl,
  computeEngagementPercent,
  gradeQuiz,
  htmlToBlocks,
  isValidQuiz,
  normalizeBlocks,
  pickQuestions,
  redactQuiz,
  scaleToComponent,
} from "../../src/lms/lms-content.util";
import type { QuizDefDto } from "@sms/types";

const quiz: QuizDefDto = {
  questions: [
    { id: "q1", type: "MCQ", prompt: "2+2?", options: ["3", "4"], answer: "1", points: 2 },
    { id: "q2", type: "TF", prompt: "sky blue", answer: "true" },
    { id: "q3", type: "SHORT", prompt: "capital of France", answer: "Paris" },
  ],
};

describe("gradeQuiz", () => {
  it("scores objective questions with per-question points", () => {
    const r = gradeQuiz(quiz, { q1: "1", q2: "true", q3: "paris" }); // q3 case-insensitive
    expect(r).toEqual({ score: 4, total: 4, correct: [true, true, true] });
  });
  it("marks wrong/missing answers", () => {
    const r = gradeQuiz(quiz, { q1: "0", q2: "false" });
    expect(r).toEqual({ score: 0, total: 4, correct: [false, false, false] });
  });
});

describe("gradeQuiz with essays", () => {
  it("counts essay points in the total but not the auto score (manual marking)", () => {
    const q = {
      questions: [
        { id: "t1", type: "TF" as const, prompt: "?", answer: "true", points: 2 },
        { id: "e1", type: "ESSAY" as const, prompt: "discuss", answer: "", points: 5 },
      ],
    };
    const r = gradeQuiz(q, { t1: "true", e1: "a long essay response" });
    expect(r.score).toBe(2); // objective only
    expect(r.total).toBe(7); // 2 + 5 essay points
    expect(r.correct).toEqual([true, false]); // essay never auto-correct
  });
});

describe("redactQuiz", () => {
  it("strips every answer key", () => {
    const r = redactQuiz(quiz);
    expect(r.questions.every((q) => q.answer === "")).toBe(true);
    expect(r.questions.map((q) => q.prompt)).toEqual(quiz.questions.map((q) => q.prompt));
  });
  it("keeps the quiz meta (window / attempts / scoring) so the student sees the rules", () => {
    const r = redactQuiz({ ...quiz, closesAt: "2026-01-01T00:00:00.000Z", maxAttempts: 3, scoring: "BEST" });
    expect(r.closesAt).toBe("2026-01-01T00:00:00.000Z");
    expect(r.maxAttempts).toBe(3);
    expect(r.scoring).toBe("BEST");
    expect(r.questions.every((q) => q.answer === "")).toBe(true); // still redacted
  });
});

describe("isValidQuiz", () => {
  it("accepts a well-formed quiz and rejects malformed ones", () => {
    expect(isValidQuiz(quiz)).toBe(true);
    expect(isValidQuiz({ questions: [] })).toBe(false);
    expect(isValidQuiz({ questions: [{ id: "x", type: "MCQ", prompt: "p", answer: "0" }] })).toBe(false); // MCQ needs options
    expect(isValidQuiz(null)).toBe(false);
  });
});

describe("pickQuestions (question-bank randomisation)", () => {
  const bank = Array.from({ length: 8 }, (_, i) => ({ id: `q${i}`, type: "TF" as const, prompt: `p${i}`, answer: "true" }));
  it("draws exactly drawCount, all from the bank, deterministic per seed", () => {
    const a1 = pickQuestions(bank, "stu1:quizA", 3);
    const a2 = pickQuestions(bank, "stu1:quizA", 3);
    expect(a1).toHaveLength(3);
    expect(a1.map((q) => q.id)).toEqual(a2.map((q) => q.id)); // stable across reloads
    expect(a1.every((q) => bank.some((b) => b.id === q.id))).toBe(true);
    expect(new Set(a1.map((q) => q.id)).size).toBe(3); // no duplicates
  });
  it("gives different students different subsets/orders", () => {
    const a = pickQuestions(bank, "stu1:quizA", 3).map((q) => q.id).join(",");
    const b = pickQuestions(bank, "stu2:quizA", 3).map((q) => q.id).join(",");
    expect(a).not.toBe(b);
  });
  it("returns all (shuffled) when drawCount is unset or >= bank size", () => {
    expect(pickQuestions(bank, "s", undefined)).toHaveLength(8);
    expect(pickQuestions(bank, "s", 99)).toHaveLength(8);
  });
});

describe("scaleToComponent (LMS % → report-card CA slice)", () => {
  it("scales a percentage onto the component max, rounded and clamped", () => {
    expect(scaleToComponent(84, 10)).toBe(8); // 8.4 → 8
    expect(scaleToComponent(85, 10)).toBe(9); // 8.5 → 9 (round half up)
    expect(scaleToComponent(100, 10)).toBe(10);
    expect(scaleToComponent(0, 10)).toBe(0);
    expect(scaleToComponent(150, 10)).toBe(10); // clamp above
    expect(scaleToComponent(-5, 10)).toBe(0); // clamp below
  });
  it("returns null when nothing is graded", () => {
    expect(scaleToComponent(null, 10)).toBeNull();
  });
});

describe("computeEngagementPercent", () => {
  it("averages only the dimensions that have content (total > 0), capped at 1", () => {
    // completed 3/4 (0.75) + quizzes 1/2 (0.5) → mean 0.625 → 63
    expect(computeEngagementPercent([{ value: 3, total: 4 }, { value: 1, total: 2 }])).toBe(63);
    // empty dimensions are ignored (no content of that kind)
    expect(computeEngagementPercent([{ value: 2, total: 2 }, { value: 0, total: 0 }])).toBe(100);
    // over-participation is capped at 1 per dimension
    expect(computeEngagementPercent([{ value: 5, total: 2 }])).toBe(100);
  });
  it("is 0 when nothing has content", () => {
    expect(computeEngagementPercent([{ value: 0, total: 0 }])).toBe(0);
    expect(computeEngagementPercent([])).toBe(0);
  });
});

describe("normalizeBlocks (lesson block model)", () => {
  it("normalises valid blocks and drops empty/unknown ones", () => {
    const out = normalizeBlocks([
      { type: "heading", text: "  Intro  ", level: 3 },
      { type: "paragraph", text: "" }, // empty → dropped
      { type: "paragraph", text: "Hello world" },
      { type: "bullets", items: ["a", "  ", "b"] },
      { type: "callout", text: "note", tone: "bogus" }, // tone defaults to info
      { type: "code", code: "x=1", lang: "py thon" }, // bad lang dropped
      { type: "unknown", text: "x" }, // unknown → dropped
      { notAnObject: true },
    ]);
    expect(out).toEqual([
      { type: "heading", text: "Intro", level: 3 },
      { type: "paragraph", text: "Hello world" },
      { type: "bullets", items: ["a", "b"] },
      { type: "callout", text: "note", tone: "info" },
      { type: "code", code: "x=1" },
    ]);
  });

  it("stores script-looking text verbatim as PLAIN TEXT (no HTML interpretation)", () => {
    const out = normalizeBlocks([{ type: "paragraph", text: "<script>alert(1)</script> & <b>x</b>" }]);
    // The dangerous string is preserved as data; rendering escapes it (React),
    // so there is no markup to execute — the block model carries no HTML.
    expect(out).toEqual([{ type: "paragraph", text: "<script>alert(1)</script> & <b>x</b>" }]);
  });

  it("returns [] for non-arrays / all-invalid input (write path then rejects empty)", () => {
    expect(normalizeBlocks(null)).toEqual([]);
    expect(normalizeBlocks("nope")).toEqual([]);
    expect(normalizeBlocks([{ type: "paragraph", text: "   " }])).toEqual([]);
  });
});

describe("htmlToBlocks (legacy lesson conversion)", () => {
  it("strips tags and splits block-level markup into paragraph blocks", () => {
    const out = htmlToBlocks("<h2>Title</h2><p>First para</p><p>Second <b>bold</b> para</p>");
    expect(out).toEqual([
      { type: "paragraph", text: "Title" },
      { type: "paragraph", text: "First para" },
      { type: "paragraph", text: "Second bold para" },
    ]);
  });

  it("neutralises a legacy script payload (tags stripped, no executable markup)", () => {
    const out = htmlToBlocks('<p>hi</p><script>alert(1)</script><img src=x onerror=alert(1)>');
    const joined = out.map((b) => (b.type === "paragraph" ? b.text : "")).join(" ");
    expect(joined).not.toContain("<script");
    expect(joined).not.toContain("onerror");
    expect(joined).toContain("hi");
  });

  it("decodes basic entities and returns [] for empty html", () => {
    expect(htmlToBlocks("<p>a &amp; b &lt;ok&gt;</p>")).toEqual([{ type: "paragraph", text: "a & b <ok>" }]);
    expect(htmlToBlocks("   ")).toEqual([]);
  });
});

describe("canonicalEmbedUrl", () => {
  it("canonicalises every accepted YouTube link shape to a nocookie embed", () => {
    const want = "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ";
    expect(canonicalEmbedUrl("YOUTUBE", "https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(want);
    expect(canonicalEmbedUrl("YOUTUBE", "https://youtu.be/dQw4w9WgXcQ")).toBe(want);
    expect(canonicalEmbedUrl("YOUTUBE", "https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=30")).toBe(want);
    expect(canonicalEmbedUrl("YOUTUBE", "https://www.youtube.com/embed/dQw4w9WgXcQ")).toBe(want);
  });

  it("canonicalises Vimeo links", () => {
    expect(canonicalEmbedUrl("VIMEO", "https://vimeo.com/123456789")).toBe("https://player.vimeo.com/video/123456789");
    expect(canonicalEmbedUrl("VIMEO", "https://player.vimeo.com/video/123456789")).toBe("https://player.vimeo.com/video/123456789");
  });

  it("rejects non-https, wrong-host, cross-provider and junk URLs (SSRF/XSS safety)", () => {
    expect(canonicalEmbedUrl("YOUTUBE", "http://youtu.be/dQw4w9WgXcQ")).toBeNull(); // not https
    expect(canonicalEmbedUrl("YOUTUBE", "https://evil.com/watch?v=dQw4w9WgXcQ")).toBeNull(); // wrong host
    expect(canonicalEmbedUrl("YOUTUBE", "https://vimeo.com/123456789")).toBeNull(); // wrong provider
    expect(canonicalEmbedUrl("YOUTUBE", 'javascript:alert(1)//youtu.be/x')).toBeNull();
    expect(canonicalEmbedUrl("VIMEO", "https://vimeo.com/not-a-number")).toBeNull();
    expect(canonicalEmbedUrl("YOUTUBE", "")).toBeNull();
  });
});
