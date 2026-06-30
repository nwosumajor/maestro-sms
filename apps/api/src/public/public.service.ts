// =============================================================================
// PublicService — pre-auth website surface (school directory + onboarding intake)
// =============================================================================
// All reads/writes here are PUBLIC (no session). The School registry is global /
// RLS-exempt, so we resolve it under a placeholder GUC (never client-supplied
// tenant data). onboarding_request is likewise global (no schoolId); the public
// submit inserts via the least-privilege app role (SELECT/INSERT grant only).
// Nothing here can touch tenant-scoped student/user data.
// =============================================================================

import { Inject, Injectable } from "@nestjs/common";
import type { PublicSchoolDto } from "@sms/types";
import {
  TENANT_DATABASE,
  type TenantDatabase,
} from "../integrity/integrity.foundation";

const ZERO = "00000000-0000-0000-0000-000000000000";

export interface OnboardingRequestInput {
  schoolName: string;
  contactName: string;
  contactEmail: string;
  contactPhone?: string | null;
  desiredSlug?: string | null;
  notes?: string | null;
}

@Injectable()
export class PublicService {
  constructor(@Inject(TENANT_DATABASE) private readonly db: TenantDatabase) {}

  /** PUBLIC: list onboarded (ACTIVE) schools for the parent directory. */
  async listSchools(): Promise<PublicSchoolDto[]> {
    return this.db.runAsTenant({ schoolId: ZERO, userId: ZERO }, (tx) =>
      tx.school.findMany({
        where: { status: "ACTIVE", isPlatform: false },
        select: { id: true, name: true, slug: true },
        orderBy: { name: "asc" },
      }),
    );
  }

  /** PUBLIC: a prospective principal asks to onboard their school. */
  async submitOnboardingRequest(input: OnboardingRequestInput) {
    const desiredSlug = input.desiredSlug?.trim().toLowerCase() || null;
    return this.db.runAsTenant({ schoolId: ZERO, userId: ZERO }, (tx) =>
      tx.onboardingRequest.create({
        data: {
          schoolName: input.schoolName,
          contactName: input.contactName,
          contactEmail: input.contactEmail,
          contactPhone: input.contactPhone ?? null,
          desiredSlug,
          notes: input.notes ?? null,
          status: "NEW",
        },
        select: { id: true, status: true },
      }),
    );
  }
}
