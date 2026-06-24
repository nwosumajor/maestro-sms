// Unit: pure quiz auto-grading + answer-key redaction.
import { gradeQuiz, isValidQuiz, redactQuiz } from "../../src/lms/lms-content.util";
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

describe("redactQuiz", () => {
  it("strips every answer key", () => {
    const r = redactQuiz(quiz);
    expect(r.questions.every((q) => q.answer === "")).toBe(true);
    expect(r.questions.map((q) => q.prompt)).toEqual(quiz.questions.map((q) => q.prompt));
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
