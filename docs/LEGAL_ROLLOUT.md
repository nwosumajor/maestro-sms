# LEGAL & COMPLIANCE ROLLOUT PACK — MAESTRO-SMS (MajorGBN Innovations Limited)

**Status:** operational working document — internal only, not published to `/legal/*`.
**Companion to:** `docs/LEGAL.md` v1.0-draft (the five customer-facing documents).
**Owner:** MajorGBN founder/CEO until a DPO is designated.
**Last updated:** 2026-07-17

This pack covers the parts of the legal programme that software cannot do:
retaining counsel, resolving every open business decision (`[●]`) in
`docs/LEGAL.md`, registering with the NDPC, running a DPIA, and buying cyber
insurance. Work the sections in order — each produces the inputs the next needs.

> **What is already engineered** (for reference while briefing counsel):
> `/legal/privacy|dpa|refunds|terms|security` public pages generated from
> `docs/LEGAL.md`; a mandatory acceptance checkbox on school onboarding
> (version recorded on the request); an append-only `legal_acceptance` ledger
> per school; checkout audit entries stamped with the accepted version; and an
> in-app re-acceptance banner that fires fleet-wide whenever
> `LEGAL_DOCS_VERSION` in `@sms/types` is bumped. Counsel's edits therefore
> ship as: edit `docs/LEGAL.md` → regenerate `apps/web/content/legal.ts` →
> bump `LEGAL_DOCS_VERSION` → every school's billing admin must re-accept.

---

## 1. Decision sheet — every `[●]` in docs/LEGAL.md

Each row is a decision only the business or counsel can make. **Recommended**
values are defensible market-standard defaults for a Nigerian education SaaS at
this stage — adopt them unless counsel objects, so the review starts from a
complete draft rather than blanks. "Who" = who signs off (B = business,
C = counsel, T = technical fact you confirm).

### 1.1 Identity & scope (Privacy Policy header + §1)

| # | Doc § | Item | Recommended | Who | Notes |
|---|-------|------|-------------|-----|-------|
| 1 | Header | RC number | Your CAC registration number — copy from the certificate of incorporation | B | Must match CAC records exactly; mismatch undermines every document. |
| 2 | Header | Registered office | The CAC-registered address | B | If you operate elsewhere, list both ("registered office / operating address"). |
| 3 | Header | Effective date | The date counsel signs off, announced ≥14 days before enforcement for existing schools | C | New signups bind immediately; existing schools get the in-app banner + email notice period. |
| 4 | §1.6 | Hosting region | State the actual region when cloud infra goes live (Terraform targets AWS — e.g. `eu-west-1` until `af-south-1` is adopted) | T | NDPA cross-border transfer rules apply to any non-Nigeria region: rely on NDPC-recognised adequacy/contractual protections; counsel to confirm the current NDPC position on AWS regions. |
| 5 | §1.6 | Subprocessor list page | Publish `/legal/subprocessors` listing: AWS (hosting), Paystack (NGN payments), Stripe (USD payments), Resend or Postmark (email), Sentry (error telemetry), SMS/WhatsApp gateway when contracted | T | Small engineering task: a static page like the other legal pages. Do this before effective date — both the Privacy Policy and DPA point at it. |

### 1.2 Retention numbers (Privacy §1.8)

| # | Item | Recommended | Who | Notes |
|---|------|-------------|-----|-------|
| 6 | Post-termination recovery hold | **90 days** | C | Matches DPA §2.9 live-system deletion window; long enough for a school to reverse a mistaken cancellation. |
| 7 | Financial ledgers | **6 years** | C | Aligns with CAMA/FIRS record-keeping expectations; counsel to confirm the controlling statute wording. |
| 8 | Audit logs | **24 months** rolling, then delete (security-incident logs kept until the incident file closes) | B | Long enough for annual audits and incident forensics; bounded so the log store isn't an unbounded PII archive. |
| 9 | Unsuccessful applications (onboarding/admissions/jobs) | **12 months** | C | Standard recruitment-data practice; also the window for discrimination-claim exposure. |

