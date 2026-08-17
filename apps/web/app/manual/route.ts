import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { MANUAL_HTML, MANUAL_PDF_BASE64 } from "./manual-html";

// The School Leader's Manual, served ONLY to signed-in users.
//
// SECURITY: this document states real authentication policy — the 3-strike
// permanent lockout, password expiry, idle timeout, and the ₦50,000 approval
// threshold. None of those depend on secrecy, but published alongside the public
// school directory the lockout policy becomes a recipe for locking out a NAMED
// administrator with three deliberate wrong guesses. So it stays behind the
// session gate and out of search engines.
//
// The auth() check here is deliberate defence in depth: /manual is also listed in
// the middleware matcher, and neither layer is trusted to be the only one.
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.redirect(new URL("/login?next=/manual", req.url));
  }

  // `?format=pdf` serves the generated file, built from the same parse of this
  // document as the page below. One handler, so the two can never be reachable
  // under different rules.
  if (new URL(req.url).searchParams.get("format") === "pdf") {
    const bytes = Buffer.from(MANUAL_PDF_BASE64, "base64");
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": 'attachment; filename="school-leaders-manual.pdf"',
        "content-length": String(bytes.length),
        "cache-control": "private, no-store",
        "x-robots-tag": "noindex, nofollow",
      },
    });
  }

  // No explicit <head>: MANUAL_HTML opens with <title>/<style> (head content) and
  // then <header> (body content). HTML5 makes both tags optional, so the parser
  // closes the implied head at the first body element — wrapping it in an explicit
  // <head> instead would pull the whole document into the head and render nothing.
  const doc = `<!doctype html>
<html lang="en">
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
${MANUAL_HTML}
</html>`;

  return new NextResponse(doc, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // Signed-in content: never cached by a shared proxy.
      "cache-control": "private, no-store",
      "x-robots-tag": "noindex, nofollow",
      "referrer-policy": "same-origin",
    },
  });
}
