// =============================================================================
// The step that makes the whole upload surface reachable
// =============================================================================
// The token, the three public endpoints, the page at /apply/documents, the rate
// limits, the signature checks, the byte checks — all built, all tested, and
// NOTHING GAVE A FAMILY THE URL. `mintDocumentUploadToken` had exactly one
// caller in the whole codebase: its own definition.
//
// A capability nobody is handed is the same as one that does not exist. That is
// the "written and never read" class, and it caught its own author here.
//
// The link rides the ACCEPTANCE email rather than one of its own: a family who
// has just been told yes will read one message, and the documents are the next
// thing the school needs from them.
// =============================================================================

import { AdmissionsService } from "../../src/admissions/admissions.service";
import { verifyDocumentUploadToken } from "../../src/documents/document-upload-token";
import { UPLOAD_TOKEN_TTL_DAYS } from "@sms/types";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

// Bcrypt at cost factor 10 dominates this suite's runtime — that is the security
// parameter doing its job, not slow code, so the timeout moves rather than the
// cost. At the 5s default these pass alone and fail under full-suite
// parallelism, which teaches people to re-run a red suite instead of reading it.
jest.setTimeout(60_000);


type Sent = { target: string; title: string; body: string };

const APP = "44444444-4444-4444-4444-444444444444";
const SCHOOL = "55555555-5555-5555-5555-555555555555";

function make(status: "ACCEPTED" | "REJECTED") {
  const sent: Sent[] = [];
  const app = {
    id: APP,
    applicantName: "Ngozi",
    applicantEmail: "ngozi@example.test",
    applicantPhone: null,
    childName: "Ada",
    childDob: null,
    status,
    details: null,
    desiredClass: null,
    stages: [],
    currentStage: 0,
    approvals: [],
    examDate: null,
    examNote: null,
    reviewNote: null,
    formFeeMinor: 0,
    formFeePaidAt: null,
    createdAt: new Date(),
  };
  const tx = {
    admissionApplication: {
      findFirst: jest.fn(async () => app),
      updateMany: jest.fn(async () => ({ count: 1 })),
      update: jest.fn(async () => app),
    },
    userRole: { findMany: jest.fn(async () => []) },
    user: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null) },
  } as unknown as TenantTx;
  const db = {
    runAsTenant: <T,>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    runAsTenantReadOnly: <T,>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
  };
  const service = new AdmissionsService(
    db as never,
    { record: jest.fn() } as never,
    { deliver: jest.fn(async (m: Sent) => { sent.push(m); }) } as never,
    { isConfigured: () => false, initialize: jest.fn() } as never,
    { effective: jest.fn().mockResolvedValue({}) } as never,
    {} as never,
    { forSchool: jest.fn().mockResolvedValue({ currency: "NGN" }) } as never,
    { promoteApplicationInTx: jest.fn() } as never,
  );
  return { service, sent, app };
}

/** notifyApplicant is private and deliberately so — reached the way the review
 *  chain reaches it, through the object, rather than by exporting it for a test. */
const notify = (service: AdmissionsService, app: unknown, status: string) =>
  (service as unknown as { notifyApplicant: (a: unknown, s: string, school: string) => Promise<void> })
    .notifyApplicant(app, status, SCHOOL);

const p: Principal = { schoolId: SCHOOL, userId: "u", roles: [], permissions: [] };
void p;

beforeAll(() => {
  process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "test-secret-for-admission-links";
});

describe("what an accepted family is told", () => {
  const OLD = process.env.PUBLIC_WEB_URL;
  beforeEach(() => { process.env.PUBLIC_WEB_URL = "https://school.example"; });
  afterAll(() => { process.env.PUBLIC_WEB_URL = OLD; });

  it("carries a link they can actually use", async () => {
    const { service, sent, app } = make("ACCEPTED");
    await notify(service, app, "ACCEPTED");
    expect(sent[0].body).toContain("https://school.example/apply/documents?token=");
  });

  it("mints a token that speaks for THIS application and no other", async () => {
    const { service, sent, app } = make("ACCEPTED");
    await notify(service, app, "ACCEPTED");
    const token = /token=([\w.-]+)/.exec(sent[0].body)?.[1];
    expect(verifyDocumentUploadToken(token)).toEqual({ applicationId: APP, schoolId: SCHOOL });
  });

  it("says how long they have, because a certificate may need a registry visit", async () => {
    const { service, sent, app } = make("ACCEPTED");
    await notify(service, app, "ACCEPTED");
    expect(sent[0].body).toContain(`${UPLOAD_TOKEN_TTL_DAYS} days`);
  });

  it("still says the child was accepted", async () => {
    // The link is an addition to the news, not a replacement for it.
    const { service, sent, app } = make("ACCEPTED");
    await notify(service, app, "ACCEPTED");
    expect(sent[0].title).toContain("accepted");
    expect(sent[0].body).toContain("Ada");
  });
});

describe("who is NOT sent one", () => {
  beforeEach(() => { process.env.PUBLIC_WEB_URL = "https://school.example"; });

  it("a family whose application was declined", async () => {
    // They have nothing to send, and the endpoints would refuse them anyway —
    // inviting them to upload would be a cruelty as well as a dead end.
    const { service, sent, app } = make("REJECTED");
    await notify(service, app, "REJECTED");
    expect(sent[0].body).not.toContain("/apply/documents");
  });
});

describe("when the platform does not know its own address", () => {
  it("sends the acceptance WITHOUT a half-built link, and says so in the log", async () => {
    // "undefined/apply/documents?token=…" in a parent's inbox is worse than no
    // sentence at all, and the school needs to know the invitation did not go.
    const OLD = process.env.PUBLIC_WEB_URL;
    delete process.env.PUBLIC_WEB_URL;
    const warned: string[] = [];
    const { Logger } = await import("@nestjs/common");
    jest.spyOn(Logger.prototype, "warn").mockImplementation((m: unknown) => { warned.push(String(m)); });
    const { service, sent, app } = make("ACCEPTED");
    await notify(service, app, "ACCEPTED");
    expect(sent[0].body).toContain("accepted");
    expect(sent[0].body).not.toContain("undefined");
    expect(warned.join(" ")).toMatch(/PUBLIC_WEB_URL is not set/);
    jest.restoreAllMocks();
    process.env.PUBLIC_WEB_URL = OLD;
  });
});
