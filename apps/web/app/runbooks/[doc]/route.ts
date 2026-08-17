import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { RUNBOOKS } from "../runbook-html";

// The operational runbooks, rendered from docs/*.md and served inside the app.
//
// WHO CAN READ THEM. Platform staff only — the same gate as the operator console
// (`platform.tenants.read`, which the owner holds and a delegated manager can be
// lent). These are not school documents: they describe the platform's own
// infrastructure, its rollback procedure, how to reach the database, and what to
// do about a TENANT-ISOLATION BREACH. A school principal has no use for any of
// it, and the incident playbook in particular is a map of where the load-bearing
// parts are.
//
// A signed-in user without the permission gets 404, not 403 — the same posture
// the rest of the platform takes, so the existence of an operator surface is not
// disclosed to someone who cannot use it.
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ doc: string }> }) {
  const { doc } = await ctx.params;
  const session = await auth();
  if (!session?.user) {
    return NextResponse.redirect(new URL(`/login?next=/runbooks/${encodeURIComponent(doc)}`, req.url));
  }
  if (!hasPermission(session.user.permissions, "platform.tenants.read")) {
    return new NextResponse("Not found", { status: 404 });
  }

  const book = RUNBOOKS[doc];
  if (!book) return new NextResponse("Not found", { status: 404 });

  // No explicit <head>: the generated HTML opens with <title>/<style> and then
  // <header>, and HTML5 closes the implied head at the first body element. The
  // onboarding manual is served the same way for the same reason.
  const html = `<!doctype html>
<html lang="en">
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
${book.html}
</html>`;

  return new NextResponse(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "private, no-store",
      "x-robots-tag": "noindex, nofollow",
      "referrer-policy": "same-origin",
    },
  });
}
