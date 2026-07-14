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
