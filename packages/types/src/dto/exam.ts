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
