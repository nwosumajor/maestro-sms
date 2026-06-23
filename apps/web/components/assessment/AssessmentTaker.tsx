"use client";

// =============================================================================
// AssessmentTaker — student test-taking surface (Screen 1)
// =============================================================================
// Composes the integrity-aware answer field with a focused header (title, time,
// save status) and the submit/save actions. Autosaves drafts (append-only on the
// server) and submits. The monitoring banner + paste friction live inside
// AssessmentAnswerField and only appear when monitoring is active (and never for
// an exempt student) — so this screen is identical for an exempt student minus
// the banner. NOTHING here can block submission (no enforcement).
// =============================================================================

import * as React from "react";
import { ClockIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AssessmentAnswerField } from "@/components/assessment/AssessmentAnswerField";
import type { IntegrityClientConfig } from "@/lib/integrity/hooks";

type SaveState = "idle" | "saving" | "saved" | "error";

export interface AssessmentTakerProps {
  assessmentTitle: string;
  timeRemainingLabel: string;
  initialContent: string;
  integrity: IntegrityClientConfig; // carries apiBaseUrl + ids + toggles + consent + exempt
  /** Optional contextual back link (e.g. to the class), from the Stitch V3 polish. */
  backHref?: string;
  backLabel?: string;
}

const wordCount = (s: string) => {
  const t = s.trim();
  return t ? t.split(/\s+/).length : 0;
};

const endpoint = (cfg: IntegrityClientConfig, action: "autosave" | "submit") =>
  `${cfg.apiBaseUrl.replace(/\/$/, "")}/assessments/${cfg.assessmentId}/submissions/${cfg.submissionId}/${action}`;

export function AssessmentTaker({
  assessmentTitle,
  timeRemainingLabel,
  initialContent,
  integrity,
  backHref,
  backLabel,
}: AssessmentTakerProps) {
  const [content, setContent] = React.useState(initialContent);
  const [save, setSave] = React.useState<SaveState>("idle");
  const [submitting, setSubmitting] = React.useState(false);
  const [submitted, setSubmitted] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const autosave = React.useCallback(
    async (value: string) => {
      setSave("saving");
      try {
        const res = await fetch(endpoint(integrity, "autosave"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ content: value }),
        });
        setSave(res.ok ? "saved" : "error");
      } catch {
        setSave("error");
      }
    },
    [integrity],
  );

  // Debounced autosave on edits.
  const onChange = (next: string) => {
    setContent(next);
    setSave("saving");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void autosave(next), 1200);
  };

  React.useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const onSubmit = async () => {
    setSubmitting(true);
    try {
      const res = await fetch(endpoint(integrity, "submit"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ content }),
      });
      if (res.ok) setSubmitted(true);
    } finally {
      setSubmitting(false);
    }
  };

  const saveLabel =
    save === "saving" ? "Saving…"
    : save === "saved" ? "Saved just now"
    : save === "error" ? "Couldn't save — keep writing, we'll retry"
    : "";

  if (submitted) {
    return (
      <div className="rounded-lg border border-border bg-card p-8 text-center">
        <h1 className="text-xl font-semibold">Submitted</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Your answer for “{assessmentTitle}” has been submitted. You can close this tab.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Contextual back link (Stitch V3 polish). */}
      {backHref && (
        <a
          href={backHref}
          className="inline-block text-sm text-muted-foreground hover:text-foreground"
        >
          ← {backLabel ?? "Back"}
        </a>
      )}

      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{assessmentTitle}</h1>
          <p className="mt-0.5 text-sm text-muted-foreground" aria-live="polite">
            {saveLabel || "Your work autosaves as you write."}
          </p>
        </div>
        {/* Outline time-remaining pill (calmer than a filled badge). */}
        <div className="flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-sm tabular-nums">
          <ClockIcon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          <span className="text-muted-foreground">Time remaining</span>
          <span className="font-medium">{timeRemainingLabel}</span>
        </div>
      </div>

      <AssessmentAnswerField
        fieldId="answer"
        value={content}
        onValueChange={onChange}
        integrity={integrity}
        placeholder="Write your answer here…"
        disabled={submitting}
      />

      {/* Live word count (Stitch V3 polish) — plain textarea, so this is derived
          from value, not an editor toolbar. */}
      <div className="-mt-2 text-right text-xs text-muted-foreground tabular-nums">
        Word count: {wordCount(content)}
      </div>

      <div className="flex items-center justify-end gap-3">
        <Button
          variant="outline"
          onClick={() => void autosave(content)}
          disabled={submitting}
        >
          Save draft
        </Button>
        <Button onClick={() => void onSubmit()} disabled={submitting}>
          {submitting ? "Submitting…" : "Submit"}
        </Button>
      </div>
    </div>
  );
}
