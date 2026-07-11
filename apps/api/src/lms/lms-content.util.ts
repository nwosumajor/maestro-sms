// =============================================================================
// LMS content helpers — quiz auto-grading + answer-key redaction (pure)
// =============================================================================
// Server-authoritative grading: the answer key lives server-side only and is
// stripped before a quiz is shown to a student. Grading is deterministic and
// objective (MCQ / true-false / short-exact) — no subjective marking here.
// =============================================================================

import type { LessonBlock, QuizAttemptResultDto, QuizDefDto, QuizQuestionDto } from "@sms/types";

/** Normalize a short-answer / option value for comparison. */
function norm(v: unknown): string {
  return String(v ?? "").trim().toLowerCase();
}

/** Stable 32-bit FNV-1a hash of a string (for deterministic per-student ordering). */
function seededHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Deterministically pick `drawCount` questions from a bank for a given seed
 * (e.g. studentId:contentId). Same seed → same subset+order across reloads, so
 * no server-side attempt state is needed; different students get different sets
 * (question-bank randomisation / anti-cheating). drawCount unset/≤0 → all, shuffled.
 */
export function pickQuestions(questions: QuizQuestionDto[], seed: string, drawCount?: number): QuizQuestionDto[] {
  const ordered = [...questions].sort((a, b) => seededHash(seed + a.id) - seededHash(seed + b.id));
  const n = drawCount && drawCount > 0 ? Math.min(drawCount, ordered.length) : ordered.length;
  return ordered.slice(0, n);
}

/** Auto-grade a quiz against a student's answers (keyed by question id). */
export function gradeQuiz(quiz: QuizDefDto, answers: Record<string, string>): QuizAttemptResultDto {
  let score = 0;
  let total = 0;
  const correct: boolean[] = [];
  for (const q of quiz.questions ?? []) {
    const points = q.points && q.points > 0 ? q.points : 1;
    total += points;
    if (q.type === "ESSAY") {
      correct.push(false); // manual-graded; contributes to total but not to the auto score
      continue;
    }
    const given = answers?.[q.id];
    const ok = norm(given) === norm(q.answer);
    if (ok) score += points;
    correct.push(ok);
  }
  return { score, total, correct };
}

/** Strip answer keys from a quiz definition before a student sees it. Keeps the
 *  meta (window / attempts / scoring) so the student sees the rules. */
