/**
 * WHICH PAGES THE PUBLIC MAY SEE — the one definition, and a DEFAULT-DENY one.
 *
 * `middleware.ts` gated on a hand-kept list of sections to PROTECT, and the app
 * outgrew it: `/cbt`, `/exams`, `/feedback`, `/group`, `/kiosk`, `/learning`,
 * `/meetings` and `/reportcards` were never added. Measured against the running
 * app, each answered 200 with no session.
 *
 * That gate is three controls at once, and all three were skipped on those eight:
 * the unauthenticated redirect to /login, the 30-day FORCED PASSWORD RESET, and
 * the per-school MFA MANDATE. So a user whose password had expired was held out
 * of /dashboard and could still open the exam hall and a child's report cards.
 *
 * Inverted, the default is the safe one: a new section under `app/(app)` is
 * protected by EXISTING, and opening a page to the public is a deliberate line
 * here (Golden Rule #7).
 *
 * It lives in its own module, not inside `middleware.ts`, so a test can drive
 * the REAL function instead of a copy of its logic — a second implementation in
 * a test proves only that the test agrees with itself.
 *
 * Edge-safe: data and string work only, no filesystem, no Node built-ins.
 */

/** Genuinely public: the marketing site, sign-in and recovery, the public
 *  intake forms, and the certificate verifier — public BY DESIGN so somebody
 *  holding a printed card can check it.
 *
 *  `/manual` and `/runbooks` are deliberately NOT here: the leader's manual and
 *  the on-call runbooks are signed-in. */
export const PUBLIC_PREFIXES = [
  "/login",
  "/reset-password",
  "/welcome",
  "/enroll",
  "/apply",
  "/onboard",
  "/careers",
  "/schools",
  "/for-owners",
  "/legal",
  "/verify",
] as const;

/** `/apply` and `/apply/anything`, but never `/applysomething`. */
export function isPublicRoute(pathname: string): boolean {
  // The marketing homepage, EXACTLY — not everything beneath it.
  if (pathname === "/") return true;
  // A file, not a page. Next serves `app/icon.png` and friends through the same
  // matcher, and redirecting those to /login breaks the favicon on the public
  // site. Anything ending in an extension is an asset.
  if (/\.[a-z0-9]+$/i.test(pathname)) return true;
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/** Everything else needs a session. */
export function needsSession(pathname: string): boolean {
  return !isPublicRoute(pathname);
}
