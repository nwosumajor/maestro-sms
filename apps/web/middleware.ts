// Protect the authenticated app routes (the matcher below). Using the auth()
// WRAPPER (not just `export { auth as middleware }`) so we can return an explicit
// NextResponse — reliably honoured — for two redirects:
//   1. no session            -> /login
//   2. passwordExpired user   -> /account/password (held there until they reset)
//   3. mfaEnrollRequired user -> /account (held there until they enrol 2FA)
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";

export const middleware = auth((req) => {
  const { pathname } = req.nextUrl;
  if (!req.auth?.user) {
    const url = new URL("/login", req.nextUrl);
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
  return NextResponse.next();
});

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/admin/:path*",
    "/analytics/:path*",
    "/classes/:path*",
    "/grades/:path*",
    "/workflows/:path*",
    "/assessments/:path*",
    "/notifications/:path*",
    "/students/:path*",
    "/timetable/:path*",
    "/certificates/:path*",
    "/attendance/:path*",
    "/fees/:path*",
    "/hostel/:path*",
    "/transport/:path*",
    "/library/:path*",
    "/tasks/:path*",
    "/polls/:path*",
    "/discussion/:path*",
    "/discipline/:path*",
    "/forms/:path*",
    "/alumni/:path*",
    "/reports/:path*",
    "/billing/:path*",
    "/documents/:path*",
    "/account/:path*",
    "/messages/:path*",
    "/calendar/:path*",
    "/hr/:path*",
    "/leave/:path*",
    "/games/:path*",
    "/operator/:path*",
    "/directory/:path*",
    "/announcements/:path*",
  ],
};
