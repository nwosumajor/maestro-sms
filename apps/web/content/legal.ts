// AUTO-DERIVED from docs/LEGAL.md — regenerate with the script in that file's
// commit history when the source changes, and bump LEGAL_DOCS_VERSION in
// @sms/types on any MATERIAL change (drives clickwrap re-acceptance).

export interface LegalDoc { slug: string; title: string; body: string }

export const LEGAL_DOCS: LegalDoc[] = [
  {
    slug: "privacy",
    title: "Privacy Policy",
    body: `## 1. Privacy Policy

### 1.1 Who we are and the two roles we play

MajorGBN operates MAESTRO-SMS, a school management platform used by schools ("Schools") to run admissions, teaching, attendance, fees, HR and related functions. Understanding **who is responsible for your data** depends on which of two roles we are playing:

- **Processor role (most data on the Platform).** For data a School enters or collects about its students, parents/guardians, staff and applicants ("School Data"), the **School is the data controller** and MajorGBN is a **data processor** acting on the School's instructions under the Data Processing Agreement (Section 2). Requests about this data (access, correction, deletion) should be directed to the School; the Platform gives Schools built-in tools to honour them.
- **Controller role.** For data we collect for our own purposes — School account and billing records, platform staff accounts, website visitors, public onboarding requests, agent/referral records, and operational logs — **MajorGBN is the data controller**.

### 1.2 The data we process

| Category | Examples | Source |
|---|---|---|
| Student records (incl. **children**) | Name, class, guardianship links, attendance, grades, report cards, admission applications, medical & emergency contact information, hostel/transport/library records, CBT results | Entered by School staff; some by guardians via admissions |
| Assessment-integrity telemetry (children) | Paste/focus/typing signals, draft history — **signals for human review only, never automated verdicts** | Generated during assessments, per-assignment/per-student toggles and accessibility exemptions |
| Parent/guardian data | Name, email, phone, children links, fee invoices and payments, messages | School staff and guardians themselves |
| Staff data | Employment records, payroll (salaries **encrypted at rest**), leave, appraisals, attendance | School HR |
| Account & billing data (our controller role) | Admin contact details, subscription plan, seat counts, payment references, saved-card *authorization tokens* (encrypted; we never store card numbers), message-credit balances | Schools; payment gateways |
| Public forms | School onboarding requests, admission applications, job applications (CVs) | The individuals submitting them |
| Technical data | Request logs with pseudonymous IDs, audit trails (actor, action, entity, timestamp), device/browser info | Automatic |

**What we deliberately do not hold:** full card numbers (Paystack/Stripe hold them; we store only gateway references, last-4 digits and encrypted reusable authorization tokens), full settlement bank account numbers (bank + last 4 digits only), biometric templates (attendance devices send signed events, never templates), and raw keystroke content (only derived metrics).

### 1.3 Children's data

Most students are minors. We treat all student records — including behavioural/integrity telemetry — as sensitive:

- Schools (as controllers) are responsible for obtaining **parental/guardian consent** where the NDPA requires it; the Platform enforces guardian-consent gates in features that need them (e.g. cross-school competitions, platform scholarships) and records every consent with an audit trail.
- Integrity monitoring is **disclosed, never covert**, produces signals for teacher review only, and honours per-student accessibility exemptions.
- Children's names never cross school boundaries: cross-school features use handles, and the arena tables carry no PII.
- Telemetry on minors is **retention-bounded**: purged on a per-school schedule (default 365 days, School-configurable) by an automated job.

### 1.4 Lawful bases

Depending on context: **performance of a contract** (running the School's subscription and the services parents/staff use), **consent** (guardian consents, optional channels like WhatsApp/SMS to a number you provide), **legal obligation** (financial record-keeping, tax), and **legitimate interests** (platform security, fraud prevention, service improvement) balanced against data-subject rights — never as a basis for children's marketing, which we do not do.

### 1.5 How data is used

To provide the services a School has enabled; to process payments and subscriptions; to send transactional notifications (in-app always; email/SMS/WhatsApp per the School's configuration and your provided contact details); to keep the Platform secure (authentication, MFA, anomaly and audit review); to comply with law; and to produce **aggregate, non-identifying** statistics. We do **not** sell personal data, use it for third-party advertising, or train AI models on School Data.

### 1.6 Who we share data with (subprocessors)

Only as needed to run the Platform, under contracts consistent with our DPA:

| Provider | Purpose | Data |
|---|---|---|
| Cloud hosting (AWS ECS/RDS/ElastiCache or equivalent) | Compute, database, cache | All Platform data (encrypted in transit; sensitive fields encrypted at rest) |
| S3 / Cloudflare R2 | Document vault (report cards, receipts, CVs) | Uploaded files, via short-lived signed URLs |
| Paystack | NGN payments, settlement split to School banks, refunds | Payer email, amounts, references |
| Stripe | USD subscription payments | Payer email, amounts, references |
| Twilio (when enabled) | SMS/WhatsApp delivery | Recipient phone, message content |
| Resend/Postmark (when enabled) | Email delivery | Recipient email, message content |
| Sentry (when enabled) | Error monitoring | Request context on server errors (auth headers redacted) |

The live list is published at \`[/legal/subprocessors]\` and Schools are notified of changes per the DPA. Data is hosted in \`[region — e.g. AWS af-south-1/eu-west-1 ●]\`; any cross-border transfer follows NDPA transfer rules.

### 1.7 Security

Defence in depth, verified by automated tests on every change: three-layer tenant isolation (JWT claim → application guard → PostgreSQL Row-Level Security) so one School can never read another's rows; TLS in transit; AES-256-GCM field-level encryption with per-tenant derived keys for the most sensitive fields (medical records, salaries, bank details, saved-card tokens); bcrypt password hashing; TOTP MFA and step-up re-authentication for high-risk actions; permanent lockout after repeated failed logins; least-privilege database roles (the application cannot drop or truncate tables); comprehensive audit logging of every mutation and every read of sensitive records; separation-of-duties (maker-checker) on money movements; and no secrets in code.

### 1.8 Retention

School Data is retained while the School's contract is active. On termination, Schools may export their data; we retain it for \`[90 ●]\` days for recovery, then delete it (statutory financial records excepted). Integrity telemetry purges on the per-school window (§1.3). Financial ledgers (invoices, payments, subscription payments, commission and credit ledgers) are append-only and retained per statutory periods (\`[6 years ●]\`). Audit logs: \`[●]\`. Unsuccessful onboarding/admission/job applications: \`[12 months ●]\`.

### 1.9 Your rights

Under the NDPA you may request access, correction, deletion, restriction, portability, and withdraw consent. **For School Data, contact your School** — the Platform gives Schools an audited data-export bundle and a governed right-to-erasure workflow to fulfil these requests; staff have self-service export/erasure of their personal HR fields. For data controlled by MajorGBN, contact \`[privacy@●]\`. You may complain to the NDPC. We respond within statutory timelines (NDPA: without undue delay).

### 1.10 Cookies, breach notice, changes, contact

We use strictly-necessary session cookies (authentication) and a local theme preference; no third-party advertising cookies. Personal-data breaches are handled per §5 (containment, NDPC notification within 72 hours where required, and notice to affected Schools/individuals without undue delay). Material changes to this policy are notified in-app and by email with a fresh effective date; continued use after notice constitutes acceptance where consent is not required. **Contact / DPO:** \`[name, privacy@●, address]\`.`,
  },
  {
    slug: "dpa",
    title: "Data Processing Agreement",
    body: `## 2. Data Processing Agreement (DPA)

*This DPA forms part of the Master Service Agreement between MajorGBN Innovations Limited (the "Processor") and the subscribing School (the "Controller") and is entered into on acceptance of the MSA.*

### 2.1 Subject matter, duration, nature and purpose

The Processor processes School Data solely to provide the Platform services described in the MSA, for the duration of the School's subscription plus the §2.9 deletion window. Processing operations: storage, retrieval, display to authorised users, computation (grades, attendance, billing), transmission of notifications, backup, and deletion.

### 2.2 Categories of data subjects and data

Data subjects: students (including children), parents/guardians, School staff, applicants (admissions and employment). Data categories: as listed in Privacy Policy §1.2, including **sensitive data** (children's records, medical information, and — where a School enables the HR module — payroll and identification data).

### 2.3 Controller obligations

The Controller warrants that it: has a lawful basis for all School Data it submits; provides required notices to and obtains required consents from data subjects (**including parental consent for children** where the NDPA requires it); configures the Platform's consent, retention and module settings consistently with its own policies; and issues only lawful processing instructions.

### 2.4 Processor obligations

The Processor shall: (a) process School Data **only on the Controller's documented instructions** (the MSA, this DPA, and in-product configuration constitute such instructions), unless required by law — in which case it informs the Controller unless prohibited; (b) ensure persons authorised to process are bound by **confidentiality**; (c) implement the technical and organisational measures in **Annex A**; (d) respect the conditions in §2.5 for subprocessors; (e) taking into account the nature of processing, **assist the Controller** with data-subject requests through the Platform's built-in export/erasure tooling and, where that is insufficient, direct assistance within \`[10 ●]\` business days; (f) assist with the Controller's NDPA obligations on security, breach notification and impact assessments; (g) at the Controller's choice, **delete or return** all School Data per §2.9; and (h) make available information necessary to demonstrate compliance and allow **audits** per §2.8.

### 2.5 Subprocessors

The Controller grants general authorisation for the subprocessors listed at \`[/legal/subprocessors]\` (Privacy Policy §1.6). The Processor: gives at least \`[14 ●]\` days' notice of additions/replacements (in-app and email to billing contacts); imposes data-protection obligations no less protective than this DPA by contract; and remains fully liable for subprocessor performance. The Controller may object on reasonable data-protection grounds; if no alternative is workable, the Controller may terminate the affected services with a pro-rata refund of prepaid unused fees.

### 2.6 Security

Annex A applies. The Processor shall not degrade the overall security posture during the term. Where the Controller enables optional channels (SMS/WhatsApp/email), the Processor transmits the minimum content needed through the contracted gateway.

### 2.7 Personal-data breach

The Processor notifies the Controller **without undue delay and within 72 hours** of becoming aware of a personal-data breach affecting School Data, with the information reasonably available (nature, categories and approximate numbers, likely consequences, measures taken/proposed, contact point), supplemented as investigation proceeds — per the incident process in the Cyber Liability & Security Addendum (§5). The Controller is responsible for its own notifications to the NDPC and data subjects for data it controls; the Processor assists.

### 2.8 Audit

The Processor makes available: this DPA, the security Annex, subprocessor list, summaries of penetration tests / security reviews \`[and certifications ●]\`. No more than once per year (or after a material breach), the Controller may audit compliance via written questionnaire, and — where reasonably required — an on-site/remote inspection at mutually agreed times, at the Controller's cost, under confidentiality, and without access to other Schools' data (tenant isolation is enforced at the database layer and cannot be suspended for audit).

### 2.9 Return and deletion

On termination, the Controller may self-export School Data (structured export bundle plus document files) for \`[30 ●]\` days. Thereafter the Processor deletes School Data within \`[90 ●]\` days from live systems and within \`[180 ●]\` days from backups, except records the Processor must retain by law (e.g. financial ledgers), which remain protected by this DPA until deletion.

### 2.10 Liability and order of precedence

Liability under this DPA is subject to the MSA's limitations except where the NDPA does not permit limitation. On conflict: NDPA/mandatory law → this DPA → MSA.

### Annex A — Technical and Organisational Measures

1. **Tenant isolation:** every tenant-scoped table carries a non-null school identifier enforced at three layers — signed JWT claim, application permission guard, and PostgreSQL Row-Level Security with forced policies; isolation is proven by an automated cross-tenant test for **every** RLS-enabled table, gated in CI.
2. **Encryption:** TLS ≥1.2 in transit; AES-256-GCM field-level encryption with per-tenant HKDF-derived keys for medical, payroll, bank and saved-card token fields; storage-level encryption at rest \`[cloud KMS ●]\`; bcrypt password hashing; documents via short-lived signed URLs.
3. **Access control:** data-driven RBAC (17 roles, fine-grained permissions), relationship scoping (teachers→their classes, parents→their children), MFA (TOTP), step-up re-authentication for high-risk actions, permanent lockout on brute force, 30-day forced password rotation, just-in-time privilege elevation with separation of duties and a non-elevatable permission set.
4. **Accountability:** append-only audit log of every mutation and of reads of sensitive records (actor, action, entity, tenant, timestamp); maker-checker on large payments and all refunds; append-only financial ledgers with no hard-delete.
5. **Operations:** least-privilege DB roles (no DROP/ALTER/TRUNCATE for the app role; migrations under a separate role); secrets via environment/secret manager, never code; structured logging with credential redaction; error monitoring with auth-header redaction; rate-limited authentication; WAF at the edge \`[when deployed on the reference cloud architecture]\`; daily automated jobs for retention purge and billing hygiene.
6. **Resilience:** automated backups \`[frequency/retention ●]\`; infrastructure as code; container-based deploys with one-off migration tasks.
7. **People:** confidentiality undertakings for staff; access on least-privilege; \`[background checks / training cadence ●]\`.`,
  },
  {
    slug: "refunds",
    title: "Refund Policy",
    body: `## 3. Refund Policy

*Applies to payments made **to MajorGBN** (subscriptions, seat top-ups, message credits). Payments made **to a School** through the Platform (school fees, admission form fees) belong to the School — see §3.5.*

### 3.1 Platform subscriptions

- **Activation is immediate** on successful payment, and the paid period runs to its stated end date.
- **14-day first-purchase guarantee:** a School's **first** subscription payment is refundable in full within \`[14 ●]\` days of payment if the School stops using the paid modules — measured from payment to written request. Renewals are not covered by this guarantee.
- **Renewals (including auto-renew):** refundable in full if requested within \`[7 ●]\` days of the charge **and** before meaningful use of the new period; otherwise the "no-deletion downgrade" applies instead of refunds — cancel any time, keep full access to the end of the paid period, then the School continues on the free Standard floor with all data intact.
- **Auto-renew mischarges** (e.g. charged after a cancellation request logged before the charge date): refunded in full.
- **Duplicate charges** (two successful charges for the same reference/period): the duplicate is refunded automatically once identified, or on request.
- **Mid-cycle upgrades:** the unused value of the old plan is **credited automatically at checkout** (proration) — that credit is the remedy; the superseded period is not separately refundable.
- **Seat top-ups & metered seat arrears:** charges for seats already used (arrears) are **non-refundable** — they pay for consumed service. The forward portion of a top-up is refundable pro-rata only if the added students are removed within \`[7 ●]\` days of the top-up.

### 3.2 Message credits

Credit bundles are **non-refundable once any credit from the bundle has been consumed**; wholly unused bundles are refundable within \`[14 ●]\` days of purchase. Credits never expire while the School has an active subscription and survive plan changes. Credits are not redeemable for cash.

### 3.3 Promotions, referral rewards, agent-attributed sales

Promo discounts and referral term rewards have **no cash value** and are not refundable or exchangeable. Where a discounted first payment is refunded under §3.1, the promo use is released and any referral/commission triggered by that payment is reversed.

### 3.4 How refunds are processed

Requests: in writing from a billing-authorised School administrator to \`[billing@●]\` with the payment reference. Approved refunds go **to the original payment method** via the gateway within **7–14 business days** of approval (bank processing may add time). Gateway transaction fees already levied by Paystack/Stripe \`[are / are not ●]\` deducted. Refunding a payment reverses everything that payment purchased (period extension, seats, credits) — never the School's data. **Chargebacks:** please contact us first; an unexplained chargeback on a delivered service may suspend the affected paid modules (never data access for export) pending resolution.

### 3.5 Payments made to Schools (fees, admission forms)

School fees and admission-form fees are collected **on behalf of the School** and settle to the School's own bank account; refund decisions belong to the School's own policy. The Platform supports the School operationally: refunds require a second approver (maker-checker), approved card refunds are pushed back to the payer's original card via the gateway where supported, and overpayments (e.g. two guardians paying the same invoice) are automatically flagged to the School's finance staff as refund-due. The **platform convenience fee** on a refunded school payment \`[is / is not ●]\` returned. Complaints unresolved by a School may be escalated to \`[support@●]\`; MajorGBN may facilitate but is not the merchant for these payments.`,
  },
  {
    slug: "terms",
    title: "Master Service Agreement",
    body: `## 4. Master Service Agreement (MSA)

*Between MajorGBN Innovations Limited and the subscribing School. Accepted electronically by an authorised School representative at onboarding or first checkout. The DPA (§2), Refund Policy (§3), Cyber Addendum (§5) and Privacy Policy (§1) are incorporated by reference.*

### 4.1 Definitions (abridged)

"**Platform**": MAESTRO-SMS and related services. "**Modules**": functional units (27 at this version) enabled per the School's plan and add-ons. "**Active Student**"/"**Seat**": a distinct user account holding the student role in the School's tenant — the single billing definition used everywhere. "**School Data**": data the School and its users submit, per the DPA. "**Authorized Users**": individuals the School provisions (staff, students, parents).

### 4.2 The services

MajorGBN provides the Platform as a subscription service: hosting, the Modules included in the School's plan (plus purchased add-ons), in-app support tooling, and updates. Plan tiers, bundled Modules and pricing are shown on the pricing page and in-app; the tier the School purchased is never reduced by us during a paid period. New Modules may be added to tiers over time.

### 4.3 The School's account and responsibilities

The School shall: (a) provision and manage its Authorized Users and keep account credentials confidential (MFA is available and recommended for staff; the Platform enforces password rotation and lockout); (b) use the Platform lawfully and per the Acceptable Use rules (§4.8); (c) ensure the accuracy of School Data and its authority to submit it, including all parent/guardian consents (DPA §2.3); (d) promptly deactivate users who leave; and (e) be responsible for acts and omissions of its Authorized Users.

### 4.4 Fees, billing and taxes

- **Per-seat pricing:** fees = Active Students × the tier's per-seat rate × the billing cycle (monthly / per-term (3 months, 5% discount) / per-year (9 billed months, 15% discount)), in NGN (Paystack) or USD (Stripe; Enterprise is USD-billed). Rates current at each checkout apply; operator price changes never affect an already-paid period.
- **Seat growth:** students added mid-period are metered daily above the billed seat count ("seat arrears") and are payable via voluntary top-up or **automatically added to the next renewal charge**. Billed seats are a floor; roster reductions take effect at the next renewal.
- **Auto-renew** (optional): the School may authorise charges to a saved card captured from its own successful payment; it may disable auto-renew at any time before a charge.
- **Late/no payment:** the paid period ends → renewal reminders → past-due status → after the grace period (\`7\` days, School-specific extensions possible) the tenant continues on the free Standard floor. **No data is ever deleted for non-payment**; full access is restored immediately on payment.
- **Collections take-rate:** where the School uses online fee collection, the disclosed platform convenience fee per transaction applies (School chooses payer-borne or school-borne). **Taxes:** fees are exclusive of VAT/levies, which the School bears where applicable; withholding arrangements \`[●]\`.

### 4.5 Term, suspension and termination

The MSA runs from acceptance until terminated. Either party may terminate for convenience effective at the end of the current paid period (no mid-period refunds except per §3). Either party may terminate for material breach uncured \`[30 ●]\` days after written notice. MajorGBN may suspend (not delete) a tenant for: serious security risk, unlawful content or use, or fraud — with notice and the minimum scope/duration practicable. On termination: export window and deletion per DPA §2.9.

### 4.6 Intellectual property

MajorGBN owns the Platform and all improvements. The School owns School Data and grants MajorGBN the licence needed solely to provide the services. Feedback may be used to improve the Platform. Aggregated, de-identified statistics that cannot identify any School or person may be used to operate and improve the Platform.

### 4.7 Service levels and support

Target availability: \`[99.5% ●]\` monthly, excluding scheduled maintenance (announced ≥\`[48h ●]\` ahead, off-peak where practicable) and force majeure. Support: \`[channels, hours, response targets by severity ●]\`. Service credits \`[●]\` are the exclusive remedy for availability shortfalls. Status page: \`[●]\`.

### 4.8 Acceptable use

No: unlawful, infringing or harmful content; attempts to breach tenant isolation or probe other Schools' data; credential sharing; abusive load or scraping; use of messaging credits for spam or non-school communication; resale without written agency terms; interference with metering, billing or integrity mechanisms. Violations may trigger §4.5 suspension.

### 4.9 Warranties and disclaimers

Each party warrants authority to contract. MajorGBN warrants the services will materially conform to their documentation and be provided with reasonable skill and care. **Otherwise the Platform is provided "as is"; implied warranties are disclaimed to the maximum lawful extent.** The Platform supports — but does not replace — the School's own educational, safeguarding, financial and legal judgment (e.g. integrity signals require human review; auto-marked CBT scores are for staff review).

### 4.10 Indemnities

MajorGBN indemnifies the School against third-party claims that the Platform (unmodified, as provided) infringes IP rights, with the usual remedies (procure the right, modify, or terminate + pro-rata refund). The School indemnifies MajorGBN against claims arising from School Data, missing consents/notices, or unlawful use by its Authorized Users.

### 4.11 Limitation of liability

Neither party is liable for indirect, consequential, special or punitive damages, or loss of profits/revenue/goodwill. Each party's total aggregate liability is capped at the **fees paid by the School in the 12 months preceding the claim** — except for: the School's payment obligations, either party's indemnities, breaches of confidentiality, gross negligence/wilful misconduct, and liability that cannot lawfully be limited. An enhanced cap for data-protection/security claims may apply per §5.6.

### 4.12 General

Confidentiality (mutual, 5 years); force majeure; assignment only with consent (except corporate reorganisation); notices in-app + email to billing contacts; entire agreement; severability; no waiver; amendments per §6 (versioned, notified, re-accepted where material). **Governing law: Federal Republic of Nigeria. Disputes:** good-faith negotiation (30 days) → arbitration in Lagos under the Arbitration and Mediation Act 2023, one arbitrator, English language \`[or courts of Lagos State ●]\`.`,
  },
  {
    slug: "security",
    title: "Cyber Liability & Security Addendum",
    body: `## 5. Cyber Liability & Security Addendum

*Part of the MSA. Allocates security responsibilities and liability for cyber incidents between MajorGBN and the School.*

### 5.1 Purpose

School platforms hold sensitive data about children. This Addendum states what each party is responsible for securing, how incidents are handled, and how cyber-related liability is allocated — so that responsibility follows control.

### 5.2 MajorGBN's security commitments

MajorGBN maintains the measures in DPA Annex A, and additionally commits to: secure development practice (code review, automated cross-tenant isolation tests gating release, dependency updates); production access on least privilege with audit; logging sufficient to investigate incidents (with credential redaction); \`[annual penetration testing ●]\`; and maintaining **cyber liability insurance** of not less than \`[₦● / $●]\` per claim \`[once procured — recommended strongly before scale ●]\`, with evidence available on request.

### 5.3 The School's security responsibilities

The School is responsible for what it controls: safeguarding its users' credentials (enforcing MFA for staff is strongly recommended and available); the devices and networks its users connect from; the accuracy of role and permission assignments it makes; prompt deactivation of leavers; its own configuration choices (module toggles, consent settings, retention windows, who may approve money); and not extracting data to insecure locations. **A compromise arising from School-side credentials, devices or configuration is not a Platform breach.**

### 5.4 Incident response

- **Detection & containment:** MajorGBN investigates suspected incidents immediately; containment actions (session revocation, credential resets, tenant suspension of an attacker account, key rotation) may be taken without prior notice where delay would increase harm.
- **Notification:** confirmed personal-data breaches affecting a School are notified to that School **within 72 hours** of confirmation (DPA §2.7) via in-app alert + email to its administrators, with known facts, likely impact and recommended School-side actions; updates follow as investigation proceeds. Regulatory notifications for data MajorGBN controls are made by MajorGBN; the School notifies for data it controls, with our assistance.
- **Cooperation & forensics:** both parties preserve relevant logs/evidence and cooperate in good faith. Post-incident, MajorGBN provides a written summary (cause, scope, remediation) within \`[15 ●]\` business days of closure.
- **No-fault first response:** neither party will publicly attribute fault before the investigation concludes; good-faith vulnerability reports (including from Schools) will never be met with legal threats (safe harbour).

### 5.5 Cost allocation

- Incidents caused by failure of MajorGBN's commitments (§5.2/Annex A): MajorGBN bears reasonable, documented costs of notification to affected data subjects, regulator interactions for the affected School Data, and \`[credit-monitoring where appropriate ●]\`, subject to §5.6.
- Incidents caused by School-side failures (§5.3): the School bears its own costs; MajorGBN provides reasonable technical assistance at \`[standard rates / no charge up to N hours ●]\`.
- Mixed-cause incidents: costs shared in proportion to contribution, determined in good faith (failing which, per MSA dispute resolution).

### 5.6 Liability for cyber incidents

For claims arising from a personal-data breach or security incident **caused by MajorGBN's breach of this Addendum or the DPA**, the liability cap is enhanced to the greater of \`[2× ●]\` the fees paid in the preceding 12 months or \`[₦● minimum]\` — still excluding indirect losses per MSA §4.11, and never limiting liability that the NDPA or other law does not permit limiting. Nothing in this Addendum makes MajorGBN liable for incidents caused by the School's §5.3 failures, force majeure attacks not preventable by the committed measures \`[state-actor carve-out — counsel to advise ●]\`, or third-party services the School connects outside the subprocessor list.

### 5.7 Business continuity

Backups and restoration per DPA Annex A §6; recovery targets \`[RPO ● / RTO ●]\`. If a disaster makes the Platform unavailable beyond \`[5 ●]\` business days, the School may terminate with a pro-rata refund of prepaid unused fees, and the export/deletion rights of DPA §2.9 apply.`,
  },
];
