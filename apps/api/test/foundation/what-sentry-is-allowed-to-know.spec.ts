// =============================================================================
// The medical record that a 500 would have sent to a third party
// =============================================================================
// `Sentry.init` ran on defaults. Its requestDataIntegration defaults are
// `{ cookies: true, data: true, headers: true, query_string: true, … }`, and
// `data` is THE REQUEST BODY.
//
// Run against this app's own SDK (8.55.2), with a transport that never leaves
// the process, one captured exception produced:
//
//   request.data     { allergies: "penicillin", conditions: "asthma",
//                      medication: "salbutamol inhaler" }
//   request.headers  { authorization: "Bearer eyJhbGciOi…",
//                      cookie: "authjs.session-token=…" }
//   request.cookies  { "authjs.session-token": "…" }
//
// A child's medical record, a bearer token and a live session — for data the
// platform field-encrypts at rest with a per-tenant key and audit-logs every
// read of. A 500 on POST /auth/login would have sent the plaintext password the
// same way.
//
// pino had already been hardened for exactly this: it redacts authorization,
// cookie, x-stepup and the webhook signatures, and strips the query string so no
// `?token=` is ever written. Sentry, recording the same requests, did none of
// it.
//
// These tests run the REAL options — `sentryOptions()`, the object main.ts
// passes — through Sentry's own pipeline. A copy of the options would be how a
// scrub gets removed from one and left in the other.
// =============================================================================

import * as Sentry from "@sentry/node";
import { scrubRequest, sentryOptions } from "../../src/observability/sentry-options";

/** A request as the http integration puts it on the isolation scope. */
const MEDICAL_REQUEST = {
  method: "PUT",
  url: "http://api/students/abc/medical?token=secret",
  headers: { authorization: "Bearer eyJhbGciOi...", cookie: "authjs.session-token=xyz" },
  data: { allergies: "penicillin", conditions: "asthma", medication: "salbutamol inhaler" },
};

/** Init Sentry exactly as main.ts does, capture one error, return the event. */
async function captureWith(request: Record<string, unknown>): Promise<Sentry.ErrorEvent | null> {
  let captured: Sentry.ErrorEvent | null = null;
  const opts = sentryOptions();
  const client = new Sentry.NodeClient({
    ...opts,
    dsn: "https://abc123@o0.ingest.sentry.io/0",
    stackParser: Sentry.defaultStackParser,
    // The integrations main.ts configures, verbatim.
    integrations: Array.isArray(opts.integrations) ? opts.integrations : [],
    // Nothing is sent anywhere: the transport keeps the envelope in-process.
    transport: () => ({
      send: async (envelope: unknown) => {
        const item = (envelope as [unknown, [[unknown, Sentry.ErrorEvent]]])[1]?.[0]?.[1];
        if (item && (item as { exception?: unknown }).exception) captured = item;
        return {};
      },
      flush: async () => true,
    }),
  });
  const scope = new Sentry.Scope();
  scope.setClient(client);
  client.init();
  scope.setSDKProcessingMetadata({ normalizedRequest: request });
  scope.captureException(new Error("boom"));
  await client.flush(2000);
  return captured;
}

describe("what leaves the process when a request 500s", () => {
  it("carries no request body", async () => {
    // The finding: a child's allergies and medication went to a third party.
    const event = await captureWith(MEDICAL_REQUEST);
    expect(event).not.toBeNull();
    expect(JSON.stringify(event)).not.toMatch(/penicillin|asthma|salbutamol/);
    expect(event?.request?.data).toBeUndefined();
  });

  it("carries no Authorization header and no cookie", async () => {
    const event = await captureWith(MEDICAL_REQUEST);
    const text = JSON.stringify(event);
    expect(text).not.toMatch(/eyJhbGciOi/);
    expect(text).not.toMatch(/authjs\.session-token/);
  });

  it("carries no query string", async () => {
    // pino strips it so no `?token=` is ever logged; the same token must not
    // reach a third party by the other door.
    expect(JSON.stringify(await captureWith(MEDICAL_REQUEST))).not.toMatch(/token=secret/);
  });

  it("still carries the exception itself", async () => {
    // Over-scrubbing would leave an incident nobody can diagnose. The error and
    // its stack are the point of sending anything at all.
    const event = await captureWith(MEDICAL_REQUEST);
    expect(JSON.stringify(event?.exception)).toMatch(/boom/);
  });
});

describe("the scrub itself", () => {
  it("removes every request-derived field", () => {
    const event = {
      request: {
        data: { password: "hunter2" },
        cookies: { s: "x" },
        headers: { authorization: "Bearer x" },
        query_string: "token=secret",
        url: "http://api/auth/login",
        method: "POST",
      },
      user: { id: "u1" },
    } as unknown as Sentry.ErrorEvent;
    const out = scrubRequest(event);
    expect(out.request?.data).toBeUndefined();
    expect(out.request?.cookies).toBeUndefined();
    expect(out.request?.headers).toBeUndefined();
    expect(out.request?.query_string).toBeUndefined();
    expect(out.user).toBeUndefined();
    // The route is not sensitive and is what makes an event findable — but its
    // query string is a second place a token lives, so the path survives and
    // the query does not.
    expect(out.request?.url).toBe("http://api/auth/login");
  });

  it("strips the query from the url as well as the field", () => {
    const event = {
      request: { url: "http://api/documents/abc/file?token=secret", method: "GET" },
    } as unknown as Sentry.ErrorEvent;
    expect(scrubRequest(event).request?.url).toBe("http://api/documents/abc/file");
  });

  it("survives an event with no request at all", () => {
    // A background job's exception has no request; the scrub must not throw
    // there, or the error is lost instead of merely being scrubbed.
    expect(() => scrubRequest({} as Sentry.ErrorEvent)).not.toThrow();
  });

  it("is wired into the options main.ts uses", () => {
    // The belt: an SDK upgrade that re-enables a default must still meet this.
    expect(sentryOptions().beforeSend).toBe(scrubRequest);
    expect(sentryOptions().sendDefaultPii).toBe(false);
  });

  it("keeps the braces as well as the belt", () => {
    // Asserted STRUCTURALLY, because behaviour cannot see it: `beforeSend` runs
    // last and scrubs everything, so deleting the integration option changes no
    // observable output and every behavioural test above still passes. Two
    // guards that fail differently are the point — the option is version-
    // specific, `beforeSend` is the published contract — and a redundancy
    // nothing checks is a redundancy that quietly becomes a single point.
    const integrations = sentryOptions().integrations;
    expect(Array.isArray(integrations)).toBe(true);
    expect((integrations as Array<{ name: string }>).map((i) => i.name)).toContain("RequestData");
  });
});
