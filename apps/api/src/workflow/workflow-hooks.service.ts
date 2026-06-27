// =============================================================================
// WorkflowHooksService — one-way "request finalized" fan-out
// =============================================================================
// Lets other modules (e.g. HR leave) react when a WorkflowRequest reaches a
// TERMINAL state, WITHOUT the workflow engine importing them (no cycle). A
// module registers a handler in onModuleInit; WorkflowService calls runFinalized
// inside the SAME tenant transaction, so the reaction is atomic with the
// transition. Mirrors the GameService→CompetitionService hook pattern.
// =============================================================================

import { Injectable } from "@nestjs/common";
import type { TenantTx } from "../integrity/integrity.foundation";

export interface FinalizedRequest {
  id: string;
  schoolId: string;
  type: string;
  /** Terminal state reached. */
  state: "APPROVED" | "REJECTED";
  payload: unknown;
  initiatorId: string;
}

export type FinalizedHandler = (tx: TenantTx, req: FinalizedRequest) => Promise<void>;

@Injectable()
export class WorkflowHooksService {
  private readonly handlers: FinalizedHandler[] = [];

  /** Register a handler invoked when ANY request reaches APPROVED/REJECTED. */
  onFinalized(handler: FinalizedHandler): void {
    this.handlers.push(handler);
  }

  /** Run every handler in order, inside the caller's tenant transaction. */
  async runFinalized(tx: TenantTx, req: FinalizedRequest): Promise<void> {
    for (const handler of this.handlers) {
      await handler(tx, req);
    }
  }
}
