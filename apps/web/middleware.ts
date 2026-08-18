// Two jobs, and they cover different ground — which is the whole reason this
// file is shaped the way it is.
//
// 1. AUTH. Protect the signed-in app: no session -> /login, an expired password
//    or a mandated-but-unenrolled 2FA -> held on the relevant page. This applies
//    to the prefixes in PROTECTED_PREFIXES and nowhere else.
//
// 2. CSP. Give every PAGE a per-request nonce so `script-src` can be real. This
//    has to cover the PUBLIC pages too — the login form, the marketing home,
//    /apply and /onboard are the unauthenticated surface, and they are exactly
//    what the old matcher did not include.
//
// So the matcher now runs on nearly everything, and the auth rules are applied
// by an explicit prefix test rather than by which routes the matcher happens to
// cover. The prefix list below is the old matcher, unchanged, moved into code:
// widening the matcher without this would have redirected every visitor to
// /login, and narrowing it by accident would have let somebody into the app.
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { THEME_SCRIPT_CSP_HASH } from "@/lib/theme-script";

/** The signed-in app. Everything not listed here is public by design. */
const PROTECTED_PREFIXES = [
  "/dashboard",
  "/admin",
  "/analytics",
  "/classes",
  "/content",
  "/gradebook",
  "/workflows",
  "/assessments",
  "/notifications",
  "/students",
  "/timetable",
  "/certificates",
  "/attendance",
  "/fees",
  "/hostel",
  "/transport",
  "/library",
  "/tasks",
  "/polls",
  "/discussion",
  "/discipline",
  "/forms",
  "/alumni",
  "/reports",
  "/scan",
  "/billing",
  "/documents",
  "/account",
  "/messages",
  "/calendar",
  "/hr",
  "/leave",
  "/games",
  "/operator",
  "/directory",
  "/announcements",
  "/family",
  "/scholarships",
  "/help",
  "/manual",
  "/runbooks",
];

/** `/fees` and `/fees/anything`, but never `/feesomething`. */
function isProtected(pathname: string): boolean {
  return PROTECTED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * The page policy.
 *
 * `strict-dynamic` with a per-request nonce is what makes this worth having:
 * Next injects an inline bootstrap that then loads the rest, so the bootstrap
 * carries the nonce and the chunks it pulls in are trusted transitively. Without
 * a nonce the only way to keep the app working would be 'unsafe-inline', which
 * permits precisely what script-src exists to stop.
 *
 * The rest is what the app genuinely needs, and no more:
 *   style-src 'unsafe-inline'  — Next and next/font emit inline styles; there is
 *                                no nonce path for them in this version.
 *   img-src https: data: blob: — school logos are served from object storage on
 *                                a presigned URL, and the platform mark is a data URI.
 *   frame-src https:           — lesson VIDEO embeds, already host-allowlisted
 *                                server-side (youtube-nocookie / vimeo).
 *   connect-src ws: wss:       — the live game/watch socket, which in local dev
 *                                is a different origin (NEXT_PUBLIC_WS_URL).
 */
function policy(nonce: string): string {
  return [
    "default-src 'self'",
    // The theme bootstrap is inline, blocking and must run before paint, so it
    // is admitted by HASH — 'self' does not cover inline code and nothing has
    // injected it. Hashes still apply under 'strict-dynamic'; host allowlists
    // do not, which is the point of it.
    `script-src 'self' 'nonce-${nonce}' '${THEME_SCRIPT_CSP_HASH}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "frame-src 'self' https:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join("; ");
}

export const middleware = auth((req) => {
  const { pathname } = req.nextUrl;

  if (isProtected(pathname)) {
    if (!req.auth?.user) {
      const url = new URL("/login", req.nextUrl);
      // Carry the interrupted destination so re-authentication returns the user
      // to where they were (relative path only — LoginForm re-validates it).
      const next = pathname + req.nextUrl.search;
      if (next && next.startsWith("/") && !next.startsWith("//")) url.searchParams.set("next", next);
      return NextResponse.redirect(url);
    }
    // 30-day reset: the password has expired — hold the user on the change page until
    // they set a new one (checked before MFA so it always takes precedence).
    if (req.auth.user.passwordExpired && pathname !== "/account/password") {
      return NextResponse.redirect(new URL("/account/password?expired=1", req.nextUrl));
    }
    // super_admin mandated MFA but the user hasn't enrolled — hold them on /account.
    if (req.auth.user.mfaEnrollRequired && !pathname.startsWith("/account")) {
      return NextResponse.redirect(new URL("/account?enroll2fa=1", req.nextUrl));
    }
  }

  // The nonce has to reach Next, and it reads it from the REQUEST's CSP header —
  // which is why the policy is set on both the request and the response rather
  // than only on the way out.
  const nonce = btoa(crypto.randomUUID());
  const csp = policy(nonce);
  const headers = new Headers(req.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", csp);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set("Content-Security-Policy", csp);
  return res;
});

export const config = {
  matcher: [
    // Everything except Next's own static output, image optimiser, metadata
    // files and the API routes. The API is excluded deliberately: the two
    // proxies under /api set their own, far stricter policy (a sandboxed opaque
    // origin), and Auth.js owns /api/auth — neither wants this page policy or
    // this file's redirects.
    "/((?!api|_next/static|_next/image|favicon.ico|manifest.webmanifest|sw.js|robots.txt|sitemap.xml|images/).*)",
  ],
};
