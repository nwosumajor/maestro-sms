# Runbook — incident response & post-mortem

> **The goal of an incident is to restore service. The goal of a post-mortem is to
> make sure you never fight that incident again.** Do them in that order, and
> never skip the second one because the first one worked.

This runbook covers MAESTRO-SMS running on AWS (`infrastructure/terraform/`). It
is written to be followed at 3am by someone who did not write the code. Every
command is real and uses this stack's actual resource names.

Companion documents:
- **`RUNBOOK-BACKUP-RESTORE.md`** — backups, PITR and the restore drill. §7 here
  hands off to it.
- **`PRODUCTION_DEPLOYMENT.md`** — first-time deploy and configuration.

---

## 0. Set these once, at the top of every incident

Everything below assumes these are exported. Do this first — it prevents the
classic 3am error of running a destructive command against the wrong environment.

```bash
export AWS_REGION=<your-region>
export PROJECT=sms                 # var.project
export ENV=prod                    # var.environment
export NAME="${PROJECT}-${ENV}"    # local.name — every resource is prefixed with this
export CLUSTER="$NAME"             # the ECS cluster IS local.name

# Sanity check you are pointed at the right account BEFORE touching anything.
aws sts get-caller-identity --query '[Account,Arn]' --output text
```

---

## 1. Severity — decide this first, in under a minute

Severity drives everything else: who you wake, how fast you communicate, and
whether you are allowed to take risky shortcuts.

| Sev | Meaning | Examples | Response | Comms |
|---|---|---|---|---|
| **SEV-1** | Data at risk, or every school is down | Tenant isolation breach, data loss/corruption, credential exposure, total outage | **Immediately**, drop everything | Notify affected schools within **1 hour** |
| **SEV-2** | Major function broken for many users | Payments not landing, nobody can log in, one school fully down | Within **30 min** | Status update to affected schools same day |
| **SEV-3** | Degraded but usable | Slow pages, one module failing, scheduled job missed | Next working hour | Only if a user reported it |
| **SEV-4** | Cosmetic or single-user | Layout bug, one user's odd state | Normal backlog | Reply to the reporter |

**Two rules that override the table:**

1. **Anything touching tenant isolation is SEV-1**, even if only one record and
   even if you think it is a display bug. One school seeing another school's data
   is the failure this entire architecture exists to prevent. Go to §5.9.
2. **Anything touching minors' data is SEV-1** — student PII, medical records,
   integrity telemetry. NDPR obligations start running from the moment you know.

---

## 2. First five minutes — triage

Do not start fixing yet. Establish *what* is broken and *whether you caused it*.

### 2.1 Is it actually down, and for whom?

```bash
APP_URL=$(cd infrastructure/terraform && terraform output -raw app_url)

# 1. EDGE — CloudFront -> ALB -> web service. What a school actually hits.
curl -sS -o /dev/null -w 'edge : %{http_code} in %{time_total}s\n' "$APP_URL"

# 2. WEB LIVENESS — the ALB's own probe. Proves ONLY that Next.js is serving:
#    it does not touch the API or the database, by design (keep it cheap).
curl -sS -o /dev/null -w 'web  : %{http_code} in %{time_total}s\n' "$APP_URL/api/health"

# 3. FULL CHAIN — edge -> web -> API (over Cloud Map) -> Postgres. This is the
#    one that actually tells you the stack works. It is a public, unauthenticated
#    read that requires a real DB query to answer.
curl -sS -o /dev/null -w 'chain: %{http_code} in %{time_total}s\n' "$APP_URL/api/public/plan-pricing"
```

> **Do not stop at `/api/health`.** It is the web tier's liveness probe and
> returns `{"status":"ok"}` without consulting the API or the database — during a
> total API outage it still answers 200. Probe 3 is the honest one. The API's own
> `/health` is **not reachable from the internet**: the ALB forwards only `/ws/*`
> to the API target group, and REST flows web→api internally over Cloud Map.

