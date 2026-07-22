# Onboarding flow upgrade

> Public onboarding: client picks plan+modules, owner alerted in-app, Approve & provision pre-fills the tenant form + auto-APPROVEs + welcomes admins; live-verified 2026-07-13, UNCOMMITTED

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

Closed the three gaps in the request-onboarding pipeline (user-requested):
1. **Client module choice**: `onboarding_request` gained `desiredPlan`/`desiredModules`
   (migration `20260713000000_onboarding_module_choice`); public form has a plan
   select + add-on module checkboxes (same plan/overrides model as provisioning);
   intake sanitises with isPlan/isModuleKey (bogus keys dropped server-side).
2. **Owner alerted**: intake fires `NotificationService.enqueue` per super_admin —
   platform-org lookup first, PRIVILEGED global fallback (this DB's owner lives in
   St. Andrews, not the platform org). TWO traps hit: (a) audit actorId is FK'd to
   a real user → use the RECIPIENT as actor for system events (never the ZERO
   uuid — rolls back the whole notification tx); (b) super_admin lacked
   `notification.read` → seeded (+ operator GET /notifications now 200; nav
   already had notifications in PLATFORM_OWNER_NAV).
3. **Approve & provision**: OnboardingRequests button routes to
   `/operator?provision=<id>`; the page passes a `prefill` prop (keyed) into
   `Provisioning` (school name, slug, contact→school_admin, plan, extras);
   POST /operator/tenants accepts `onboardingRequestId` → flips the request
   APPROVED ("Provisioned as <slug>") and sends founding admins an in-app
   welcome (login URL + first-login reset note).

Also fixed this session: 18 earlier migrations (2026-08-dated, LMS+HR programs)
existed in the DB but not the ledger — `prisma migrate resolve --applied` ×18
(+ the failed 20260805_lms_progress record). `prisma migrate deploy` is clean now.

Verified live end-to-end incl. sanitisation, auto-approve, welcome + owner
notifications; route smoke owner+admin green; test tenant/requests deleted.
UNCOMMITTED. Follow-up idea: email channel for the requester (external email —
the welcome notification currently reaches only the created in-app accounts).

**Comprehensive intake (same day, follow-up request):** the form moved to the
dedicated public `/onboard` page (homepage #onboard section is now a CTA card
linking to it). `onboarding_request` gained 10 profile columns (migration
`20260713010000_onboarding_details`): schoolType/address/city/state/country/
website/studentCount/staffCount/contactRole/currentSystem. Zod REQUIRES type,
full location, both counts, contact role + phone (public POST contract changed —
the form is the only client). Shared vocab `ONBOARDING_SCHOOL_TYPES` /
`ONBOARDING_CONTACT_ROLES` in `@sms/types/dto/public.ts` (form selects + API
enum validation from one source). The form is sectioned (About/Location/Size/
Contact/Plan/Anything else), has the 36-states+FCT select when country=Nigeria,
and shows a LIVE ₦/month estimate (students × tier per-seat rate from
`/api/public/plan-pricing` — never hardcoded). Owner alert body now carries
plan + ~students + city/state; operator card shows the full profile. Verified:
incomplete submit → 400 with field list; full submit → 201, alert
"(PREMIUM plan, ~850 students, Ikeja, Lagos)", queue row complete; /onboard +
homepage render; owner route smoke green. Test rows deleted.
