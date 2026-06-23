// =============================================================================
// Similarity detector
// =============================================================================
// Compares this submission against OTHERS IN THE SAME ASSESSMENT (and, when
// provided, prior submissions). PROSE uses embedding cosine similarity; CODE
// uses k-gram shingling with Jaccard similarity (MOSS-style). High similarity is
// flagged with the best match and score — never as a "copied" verdict.
//
// // SECURITY: the cohort handed in is ALREADY tenant-scoped by RLS at load
// time, so cross-tenant comparison is structurally impossible here. The detector
// also never reveals another student's CONTENT in the signal — only an id +
// score, so a teacher can pull both up under their own permissions.
// =============================================================================

import type {
  Detector,
  EmbeddingProvider,
  NewSignal,
  SubmissionContext,
} from "./types";
import {
  IntegritySignalSeverity,
  IntegritySignalType,
} from "@sms/types";

const NAME = "similarity@v1";

// ---- code shingling (n-gram / winnowing-lite) -------------------------------
function normalizeCode(s: string): string {
  // Collapse whitespace and lowercase so trivial reformatting doesn't hide reuse.
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

function shingles(text: string, k = 5): Set<string> {
  const norm = normalizeCode(text);
  const set = new Set<string>();
  if (norm.length < k) {
    if (norm) set.add(norm);
    return set;
  }
  for (let i = 0; i <= norm.length - k; i++) set.add(norm.slice(i, i + k));
  return set;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const g of a) if (b.has(g)) inter++;
  return inter / (a.size + b.size - inter);
}

// ---- prose embeddings -------------------------------------------------------
function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function severityFor(score: number): NewSignal["severity"] {
  if (score >= 0.9) return IntegritySignalSeverity.HIGH;
  if (score >= 0.75) return IntegritySignalSeverity.MEDIUM;
  if (score >= 0.6) return IntegritySignalSeverity.LOW;
  return IntegritySignalSeverity.INFO;
}

const FLAG_THRESHOLD = 0.6;

/** The embedding provider is optional: without one, prose similarity is skipped
 *  (we never silently fall back to a weaker method and present it as the same). */
export function createSimilarityDetector(
  embeddings?: EmbeddingProvider,
): Detector {
  return {
    name: NAME,
    async run(ctx: SubmissionContext): Promise<NewSignal[]> {
      const self = ctx.submission.content?.trim();
      if (!self) return [];
      const others = ctx.cohort.filter(
        (c) => c.id !== ctx.submission.id && (c.content ?? "").trim().length > 0,
      );
      if (others.length === 0) return [];

      let method: "EMBEDDING" | "SHINGLING";
      let best = { id: "", score: 0 };

      if (ctx.submission.contentKind === "CODE") {
        method = "SHINGLING";
        const selfShingles = shingles(self);
        for (const o of others) {
          const score = jaccard(selfShingles, shingles(o.content ?? ""));
          if (score > best.score) best = { id: o.id, score };
        }
      } else {
        if (!embeddings) return []; // no provider -> no prose similarity claim
        method = "EMBEDDING";
        const vectors = await embeddings.embed([
          self,
          ...others.map((o) => o.content ?? ""),
        ]);
        const selfVec = vectors[0];
        for (let i = 0; i < others.length; i++) {
          const score = cosine(selfVec, vectors[i + 1]);
          if (score > best.score) best = { id: others[i].id, score };
        }
      }

      if (best.score < FLAG_THRESHOLD) return [];

      return [
        {
          type: IntegritySignalType.SIMILARITY,
          severity: severityFor(best.score),
          confidence: Number(best.score.toFixed(2)),
          detector: NAME,
          evidence: {
            method,
            bestMatchSubmissionId: best.id, // id only, never the other's content
            similarityScore: Number(best.score.toFixed(3)),
            cohortSize: others.length,
            note: "Compared within this tenant's cohort only (RLS-scoped).",
          },
        },
      ];
    },
  };
}