| edge | web | chain | Meaning | Go to |
|---|---|---|---|---|
| 200 | 200 | 200 | Not an outage — a specific feature or one tenant | §5.6–§5.12 |
| 200 | 200 | 5xx | **API or database is down**; the web tier is masking it | §5.1, then §5.3 |
| 200 | 200 | slow | Saturation or a slow query | §5.2 |
| fail | 200 | — | CloudFront / WAF / DNS — the app is fine | §5.1, WAF subsection |
| fail | fail | fail | Platform-wide | §5.1 |
| 403 | — | — | WAF is blocking | §5.1, WAF subsection |

### 2.2 Did a deploy cause this?

**Ask this before anything else.** Most incidents are self-inflicted and the
fastest fix is undo, not diagnosis.

```bash
# When did the services last change?
aws ecs describe-services --cluster "$CLUSTER" --services "$NAME-api" "$NAME-web" \
  --query 'services[].{svc:serviceName,status:status,running:runningCount,desired:desiredCount,updated:deployments[0].updatedAt,rollout:deployments[0].rolloutState}' \
  --output table

# And what did we ship?
gh run list --workflow deploy --limit 5
```

**If a deploy landed within ~30 minutes of the symptom, treat it as the cause
until proven otherwise. Roll back first (§6), diagnose afterwards.** A rollback
takes minutes; root-causing a bad release under pressure takes hours.

### 2.3 What is the blast radius?

```bash
# Which alarms are actually firing?
aws cloudwatch describe-alarms --state-value ALARM \
  --query 'MetricAlarms[].{alarm:AlarmName,since:StateUpdatedTimestamp}' --output table
```

The 12 configured alarms and what each one really means:

| Alarm | Threshold | Read it as |
|---|---|---|
| `-alb-target-5xx` | >10 | **The app is throwing errors.** Go to logs/Sentry. |
| `-alb-elb-5xx` | >10 | The **load balancer** couldn't reach a healthy task. §5.1 |
| `-{svc}-latency-p95` | >2s | Saturation, or a slow query. §5.2 |
| `-{svc}-unhealthy-target` | ≥1 | Tasks failing health checks — often a crash loop. §5.1 |
| `-{svc}-cpu-saturated` | >85% | Under-provisioned or a hot loop. §5.2 |
| `-rds-cpu` | >80% | Query problem far more often than a size problem. §5.3 |
| `-rds-storage` | <5 GB | **Urgent** — a full disk stops all writes. §5.3 |
| `-rds-connections` | var | Connection leak or pool misconfiguration. §5.3 |
| `-rds-memory` | <200 MB | Working set exceeds the instance. §5.3 |
| `-redis-*-memory` | >80% | Cache pressure; evictions are next. §5.4 |
| `-redis-*-evictions` | >0 | **Already evicting** — sessions/entitlements churning. §5.4 |
| `-site-down` | 3 fails | Route 53 says the site is unreachable from outside. §5.1 |

Alarms notify the SNS topic `$NAME-alerts` → the address in `var.alert_email`.
**If you are not receiving these, that is itself a SEV-2** — fix the subscription
before the next incident, not during it.

---

## 3. Communicate early — a silent outage is a bigger outage

Schools tolerate downtime far better than silence. During exam weeks or fee
deadlines they will not tolerate either, so lead with a time.

**Within 15 minutes of confirming SEV-1/SEV-2**, send something like:

> We are aware of an issue affecting [what] since [time]. Your data is safe and
> nothing has been lost. We are working on it and will update you by [time +30m].

Rules that keep trust intact:
- **Commit to the next update time, not to a fix time.** Then keep that promise
  even when there is no progress — "still working, next update at X" is fine.
- **Say what is safe.** Schools' first fear is lost records. If you know data is
  intact, say so plainly.
- **Never speculate on cause while still fixing.** An early wrong theory becomes
  the thing they remember.
- If money or student data is involved, get the facts straight before naming a
  cause — that message may end up in front of a regulator.

