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
  room: { name: string } | null;
}
