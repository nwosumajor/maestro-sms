// HR response DTOs.

export interface EmployeeDto {
  id: string;
  jobTitle: string;
  department: string | null;
  employmentType: string;
  startDate: Date;
  status: string;
  salaryMinor: number | null;
  user: { name: string; email: string } | null;
}
