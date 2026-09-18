/**
 * Bringing the register form INTO VIEW when a board sends you to it.
 *
 * Both attendance boards offer a "Take register" control that is a `Link` to
 * `/attendance?classId=<id>` — the same page, one search parameter different.
 * Two things go wrong with that on its own, and they were measured in a real
 * browser rather than reasoned about:
 *
 *   • Clicking it for the class you are ALREADY looking at changes nothing in
 *     the URL, so Next performs no navigation at all: zero requests, no scroll,
 *     nothing on screen. The teacher presses the one control the page offers and
 *     the product does not react.
 *   • Even when it does navigate, the form is far below the boards — the Save
 *     button sits at y=1094 on a teacher's page and y=4318 on an
 *     administrator's, against a 757px viewport. Off-screen either way.
 *
 * So the control needs a client-side reveal that does not depend on the URL
 * having changed. Written once here because BOTH boards need it and this repo
 * keeps finding rules that were right in one copy and wrong in the other.
 */
export const TAKE_REGISTER_ANCHOR = "take-register";

/** Scroll the register form into view. Safe when it is absent — a caller who
 *  may not take any register has no form, and nothing should happen. */
export function revealTakeRegister() {
  // After the frame in which the navigation (if any) commits, so the element is
  // the one the click is about rather than the one being replaced.
  requestAnimationFrame(() => {
    document.getElementById(TAKE_REGISTER_ANCHOR)?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}
