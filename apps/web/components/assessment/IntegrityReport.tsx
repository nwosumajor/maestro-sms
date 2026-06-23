// =============================================================================
// IntegrityReport — read-only teacher view of a submission's signals
// =============================================================================
// Renders aggregated signals + evidence for HUMAN REVIEW. Hard requirements:
//  - The disclaimer (Golden Rule #8) is shown PROMINENTLY and verbatim.
//  - This view is read-only: it offers NO "penalize" / "flag as cheating"
//    control. Any consequence is a separate, manually-initiated, separately
//    logged teacher action — deliberately not wired into this evidence view.
//  - No raw student content is shown here; only derived evidence the API sent.
// Built with shadcn/ui + design tokens.
// =============================================================================

import * as React from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { ShieldAlertIcon } from "lucide-react";
import type {
  IntegrityReportDto,
  IntegrityReportSignal,
} from "@sms/types/integrity-report";
import type { IntegritySignalSeverity } from "@sms/types/integrity-enums";

// Token-driven severity styles (see design tokens). Constant across tenants so
// "High" always reads the same regardless of school theme (Golden Rule #8).
const SEVERITY_VARIANT: Record<
  IntegritySignalSeverity,
  { label: string; className: string }
> = {
  INFO: { label: "Info", className: "bg-severity-info-bg text-severity-info-fg" },
  LOW: { label: "Low", className: "bg-severity-low-bg text-severity-low-fg" },
  MEDIUM: { label: "Medium", className: "bg-severity-medium-bg text-severity-medium-fg" },
  HIGH: { label: "High", className: "bg-severity-high-bg text-severity-high-fg" },
};

const TYPE_LABEL: Record<string, string> = {
  PASTE: "Paste",
  FOCUS_LOSS: "Left the tab",
  TYPING_ANOMALY: "Typing pattern",
  SIMILARITY: "Similarity",
  DRAFT_ANOMALY: "Draft history",
};

function SeverityBadge({ severity }: { severity: IntegritySignalSeverity }) {
  const v = SEVERITY_VARIANT[severity];
  return <Badge className={v.className}>{v.label}</Badge>;
}

function EvidenceList({ evidence }: { evidence: Record<string, unknown> }) {
  const entries = Object.entries(evidence);
  if (entries.length === 0) return null;
  return (
    <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
      {entries.map(([k, val]) => (
        <div key={k} className="flex justify-between gap-4 border-b border-border/40 py-1">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="text-right font-mono">
            {typeof val === "object" ? JSON.stringify(val) : String(val)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function SignalCard({ signal }: { signal: IntegrityReportSignal }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">
            {TYPE_LABEL[signal.type] ?? signal.type}
          </CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant="outline">{signal.source === "CLIENT" ? "Client" : "Server"}</Badge>
            <SeverityBadge severity={signal.severity} />
          </div>
        </div>
        <CardDescription>
          {signal.detector ?? "—"} · confidence {Math.round(signal.confidence * 100)}% ·{" "}
          {new Date(signal.createdAt).toLocaleString()}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <EvidenceList evidence={signal.evidence} />
      </CardContent>
    </Card>
  );
}

export function IntegrityReport({ report }: { report: IntegrityReportDto }) {
  const { summary } = report;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">{report.assessmentTitle}</h1>
        <p className="text-sm text-muted-foreground">
          Submission {report.submissionId.slice(0, 8)} · status {report.status}
          {report.submittedAt
            ? ` · submitted ${new Date(report.submittedAt).toLocaleString()}`
            : " · not yet submitted"}
        </p>
      </div>

      {/* Golden Rule #8 — shown verbatim, prominently, above the signals.
          Calm `info` styling (indigo), never a red alarm. */}
      <Alert variant="info">
        <ShieldAlertIcon className="h-4 w-4" aria-hidden />
        <AlertTitle>For your review — not a determination</AlertTitle>
        <AlertDescription>{report.disclaimer}</AlertDescription>
      </Alert>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">{summary.total} signal(s):</span>
        {(["HIGH", "MEDIUM", "LOW", "INFO"] as IntegritySignalSeverity[])
          .filter((s) => summary.bySeverity[s] > 0)
          .map((s) => (
            <span key={s} className="flex items-center gap-1">
              <SeverityBadge severity={s} />
              <span>{summary.bySeverity[s]}</span>
            </span>
          ))}
      </div>

      {report.signals.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No integrity signals were recorded for this submission.
        </p>
      ) : (
        <div className="space-y-3">
          {report.signals.map((s) => (
            <SignalCard key={s.id} signal={s} />
          ))}
        </div>
      )}
    </div>
  );
}