Channels: `support@majormaestro.com`, WhatsApp for urgency, and — if the app is
up — an in-app announcement. For SEV-1 affecting one school, phone the principal.

---

## 4. Diagnostic toolkit

### 4.1 Logs (structured JSON, via `nestjs-pino`)

Every request logs one line with `request_id`, `school_id`, `user_id`, method,
route, status and latency. Auth/cookie/step-up/webhook-signature headers are
**redacted** and the query string is stripped, so logs never contain a token.

```bash
# Live tail — the fastest way to see what's happening now.
aws logs tail "/ecs/$NAME/api" --follow --since 10m
aws logs tail "/ecs/$NAME/web" --follow --since 10m

# Errors only.
aws logs tail "/ecs/$NAME/api" --since 30m --filter-pattern '{ $.level >= 50 }'

# Everything one school did (tenant-scoped triage).
aws logs tail "/ecs/$NAME/api" --since 1h \
  --filter-pattern "{ \$.school_id = \"<school-uuid>\" }"

# Follow ONE request end to end — the id is in the x-request-id response header,
# so ask the reporting user for it.
aws logs tail "/ecs/$NAME/api" --since 1h \
  --filter-pattern "{ \$.request_id = \"<id>\" }"
```

Retention is **30 days** (`logs.tf`). Anything older must come from Sentry or the
audit log.

### 4.2 Sentry

5xx responses are captured with request and tenant context, then re-thrown
unchanged. Sentry is where you get a **stack trace**; CloudWatch is where you get
**frequency and blast radius**. Use both — Sentry alone will not tell you whether
one school or fifty are affected.

### 4.3 The audit log — the authoritative record of who did what

For anything involving money, access or student data, this beats logs and beats
memory. It is append-only and nobody can edit it.

```sql
SELECT "createdAt", "actorId", action, entity, "entityId", metadata
FROM audit_log
WHERE "schoolId" = '<school-uuid>'
  AND "createdAt" > now() - interval '2 hours'
ORDER BY "createdAt" DESC
LIMIT 100;
```

### 4.4 Getting a shell / a psql session

```bash
# Shell into a running task (ECS Exec must be enabled on the service).
TASK=$(aws ecs list-tasks --cluster "$CLUSTER" --service-name "$NAME-api" \
  --query 'taskArns[0]' --output text)
aws ecs execute-command --cluster "$CLUSTER" --task "$TASK" \
  --container api --interactive --command "/bin/sh"
```

**The database is in a private subnet and has no public endpoint.** Reach it via
a bastion or SSM port-forward, never by making it public — not even "just for a
minute during an incident". That minute is how databases end up on Shodan.

---

## 5. Playbooks by symptom

### 5.1 Site down, or 5xx storm

**Fastest path: is anything actually running?**

```bash
aws ecs describe-services --cluster "$CLUSTER" --services "$NAME-api" "$NAME-web" \
  --query 'services[].{svc:serviceName,running:runningCount,desired:desiredCount,rollout:deployments[0].rolloutState}' \
  --output table
```

| What you see | Cause | Action |
|---|---|---|
| `running` = 0 | Tasks can't start | Check stopped-task reason ↓ |
| `running` < `desired` | Crash loop | Check stopped-task reason ↓ |
| `rolloutState: FAILED` | Circuit breaker tripped | It **already rolled back** (`rollback = true`). Find out why before redeploying. |
| Healthy but 5xx | App-level errors | Sentry + `$.level >= 50` logs |

```bash
# WHY did a task die? This is the single most useful command in this document.
aws ecs describe-tasks --cluster "$CLUSTER" --tasks $(
  aws ecs list-tasks --cluster "$CLUSTER" --service-name "$NAME-api" \
    --desired-status STOPPED --query 'taskArns[0]' --output text
) --query 'tasks[].{stopped:stoppedReason,exit:containers[0].exitCode,reason:containers[0].reason}' --output table
```

Common causes, in the order they actually occur:

- **Secret missing or malformed** — a task that cannot read a Secrets Manager
  value dies instantly on boot. Check `secrets.tf` against what exists.
