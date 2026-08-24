// =============================================================================
// The weaker action re-authenticated and the stronger one did not
// =============================================================================
// Step-up re-auth exists for one threat: a session that is open when it should
// not be — borrowed laptop, stolen cookie, someone still logged in at a shared
// desk. It is applied to 53 of the 502 mutating routes, which is right: asking
// for a password before every invoice line would train people to type it
// without reading.
//
// What is NOT right is applying it INCONSISTENTLY WITHIN ONE PERMISSION, and
// three cases had the gate on the weaker action and not the stronger:
//
//   rbac.manage                  toggling the school's MFA POLICY: step-up.
//                                GRANTING SOMEBODY THE PRINCIPAL ROLE: none.
//                                Only junior-admin-tier grants are maker-checker;
//                                every other role was a direct, audited write.
//
//   platform.user.credentials    resetting one user's password / MFA / status:
//                                step-up. Switching MFA OFF FOR A WHOLE ROLE
//                                ACROSS A TENANT: none — strictly the larger act.
//
//   platform.subscription.manage comping message credits: step-up. Granting a
//                                tenant a PLAN, a STATUS and a paid PERIOD: none.
//
// Found by extracting every mutating route with its permission and its
// decorators, then asking which permissions hold both gated and ungated routes.
// That asymmetry is computable, so it should not need a person to notice it.
//
// The gate does not demand step-up everywhere — that would be a worse product
// and people would stop reading the prompt. It demands that a route sharing a
// permission with a gated one is EITHER gated too OR named here with a reason.
// =============================================================================

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const API_SRC = join(__dirname, "../../src");
const ROUTE = /@(Get|Post|Put|Patch|Delete)\(\s*(?:["'`]([^"'`]*)["'`])?\s*\)/g;

/**
 * Routes that share a permission with a step-up-gated sibling and legitimately
 * do NOT need it, with the reason. Day-to-day work is the common case: a
 * control everybody has to click through ten times a morning is a control they
 * stop reading.
 */
const ALLOWED: Record<string, string> = {
  "POST /students/:studentId/profile/approve": "Approving a submitted profile is routine records work, not a change of authority.",
  "POST /admin/sis/nudge/run": "Sends reminders; changes no authority and moves no money.",
  "POST /admin/users": "Creating an account grants nothing on its own — roles carry the authority, and those are now gated.",
  "POST /billing/referral/code": "Generates the school's own shareable code; grants nothing to anyone else.",
  "POST /legal/acceptance": "Records that terms were accepted. Re-authenticating to agree to terms is theatre.",
  "POST /invoices/:id/adjustments": "Maker-checker already: the approver must be a different person.",
  "PUT /invoices/:id/plan": "Rearranges when an existing balance falls due; the total cannot change.",
  "POST /invoices/:id/apply-credit": "Moves the family's own credit onto the family's own invoice; nothing leaves.",
  "POST /invoices/:id/overpayment-to-credit": "Double-entry move of the family's own overpayment.",
  "POST /students/:id/virtual-account": "Provisions a collection account in the pupil's name; takes no money.",
  "POST /fees/settlement/resolve": "Records the outcome of a settlement enquiry; it does not move money itself.",
  "POST /fees/reminders/run": "Sends overdue reminders to families; daily work that moves nothing.",
  "POST /fees/items": "Fee CATALOGUE entry; bills nobody until an invoice uses it.",
  "PATCH /fees/items/:id": "Same — the catalogue, not a bill.",
  "POST /invoices": "Raising a bill is the finance office's ordinary work, many times a day.",
  "POST /invoices/issue-bulk": "Issuing a run that was already drafted and reviewed.",
  "POST /invoices/:id/issue": "Issues one already-drafted invoice; the amounts were set and reviewed before this.",
  "POST /invoices/:id/cancel": "Withdraws a charge, which is the direction that helps the family rather than harms them.",
  "POST /invoices/:id/payments": "Recording receipts is the busiest action in the product, and large ones are maker-checker already.",
  "POST /fees/disputes/:id/respond": "Records the school's evidence response to a chargeback.",
  "POST /hr/recruitment/requisitions": "Opening a vacancy changes no authority and moves no money.",
  "POST /hr/recruitment/requisitions/:id/status": "Moves a vacancy through its own states; no authority changes hands.",
  "POST /hr/recruitment/requisitions/:id/applicants": "Adds a candidate to a hiring pipeline; grants them nothing.",
  "POST /hr/recruitment/applicants/:id/stage": "Moves a candidate through the pipeline; grants them nothing.",
  "POST /hr/employment/changes/:id/decide": "Maker-checker already: a different person decides, and the pay change itself goes through the salary path, which IS step-up gated at both ends.",
  "POST /operator/payment-channels/health/run": "Read-only probe of the payment gateways; changes nothing.",
  "POST /operator/payment-channels/:channel/test": "Sends a test call to a gateway; moves no money.",
  "POST /operator/platform-delegations/:id/revoke": "TAKES authority away. The restrictive direction should never be harder than the permissive one.",
  "POST /scholarships/applications/:id/review": "Documented decision: REVIEW/SHORTLIST/REJECT carry no money; only AWARD does, and AWARD is gated.",
  "POST /scholarships/programs/:id/announce-exam": "Tells candidates when the exam is; carries no decision and no money.",
  "POST /scholarships/programs/:id/collect-results": "Gathers results already recorded elsewhere.",
  "POST /students/:studentId/readmit": "Restores a pupil's access, which is the direction that helps them rather than harms them.",
  "POST /students/:studentId/documents/release": "Releases the family's own documents to them.",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "dist") continue;
    const f = join(dir, e);
    if (statSync(f).isDirectory()) walk(f, out);
    else if (f.endsWith(".controller.ts")) out.push(f);
  }
  return out;
}

interface Row { key: string; perm: string; stepUp: boolean }

function routes(): Row[] {
  const out: Row[] = [];
  for (const file of walk(API_SRC)) {
    const src = readFileSync(file, "utf8");
    const prefix = /@Controller\(\s*["'`]([^"'`]*)["'`]\s*\)/.exec(src)?.[1] ?? "";
    const hits = [...src.matchAll(ROUTE)];
    for (const [i, m] of hits.entries()) {
      if (m[1] === "Get") continue;
      const block = src.slice(m.index!, hits[i + 1]?.index ?? src.length);
      const perm = /@RequirePermission\(([^)]*)\)/.exec(block)?.[1]?.trim() ?? "";
      if (!perm) continue;
      const path = ("/" + [prefix, m[2] ?? ""].filter(Boolean).join("/")).replace(/\/+/g, "/");
      out.push({ key: `${m[1].toUpperCase()} ${path}`, perm, stepUp: /@RequireStepUp\(/.test(block) });
    }
  }
  return out;
}

describe("step-up, within a single permission", () => {
  const all = routes();

  it("extracted a believable number of routes", () => {
    // A matcher that quietly matches nothing would pass for ever.
    expect(all.length).toBeGreaterThan(200);
    expect(all.filter((r) => r.stepUp).length).toBeGreaterThan(20);
  });

  it("is either applied to every route of that permission, or the exception is named", () => {
    const gated = new Set(all.filter((r) => r.stepUp).map((r) => r.perm));
    const offenders = all
      .filter((r) => !r.stepUp && gated.has(r.perm) && !(r.key in ALLOWED))
      .map((r) => `${r.key}  (shares ${r.perm} with a step-up-gated route)`);
    expect(offenders).toEqual([]);
  });

  it("gates the three that were the wrong way round", () => {
    // Named explicitly: these are the point of the file, and a future refactor
    // that drops one should fail here rather than in a sweep nobody runs.
    const byKey = new Map(all.map((r) => [r.key, r]));
    for (const key of [
      "POST /admin/users/:userId/roles",
      "DELETE /admin/users/:userId/roles/:roleName",
      "PUT /operator/tenants/:schoolId/users/:userId/mfa-required",
      "PUT /operator/tenants/:schoolId/roles/:roleName/mfa-required",
      "PUT /operator/tenants/:schoolId/subscription",
    ]) {
      expect([key, byKey.get(key)?.stepUp]).toEqual([key, true]);
    }
  });

  it("gives every exemption a reason somebody could disagree with", () => {
    for (const [route, why] of Object.entries(ALLOWED)) {
      expect([route, why.length > 30]).toEqual([route, true]);
    }
  });
});
