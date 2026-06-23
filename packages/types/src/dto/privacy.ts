// Privacy (NDPR right-to-erasure) response DTOs.

export interface ErasureRequestDto {
  id: string;
  studentId: string;
  reason: string;
  status: string;
  createdAt: Date;
}