- **DB unreachable** — security group, or RDS failing over. §5.3.
- **Migration left the schema half-applied** — the deploy's migrate task failed
  but services rolled anyway. §5.5.
- **OOM** — `exitCode: 137`. Raise task memory, then find the leak.

**If the edge is 403 but the API is healthy — that is WAF.** `waf.tf` attaches
AWSManagedRulesCommonRuleSet (p1), KnownBadInputs (p2) and a per-IP rate limit to
CloudFront. A false positive usually looks like *one school, one action, always
fails* — a rich-text field or an upload tripping a SQLi/XSS signature.

```bash
aws wafv2 get-sampled-requests --scope CLOUDFRONT \
  --web-acl-arn <arn> --rule-metric-name common \
  --time-window StartTime=$(date -u -d '30 min ago' +%s),EndTime=$(date -u +%s) \
  --max-items 50
```

Fix by narrowing the rule with a scope-down statement — **never by removing the
rule group**. Turning off WAF to fix one form is trading a bug for exposure.

### 5.2 Everything is slow

Establish *where* the time goes before changing anything.

```bash
# ALB latency and volume over the last hour.
aws cloudwatch get-metric-statistics --namespace AWS/ApplicationELB \
  --metric-name TargetResponseTime --start-time $(date -u -d '1 hour ago' +%FT%TZ) \
  --end-time $(date -u +%FT%TZ) --period 300 --statistics Average Maximum \
  --dimensions Name=LoadBalancer,Value=<lb-id>
```

| Pattern | Likely cause | Action |
|---|---|---|
| ECS CPU >85%, RDS calm | Under-provisioned tasks | Autoscaling targets 60% CPU; raise `max_capacity` |
| RDS CPU >80% | A query, not the instance size | Performance Insights ↓ |
| Both calm, latency high | Downstream (gateway, email, S3) | Check provider status |
| Slow only for one school | Data volume or an unindexed path | Reproduce with their `school_id` |

**Performance Insights is enabled** on both writer and replica — go straight to
*Top SQL* and look for a query whose load changed. Do not resize the instance
before you have looked; the cause is nearly always one query, and resizing hides
it until it comes back worse.

Recent precedent worth knowing: a load test at 5,000 schools showed **the writer
idle** while the real fix was an entitlement-cache TTL. Measure, don't assume.

### 5.3 Database problems

**Storage <5 GB — treat as urgent.** A full disk makes Postgres reject writes:
every attendance mark, payment and grade fails.

```bash
aws rds describe-db-instances --db-instance-identifier "$NAME-pg" \
  --query 'DBInstances[0].{alloc:AllocatedStorage,max:MaxAllocatedStorage,class:DBInstanceClass,az:MultiAZ,status:DBInstanceStatus}'
```
Storage autoscaling should absorb this; if `max` is reached, raise it — this is
an online operation. Then find the growth: usually `audit_log` (partitioned) or
integrity telemetry whose retention sweep has stopped running (§5.11).

**Connections climbing** — check the pool, not the database. Every ECS task holds
a Prisma pool; `desired_count × pool_size` must stay under `max_connections`.
`rds_proxy.tf` exists for exactly this and pools safely with the RLS model,
because the tenant GUC is transaction-local.

**CPU >80%** — Performance Insights → Top SQL. Resist resizing first.

**Failover / instance replacing** — with `multi_az` this self-heals in 60–120s;
the app reconnects on its own. Without it you wait for the replacement. Nothing
to do but communicate (§3). `deletion_protection = true` and
`skip_final_snapshot = false` mean the data is safe either way.

### 5.4 Redis problems

Redis carries cache, rate-limit counters, BullMQ queues, and the pub/sub that
fans entitlement invalidation and live-game nudges across tasks.

**Evictions > 0 is the alarm that matters** — it means keys are being dropped.
Consequences here, in order of how much they'll hurt:

