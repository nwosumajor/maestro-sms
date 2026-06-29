// Protect the authenticated app routes. The `authorized` callback in lib/auth.ts
// returns false when there's no session, which redirects to /login (pages.signIn).
export { auth as middleware } from "@/lib/auth";

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
    "/attendance/:path*",
    "/fees/:path*",
    "/documents/:path*",
    "/account/:path*",
    "/messages/:path*",
    "/calendar/:path*",
    "/hr/:path*",
    "/operator/:path*",
    "/directory/:path*",
    "/announcements/:path*",
  ],
};
