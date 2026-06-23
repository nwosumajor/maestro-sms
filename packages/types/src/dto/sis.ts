// SIS (student profile / contacts / medical) response DTOs. Superset shapes:
// the display pages read all fields; the edit forms read a subset (Partial<…>).

export interface StudentProfileDto {
  studentId: string;
  admissionNumber: string | null;
  dateOfBirth: Date | null;
  gender: string | null;
  phone: string | null;
  email: string | null;
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  postalCode: string | null;
}

export interface MedicalRecordDto {
  bloodGroup: string | null;
  allergies: string | null;
  conditions: string | null;
  medications: string | null;
  dietaryNotes: string | null;
  notes: string | null;
}

export interface ContactDto {
  id: string;
  name: string;
  relationship: string;
  phone: string;
  email: string | null;
  priority: number;
}