1. **Entitlement cache thrash** → modules flicker for schools mid-request.
2. **Rate-limit counters lost** → login throttling weakens.
3. **BullMQ jobs lost** → notifications and report generation silently stop.

The app degrades rather than dies without Redis (pub/sub falls back to
process-local), so a Redis outage is SEV-2, not SEV-1 — but **queued background
work is genuinely lost**, so afterwards check whether notifications and
scheduled sweeps actually ran.

### 5.5 A deploy went wrong

The pipeline is: OIDC → build/push ECR → point one-off task defs at the new image
→ **run the migrate task and wait** → roll services → `wait services-stable`.

**If the migrate step failed, stop.** Services may already be running new code
against an old schema. Roll back (§6) rather than pushing forward.

```bash
# Read the migrate task's own logs — it is a separate log stream.
aws logs tail "/ecs/$NAME/api" --since 30m --filter-pattern "entrypoint"
```

Three migration traps specific to this repo:

- **The migration history does not replay from scratch.** `20260713020000_multi_currency_billing` ALTERs `plan_price`, created only by the later-stamped `20260726000000_plan_pricing`. Already-migrated databases are fine. **Never fix this by reordering migration folders** — that breaks the checksum every migrated environment has recorded, including production. A genuinely fresh database must be built with `prisma db push`, not `migrate deploy`.
- **A new RLS file must be registered** in `apps/api/docker-entrypoint.sh` via `apply_rls <file> <last-policy-name>`. Miss it and the table ships **with no tenant isolation** — a SEV-1 waiting to happen. The RLS coverage meta-test catches this in CI; do not merge past it.
- **New permissions need the seed to re-run.** Otherwise the new endpoint 403s for everyone, including super_admin, and looks like a broken deploy.

### 5.6 Payments not landing

Money problems are SEV-2 and parents notice within minutes.

**The gateway almost never loses a payment — the webhook does.** There is a
designed recovery path; use it before touching the ledger by hand.

```bash
# 1. Was the webhook received at all? gateway_event logs every VERIFIED webhook
#    BEFORE dispatch, so absence here means it never arrived.
#    SELECT * FROM gateway_event WHERE reference = '<gateway-ref>';

# 2. Reconcile — lists the gateway's settled charges over a 3-day window and
#    posts anything missing from the ledger. Idempotent; safe to re-run.
curl -X POST "$APP_URL/api/fees/reconciliation/run" -H "Authorization: Bearer <super_admin>"
```

| Symptom | Cause | Action |
|---|---|---|
| Paid, invoice unchanged | Webhook lost | Run reconciliation ↑ |
| Paid twice, credited once | **Correct** — idempotent on gateway reference | Explain; refund the duplicate |
| Bank transfer unallocated | No open invoice | Landed as student CREDIT; finance notified |
| Payment stuck pending | ≥₦50,000 needs a second approver | Not a bug — §5.7 |
| Subscription paid, modules off | Entitlement cache (30s) or invalidation didn't fan out | Wait 30s; if persistent, check Redis pub/sub |

**Never hand-edit the ledger.** `InvoiceSettlementService` is the single
idempotent posting path; a manual row bypasses the audit trail and the
idempotency key, and you will double-post under retry.

Also check **disputes** — they carry gateway deadlines and are lost by default if
unanswered.

### 5.7 Nobody can log in

Work outward from the smallest scope:

| Scope | Likely cause | Fix |
|---|---|---|
| One user | 3 failed attempts = **permanent lock** | Admin reactivates. A super_admin's own lock auto-expires after 15 min. |
| One user, "password expired" | 30-day rotation | They reset it; working as designed |
| All staff at one school | `requireStaffMfa` on, nobody enrolled | Non-blocking by design — they're held on /account |
| Everyone, everywhere | `AUTH_SECRET` changed / unreadable | Check the secret; `AUTH_SECRET_PREVIOUS` exists for rotation |
| Everyone, 502s | Session cookie oversized | Budget is 3 KB; smoke test enforces it |
| One school entirely | School `DISABLED` by the operator | Intentional — verify before re-enabling |

