// Super-admin operator console response DTOs.

export interface TenantDto {
  id: string;
  name: string;
  slug: string;
  status: string;
  createdAt: Date;
  users: number;
}
