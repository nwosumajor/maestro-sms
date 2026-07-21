/** A parent-teacher appointment slot (with current booking count). */
export interface MeetingSlotDto {
  id: string;
  teacherId: string;
  teacherName: string | null;
  startsAt: Date;
  endsAt: Date;
  capacity: number;
  booked: number;
  location: string | null;
  note: string | null;
  active: boolean;
}

/** A parent's booking of a slot. */
export interface MeetingBookingDto {
  id: string;
  slotId: string;
  studentId: string;
  studentName: string;
  teacherName: string | null;
  startsAt: Date;
  location: string | null;
  status: string;
  note: string | null;
}
