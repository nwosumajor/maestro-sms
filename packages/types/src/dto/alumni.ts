// Alumni Management response DTOs (server form; Date fields are Date).

export interface AlumnusDto {
  id: string;
  userId: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  graduationYear: number | null;
  lastClass: string | null;
  occupation: string | null;
  notes: string | null;
  createdAt: Date;
}

/** How many alumni one screen of the register carries. */
export const ALUMNI_PAGE_SIZE = 50;

/**
 * A page of a school's alumni register.
 *
 * The list was `take: 500` with no page and no total, on the one table in this
 * product that only ever grows — a school adds a whole cohort every year and
 * nothing removes an alumnus. The broadcast beside it says exactly that in its
 * own comment ("An alumni roll only ever grows — nobody stops being an
 * alumnus") and counts in the database because of it; the list did not.
 *
 * Measured on a school with three real cohorts of 200: 600 held, 500 shown, and
 * because the order is newest-cohort-first the 100 that vanished were the
 * OLDEST — which for alumni is precisely backwards, since the established
 * cohorts are the ones a school wants for reunions and fundraising. At ten
 * years the default view would show a quarter of the register and say nothing.
 */
export interface AlumniPageDto {
  items: AlumnusDto[];
  /** Matching the filter, not the page. */
  total: number;
  page: number;
  pageSize: number;
}
