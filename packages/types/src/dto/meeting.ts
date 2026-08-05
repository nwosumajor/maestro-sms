/** A parent-teacher appointment slot (with current booking count). */
export interface MeetingSlotDto {
  /** WHO the meeting is for, and a ready-made label for it. The label is built
   *  server-side because only the server has the class and pupil names, and
   *  three screens would otherwise each build their own wording. */
  audienceKind: string;
  audienceRef: string | null;
  audienceLabel: string;
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
  /** Video meeting, when the host attached one. */
  provider: string | null;
  /** Released only inside the join window (or to the host); null otherwise. */
  joinUrl: string | null;
  /** True when the link is live right now. */
  joinOpen: boolean;
  /** When the Join button starts working (null if there is no link). */
  joinOpensAt: Date | null;
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
