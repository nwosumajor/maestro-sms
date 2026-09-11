/** One global-search hit, with a link into the app. */
export interface SearchHitDto {
  kind: "student" | "staff" | "class" | "invoice";
  id: string;
  title: string;
  subtitle: string | null;
  href: string;
}

/**
 * How many a category actually matched, and where the rest of them live.
 *
 * The omnibox shows six per category and said nothing about the remainder, so a
 * search that matched 150 pupils and a search that matched exactly six looked
 * identical. Measured on a 1,200-pupil roll: "Adebayo" matched 150 and returned
 * 6, "Okonkwo" 150 and 6, "Eze" 150 and 6 — and the six were not the first six
 * by any order a reader could see, because the query had no ORDER BY at all.
 *
 * That is the difference between "your pupil is not on the roll" and "your pupil
 * is one of the 144 I did not show you", and the screen could not tell them
 * apart.
 */
export interface SearchCategoryDto {
  kind: SearchHitDto["kind"];
  /** How many of this kind are in `hits`. */
  shown: number;
  /**
   * How many matched in all. Counted ONLY when more than a page matched — the
   * common search matches a handful, and an ILIKE count on every keystroke is
   * a cost nobody should pay to be told "6 of 6".
   */
  total: number;
  /**
   * The full list, with the query carried over — or NULL where the product has
   * no such page. A "see all" that leads nowhere is worse than none: `/students`
   * and `/hr` take a `?q=`, `/classes` and `/fees` do not, and this says so
   * rather than inventing a destination.
   */
  seeAllHref: string | null;
}

export interface SearchResultDto {
  query: string;
  hits: SearchHitDto[];
  /** One entry per category that was searched and matched something. */
  categories: SearchCategoryDto[];
}
