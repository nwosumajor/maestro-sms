# MAESTRO-SMS — Production Deployment Runbook (AWS)

**Status:** operational runbook — follow top-to-bottom for first go-live; later
sections are the recurring/incident procedures.
**Scope:** everything required to take the platform from this repository to a
live, paying-customer production environment on AWS, with probable monthly
costs and the cost levers that are safe (and unsafe) to pull.
**Companion docs:** `infrastructure/terraform/README.md` (module detail),
`docs/LEGAL_ROLLOUT.md` (compliance prerequisites), `.github/workflows/deploy.yml`
(the deploy pipeline this runbook assumes).
**Last reviewed:** 2026-07-17

---

## 0. What gets deployed (architecture recap)

All of this already exists as code in `infrastructure/terraform/` — production
is a `terraform apply` plus the procedures below, not new engineering.

```
Internet
  │
  ├── Route 53 (DNS)  ──►  CloudFront (TLS, caching, PriceClass_100)
  │                              │
  │                        WAFv2 (managed rule sets + rate limiting)
  │                              │
  │                        ALB (public subnets)
  │                         ├── /ws/*  ──► API target group (WebSockets)
  │                         └── /*     ──► Web target group (Next.js)
  │
  VPC 10.0.0.0/16 — 2 AZs, 3 subnet tiers
  ├── public:  ALB, 1× NAT Gateway
  ├── private-app: ECS Fargate services
  │      ├── web (Next.js + Auth.js, BFF)   × N tasks
  │      ├── api (NestJS, REST + /ws)       × N tasks
  │      ├── one-off migrate task (RUN_MODE, run by CI each deploy)
  │      └── EventBridge-scheduled retention/dunning task (daily)
  └── private-data (no internet route):
         ├── RDS PostgreSQL 16 (Multi-AZ), optional read replicas + RDS Proxy
         └── ElastiCache Redis (queues, cache, pub/sub fan-out)

S3 (Document Vault, KMS-encrypted) · ECR (images) · Secrets Manager (all creds)
CloudWatch (logs/metrics/alarms) · GitHub Actions OIDC role (no long-lived keys)
```

Security posture that must survive every cost decision: three-layer tenant
isolation (JWT → guard → Postgres RLS), least-privilege DB roles
(`major_user` app role cannot DDL; `sms_migrator` runs migrations), private
data subnets with no internet route, KMS everywhere, no secrets in code.

---

## 1. Prerequisites (gather before touching AWS)

### 1.1 Accounts & access
| Item | Detail |
|------|--------|
| AWS account | Fresh, dedicated account (or a `prod` account in an Organization). Do NOT deploy into a personal/experiments account. |
| Root account hardening | Hardware/virtual MFA on root; root used never again after setup. |
| Admin IAM identity | One admin via IAM Identity Center (SSO) or an IAM user with MFA, used only for Terraform bootstrap. |
| GitHub repository | `nwosumajor/maestro-sms` — CI deploys via OIDC; no AWS keys stored in GitHub. |
| Domain | The production domain (e.g. `maestro-sms.com`) — registered anywhere, but a **Route 53 hosted zone** for it is required (`route53_zone_id` variable). |

### 1.2 Third-party services (production credentials)
| Service | What you need | Notes |
|---------|--------------|-------|
| **Paystack** | LIVE secret key; business activation complete | Also per-school subaccounts are created by the app for split settlement — the live key must belong to the activated business. |
| **Stripe** | LIVE secret key + webhook signing secret | USD/Enterprise billing. Activate the account (KYB) before go-live. |
| **Email** (Resend or Postmark) | API key + **verified sending domain** (SPF, DKIM, DMARC DNS records) | Receipts, dunning, onboarding, set-password links all depend on this. Verify the domain days ahead — DNS propagation. |
| **Twilio** (optional at launch) | Account SID, auth token, SMS sender, WhatsApp sender | Only needed when message-credit SMS/WhatsApp channels go live; the app degrades gracefully without it. |
| **Sentry** (recommended) | DSN for the API project | Free tier is fine at launch. |

