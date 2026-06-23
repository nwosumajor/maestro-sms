// Attendance response DTOs. Student/class pickers reuse IdNameDto.

export interface AttendanceRecordDto {
  id: string;
  status: string;
  note: string | null;
  session: { classId: string; date: string };
}
