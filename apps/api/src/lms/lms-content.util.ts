// =============================================================================
// LMS content helpers — quiz auto-grading + answer-key redaction (pure)
// =============================================================================
// Server-authoritative grading: the answer key lives server-side only and is
// stripped before a quiz is shown to a student. Grading is deterministic and
// objective (MCQ / true-false / short-exact) — no subjective marking here.
// =============================================================================

import type { QuizAttemptResultDto, QuizDefDto, QuizQuestionDto } from "@sms/types";

/** Normalize a short-answer / option value for comparison. */
function norm(v: unknown): string {
  return String(v ?? "").trim().toLowerCase();
}

/** Auto-grade a quiz against a student's answers (keyed by question id). */
export function gradeQuiz(quiz: QuizDefDto, answers: Record<string, string>): QuizAttemptResultDto {
  let score = 0;
  let total = 0;
  const correct: boolean[] = [];
  for (const q of quiz.questions ?? []) {
    const points = q.points && q.points > 0 ? q.points : 1;
    total += points;
    const given = answers?.[q.id];
    const ok = norm(given) === norm(q.answer);
    if (ok) score += points;
    correct.push(ok);
  }
  return { score, total, correct };
}

/** Strip answer keys from a quiz definition before a student sees it. */
export function redactQuiz(quiz: QuizDefDto): QuizDefDto {
  return {
    questions: (quiz.questions ?? []).map((q): QuizQuestionDto => ({
      id: q.id,
      type: q.type,
      prompt: q.prompt,
      options: q.options,
      points: q.points,
      answer: "", // never expose the key to a taker
    })),
  };
}

/** Basic structural validation of a quiz definition at the API boundary. */
export function isValidQuiz(quiz: unknown): quiz is QuizDefDto {
  if (!quiz || typeof quiz !== "object") return false;
  const qs = (quiz as { questions?: unknown }).questions;
  if (!Array.isArray(qs) || qs.length === 0) return false;
  return qs.every((q) => {
    const x = q as Partial<QuizQuestionDto>;
    if (!x.id || !x.prompt || !x.type) return false;
    if (!["MCQ", "TF", "SHORT"].includes(x.type)) return false;
    if (x.type === "MCQ" && (!Array.isArray(x.options) || x.options.length < 2)) return false;
    if (typeof x.answer !== "string" || x.answer.length === 0) return false;
    return true;
  });
}
