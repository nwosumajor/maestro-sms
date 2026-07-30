/** A scheduled physical exam sitting (with seated + invigilator counts). */
export interface ExamSittingDto {
  id: string;
  title: string;
  subject: string | null;
  date: string;
  startsAt: string;
  endsAt: string;
  hall: string;
  /** Set when the hall was picked from the room registry rather than typed. */
  roomId: string | null;
  capacity: number;
  note: string | null;
  /** The class sitting this exam — the roster a paper sitting auto-seats from. */
  classId: string | null;
  className: string | null;
  seated: number;
  invigilators: number;
  /** Grouping into an approvable schedule (null for a standalone sitting). */
  scheduleId: string | null;
  /** The online CBT exam backing this sitting, if any. */
  cbtExamId: string | null;
  /** The backing CBT exam's status (DRAFT|PENDING_APPROVAL|PUBLISHED|CLOSED) — null for a paper sitting. */
  cbtStatus: string | null;
  /** Whether the CBT exam has been RELEASED (opened) for students to sit. */
  released: boolean;
  /** Live sitting tallies for the invigilator board (present when CBT-backed). */
  started: number;
  submitted: number;
}

/** An approvable exam schedule (a term's batch of subject sittings). */
export interface ExamScheduleDto {
  id: string;
  title: string;
  termId: string | null;
  /** DRAFT | PENDING_REVIEW | APPROVED | REJECTED. */
  status: string;
  createdAt: string;
  sittingCount: number;
  /** How many of its sittings are backed by a CBT exam. */
  cbtCount: number;
}

/** A student's seat in a sitting. */
export interface ExamSeatDto {
  studentId: string;
  studentName: string;
  seatNo: number;
}

/**
 * One student's line on a sitting's register: their seat, plus whether they were
 * marked. `status` is null when nobody has marked them yet — distinct from ABSENT,
 * because "not yet taken" and "did not turn up" must never look the same.
 */
export interface ExamAttendanceRowDto {
  studentId: string;
  studentName: string;
  seatNo: number;
  /** PRESENT | ABSENT | null (unmarked). */
  status: string | null;
  note: string | null;
  markedByName: string | null;
  markedAt: string | null;
}

/** A sitting's register: every seated student, with totals. */
export interface ExamAttendanceDto {
  sittingId: string;
  title: string;
  hall: string;
  date: string;
  startsAt: string;
  endsAt: string;
  rows: ExamAttendanceRowDto[];
  present: number;
  absent: number;
  /** Seated but not yet marked either way. */
  unmarked: number;
}

/** An invigilator assignment. */
export interface InvigilationDto {
  sittingId: string;
  staffId: string;
  staffName: string;
  lead: boolean;
}

/**
 * One hall's state on exam day. Built for the question an exam officer actually
 * asks while walking the halls — "is this room started, and is anyone watching
 * it?" — so the warnings are part of the payload rather than something the
 * browser has to infer.
 */
export interface ExamDayHallDto {
  sittingId: string;
  hall: string;
  title: string;
  subject: string | null;
  startsAt: string;
  endsAt: string;
  seated: number;
  capacity: number;
  invigilators: number;
  /** Null for a paper sitting; otherwise the backing exam's status. */
  cbtStatus: string | null;
  released: boolean;
  started: number;
  submitted: number;
  /** Rostered nobody — the one omission that cannot be fixed after the exam. */
  noInvigilator: boolean;
  /** Seated nobody, so no student can sit it. */
  noSeats: boolean;
  /** Marked absent on this sitting's own register (not the daily class register). */
  absent: number;
  /** Seated but not yet marked present or absent. */
  unmarked: number;
  /** Over capacity, or a hall/time clash with another sitting the same day. */
  warning: string | null;
}

/** The exam-day board: every sitting on one date, grouped by hall. */
export interface ExamDayDto {
  date: string;
  halls: ExamDayHallDto[];
}

/** A student's (or invigilator's) view of an upcoming exam. */
export interface MyExamDto {
  studentId: string;
  studentName: string;
  title: string;
  subject: string | null;
  date: string;
  startsAt: string;
  endsAt: string;
  hall: string;
  seatNo: number;
}
