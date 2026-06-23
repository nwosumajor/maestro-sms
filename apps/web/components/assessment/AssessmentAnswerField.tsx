"use client";

// =============================================================================
// AssessmentAnswerField — answer input wired to integrity capture
// =============================================================================
// Reference wiring of useAssessmentIntegrity onto a real answer field. Two
// things are NON-NEGOTIABLE here per CLAUDE.md:
//
//  1. TRANSPARENCY (Golden Rule #5): when monitoring is active the student is
//     shown an explicit, visible disclosure. Monitoring is "never covert".
//  2. NO ENFORCEMENT: nothing here can stop a student from submitting. Paste
//     friction is the only interference and it is cosmetic — the signal, not
//     the block, is what matters server-side.
//
// Rebuilt in shadcn/ui + design tokens (no AI-generated one-off screens shipped).
// =============================================================================

import * as React from "react";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { EyeIcon } from "lucide-react";
import {
  useAssessmentIntegrity,
  type IntegrityClientConfig,
} from "@/lib/integrity/hooks";

export interface AssessmentAnswerFieldProps {
  fieldId: string;
  value: string;
  onValueChange: (next: string) => void;
  integrity: IntegrityClientConfig;
  placeholder?: string;
  disabled?: boolean;
}

/**
 * Disclosure banner. Lists exactly which capture is on so the notice is honest
 * and specific rather than a vague "you are being monitored".
 */
function IntegrityMonitoringNotice({
  toggles,
}: {
  toggles: IntegrityClientConfig["toggles"];
}) {
  const items: string[] = [];
  if (toggles.pasteCapture) items.push("paste attempts (length only, never content)");
  if (toggles.focusTracking) items.push("when you leave this tab");
  if (toggles.typingCadence) items.push("typing rhythm (timing only, never what you type)");
  if (items.length === 0) return null;

  return (
    <Alert variant="info" className="mb-3">
      <EyeIcon className="h-4 w-4" aria-hidden />
      <AlertTitle>Academic-integrity monitoring is on for this task</AlertTitle>
      <AlertDescription>
        For review by your teacher, this assessment records: {items.join("; ")}.
        These are signals for a human to consider — they are never an automatic
        penalty. Need an accommodation? Ask your teacher about an exemption.
      </AlertDescription>
    </Alert>
  );
}

export function AssessmentAnswerField({
  fieldId,
  value,
  onValueChange,
  integrity,
  placeholder,
  disabled,
}: AssessmentAnswerFieldProps) {
  const { active, pasteFriction, fieldProps } = useAssessmentIntegrity(
    fieldId,
    integrity,
  );

  return (
    <div>
      {active && <IntegrityMonitoringNotice toggles={integrity.toggles} />}

      <Textarea
        id={fieldId}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        // Capture handlers are no-ops when monitoring is inactive (exempt/off),
        // so an exempt student gets a completely ordinary field.
        onPaste={fieldProps.onPaste}
        onKeyDown={fieldProps.onKeyDown}
        onChange={(e) => {
          fieldProps.onChange(e);
          onValueChange(e.target.value);
        }}
        aria-describedby={active ? `${fieldId}-integrity-note` : undefined}
      />

      {pasteFriction && (
        <p id={`${fieldId}-integrity-note`} className="mt-1 text-sm text-muted-foreground">
          Pasting is turned off for this answer. Type your response. If you use
          assistive technology, ask your teacher for an exemption.
        </p>
      )}
    </div>
  );
}
