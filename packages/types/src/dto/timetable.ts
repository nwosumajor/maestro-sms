// Timetable response DTOs. Rooms reuse IdNameDto.

export interface PeriodDto {
  id: string;
  name: string;
  sequence: number;
  startTime: string;
  endTime: string;
}

export interface TimetableEntryDto {
  id: string;
  dayOfWeek: string;
  periodId: string;
  subject: string;
  /** Teacher assigned to the lesson (id + resolved display name). */
  teacherId: string;
  teacherName: string;
  /** Physical room the lesson occupies (nullable — a lesson need not have one). */
  roomId: string | null;
  room: { name: string } | null;
}