### 1.3 Compliance gates (see docs/LEGAL_ROLLOUT.md)
Do not onboard real schools before: legal docs finalized + effective,
NDPC registration filed, DPO designated, breach runbook written. Production
data of minors without these is a regulatory exposure, not a soft TODO.

---

## 2. Env/secret wiring — RESOLVED (was the pre-deploy gap)

The Terraform now wires the full application surface. Via `terraform.tfvars`
(see the updated `terraform.tfvars.example`): Stripe key + webhook secret,
email provider/key/from, Twilio SID/token/senders, Sentry DSN, log level —
all defaulting to empty = feature gracefully disabled (Stripe checkout 503s,
email logs to stdout, SMS/WhatsApp fail soft). `METRICS_TOKEN` is
**auto-generated** into Secrets Manager and injected into the API task —
`/metrics` is never open in production; your scraper reads the token from
the `sms/metrics-token` secret. `PUBLIC_WEB_URL` is derived from
`domain_name`.

Remaining optional envs are deliberate runtime tuners, settable per-task-def
if ever needed: `SENTRY_TRACES_SAMPLE_RATE`, `APP_RELEASE`,
`TENANT_RATE_LIMIT_PER_MIN`, cron overrides (`BILLING_DUNNING_CRON`,
`HR_REMINDER_CRON`, `INTEGRITY_RETENTION_CRON`, `AUDIT_PARTITION_CRON`).

Note the two-step Stripe dance: the webhook signing secret only exists after
you register the endpoint in the Stripe dashboard (Step 7) — first apply with
it empty, register, then set `stripe_webhook_secret` and re-apply (task defs
roll automatically).

---

## 3. Cost plan (probable monthly, USD, eu-west-1)

> Estimates at on-demand list prices, 730 h/mo, July 2026 — verify against the
> AWS Pricing Calculator before budgeting; prices drift. Naira figures at an
> illustrative ₦1,600/$ — restate at the real rate.

### 3.1 Profile A — LAUNCH (≤ 50 schools, the tfvars defaults)

2× web + 2× api Fargate tasks (0.5 vCPU / 1 GB each), `db.t4g.small`
Multi-AZ, `cache.t4g.micro`, 1 NAT, no replica/proxy.

| Component | Sizing | Est. $/mo |
|-----------|--------|-----------|
| ECS Fargate (4 tasks × 0.5 vCPU/1 GB, **ARM64/Graviton**) | 24/7 | ~58 |
| ALB | + modest LCU | ~25 |
| NAT Gateway (1) | $0.048/h + data | ~40–55 |
| RDS PostgreSQL `db.t4g.small` **Multi-AZ** | 20 GB gp3 | ~58 |
| ElastiCache `cache.t4g.micro` | 1 node | ~13 |
| CloudFront (PriceClass_100) | ≤1 TB free tier | ~0–15 |
| WAFv2 | ACL + managed rules + requests | ~12 |
| Route 53 | zone + queries | ~2 |
| S3 + KMS (2 CMKs) + ECR | early volumes | ~8 |
| Secrets Manager (~10–12 secrets) | $0.40 each | ~5 |
| CloudWatch logs/metrics/alarms | 30-day retention | ~10–20 |
| Scheduled retention/dunning task | minutes/day | ~1 |
| Alarms (~18) + Route 53 health probe | detection layer | ~3 |
| **Total** | | **~$235–275/mo (~₦375k–440k)** |

The whole compute + data tier is Graviton (ARM): Fargate tasks
(`cpu_architecture=ARM64`, images built natively on an ARM CI runner), RDS
`t4g`/`m7g`/`r7g`, ElastiCache `t4g`/`m7g` — ~20% cheaper per unit with no
user-facing difference. The free S3 gateway VPC endpoint is provisioned
(cuts NAT data charges), and ECR keeps only the last 20 images per repo
(lifecycle policy).

### 3.2 Profile B — GROWTH (~500 schools)
Upsize: api 4× (1 vCPU/2 GB), web 3×, `db.m7g.large` Multi-AZ + 1 read
replica, **RDS Proxy on** (`enable_rds_proxy=true`), `cache.t4g.small`,
storage 100 GB. **≈ $800–1,000/mo (~₦1.3m–1.6m)** — dominated by RDS
(~$420 for primary+replica) and Fargate (~$250). At this stage buy reserved
capacity (§3.4) and the real number drops toward ~$650.