### 1.3 DPA operational windows (§2)

| # | Doc § | Item | Recommended | Who |
|---|-------|------|-------------|-----|
| 10 | §2.4(e) | Direct assistance with data-subject requests | **10 business days** | B |
| 11 | §2.5 | Subprocessor change notice | **14 days** | C |
| 12 | §2.8 | Audit artefacts: "and certifications" | Delete the phrase until a certification exists (don't promise ISO 27001/SOC 2 you don't hold); reinstate when achieved | C |
| 13 | §2.9 | Export window / live deletion / backup deletion | **30 / 90 / 180 days** | B |
| 14 | Annex A §2 | Storage-level encryption | Confirm and state the mechanism when cloud goes live: AWS KMS (RDS + S3 customer-managed keys — already in the Terraform) | T |
| 15 | Annex A §6 | Backup frequency/retention | State actuals: **daily automated snapshots, 35-day retention** (RDS default ceiling) — set this in Terraform and the doc together | T |
| 16 | Annex A §7 | Background checks / training | Commit only to what you'll do: "identity and reference checks for staff with production access; annual security-awareness training" | B |

### 1.4 Refund Policy windows (§3)

| # | Item | Recommended | Who | Notes |
|---|------|-------------|-----|-------|
| 17 | First-purchase guarantee | **14 days** | B | Strong conversion lever; risk is bounded (first payment only, one per school). |
| 18 | Renewal refund window | **7 days** and before meaningful use | B | |
| 19 | Seat top-up forward-portion window | **7 days** | B | Arrears stay non-refundable — that's consumed service. |
| 20 | Unused credit-bundle refunds | **14 days** | B | |
| 21 | Gateway fees deducted from refunds? | **Are deducted** (state it plainly) | B | Paystack/Stripe don't return their fee on refund; absorbing it invites refund arbitrage. |
| 22 | Platform convenience fee returned on school-fee refunds? | **Is returned** when the underlying payment is refunded | B | Cleaner story ("we never profit from a reversed payment") and the amounts are small. |
| 23 | Escalation + billing contacts | `billing@majorgbn.com`, `support@majorgbn.com`, `privacy@majorgbn.com` | B | Create the three mailboxes before the effective date; they appear in four documents. |

### 1.5 MSA commercial terms (§4)

| # | Item | Recommended | Who | Notes |
|---|------|-------------|-----|-------|
| 24 | Withholding tax arrangements | "Where the School is required to withhold, it gross-ups so MajorGBN receives the invoiced amount net" — counsel to confirm enforceability | C | Common SaaS position in Nigeria; alternative is accepting WHT credit notes. |
| 25 | Breach cure period | **30 days** | C | |
| 26 | Availability target | **99.5% monthly** | B | Achievable on single-region ECS; don't promise 99.9% before multi-AZ is proven. |
| 27 | Maintenance notice | **48 hours** | B | |
| 28 | Support terms | "In-app and email support, business hours (WAT); Severity-1 (platform down) response within 4 business hours, others within 1 business day" | B | Promise response, never resolution times. |
| 29 | Service credits | 5% of the month's subscription fee per full 0.5% availability shortfall, capped at 25%, claimed within 30 days | B | Keeps credits the exclusive remedy — cheaper than damages exposure. |
| 30 | Status page | Defer: commit to "in-app incident notices" now; add a public status page URL when one exists | T | Don't reference a page that doesn't exist. |
| 31 | Disputes: arbitration vs courts | **Arbitration in Lagos** (Arbitration and Mediation Act 2023, sole arbitrator, English) | C | Faster and private; counsel to confirm the clause wording and appointing authority. |

### 1.6 Cyber Liability Addendum (§5)

