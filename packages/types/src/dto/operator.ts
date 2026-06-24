// Super-admin operator console response DTOs.

export interface TenantDto {
  id: string;
  name: string;
  slug: string;
  status: string;
  createdAt: Date;
  users: number;
  /** Subscription plan (BASIC | STANDARD | ENTERPRISE). */
  plan: string;
  /** Count of subscription-enabled modules. */
  moduleCount: number;
}