### 3.3 Profile C — SCALE (~5,000 schools)
`db.r7g.xlarge` Multi-AZ + 2 replicas + Proxy, api 8–12 tasks with
auto-scaling, `cache.m7g.large`, 500 GB+, higher log/WAF volumes.
**≈ $2,800–3,800/mo (~₦4.5m–6m).** At ~₦20k+/school/mo revenue, infra is
<0.5% of revenue — the architecture's shared-tenancy economics doing its job.

### 3.4 Cost levers that are SAFE (no user-facing consequence)
1. **Compute Savings Plan** (1-yr, no-upfront) on Fargate: ~20% off compute.
   Buy after one month of observed steady-state, sized to the floor usage.
2. **RDS Reserved Instance** (1-yr, no-upfront) once the instance class is
   stable: ~30–35% off the biggest line item.
3. **VPC endpoints:** the free S3 *gateway* endpoint is already provisioned
   (`network.tf`). Interface endpoints (ECR/Logs/Secrets) cost ~$7.30/mo
   *each* in fixed hourly charges — only net-positive once NAT data through
   them exceeds that; revisit at the Growth profile, not before.
4. **Log discipline:** 30-day CloudWatch retention (already the default
   posture), `LOG_LEVEL=info`, `/metrics` + `/health` scrapes excluded from
   request logs (already built).
5. **gp3 storage** (already) and rightsizing storage growth alarms instead of
   over-provisioning.
6. **CloudFront PriceClass_100** (already set) — Nigeria is served via Europe
   edges either way at this class; fine.
7. **Scheduled scale-down of a staging environment** (if you run one) to zero
   outside working hours — never do this to production.
8. **AWS Budgets** with alerts at 80%/100% of the profile figure — costs
   nothing, catches runaway spend (see §9).

### 3.5 Cost cuts to REFUSE (they have user consequences)
| Tempting cut | Saves | Why not |
|--------------|-------|---------|
| Single-AZ RDS | ~$29/mo | A single AZ event takes every school down for as long as recovery takes; Multi-AZ fails over in ~1–2 min. This is the cheapest insurance you will ever buy. |
| Drop to 1 web/1 api task | ~$36/mo | Zero-downtime deploys and any task crash both require ≥2; one task = visible outages on every deploy. |
| Remove WAF | ~$12/mo | The rate-limited login guard is the *backstop* to the WAF, not a replacement; schools' portals face the public internet. |
| Shorter/no DB backups | ~$0–5/mo | Backup retention within instance-size is effectively free; cutting it only removes your restore path. |
| NAT instance instead of NAT Gateway | ~$30/mo | Real saving but you now own patching/failover of a single point of egress failure (webhooks, email, Paystack calls all die silently). Revisit only with dedicated ops capacity. |
| Skipping CloudFront ("ALB is enough") | ~$0–15/mo | Loses the WAF attachment point, TLS edge, and caching; ALB then needs its own public exposure hardening. |

---

## 4. First-time deployment procedure

Work in order. Times assume the prerequisites in §1 are in hand.

### Step 1 — AWS account bootstrap (once, ~1 h)
1. Enable MFA on root; create the admin identity; sign out of root forever.
2. Set the account's default region `eu-west-1` (or the region counsel
   approved — cross-border transfer position, LEGAL_ROLLOUT row 4; if
   `af-south-1` is chosen, adjust `region`/`azs` in tfvars and re-check
   instance-type availability).
3. Enable **Cost Explorer** and create an **AWS Budget** (§9).
4. Create the Terraform state backend: an S3 bucket
   (`sms-terraform-state-<acct>`, versioned, encrypted) + DynamoDB lock table
   — copy `backend.tf.example` → `backend.tf` and fill these in.