| # | Item | Recommended | Who | Notes |
|---|------|-------------|-----|-------|
| 32 | Penetration testing | "Annual third-party penetration test, first within 12 months of the effective date" | B | Budget it (see §5 of this pack); the RLS/isolation test suite is a talking point but not a substitute. |
| 33 | Insurance minimum | **₦250,000,000 (~$150k) per claim** initially; scale with ARR (see §5) | B | State "once procured"; do not warrant cover you don't yet hold. |
| 34 | Post-incident report deadline | **15 business days** | B | |
| 35 | Credit monitoring | Replace with "reasonable identity-protection assistance where appropriate" — credit monitoring is not a mature product for Nigerian minors | C | |
| 36 | Assistance for school-caused incidents | "No charge up to 10 hours, then standard rates" | B | |
| 37 | Enhanced liability cap for data breaches | **2× trailing-12-month fees, floor ₦25,000,000** | C | The floor matters early, when 2× fees of a small school is trivial. |
| 38 | State-actor carve-out | Include a narrowly-drafted carve-out for attacks a reasonably-secured platform cannot prevent — counsel to draft | C | |
| 39 | RPO / RTO | **RPO 24h / RTO 24h** now (daily snapshots); improve to RPO 1h when point-in-time recovery is enabled and tested | T | Only publish numbers a restore drill has proven — run one first (see §7 checklist). |
| 40 | Disaster termination trigger | **5 business days** of continuous unavailability | B | |

---

## 2. Counsel engagement brief

**Who to retain:** a Nigerian firm or sole practitioner with demonstrable
NDPA 2023 / data-protection practice AND commercial-SaaS contract experience.
Ask specifically: "Have you registered a data controller of major importance
with the NDPC, and have you papered a B2B SaaS processing children's data?"
Both yes, or keep looking. (Firms active in this space cluster in Lagos and
Abuja; a licensed **DPCO** — Data Protection Compliance Organisation — can
cover the NDPC-facing work but not the contract drafting; some firms are both.)

**Scope of work (fixed-fee if possible):**
1. Review and mark up all five documents in `docs/LEGAL.md` against the NDPA
   2023, its GAID (General Application and Implementation Directive), CAMA,
   the FCCPA (consumer-protection angles of the Refund Policy), and the
   Arbitration and Mediation Act 2023.
2. Confirm or amend every decision-sheet value above (the `Who = C` rows are
   theirs; the `B` rows they sanity-check).
3. Advise on: children's-consent mechanics (guardian consent flows are built —
   are they NDPA-sufficient?); cross-border hosting; WHT gross-up; the
   state-actor carve-out; whether the enhanced breach cap is insurable as
   drafted.
4. Produce the final text as edits to `docs/LEGAL.md` (it is the single source
   of truth — the website is generated from it).
5. A short written opinion that the acceptance mechanism (onboarding checkbox +
   in-app re-acceptance banner + version ledger) forms a binding contract under
   Nigerian law, and whether any change category requires more than
   notice-and-continued-use.

**Inputs to hand them on day one:** `docs/LEGAL.md`; this pack with the
recommended column pre-filled by you; CAC certificate; the subprocessor list;
a one-page architecture summary (multi-tenant, RLS isolation, field-level
encryption, audit logging — lift from the DPA Annex A).

**Acceptance criteria for the engagement:** every `[●]` resolved; version
bumped to 1.0 (drop "-draft"); counsel confirms the effective-date notice plan;
you re-generate the site content and bump `LEGAL_DOCS_VERSION`.

---

## 3. NDPC registration walkthrough (NDPA 2023)

> **Why this is mandatory, not optional:** the NDPA (s.44) requires **data
> controllers and processors of major importance** to register with the Nigeria
> Data Protection Commission. The NDPC's guidance classifies controllers by
> processing volume and sensitivity. MAESTRO-SMS processes **children's data,
> health (medical) data, and financial data at multi-school scale** — on any
> reading this lands in the major-importance regime (likely the highest level,
> UHLC — Ultra-High Level) once even a handful of schools are live. Verify the
> current thresholds and fee schedule on **ndpc.gov.ng** at filing time; they
> have been revised before.

**Sequence:**

1. **Designate a DPO first** (registration asks for one). See §4 below.
2. **Classify yourself.** Count data subjects across all tenants (students +
   guardians + staff). Document the count and the categories (children,
   health, financial) — the classification drives the fee band and audit duty.