export function redactQuiz(quiz: QuizDefDto): QuizDefDto {
  return {
    ...quiz,
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

/**
 * Parse a YouTube/Vimeo link into a CANONICAL, host-allowlisted embed URL, or
 * return null if it isn't a recognised video on the expected host. SECURITY: the
 * service persists only this normalised value, so a student's client can only
 * ever render a safe iframe src (youtube-nocookie / player.vimeo) — never an
 * arbitrary attacker-supplied URL.
 */
export function canonicalEmbedUrl(provider: "YOUTUBE" | "VIMEO", raw: string): string | null {
  let u: URL;
  try {
    u = new URL(String(raw ?? "").trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  const host = u.hostname.replace(/^www\./, "");
  if (provider === "YOUTUBE") {
    let id = "";
    if (host === "youtu.be") id = u.pathname.slice(1);
    else if (host === "youtube.com" || host === "m.youtube.com") {
      id = u.searchParams.get("v") ?? (u.pathname.startsWith("/embed/") ? u.pathname.split("/")[2] ?? "" : "");
    } else if (host === "youtube-nocookie.com") {
      id = u.pathname.startsWith("/embed/") ? u.pathname.split("/")[2] ?? "" : "";
    }
    return /^[A-Za-z0-9_-]{6,20}$/.test(id) ? `https://www.youtube-nocookie.com/embed/${id}` : null;
  }
  // VIMEO
  if (host !== "vimeo.com" && host !== "player.vimeo.com") return null;
  const id = (u.pathname.match(/(\d{6,})/) ?? [])[1] ?? "";
  return id ? `https://player.vimeo.com/video/${id}` : null;
}

/** Basic structural validation of a quiz definition at the API boundary. */
export function isValidQuiz(quiz: unknown): quiz is QuizDefDto {
  if (!quiz || typeof quiz !== "object") return false;
  const qs = (quiz as { questions?: unknown }).questions;
  if (!Array.isArray(qs) || qs.length === 0) return false;
  return qs.every((q) => {
    const x = q as Partial<QuizQuestionDto>;
    if (!x.id || !x.prompt || !x.type) return false;
    if (!["MCQ", "TF", "SHORT", "ESSAY"].includes(x.type)) return false;
    if (x.type === "MCQ" && (!Array.isArray(x.options) || x.options.length < 2)) return false;
    // ESSAY is manual-graded, so it carries no answer key.
    if (x.type !== "ESSAY" && (typeof x.answer !== "string" || x.answer.length === 0)) return false;
    return true;
  });
}

/** Scale a 0–100 percentage onto a grade component's max (e.g. 84% → 8/10),
 *  rounded to the nearest whole mark and clamped into [0, max]. Returns null
 *  when there is nothing graded yet (percent === null). Pure — the report-card
 *  "assignment" CA slice is worth `max` points, so an LMS percentage maps
 *  linearly onto it. */
export function scaleToComponent(percent: number | null, max: number): number | null {
  if (percent === null || !Number.isFinite(percent)) return null;
  const mark = Math.round((percent / 100) * max);
  return Math.max(0, Math.min(max, mark));
}

// -----------------------------------------------------------------------------
// Lesson blocks — structured, PLAIN-TEXT content (no raw HTML)
// -----------------------------------------------------------------------------
// A lesson body is a list of typed blocks whose text fields are stored verbatim
// and rendered by auto-escaping React components. This removes the stored-XSS
// vector a free-form HTML body carried. `normalizeBlocks` is LENIENT (drops
// invalid/empty blocks, never throws) so it is safe for both write-validation
// (writes additionally require a non-empty result) and reading stored data.

const BLOCK_LIMITS = { text: 5000, code: 20000, tex: 2000, item: 1000, lang: 20, items: 200, blocks: 500 };

// Strip C0/C1 control chars but keep tab (09) and newline (0A).
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;

/** Trim trailing space, cap length, and strip control characters. */
function cleanText(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  return v.replace(CONTROL_CHARS, "").slice(0, max).trimEnd();
}

function cleanItems(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => cleanText(x, BLOCK_LIMITS.item).trim())
    .filter((s) => s.length > 0)
    .slice(0, BLOCK_LIMITS.items);
}

/** Validate + normalise a lesson block array. Lenient: unknown types and empty
 *  blocks are dropped rather than throwing (so stored/legacy data can't 500 a
 *  read). Returns a clean, capped `LessonBlock[]`. */
export function normalizeBlocks(input: unknown): LessonBlock[] {
  if (!Array.isArray(input)) return [];
  const out: LessonBlock[] = [];
  for (const b of input.slice(0, BLOCK_LIMITS.blocks)) {
    if (!b || typeof b !== "object") continue;
    const type = (b as { type?: unknown }).type;
    switch (type) {
      case "heading": {
        const text = cleanText((b as { text?: unknown }).text, BLOCK_LIMITS.text).trim();
        if (!text) break;
        const lvl = (b as { level?: unknown }).level;
        out.push({ type: "heading", text, level: lvl === 3 ? 3 : 2 });
        break;
      }
      case "paragraph": {
        const text = cleanText((b as { text?: unknown }).text, BLOCK_LIMITS.text).trim();
        if (text) out.push({ type: "paragraph", text });
        break;
      }
      case "quote": {
        const text = cleanText((b as { text?: unknown }).text, BLOCK_LIMITS.text).trim();
        if (text) out.push({ type: "quote", text });
        break;
      }
      case "callout": {
        const text = cleanText((b as { text?: unknown }).text, BLOCK_LIMITS.text).trim();
        if (!text) break;
        const tone = (b as { tone?: unknown }).tone;
        out.push({ type: "callout", text, tone: tone === "warn" || tone === "tip" ? tone : "info" });
        break;
      }
      case "bullets": {
        const items = cleanItems((b as { items?: unknown }).items);
        if (items.length) out.push({ type: "bullets", items });
        break;
      }
      case "numbered": {
        const items = cleanItems((b as { items?: unknown }).items);
        if (items.length) out.push({ type: "numbered", items });
        break;
      }
      case "code": {
        const code = cleanText((b as { code?: unknown }).code, BLOCK_LIMITS.code);
        if (!code.trim()) break;
        const langRaw = cleanText((b as { lang?: unknown }).lang, BLOCK_LIMITS.lang).trim();
        const lang = /^[a-zA-Z0-9+#-]+$/.test(langRaw) ? langRaw : undefined;
        out.push(lang ? { type: "code", code, lang } : { type: "code", code });
        break;
      }
      case "math": {
        const tex = cleanText((b as { tex?: unknown }).tex, BLOCK_LIMITS.tex).trim();
        if (tex) out.push({ type: "math", tex });
        break;
      }
      default:
        break; // unknown block type → dropped
    }
  }
  return out;
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

/** Best-effort conversion of a LEGACY `{html}` lesson into plain-text paragraph
 *  blocks: block-level tags become paragraph breaks, all tags are stripped, and
 *  a handful of entities are decoded. Never interprets markup — the result is
 *  plain text, so a legacy lesson can never render as raw HTML again. */
export function htmlToBlocks(html: string): LessonBlock[] {
  if (typeof html !== "string" || !html.trim()) return [];
  const withBreaks = html
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\/\s*(p|div|li|h[1-6]|tr|section|article|ul|ol|blockquote)\s*>/gi, "\n\n");
  const stripped = withBreaks.replace(/<[^>]*>/g, "");
  const decoded = stripped.replace(/&[a-zA-Z#0-9]+;/g, (m) => ENTITIES[m.toLowerCase()] ?? m);
  return decoded
    .split(/\n{2,}/)
    .map((p) => p.replace(/[ \t]+/g, " ").trim())
    .filter((p) => p.length > 0)
    .slice(0, BLOCK_LIMITS.blocks)
    .map((text) => ({ type: "paragraph", text: text.slice(0, BLOCK_LIMITS.text) }) as LessonBlock);
}

/** A composite engagement score (0–100) — the mean of each available ratio
 *  (value/total, capped at 1) across the dimensions that actually have content
 *  (total > 0). Pure; a SIGNAL for a teacher, never a verdict (Golden Rule #8). */
export function computeEngagementPercent(parts: { value: number; total: number }[]): number {
  const active = parts.filter((p) => p.total > 0);
  if (active.length === 0) return 0;
  const sum = active.reduce((s, p) => s + Math.min(1, Math.max(0, p.value) / p.total), 0);
  return Math.round((sum / active.length) * 100);
}
