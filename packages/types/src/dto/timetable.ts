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

/** One (day, period) slot a teacher CANNOT teach — CSP generator input. */
export interface TeacherUnavailabilityDto {
  teacherId: string;
  dayOfWeek: string;
  periodId: string;
}

/** Structural over-demand found by the generator's preflight: `demand` lessons
 *  compete for `capacity` free slots. `name` is the resolved teacher/class/room. */
export interface TimetableDiagnosticDto {
  kind: "TEACHER_OVERLOAD" | "CLASS_OVERLOAD" | "ROOM_OVERLOAD";
  name: string;
  demand: number;
  capacity: number;
}

/** Outcome of POST /timetable/generate (the CSP solver run). */
export interface TimetableGenerateResultDto {
  /** Lessons written to the grid. */
  placed: number;
  /** True when the CSP search satisfied EVERY quota (no best-effort fallback). */
  complete: boolean;
  /** Lessons that could not be placed, with the blocking constraint. */
  unplaced: { className: string; subject: string; teacherName: string; reason: string }[];
  /** Impossible-demand warnings (over-allocated teacher / class / room). */
  diagnostics: TimetableDiagnosticDto[];
}
