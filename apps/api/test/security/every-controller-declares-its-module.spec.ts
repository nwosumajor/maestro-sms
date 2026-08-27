// =============================================================================
// A paid module's controller that carries no entitlement tag is a free feature
// =============================================================================
// Module entitlement is the second gate above RBAC: `@RequireModule(MODULES.X)`
// at class level, resolved per school, 404 when the module is off. CLAUDE.md
// listed the deliberately ALWAYS-ON controllers as prose — "foundation/auth,
// security, privacy, notifications, admin dashboard, operator, billing" — seven
// categories against twenty-one untagged controller classes, and nothing checked
// it either way.
//
// The gap it hid: `MemberScanController` sat inside `certificate/` with no tag
// while `certificate.controller.ts` beside it carried one. CERTIFICATE is a
// PREMIUM add-on, so every school on the STANDARD tier got the ID-card scan desk
// for nothing. Tagging it breaks no one — a school without the certificate
// module has never had an ID card to scan, and no live school has a single
// `scan_event`.
//
// Most of the rest are genuinely always-on and always were: infrastructure
// (health, metrics), the auth and security spine, cross-cutting features with no
// module key at all (search, meetings, exam logistics, the directory), and the
// public surface, which has no school session to resolve an entitlement from.
// The point of this file is that each is now a DECISION with a reason rather
// than an absence indistinguishable from an oversight.
// =============================================================================

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const API_SRC = join(__dirname, "../../src");

