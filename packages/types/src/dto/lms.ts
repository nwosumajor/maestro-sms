// LMS / Classes + Workflow-summary response DTOs.

export interface ClassDto {
  id: string;
  name: string;
  subject: string | null;
}

/** Compact workflow row used on the dashboard. */
export interface WorkflowSummaryDto {
  id: string;
  state: string;
}

/** Workflow row in the approvals inbox. */
export interface WorkflowInboxItemDto {
  id: string;
  type: string;
  title: string;
  state: string;
  initiatorId: string;
  createdAt: Date;
  /** Multi-stage progress (0/0 for a single-stage request). */
  currentStage: number;
  stageCount: number;
  /** Label of the stage currently awaiting approval (null when not staged/terminal). */
  stageLabel: string | null;
}