**If you locked yourself out as the only super_admin**, `PLATFORM_OWNER_PASSWORD`
plus a re-run of the seed rewrites `owner@sms.platform`'s password. That is the
documented recovery path (see CLAUDE.md).

### 5.8 A scheduled job didn't run

EventBridge Scheduler runs the retention task daily at **02:30 UTC**
(`retention.tf`). Dunning, HR reminders, late fees, overdue reminders and
reconciliation run as BullMQ jobs inside the API.

```bash
aws scheduler get-schedule --name "$NAME-retention" --query '{state:State,expr:ScheduleExpression}'
aws ecs list-tasks --cluster "$CLUSTER" --family "$NAME-retention" --desired-status STOPPED
```

**The most common cause is a missing privileged URL.** Retention, dunning and HR
reminders all need `DATABASE_RETENTION_URL` (falling back to
`DATABASE_MIGRATE_URL`) because the app role deliberately has no DELETE on
telemetry tables and cannot read across tenants. **Unset ⇒ the job silently
disables itself.** Every one of these also has a manual trigger endpoint — use it
to catch up, they are all idempotent.

### 5.9 Suspected tenant isolation breach — SEV-1

**Stop. Do not debug this casually.** This is the failure the whole architecture
exists to prevent, and it is a reportable data breach under NDPR.

1. **Preserve evidence.** Screenshot, capture `request_id`, do not clear logs.
2. **Establish whether data actually crossed**, or whether it is a display bug —
   a stale cache or a wrong label is not a breach.
3. **Verify RLS is still enabled** on the table in question:

```sql
SELECT relname, relrowsecurity FROM pg_class
WHERE relname = '<table>' AND relnamespace = 'public'::regnamespace;
```

4. **Prove isolation directly** — as the app role under tenant A's GUC, count
   tenant B's rows. This is exactly what `restore-drill.sh` asserts:

```sql
SET LOCAL app.current_school_id = '<school-A-uuid>';
SELECT count(*) FROM <table> WHERE "schoolId" = '<school-B-uuid>';  -- MUST be 0
```

5. If a row genuinely crossed: **SEV-1 comms**, identify every affected record
   via the audit log, and start the NDPR clock. Notify affected schools; they have
   their own obligations to parents and cannot meet them if you delay.

Most likely root causes, in order: a new table whose RLS file was never
registered in `docker-entrypoint.sh`; a privileged-client query missing its
`school_id` filter; or a cache key missing the tenant.

### 5.10 Data loss or accidental deletion

Do not improvise. **`RUNBOOK-BACKUP-RESTORE.md` is the authority** — this is a
pointer, not a substitute.

- **Postgres:** PITR to any point in the last **14 days**; AWS Backup holds
  weekly/monthly for **90/365 days**. Restore to a **new instance** and reconcile
  — never restore in place over a live database.
- **Documents (S3):** bucket versioning means deletes and overwrites are
  recoverable; retrieve the prior version.
- **Financial and academic records are append-only by design** — invoices,
  payments, audit entries and disciplinary entries are not hard-deleted. If one
  is "missing", it was almost certainly never written. Check the audit log before
  reaching for a restore.

### 5.11 Security incident / exposed credentials

1. **Rotate first, investigate second.** Every secret lives in Secrets Manager
   (`secrets.tf`): `auth-secret`, `data-encryption-key`, the DB URLs, Paystack,
   Stripe, email and Twilio keys.
2. `AUTH_SECRET_PREVIOUS` exists so you can rotate the session secret **without
   signing everyone out** — set the old value there, the new one in `auth-secret`.
3. **`data-encryption-key` is different and dangerous.** It derives per-tenant
   keys for medical records and salaries. Rotating it without re-encrypting makes
   that data **permanently unreadable**. Plan a migration; do not rotate it in a
   panic.
4. Audit what the credential touched via `audit_log`, then work out disclosure
   obligations.

