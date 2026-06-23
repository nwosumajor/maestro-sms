// Admissions (public intake review) response DTOs.

export interface AdmissionApplicationDto {
  id: string;
  applicantName: string;
  applicantEmail: string;
  childName: string;
  status: string;
  createdAt: Date;
}