3. **Register on the NDPC portal** (ndpc.gov.ng). You will need: CAC
   documents, DPO details, processing categories/purposes, data-subject counts,
   security-measures summary (lift from DPA Annex A), and the registration fee
   for your band.
4. **Annual compliance audit returns (CAF).** Controllers of major importance
   file an annual data-protection audit, prepared by a **licensed DPCO**, by
   the NDPC's deadline (historically 31 March for the prior year). Budget for
   the DPCO engagement annually. If you retain a DPCO as outsourced DPO (§4),
   bundle both.
5. **Keep evidence current:** the DPIA (§6), the records-of-processing summary,
   breach-response runbook, and the subprocessor list are what a DPCO audit
   will ask for. All of them exist or are templated in this pack.

**Renewal:** registration is annual. Put both the renewal and the audit-return
deadline in the operational calendar (§7).

---

## 4. DPO designation brief

The NDPA requires a controller of major importance to designate a **Data
Protection Officer**. Options:

| Option | Fit | Cost shape |
|--------|-----|-----------|
| Founder self-designates | Legal only if they can act without conflict; NDPC guidance expects adequate knowledge — defensible at pre-scale, weak once schools multiply | Free |
| Trained internal staff member | Good from ~10+ schools; send them on an NDPC-recognised certification | Salary + training |
| **Outsourced DPO via a licensed DPCO** | **Recommended now**: instant credibility with the NDPC, bundles the annual audit duty, scales down cost | Monthly retainer |

Whichever route: publish the DPO's name and `privacy@majorgbn.com` in Privacy
Policy §1.12 (decision-sheet row 23), give them authority to halt a launch on
data-protection grounds (minute this), and route the breach runbook's
"notify NDPC within 72 hours" decision through them.

---

## 5. Cyber liability insurance — procurement brief

**Why before scale:** the Addendum (§5.7) promises an enhanced liability cap
for breaches. Uninsured, that promise is your balance sheet. The children's-
data angle makes uninsured operation genuinely reckless past the first few
paying schools.

**Coverage checklist (first-party):** incident response & forensics costs;
data-subject and regulator notification costs; data restoration; business
interruption; cyber extortion/ransomware response; social-engineering fraud
(payment-diversion) rider if available.

**Coverage checklist (third-party):** privacy liability (claims by schools,
guardians, data subjects); network security liability; regulatory
defence costs and fines **to the extent insurable under Nigerian law**
(counsel to confirm NDPA-fine insurability); contractual liability extension
covering the DPA/Addendum obligations (underwriters will ask to read them —
send `docs/LEGAL.md`).

**Limits:** start at **₦250m per claim / ₦500m aggregate** (matches
decision-sheet row 33); revisit at every 3× ARR growth or 50-school milestone.

**Where to buy:** a broker with Nigerian cyber capacity (the cyber lines in
Nigeria are typically fronted locally and reinsured via London/continental
markets). Ask the broker to quote at least two markets.

**What underwriters will ask — prepare a pack:** MFA everywhere (yes — TOTP +
step-up re-auth), encryption at rest/in transit (yes — field-level AES-256-GCM
+ TLS), backups (state the Terraform reality), least-privilege and audit
logging (yes), tested incident-response plan (write the runbook first — §7),
penetration-test report (schedule one — decision row 32; some markets quote
without it but load the premium), prior incidents (none), revenue and data-
subject counts. The security posture here is unusually strong for the stage —
make the underwriter read the DPA Annex A; it moves premium.

---

## 6. DPIA starter — children's data (NDPA s.28-style impact assessment)

The NDPA expects an impact assessment where processing is likely to result in
high risk — children's data at scale qualifies. This starter enumerates the
processing; the DPO/DPCO completes likelihood/severity scoring and signs it.

**Format per operation:** what & why → risk → mitigations already built →
residual actions.

