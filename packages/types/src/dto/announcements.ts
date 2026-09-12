// School announcement DTOs.

export const ANNOUNCEMENT_AUDIENCES = ["ALL", "STUDENTS", "STAFF"] as const;
export type AnnouncementAudienceValue = (typeof ANNOUNCEMENT_AUDIENCES)[number];

export interface AnnouncementDto {
  id: string;
  title: string;
  body: string;
  audience: string;
  authorName: string;
  createdAt: Date;
}

/**
 * A page of the school's notice board.
 *
 * `list` returned the newest 100 with no count, no page and no search. Measured
 * on a five-year school posting ~2.5 notices a week (501 held): a principal
 * reached back to 2025-01-26 and a parent to 2024-11-09, with three to four
 * years of what the school had told families unreachable at any URL — and
 * nothing on the page saying a notice had been left out.
 *
 * A notice board is read to answer "what did the school say about X", so SEARCH
 * is the control that matters; it runs in SQL, because filtering the fetched
 * page in the browser could only ever see the rows that survived the cap.
 */
export interface AnnouncementPageDto {
  items: AnnouncementDto[];
  /** Total matching the current search, counted in SQL. */
  total: number;
  shown: number;
  page: number;
  pageSize: number;
}
