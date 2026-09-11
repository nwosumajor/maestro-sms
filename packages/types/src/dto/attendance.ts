// Attendance response DTOs. Student/class pickers reuse IdNameDto.

export interface AttendanceRecordDto {
  id: string;
  status: string;
  note: string | null;
  session: { classId: string; date: string };
}


/**
 * One class's register for a day, and WHO is responsible for it.
 *
 * The board answered "which registers are missing" and stopped there, so a head
 * teacher could see that Form 2B had none and not who to ask. It also listed
 * only the gaps — a count said "4 of 31 not taken" and the 27 that were done
 * were never shown, which is the half that tells you the day is under control.
 */
export interface RegisterStatusRowDto {
  classId: string;
  className: string;
  taken: boolean;
  /** Pupils marked, against those on roll — a register saved half way through
   *  reads as "done" everywhere else. */
  marked: number;
  enrolled: number;
  /** The class teacher (`Class.supervisorId`), or null where none is assigned. */
  teacherId: string | null;
  teacherName: string | null;
  /**
   * FALSE when there is no supervisor, or the one on record has left. Such a
   * register will never be chased by the daily reminder and cannot be, so the
   * board says so rather than showing an empty column: "nobody is assigned to
   * this class" is a different problem from "the teacher has not taken it".
   */
  teacherActive: boolean;
}

export interface RegisterStatusDto {
  /** The SCHOOL's day, not the server's. */
  date: string;
  classes: RegisterStatusRowDto[];
}