### Step 2 — Terraform variables (~30 min)
`cp terraform.tfvars.example terraform.tfvars` and set:
```hcl
project          = "sms"
environment      = "prod"
region           = "eu-west-1"
domain_name      = "app.maestro-sms.com"     # or apex
route53_zone_id  = "Z..."                     # the hosted zone from §1.1
github_repo      = "nwosumajor/maestro-sms"   # OIDC trust
# Launch profile = keep every sizing default (db.t4g.small, 2+2 tasks,
# multi_az=true, replicas=0, proxy=false).
paystack_secret_key = ""   # set LIVE key here or rotate in later via console
```
Never commit `terraform.tfvars` or `backend.tf` (already gitignored).

### Step 3 — Apply (~25 min; CloudFront is the slow part)
```bash
cd infrastructure/terraform
terraform init
terraform plan -out prod.plan    # READ the plan — ~90 resources, nothing destructive on first run
terraform apply prod.plan
```
Outputs to record: ALB DNS, CloudFront domain, ECR repo URLs, the GitHub OIDC
role ARN, RDS endpoint, the S3 documents bucket.
ACM validation + CloudFront distribution can take 15–30 min; DNS records for
the domain are created in the hosted zone automatically (`route53.tf`).

### Step 4 — Populate the out-of-band secrets (~30 min)
Terraform generates DB passwords, `AUTH_SECRET`, `DATA_ENCRYPTION_KEY`, and
`METRICS_TOKEN` itself. You supply via tfvars (§2): Paystack LIVE key, Stripe
key (+ webhook secret after Step 7), email API key + provider + from, Sentry
DSN, Twilio (when ready).

> ⚠️ **`DATA_ENCRYPTION_KEY` is generated once and must never change** — it
> derives the per-tenant field-encryption keys for medical/salary/bank/card
> data. Losing or rotating it without a re-encryption migration bricks that
> data. Confirm the state bucket versioning (Step 1.4) and additionally store
> a sealed offline copy of this one secret (e.g. printed, in a safe) — this is
> the single most important disaster-recovery artifact.

### Step 5 — First application deploy (~20 min)
1. In GitHub → repo → Settings → Secrets and variables → Actions, set the
   workflow's expected values (role ARN, region, ECR repos — see the `env:`
   block at the top of `.github/workflows/deploy.yml`).
2. Trigger the `deploy` workflow (push to main or manual dispatch). It will:
   build+push both images to ECR → **run the one-off migrate task and wait**
   (Prisma `migrate deploy`, then RLS SQL files applied idempotently, then
   seed) → roll `web` and `api` services to the new image.
3. Watch: ECS console → services reach steady state; the migrate task exits 0.

### Step 6 — Smoke verification (~30 min) — do not skip
```
[ ] https://<domain>/            → homepage 200 over TLS (CloudFront header present)
[ ] /api health + login          → sign in as the platform owner (owner@sms.platform
                                    seed — CHANGE ITS PASSWORD IMMEDIATELY, enable TOTP)
[ ] ROLE-HEAVY login             → also sign in as a principal/school_admin and load a few
                                    pages. Their session cookie is the largest (most roles/
                                    modules); an owner-only test once masked a proxy-header
                                    502 that only role-heavy sessions triggered. The route
                                    smoke enforces a 3 KB session-cookie budget — keep it.
                                    (nginx exists ONLY in local compose; prod is CloudFront →
                                    ALB → ECS, whose header limits are higher but not infinite.)
[ ] /metrics without token       → 401/403 (token is auto-generated; if 200, the task def lost its METRICS_TOKEN wiring — stop and fix)
[ ] WebSockets                   → open a game/live screen, LiveDot shows "Live" (proves /ws/* ALB routing)
[ ] Document upload + download   → proves S3 presigner + KMS + bucket policy
[ ] RDS: connect as major_user   → `SELECT` on a tenant table w/o GUC returns 0 rows (RLS live);
                                    `CREATE TABLE` fails (least-privilege role real)
[ ] Email: trigger a set-password invite → arrives, SPF/DKIM pass (check headers)
[ ] Seed hygiene: demo logins    → decide now: run with SEED demo data disabled/removed
                                    for prod, or change every demo password. Demo creds
                                    in a live system = breach waiting.
```