1. **Student identity, academic & attendance records** (core SIS/LMS).
   *Risk:* cross-tenant leakage; excessive internal access. *Built:* 3-layer
   tenant isolation (JWT → guard → Postgres RLS) with a CI coverage gate;
   relationship scoping (teacher→their classes, parent→their children);
   404-not-403; full audit logging of PII reads/writes. *Residual:* periodic
   access-recertification (the `/admin/recertification` report exists — put a
   termly review in the calendar).
2. **Medical records & emergency contacts.** *Risk:* special-category exposure.
   *Built:* AES-256-GCM field encryption with per-tenant HKDF keys; step-up
   re-auth on edits; reads audited. *Residual:* key-rotation procedure —
   document it (engineering task).
3. **Assessment-integrity telemetry** (paste/focus/typing signals on minors).
   *Risk:* covert surveillance; automated punishment. *Built:* signals-only
   (human review, never a verdict — Golden Rule #8); per-student accessibility
   exemptions; per-school retention window with an automated purge job;
   consent-gated; disclosed in the Privacy Policy. *Residual:* confirm each
   school's enrollment paperwork actually discloses monitoring (school-side
   duty — MSA §5.3 covers it; add to the onboarding email template).
4. **Guardian-consent flows** (cross-school games, scholarships). *Built:*
   two-tier consent (school + guardian), audit-logged; pseudonymous handles
   only across tenant boundaries. *Residual:* counsel confirms NDPA-sufficiency
   of the consent UX (§2 scope item 3).
5. **Payments & billing** (guardian card payments, saved-card tokens).
   *Risk:* financial-data exposure. *Built:* gateway-hosted card entry (PAN
   never touches the platform); saved-card authorization tokens field-encrypted;
   append-only ledgers; maker-checker on refunds/large postings; webhook
   signature verification + idempotency. *Residual:* none beyond insurance (§5).
6. **Staff HR data** (salaries, bank details, biometric-attendance events).
   *Built:* field encryption; salary maker-checker; biometric templates never
   stored (events only, HMAC-signed devices); staff self-service NDPR
   export/erasure. *Residual:* none identified.
7. **Messaging/community content involving minors.** *Built:* participant
   scoping; non-staff may only message staff. *Residual:* moderation/abuse-
   report route — confirm the discipline-room flow is referenced in school
   onboarding guidance.
8. **Cross-border transfer** (if hosting outside Nigeria). *Residual:* tie to
   decision-sheet row 4; DPO documents the transfer basis.

**Sign-off block:** DPO name/date; review cadence **annually and on any new
category of processing** (a new module touching student data = a DPIA delta).

---

## 7. Launch checklist & operational calendar

**Before the effective date (in order):**
- [ ] Create `privacy@`, `billing@`, `support@` mailboxes (row 23).
- [ ] Pre-fill this pack's recommended values; retain counsel (§2).
- [ ] Designate the DPO (§4) — needed by both counsel and NDPC steps.
- [ ] Publish `/legal/subprocessors` (row 5 — small engineering task).
- [ ] Counsel returns final text → edit `docs/LEGAL.md`, regenerate
      `apps/web/content/legal.ts`, bump `LEGAL_DOCS_VERSION`, set the
      effective date, deploy. Existing schools see the re-acceptance banner;
      give the promised ≥14-day notice by email before enforcing.
- [ ] NDPC registration filed (§3).
- [ ] Write the breach-response runbook (who declares an incident; DPO's
      72-hour NDPC decision; school-notification template; evidence
      preservation). Run one tabletop drill.
- [ ] Run and document one backup **restore drill** (validates the RPO/RTO you
      publish — row 39).
- [ ] Broker engaged for cyber insurance; bind cover (§5).

**Recurring:**
| Cadence | Item |
|---------|------|
| Annually | NDPC registration renewal + DPCO audit return (verify deadline, historically 31 Mar) |
| Annually | Penetration test (row 32) → summary into the DPA §2.8 artefact set |
| Annually | DPIA review + insurance limit review |
| Termly | Access-recertification review per school (report exists in-app) |
| On every legal edit | Regenerate site content + bump `LEGAL_DOCS_VERSION` (material changes: email notice too) |
| On every new subprocessor | Update `/legal/subprocessors` + 14-day notice (row 11) |
