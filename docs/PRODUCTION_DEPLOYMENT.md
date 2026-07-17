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

## 2. Pre-deploy engineering gap (must fix before first apply)

The Terraform wires these container env/secrets today: `AUTH_SECRET`,
`DATA_ENCRYPTION_KEY`, DB URLs (app/migrate/replica), Redis, S3 bucket,
`PAYSTACK_SECRET_KEY`, `WEB_ORIGIN`, `STORAGE_PROVIDER`.

The application has since grown and now also reads (inventory taken from the
code): `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `EMAIL_PROVIDER`,
`EMAIL_API_KEY`, `EMAIL_FROM`, `PUBLIC_WEB_URL`, `METRICS_TOKEN`,
`SENTRY_DSN`, `SENTRY_TRACES_SAMPLE_RATE`, `APP_RELEASE`, `LOG_LEVEL`,
`SMS_PROVIDER`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`,
`TWILIO_WHATSAPP_FROM`, `TENANT_RATE_LIMIT_PER_MIN`, cron overrides
(`BILLING_DUNNING_CRON`, `HR_REMINDER_CRON`, `INTEGRITY_RETENTION_CRON`,
`AUDIT_PARTITION_CRON`).

**Action (small Terraform change, ~1 file each):**
1. Add the secret-bearing ones (`stripe-secret-key`, `stripe-webhook-secret`,
   `email-api-key`, `metrics-token`, `twilio-auth-token`) to
   `secrets.tf` `secret_values` (as `variable`s like `paystack_secret_key`,
   empty-string default = feature disabled).
2. Wire them into the API task definition in `ecs.tf` (`secrets` block for
   secret values, `environment` block for plain ones like `EMAIL_PROVIDER`,
   `EMAIL_FROM`, `PUBLIC_WEB_URL`, `SENTRY_DSN`, `LOG_LEVEL=info`).
3. Set `METRICS_TOKEN` — the `/metrics` endpoint is OPEN when unset. This is
   mandatory for production, not optional.

Everything unset degrades gracefully (Stripe checkout 503s, email logs to
stdout, SMS channels fail soft) — but set at minimum: Stripe, email,
`METRICS_TOKEN`, `PUBLIC_WEB_URL`, `SENTRY_DSN`.

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
| ECS Fargate (4 tasks × 0.5 vCPU/1 GB) | 24/7 | ~72 |
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
| **Total** | | **~$245–285/mo (~₦390k–460k)** |

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
3. **VPC gateway/interface endpoints** for S3, ECR, CloudWatch, Secrets
   Manager: cuts NAT data-processing charges (images + logs are the bulk of
   NAT traffic). S3 gateway endpoint is free — do it immediately.
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
Terraform generates DB passwords, `AUTH_SECRET`, `DATA_ENCRYPTION_KEY` itself.
You supply, via console/CLI into the created Secrets Manager entries (or
tfvars where a variable exists): Paystack LIVE key, Stripe key + webhook
secret, email API key, metrics token, Twilio (when ready).

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
[ ] /metrics without token       → 401/403 (if 200, METRICS_TOKEN is unset — stop, fix §2)
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

### Step 8 — Observability & alarms (~1 h)
1. Sentry DSN in (already via §2); throw a test 500, see it arrive.
2. CloudWatch alarms (create via console or a small tf addition):
   - ALB 5xx rate > 1% for 5 min
   - ALB target unhealthy count ≥ 1
   - RDS: CPU > 80% (15 min), FreeStorageSpace < 5 GB, connections > 80% max
   - Redis: memory > 80%, evictions > 0
   - ECS: running task count < desired
   - Billing: the AWS Budget alerts (§9)
   Route all to an SNS topic → your email (and phone via SMS for the 5xx one).
3. Point an external uptime pinger (free tier of any monitor) at `/` and the
   API health route — CloudWatch can't see a dead CloudFront distribution.

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
| API p95 latency up + Fargate CPU > 70% sustained | Raise `api_desired_count` (or add target-tracking auto-scaling on CPU 60%) | ~$18/task |
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
rotate `AUTH_SECRET` (forces global re-login) and affected credentials.
Never rotate `DATA_ENCRYPTION_KEY` in panic (see Step 4 warning).

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

1. **AWS Budget:** monthly, amount = profile estimate +20%, alerts at 80%
   actual and 100% forecast → email + SMS.
2. **Cost allocation tags:** activate the `Name`/project tags Terraform sets,
   so Cost Explorer can split by component.
3. **Cost anomaly detection:** one monitor, default settings, same SNS topic.
4. Review §3.4 levers at month 2 (Savings Plan) and month 3 (RDS RI) once
   usage is proven — reserving before observing is how you buy the wrong size.

---

## 10. Known deviations to decide explicitly (sign off, don't drift)

| Decision | Default in code | Production recommendation |
|----------|-----------------|---------------------------|
| Region | `eu-west-1` | Confirm with counsel (NDPA transfer position); `af-south-1` costs ~10–15% more and has all needed services — acceptable if required. |
| Redis transit encryption | off | Turn ON (`redis_transit_encryption=true`) — inside-VPC risk is low but the flag exists and the auth token wiring is built; cost is zero. |
| Single NAT | 1 gateway | Accept at launch (documented in §7); revisit at Growth profile. |
| RDS Proxy | off | Off at launch is correct; §6 trigger governs. |
| Demo seed in prod | seed runs on migrate task | Strip demo tenants/accounts for prod or rotate all their passwords — decide before Step 5. |
| Staging environment | none | Optional: a scale-to-zero copy (~$60–80/mo if always-off outside hours). The strong test suite + smoke script partially substitutes at launch. |