**Known precedent worth checking on any pre-existing environment:** databases
seeded before the demo-data fix contain `owner@sms.platform` with a public
password. Verify and rotate:

```sql
SELECT email, status FROM "user"
WHERE email LIKE '%@demo.school' OR email LIKE '%@sms.platform';
```

### 5.12 One school reports a problem nobody else has

Almost always configuration rather than a fault. Check in this order:

1. **Subscription status** — PAST_DUE beyond grace drops them to the entry tier,
   so modules vanish. Looks exactly like a bug.
2. **Their plan** — the module may never have been included.
3. **The user's roles** — a missing menu item is usually a missing role.
4. **Relationship scoping** — a teacher sees only their classes, a parent only
   their children. Working as designed, and the most common false report.
5. **`disabledAt` on the school**, and lockout state on the user.

---

## 6. Rollback

**Rolling back is not an admission of failure — it is the fastest path to
service.** Diagnose after the bleeding stops.

### 6.1 Automatic

Both services set `deployment_circuit_breaker { rollback = true }`. A deployment
whose tasks never pass health checks **rolls back on its own**. If you see
`rolloutState: FAILED`, the rollback already happened — your job is to find out
why, not to redeploy the same image.

### 6.2 Manual — code only

```bash
# Previous task definition revision.
PREV=$(aws ecs describe-task-definition --task-definition "$NAME-api" \
  --query 'taskDefinition.revision' --output text)
aws ecs update-service --cluster "$CLUSTER" --service "$NAME-api" \
  --task-definition "$NAME-api:$((PREV-1))" --force-new-deployment

aws ecs wait services-stable --cluster "$CLUSTER" --services "$NAME-api"
```

### 6.3 When a migration is involved — think first

**Code rolls back cleanly. Schema does not.** Before rolling back, ask whether
the old code can run against the new schema.

- **Additive migration** (new nullable column/table) — old code ignores it. Safe.
- **Destructive migration** (dropped/renamed column, tightened constraint) — old
  code will break. **Rolling back makes things worse.** Fix forward, or restore
  from PITR and accept the data loss between the restore point and now.

This is why additive-only migrations are worth the discipline: they keep
rollback available.

---

## 7. Recovery verification — prove it, don't assume it

Before declaring an incident over:

```bash
curl -sS -o /dev/null -w 'edge  %{http_code} %{time_total}s\n' "$APP_URL"
curl -sS -o /dev/null -w 'web   %{http_code} %{time_total}s\n' "$APP_URL/api/health"
# The one that matters — proves web -> API -> Postgres end to end.
curl -sS -o /dev/null -w 'chain %{http_code} %{time_total}s\n' "$APP_URL/api/public/plan-pricing"
aws cloudwatch describe-alarms --state-value ALARM --query 'MetricAlarms[].AlarmName'
```

Then check the things that fail *quietly*, which is where the second incident
usually hides:

- [ ] A real user can sign in — try each of principal, teacher, parent
- [ ] A payment posts end to end (or run reconciliation and confirm zero gaps)
- [ ] Notifications are being delivered, not just queued
- [ ] Scheduled sweeps ran, or were triggered manually to catch up
- [ ] No 5xx in the last 15 minutes: `--filter-pattern '{ $.level >= 50 }'`
- [ ] Tenant isolation intact if anything touched the schema (§5.9 step 4)

---

## 8. The post-mortem

**Write one for every SEV-1 and SEV-2, within 48 hours, while it is still
uncomfortable.** A post-mortem written a week later is fiction — everyone has
already rewritten the story to make themselves reasonable.

### 8.1 Blameless means specific, not vague

Blameless does not mean avoiding what happened. It means asking *why the system
allowed it* rather than *who did it*.

- Not: "Someone deployed a bad migration."
- But: "A destructive migration reached production because nothing in the
  pipeline distinguishes additive from destructive, and rollback is only safe for
  the former."

The first sentence produces a scolding. The second produces a CI check.

### 8.2 Template

Save as `docs/postmortems/YYYY-MM-DD-short-slug.md`.

