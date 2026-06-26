// =============================================================================
// WS handshake ticket: browser → this route → a short-lived Bearer for /ws/*
// =============================================================================
// The live game sockets (/ws/duel, /ws/watch, …) authenticate the HANDSHAKE with
// the same HS256 token the REST API verifies, passed as ?token=. A browser socket
// can't reuse the BFF's per-request server-side bearer, so it asks this route for
// a freshly minted one just before connecting.
//
// SECURITY: the token still comes ONLY from the verified session (tenant + authz
// claims are server-stamped, never client input) and is short-lived (5 min, from
// bearerForSession). This is the established auth path for the game transport
// sockets — deliberately narrower than holding a long-lived API token. The socket
// it authorizes is READ-ONLY (the gateway re-reads the RLS-scoped, redacted view).
// =============================================================================

import { NextResponse } from "next/server";
import { bearerForSession } from "@/lib/apiToken";

export async function GET() {
  const token = await bearerForSession();
  if (!token) return new NextResponse("Unauthorized", { status: 401 });
  // no-store: never cache a credential.
  return NextResponse.json({ token }, { headers: { "Cache-Control": "no-store" } });
}
