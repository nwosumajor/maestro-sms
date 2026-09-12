/** A parent-teacher appointment slot (with current booking count). */
export interface MeetingSlotDto {
  /** WHO the meeting is for, and a ready-made label for it. The label is built
   *  server-side because only the server has the class and pupil names, and
   *  three screens would otherwise each build their own wording. */
  audienceKind: string;
  audienceRef: string | null;
  audienceLabel: string;
  /** APPOINTMENT | BRIEFING — whether a capacity claim applies. */
  kind?: string;
  /** Colleagues attending alongside the organiser, so a parent knows who will
   *  be in the room before they walk in. */
  cohosts?: Array<{ id: string; name: string }>;
  id: string;
  teacherId: string;
  teacherName: string | null;
  startsAt: Date;
  endsAt: Date;
  capacity: number;
  booked: number;
  /**
   * WHO booked — populated ONLY on a host's view of their own slots.
   *
   * The host had the count and nothing else, so a teacher could not tell which
   * family was coming to their own appointment, and — once the cancel gate was
   * fixed — still had no booking id to act on. Deliberately absent from the
   * parent-facing open-slots list: one family must never see another's booking.
   */
  bookings?: Array<{ id: string; parentName: string | null; studentName: string | null }>;
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

/**
 * Which end of a diary a meetings list is showing.
 *
 * These lists are read to answer "what is next", and both were ordered
 * `startsAt ASC` over the WHOLE history under a cap — so the rows returned were
 * the OLDEST ever recorded and the cap discarded the future. An ascending cap on
 * a diary is the mirror of the newest-first cap this repo records against a
 * register: the same defect pointed at the other end of time.
 */
export type MeetingWhen = "upcoming" | "past";

/** A page of meeting slots, with the total its filter actually matched. */
export interface MeetingSlotPageDto {
  items: MeetingSlotDto[];
  /** Counted in SQL over the same predicate the page is drawn from. */
  total: number;
  /** How many rows this page holds — `total > shown` means there are more. */
  shown: number;
  when: MeetingWhen;
  /** The other end, so a screen can say what it is not showing. */
  otherTotal: number;
}

/** A page of a parent's own bookings. Same shape, same reasoning. */
export interface MeetingBookingPageDto {
  items: MeetingBookingDto[];
  total: number;
  shown: number;
  when: MeetingWhen;
  otherTotal: number;
}
