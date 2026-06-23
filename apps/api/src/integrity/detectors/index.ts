import type { Detector, EmbeddingProvider } from "./types";
import { pasteOriginDetector } from "./paste-origin.detector";
import { typingAnomalyDetector } from "./typing-anomaly.detector";
import { draftEvolutionDetector } from "./draft-evolution.detector";
import { createSimilarityDetector } from "./similarity.detector";

/** Assemble the detector set. Order doesn't matter — each emits independently. */
export function buildDetectors(embeddings?: EmbeddingProvider): Detector[] {
  return [
    pasteOriginDetector,
    typingAnomalyDetector,
    draftEvolutionDetector,
    createSimilarityDetector(embeddings),
  ];
}

export * from "./types";
