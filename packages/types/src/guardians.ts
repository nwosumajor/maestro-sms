// =============================================================================
// How many adults may be attached to one child
// =============================================================================
// Each guardian link is an ACCESS GRANT: that account sees the child's fees,
// grades, attendance, report cards and documents, and receives every
// notification about them. So the list cannot be unbounded — a bad import loop
// or an unnoticed picker mis-click should not be able to attach forty adults to
// one pupil.
//
// But the cap is set to catch THAT, not to model a family. Two is the obvious
// number and it is the wrong one:
//
//   - A boarding pupil normally has parents PLUS a local guardian near the
//     school, who is the person actually telephoned. Three before anything
//     unusual, and the commonest arrangement in this market.
//   - Separated parents are two on their own; a step-parent doing the school
//     run makes three.
//   - A child living with a grandmother or an aunt while a parent works
//     elsewhere, with the parent still holding rights.
//
// AND THE FAILURE MODE OF A LOW CAP IS WORSE THAN A HIGH ONE. At the cap the
// office does the only thing the software allows: unlink somebody to make room.
// The mother then stops receiving absence alerts and invoices, silently —
// nothing tells her, and the next person to look sees a tidy list of two and no
// sign anything was removed. A cap that gets worked around by deleting an
// access grant causes the harm it was meant to prevent.
//
// Four covers mother + father + local guardian + step-parent and still catches
// the runaway, which looks like forty rather than five.
//
// It is a platform constant rather than a per-school setting on purpose: one
// more thing to configure is one more thing to get wrong, and no school has yet
// needed a different number. If one genuinely does, this is the line to change
// and both the API and the web read it — they cannot drift apart.
export const MAX_GUARDIANS_PER_STUDENT = 4;
