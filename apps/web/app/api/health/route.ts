// Liveness probe for the ALB target group. Public, no auth, no DB — it only
// proves the Next.js server is up and serving. Keep it cheap and side-effect free.
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({ status: "ok" });
}
