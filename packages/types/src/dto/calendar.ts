// Calendar / school-events response DTO.

export interface CalendarEventDto {
  id: string;
  title: string;
  /**
   * The SERIES start. For a repeating event this is the first occurrence and
   * NOT the one being listed — read `occurrenceStartsAt` for that.
   */
  startsAt: Date;
  /**
   * THE DATE THIS ROW IS ACTUALLY ON.
   *
   * `GET /events` expands a repeating event into one row per occurrence inside
   * the requested window, and each row carries the whole series with this field
   * saying which occurrence it is. The DTO exposed only `startsAt`, so the
   * calendar page rendered every Monday assembly on the FIRST Monday — a term
   * of them stacked on one date, with a duplicated React key to match.
   *
   * Latent until now only because no screen could create a repeating event; the
   * form that fixes that is what surfaced this.
   */
  occurrenceStartsAt: Date;
  occurrenceEndsAt: Date | null;
  /** A whole day (or several), not a time — render it as a date. */
  allDay: boolean;
  audience: string;
}
