// =============================================================================
// What Sentry is allowed to know
// =============================================================================
// `Sentry.init` ran on defaults. Its `requestDataIntegration` defaults are
// `{ cookies: true, data: true, headers: true, query_string: true, … }`, and
// `data` is THE REQUEST BODY. Run against this app's own SDK (8.55.2) with a
// transport that never leaves the process, a 5xx produced:
//
//   request.data     { allergies: "penicillin", conditions: "asthma",
//                      medication: "salbutamol inhaler" }
//   request.headers  { authorization: "Bearer eyJhbGciOi…",
//                      cookie: "authjs.session-token=…" }
//   request.cookies  { "authjs.session-token": "…" }
//
// That is a child's medical record, a bearer token and a live session, sent to a
// third party — for data this platform field-encrypts at rest with a per-tenant
// key and audit-logs every read of (Golden Rule #5). A 500 on `POST /auth/login`
// would have sent the plaintext password the same way.
//
// The request log had already been hardened for exactly this: pino redacts
// authorization, cookie, x-stepup and the webhook signatures, and strips the
// query string so no `?token=` is ever written. Sentry was doing none of it. Two
// recorders of the same requests, one careful and one not.
//
// SO NOTHING FROM THE REQUEST GOES. Not the body, not headers, not cookies, not
// the query string. What a 5xx is actually debugged from — the exception and its
// stack, plus the request id, method, matched route, status and tenant that
// ErrorLoggingInterceptor attaches explicitly — is untouched.
//
// BELT AND BRACES, ON PURPOSE. The integration option and `beforeSend` do the
// same job twice because they fail differently: the option is version-specific
// (its defaults are internal to the SDK and have changed before), while
// `beforeSend` is the published contract and runs last, on every event, whatever
// an integration decided. An upgrade that quietly re-enables a default must not
// be the thing standing between a child's medical record and a third party.
// =============================================================================

import * as Sentry from "@sentry/node";
import { envOr } from "../common/env";

/** Nothing derived from the request survives this. */
export function scrubRequest(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  if (event.request) {
    delete event.request.data;
    delete event.request.cookies;
    delete event.request.headers;
    delete event.request.query_string;
    // AND the query INSIDE the url, which is a separate place the same secret
    // lives. Deleting `query_string` alone left `…/medical?token=secret` in
    // `url` — found by the test, not by reading the SDK. pino strips the query
    // from its url for this reason; the second door has to be shut too.
    if (typeof event.request.url === "string") {
      event.request.url = event.request.url.split("?")[0];
    }
  }
  // `user` would be the caller's identity, which the anonymity rules already
  // withhold on some routes; the interceptor puts what is needed in its own
  // context, so this stays empty rather than partly-right.
  delete event.user;
  return event;
}

/**
 * The options `main.ts` initialises Sentry with.
 *
 * Exported so the test exercises THE SAME object rather than a copy of it — a
 * copy is how a scrub gets removed from one and left in the other.
 */
export function sentryOptions(): Sentry.NodeOptions {
  return {
    dsn: process.env.SENTRY_DSN,
    environment: envOr("NODE_ENV", "production"),
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0),
    release: process.env.APP_RELEASE,
    // Never IP addresses, cookies or user identity, whatever an integration
    // would otherwise attach.
    sendDefaultPii: false,
    integrations: [
      Sentry.requestDataIntegration({
        include: { data: false, cookies: false, headers: false, ip: false, query_string: false, user: false },
      }),
    ],
    beforeSend: scrubRequest,
  };
}