### Step 7 — Payment rails (~1 h, needs live business accounts)
1. **Paystack dashboard** → webhook URL. The API route is
   `POST /payments/webhook` (`@Public`, HMAC-SHA512-verified). In the cloud
   topology the ALB sends only `/ws/*` to the API, so the publicly reachable
   URL goes through the web BFF: `https://<domain>/api/sms/payments/webhook`.
   ⚠️ Signature verification needs the **exact raw body** — the redelivery
   test below proves the BFF forwards it byte-for-byte; if signatures fail,
   this proxy hop is the first suspect (alternative: add an ALB listener rule
   forwarding `/payments/webhook` straight to the API target group).
   Test-charge a real card end-to-end (₦100 invoice), confirm the webhook
   posts the payment, receipt email fires, split settles to a test school
   subaccount.
2. **Stripe dashboard** → add the webhook endpoint, copy the signing secret
   into Secrets Manager (it's per-endpoint), redeploy api service.
   Run one Enterprise USD test checkout in live mode (refund it after).
3. Verify webhook **idempotency** by redelivering an event from each
   dashboard: balance must not double-credit.

### Step 8 — Observability & alarms (~20 min; provisioned by Terraform)
The detection layer is code (`alarms.tf`, `autoscaling.tf`) — your job here is
confirmation, not creation:
1. Set `alert_email` (and `monthly_budget_usd`) in tfvars BEFORE the apply,
   then **click the SNS confirmation links** in the two emails that arrive
   (one per region — the outside-in probe alarms from us-east-1).
   Unconfirmed subscription = silent alarms.
2. What's armed: ALB target-5xx + LB-5xx, p95 latency > 2s (web/api),
   unhealthy targets, ECS CPU saturation (auto-scaling at ceiling), RDS
   CPU/storage/connections/memory, Redis memory/evictions (both nodes), a
   **Route 53 external health probe** on `https://<domain>/` (the
   wake-someone-up alarm — catches dead DNS/CloudFront that internal metrics
   can't see), and AWS Budget alerts at 80% actual / 100% forecast.
3. **Auto-scaling** is armed on both services: floor = `desired_count` (2 —
   redundancy never sacrificed), ceiling 10, target-tracking on CPU 60% AND
   ALB requests-per-target (leading indicator); scale-out 60s, scale-in
   conservative. Note `terraform apply` never resets the live count
   (`ignore_changes = [desired_count]`).
4. Sentry DSN in (via §2); throw a test 500, see it arrive with request +
   tenant context.
5. Fire drill: stop one api task in the console → unhealthy-target alarm →
   email arrives → service self-heals. Now you've seen the loop once before
   it matters.

### Step 9 — Backup & restore DRILL (before first paying school)
1. Confirm automated RDS snapshots are on (Terraform default) and take one
   manual snapshot tagged `pre-golive`.
2. **Restore it** to a throwaway instance, connect, verify a tenant's rows
   exist, then delete the instance. An untested backup is a hope, not a
   backup. Record time-to-restore — that's your real RTO (publish per
   LEGAL_ROLLOUT row 39).
3. Enable RDS deletion protection (console toggle) on the production instance.
4. S3: the documents bucket is versioned by the module; confirm, and add a
   lifecycle rule shifting non-current versions to Glacier after 30 days
   (cost lever, zero user impact).

### Step 10 — Go-live gate
```
[ ] Legal effective + acceptance flow live (LEGAL_ROLLOUT §7 checklist done)
[ ] Owner account: strong password + TOTP; demo accounts neutralized
[ ] All §6 smoke checks green, §7 payment tests settled, §8 alarms firing to a human
[ ] Restore drill documented (§9)
[ ] First real school onboarded via /onboard → approve → provision → their
    admin signs in via invite link — the full production path, once, yourself
```

---

## 5. Recurring operations

| Cadence | Procedure |
|---------|-----------|
| Every deploy | Push to main → CI gates (typecheck, unit, RLS e2e) → deploy workflow. Rolling deploy = zero downtime with ≥2 tasks/service. Watch the migrate task result — a failed migration halts the roll (services stay on the old image). |
| Weekly | Skim Sentry + the 5xx alarm history; check RDS storage growth trend. |
| Monthly | Cost Explorer vs budget; review CloudWatch log volume; `terraform plan` (should be empty — drift check). |
| Quarterly | Restore drill (§9.2); rotate the Paystack/Stripe/email keys if staff changed; review WAF blocked-request sample for false positives. |
| Per scale milestone | See §6 triggers. |

**Postgres minor upgrades:** RDS auto-minor-version-upgrade during the
maintenance window (Multi-AZ = brief failover, ~1–2 min, off-peak). Major
version upgrades: snapshot → test-restore → upgrade in window, never same-day.

---

## 6. Scaling triggers (when to spend more)

| Signal | Action | Cost delta |
|--------|--------|-----------|
| The `cpu-saturated` alarm fires (auto-scaling pinned at its ceiling) | Raise `api_max_count`/`web_max_count` — scaling to the current ceiling is already automatic (target-tracking on CPU 60% + ALB req/target, floor 2) | ~$15/extra ARM task |
| DB connections approaching max (t4g.small ≈ ~400 with default params; watch the alarm) | `enable_rds_proxy = true` — decouples connection count from task count (the app's GUC handling is already pooler-safe) | ~$22+ |
| DB CPU > 70% sustained on reads (analytics, lists) | `db_read_replica_count = 1` — the read/write split (Phase 1 scaling work) routes read-only tenant paths to it automatically via `DATABASE_REPLICA_URL` | ~$29 (t4g.small) |
| DB CPU high on writes / IO waits | Upsize instance class (t4g.small → m7g.large → r7g.xlarge). Multi-AZ makes this a failover-blip, not an outage: modify, it applies to standby first | 2–6× DB line |
| Redis memory/eviction alarms | Upsize node type (micro → small → m7g.large) | ~$13 → ~$100 |
| NAT data charges climbing | Add VPC endpoints (§3.4.3) before anything else | negative |
| > ~1,500 schools | Execute the remaining phases of the scaling program (partitioning, per-tenant rate limits are env-toggleable already, load test) before, not after, the growth | engineering time |

---

## 7. Incident & disaster scenarios

**Bad deploy (app broken, infra fine):** re-run the deploy workflow pinned to
the previous image tag (every push tags by SHA) — ECS rolls back in minutes.
Migrations are forward-only: never roll back a migration in prod; fix forward.

**AZ failure:** ALB + ECS span 2 AZs; RDS Multi-AZ fails over automatically
(~1–2 min of DB errors, tasks reconnect). NAT is single-AZ — outbound calls
(webhooks OUT, email, Paystack API) from the surviving AZ pause until the AZ
returns or you re-point the private route table; inbound user traffic is
unaffected. Accepted launch-profile tradeoff; add a second NAT (~$35/mo) when
revenue justifies it.

**Region failure (rare, catastrophic):** recovery = new region: Terraform
apply + restore latest snapshot (cross-region snapshot copy is a cheap ~$2–5/mo
insurance — enable it) + S3 cross-region replication if documents are
business-critical (defer at launch; report cards regenerate). Publish RTO
honestly per what the drill shows (~half a day), not aspirationally.

**Data breach suspicion:** breach runbook (LEGAL_ROLLOUT §7) — preserve
CloudWatch logs + audit tables (append-only), DPO makes the 72-hour NDPC call,
rotate `AUTH_SECRET` (in a breach: rotate WITHOUT setting the previous-secret
window — the global logout is the point) and affected credentials.
Never rotate `DATA_ENCRYPTION_KEY` in panic (see Step 4 warning).

**Routine AUTH_SECRET rotation (graceful — no fleet logout):**
1. Read the current value: `aws secretsmanager get-secret-value --secret-id
   sms/auth-secret`.
2. Set `auth_secret_previous = "<that value>"` in tfvars.
3. `terraform apply -replace=random_password.auth_secret` — new secret signs
   everything; old sessions/invites/reset-links keep verifying via the window.
4. After 30 days (longest-lived token = 7-day invites, sessions re-signed on
   activity), clear `auth_secret_previous` and apply again — the old secret is
   now fully retired.
Session claims are also **revalidated mid-session** (`GET /auth/refresh`,
default every 10 min of activity — `SESSION_CLAIMS_REFRESH_SEC` tunes it): a
revoked role, disabled/locked account, or suspended school kills or updates
the live session within minutes; a transient API failure never logs anyone
out (fail-open on availability, fail-closed on explicit revocation).

**Paystack/Stripe outage:** payments fail closed, ledgers stay consistent
(webhook-driven, idempotent). No action beyond status-page comms; parents
retry.

**Redis loss:** queues/cache/pub-sub degrade — notifications delay, live
screens fall back to polling (built), entitlement caches re-warm. ElastiCache
node replacement is automatic; no data of record lives in Redis.

**Runaway cost:** Budget alarm → Cost Explorer group-by-service → the usual
suspects are NAT data (add endpoints), log ingestion (drop a noisy logger),
or a scaling loop (cap max task count).

---

## 8. Security hardening checklist (production posture)

```
[ ] Root MFA'd and unused; no long-lived IAM access keys anywhere (CI = OIDC)
[ ] METRICS_TOKEN set; /metrics rejects unauthenticated scrapes
[ ] RDS: deletion protection ON, not publicly accessible (module default),
    encrypted (KMS), in the no-internet data tier
[ ] S3 documents bucket: block-public-access ON (module default), KMS CMK
[ ] Secrets only in Secrets Manager; task role scoped to exactly its secrets
[ ] WAF managed rule groups in BLOCK mode after a 1-week COUNT-mode bake-in
    (watch for false positives on school traffic first)
[ ] CloudTrail ON (account-wide, all regions) — it's ~$0 at this volume and
    the first thing forensics needs
[ ] GuardDuty ON (~$5–15/mo at launch volume) — cheap managed threat detection
[ ] Owner + all platform staff: TOTP enforced; step-up-guarded endpoints tested
[ ] Demo/seed accounts removed or repassworded (Step 6)
[ ] Quarterly access review: who can assume the admin role, who's in GitHub
    with push-to-main
```

---

## 9. Cost governance setup (15 minutes, do in Step 1)

1. **AWS Budget:** provisioned by Terraform (`monthly_budget_usd`, alerts at
   80% actual / 100% forecast to `alert_email`) — just set the two tfvars.
2. **Cost allocation tags:** activate the `Name`/project tags Terraform sets,
   so Cost Explorer can split by component (console, once).
3. **Cost anomaly detection:** one monitor, default settings, same SNS topic
   (console, once).
4. Review §3.4 levers at month 2 (Savings Plan) and month 3 (RDS RI) once
   usage is proven — reserving before observing is how you buy the wrong size.

---

## 10. Known deviations to decide explicitly (sign off, don't drift)

| Decision | Default in code | Production recommendation |
|----------|-----------------|---------------------------|
| Region | `eu-west-1` | Confirm with counsel (NDPA transfer position); `af-south-1` costs ~10–15% more and has all needed services — acceptable if required. **Not `us-east-1`** despite marginally lower prices (~5% overall): Lagos→Dublin is ~100–120 ms on the West-African submarine cables vs ~160–190 ms to Virginia — a user-visible penalty on every request — and storing minors' data in a GDPR-jurisdiction region is materially easier to defend to the NDPC than a US transfer. ~$15/mo saved is not worth either. |
| Redis transit encryption | off | Turn ON (`redis_transit_encryption=true`) — inside-VPC risk is low but the flag exists and the auth token wiring is built; cost is zero. |
| Single NAT | 1 gateway | Accept at launch (documented in §7); revisit at Growth profile. |
| RDS Proxy | off | Off at launch is correct; §6 trigger governs. |
| Demo seed in prod | seed runs on migrate task | Strip demo tenants/accounts for prod or rotate all their passwords — decide before Step 5. |
| Staging environment | none | Optional: a scale-to-zero copy (~$60–80/mo if always-off outside hours). The strong test suite + smoke script partially substitutes at launch. |