```markdown
# Post-mortem — <short title>

- **Date:** YYYY-MM-DD
- **Severity:** SEV-n
- **Duration:** HH:MM UTC → HH:MM UTC (N minutes)
- **Author:** <name>
- **Status:** draft | reviewed | actions complete

## Impact
Who was affected, how many schools, and what they could not do. Quantify it:
"~40 schools could not record payments for 25 minutes; 12 payments were delayed
but none lost." Vague impact makes the whole document easy to ignore.

## Timeline (UTC)
| Time | Event |
|---|---|
| 09:14 | Deploy of `abc1234` completed |
| 09:19 | `-alb-target-5xx` alarm fired |
| 09:22 | Acknowledged; began triage |
| 09:31 | Rolled back to previous task definition |
| 09:36 | Alarms cleared; service confirmed restored |

Include **detection time** and **time to first comms** — those are usually the
biggest wins available.

## Root cause
The actual mechanism, not the trigger. Keep asking "why does that happen?" until
you reach something you can change. Stop at a system property, not a person.

## What went well
Genuinely list this. If the circuit breaker saved you, that is evidence the
investment paid off — and evidence for making the next one.

## What went badly
Where you were slow, blind, or lucky. **"We got lucky" belongs here** — luck is
not a control.

## Where we got lucky
Separate heading, because it is the most valuable section and the easiest to skip.
"Only 3 schools were mid-payment; at 14:00 on a fee deadline this would have been
40."

## Action items
| Action | Type | Owner | Due | Status |
|---|---|---|---|---|
| Add CI check flagging destructive migrations | prevent | | | |
| Alarm on migrate-task failure | detect | | | |
| Document rollback-with-migration in this runbook | mitigate | | | |

Every action is **prevent**, **detect** or **mitigate**. If you have no *detect*
item, ask why you found out from a user rather than an alarm.
```

### 8.3 Rules that keep post-mortems honest

- **Action items need an owner and a date**, or they are decoration.
- **Cap them at three to five.** Twenty actions means zero actions.
- **At least one must be shippable this week.** Momentum matters more than
  completeness.
- **Review the previous post-mortem's actions when writing a new one.** Repeat
  incidents are almost always unfinished action items.
- **Feed fixes back into this runbook** in the same PR as the code fix. A runbook
  that lags reality is worse than none, because it is trusted.

### 8.4 Do schools get told?

| Severity | Tell them | Contents |
|---|---|---|
| SEV-1 | **Always**, within 24h of resolution | What happened, whether their data was affected, what you changed |
| SEV-2 | If they noticed or asked | Plain summary, no internals |
| SEV-3/4 | Only the reporter | "Fixed, thanks for reporting" |

Never send them the internal post-mortem — it contains architecture detail and
blunt self-assessment. Write a short separate note. **If minors' data was
involved, that note may have legal weight: get the facts settled before sending.**

---

## 9. Preventing the next one

The controls already in place, so you know what you are relying on:

| Control | Where | Catches |
|---|---|---|
| Deployment circuit breaker + auto-rollback | `ecs.tf` | Bad releases that fail health checks |
| RLS coverage meta-test | `apps/api/test/rls.e2e-spec.ts` | A new tenant table with no isolation test |
| Pricing consistency test | `apps/web/lib/__tests__/` | Owner-facing docs drifting from real pricing |
| Route smoke, 18 roles × 91 routes | `pnpm smoke:routes` | SSR 500s that unit tests miss |
| Restore drill | `infrastructure/scripts/restore-drill.sh` | Backups that don't actually restore |
| Fail-closed demo seeding | `packages/db/prisma/seed.ts` | Demo credentials reaching production |
| 12 CloudWatch alarms → SNS | `alarms.tf` | Infrastructure symptoms |
| WAF managed rules + rate limit | `waf.tf` | Common attack traffic |

**Rehearse the restore drill quarterly.** A backup you have never restored is not
a backup — and an incident is the worst possible moment to discover that.
