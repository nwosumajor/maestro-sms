// =============================================================================
// Pagination / list-size limits — one source of truth (scaling Phase 3)
// =============================================================================
// Interactive list endpoints must never return an unbounded result set: a
// single large tenant (thousands of students / years of history) would blow
// query time, response size, and API memory. Every school-wide, time-growing
// list caps its row count here. Views that need to page deeper add a keyset
// cursor (see the audit-log viewer for the reference pattern); most inbox/queue
// views only ever surface the most-recent page, which this cap covers.

/** Hard cap for a school-wide interactive list (approvals queue, assessments,
 *  leave history, …). Chosen well above any single school's realistic active
 *  set so a normal view is never truncated, while a pathological/adversarial
 *  tenant can't force an unbounded scan. */
export const LIST_CAP = 500;

/** Cap for a typeahead/search result set (people pickers). Small — the caller
 *  is expected to narrow with a query, not scroll thousands of rows. */
export const SEARCH_CAP = 50;

/**
 * Ceiling on an UNSEARCHED roster listing.
 *
 * Comfortably past a class or a year group, so every legitimate "show me the list"
 * still fits — but it means a picker can no longer be fed by dumping the whole
 * school. Anything needing a total calls the count endpoint; anything needing a
 * particular person searches (SEARCH_CAP).
 */
export const ROSTER_CAP = 500;

/** One page of the approvals register. Small, because each row is a card the
 *  reviewer reads rather than a table line they scan — and because the register
 *  is now reachable by filter and page instead of by scrolling 500 cards. */
export const WORKFLOW_PAGE_SIZE = 25;

/** One page of the leave register. Rows are table lines rather than cards, so a
 *  page can be larger than the approvals register's. */
export const LEAVE_PAGE_SIZE = 50;

/** One page of the assessment list — cards a teacher scans for today's work. */
export const ASSESSMENT_PAGE_SIZE = 30;
