/** A scheduled physical exam sitting (with seated + invigilator counts). */
export interface ExamSittingDto {
  id: string;
  title: string;
  subject: string | null;
  date: string;
  startsAt: string;
  endsAt: string;
  hall: string;
  capacity: number;
  note: string | null;
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

/** An invigilator assignment. */
export interface InvigilationDto {
  sittingId: string;
  staffId: string;
  staffName: string;
  lead: boolean;
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
