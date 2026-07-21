// =============================================================================
// GatewayEventService — append-only log of every VERIFIED webhook event
// =============================================================================
// One call per verified event, from both webhook routes, BEFORE dispatch —
// so the raw evidence exists even when downstream processing drops the event
// (unmappable tenant, unknown kind, a bug). Best-effort by contract: a log
// failure must never fail the webhook (the gateway would retry forever).
// Raw parameterized INSERT (no Prisma create): the app role has no UPDATE/
// DELETE on the table and writes happen with NO tenant GUC — see rls/79.
// =============================================================================

import { Injectable, Logger } from "@nestjs/common";
import { prisma } from "@sms/db";

@Injectable()
export class GatewayEventService {
  private readonly logger = new Logger("GatewayEvents");

  async record(input: {
    gateway: "PAYSTACK" | "STRIPE";
    eventType: string;
    reference?: string | null;
    schoolId?: string | null;
    payload: unknown;
  }): Promise<void> {
    try {
      await prisma.$executeRaw`
        INSERT INTO "gateway_event" (id, "schoolId", gateway, "eventType", reference, payload)
        VALUES (gen_random_uuid(), ${input.schoolId ?? null}::uuid, ${input.gateway}, ${input.eventType},
                ${input.reference ?? null}, ${JSON.stringify(input.payload)}::jsonb)`;
    } catch (e) {
      this.logger.warn(`gateway event log failed (${input.gateway} ${input.eventType}): ${(e as Error).message}`);
    }
  }
}