const ALWAYS_ON: Record<string, string> = {
  // The CLASS is always-on and its authoring routes carry their own tag — see
  // the split pinned in the test below. Deciding a request the platform's own
  // maker-checker controls raised is part of the control spine; AUTHORING one
  // is the workflow engine sold as a PREMIUM feature.
  WorkflowController:
    "Approval decisions span modules a school may or may not have. Gating the whole controller on " +
    "MODULES.WORKFLOW left STANDARD schools able to RAISE five maker-checker requests and unable to see " +
    "or decide any of them. Authoring routes are tagged individually.",
  HealthController: "Liveness probe. No session, no tenant, no entitlement to resolve.",
  MetricsController: "Prometheus scrape, gated by METRICS_TOKEN rather than by a subscription.",
  AuthController: "Login and session refresh. A school must be able to sign in to discover it owes money.",
  SecurityController: "Step-up, MFA and privilege elevation — the security spine, which cannot be a paid extra.",
  PrivacyController: "NDPR data-subject rights. A family's right of access does not depend on a school's tier.",
  SchoolArchiveController: "Retention and archival — a legal obligation, not a feature.",
  ExemptionController:
    "Accessibility accommodations for integrity monitoring. CLAUDE.md is explicit that paste-blocking MUST have a per-student exemption or it becomes discriminatory; making that accommodation contingent on a paid module would be exactly the wrong way round.",
  NotificationController: "The inbox. Every module notifies through it, including the ones telling a school its subscription lapsed.",
  AdminController: "The admin dashboard and RBAC. A school must be able to manage its own people at any tier.",
  OperatorController: "The platform owner's console. It manages subscriptions and cannot depend on one.",
  LegalController: "Records that a school accepted the terms — a precondition of using the product, not a feature of it.",
  PublicController: "Unauthenticated: the directory, onboarding, invites and password resets. There is no school session to resolve an entitlement from.",
  LocalStorageController: "The DEV storage stub, registered only when STORAGE_PROVIDER is not s3.",
  MobileMoneyController: "Payment rails, including callbacks that arrive with no session. Money must reach a school whatever its tier.",
  AcademicProgressionController: "Term and session roll-over. A school must be able to move into next term at any tier; the register lock and report headers depend on it.",
  DirectoryController: "The people directory, shared by every module rather than belonging to one.",
  SearchController: "Global search, which includes only the categories the caller can already read.",
  AnnouncementsController: "School-wide announcements, part of the messaging floor included in every tier.",
  MeetingController: "Parent-teacher meetings — a cross-cutting feature with no module key of its own.",
  ExamController: "Exam logistics (sittings, seats, invigilators) — likewise no module key of its own.",
  ApprovalsController:
    "Already a recorded decision in the file itself: approvals span modules a school may or may not have, so gating the queue on any one of them would hide requests raised by another.",
  BillingController:
    "A school must be able to reach its own billing to pay — gating that on a subscription is the loop that cannot close.",
  BrandingController: "School branding, read by the login page before anyone has a session at all.",
  DashboardController: "The admin overview, listed as always-on in CLAUDE.md; it summarises whatever modules the school does have.",
  FeedbackController: "Feedback to the platform owner. A school that cannot use a module still needs to say so.",
  ComplianceController: "GDPR breach register and posture — a legal obligation like the rest of the privacy spine.",
  PublicDocumentsController: "Unauthenticated, authorised by a signed link; the family holding it has no school session to resolve an entitlement from.",
  PublicBiometricController: "Unauthenticated device ingestion, authorised by an HMAC signature rather than by a session.",
  PublicCareersController: "The public careers page. A candidate has no session and no tier.",
  ScholarshipController:
    "CLAUDE.md states it: scholarship is ALWAYS-ON, open to every plan, because it is a growth lever — a school on the entry tier is exactly the one whose families need a platform-funded bursary.",
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

interface Ctrl { cls: string; file: string; tagged: boolean }

function controllers(): Ctrl[] {
  const out: Ctrl[] = [];
  for (const file of walk(API_SRC)) {
    const src = readFileSync(file, "utf8");
    const lines = src.split("\n");
    for (const [i, l] of lines.entries()) {
      const m = /^export class (\w+Controller)\b/.exec(l);
      if (!m) continue;
      // The decorator run immediately above this class — NOT the whole file.
      // Several files hold two controllers, and one tag must not answer for the
      // other; that is exactly how the scan desk stayed untagged next to a
      // tagged sibling.
      let tagged = false;
      for (let j = i - 1; j >= 0; j--) {
        const t = lines[j].trim();
        if (!(t.startsWith("@") || t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t === "")) break;
        if (t.startsWith("@RequireModule(")) tagged = true;
      }
      out.push({ cls: m[1], file: file.slice(API_SRC.length + 1), tagged });
    }
  }
  return out;
}

describe("every controller", () => {
  const all = controllers();

  it("was found — the scan has not silently broken", () => {
    expect(all.length).toBeGreaterThan(50);
    expect(all.filter((c) => c.tagged).length).toBeGreaterThan(20);
  });

  it("either declares its module or is named always-on with a reason", () => {
    const offenders = all.filter((c) => !c.tagged && !(c.cls in ALWAYS_ON)).map((c) => `${c.cls}  [${c.file}]`);
    expect(offenders).toEqual([]);
  });

  it("keeps the workflow ENGINE paid and the DECISION always-on", () => {
    // The split, pinned route by route. Getting it wrong in either direction is
    // a real defect: gate the decision and a STANDARD school cannot finish a
    // control the product imposed on it; ungate authoring and the workflow
    // engine — a PREMIUM module — is free.
    const src = readFileSync(join(API_SRC, "workflow/workflow.controller.ts"), "utf8");
    // Bound by the next ROUTE decorator, not the next decorator of any kind:
    // `@RequireModule` sits on the line immediately below `@Post()`, so a naive
    // "to the next @" window closes before the thing being looked for. The same
    // bound-the-decorator-RUN lesson the public-routes gate already records.
    const ROUTE = /\n  @(?:Get|Post|Put|Patch|Delete)\(/g;
    const routeOf = (decorator: string) => {
      const i = src.indexOf(`\n  ${decorator}`);
      expect(i).toBeGreaterThan(-1);
      ROUTE.lastIndex = i + decorator.length + 3;
      const m = ROUTE.exec(src);
      return src.slice(i, m ? m.index : src.length);
    };
    // Authoring: PAID.
    for (const r of ['@Post()', '@Post(":id/submit")', '@Get("approvers")']) {
      expect(routeOf(r)).toMatch(/@RequireModule\(MODULES\.WORKFLOW\)/);
    }
    // Deciding and reading: ALWAYS-ON.
    for (const r of ['@Post(":id/review")', '@Post(":id/veto")', '@Get()', '@Get(":id")']) {
      expect(routeOf(r)).not.toMatch(/@RequireModule/);
    }
    // And no class-level tag, which would override every one of them.
    expect(src).not.toMatch(/@RequireModule\(MODULES\.WORKFLOW\)\n@Controller/);
  });

  it("gates the ID-card scan desk, which was a PREMIUM feature given away", () => {
    expect(all.find((c) => c.cls === "MemberScanController")?.tagged).toBe(true);
  });

  it("does not carry always-on entries for controllers that no longer exist", () => {
    // A stale exemption is a hole waiting for a name to be reused.
    const names = new Set(all.map((c) => c.cls));
    expect(Object.keys(ALWAYS_ON).filter((k) => !names.has(k))).toEqual([]);
  });

  it("gives every always-on entry a reason", () => {
    for (const [cls, why] of Object.entries(ALWAYS_ON)) {
      expect([cls, why.length > 40]).toEqual([cls, true]);
    }
  });
});
