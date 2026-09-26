#!/usr/bin/env bash
# =============================================================================
# GO-LIVE REHEARSAL — run the production procedure before a school depends on it
# =============================================================================
# docs/PRODUCTION_DEPLOYMENT.md describes how to go live. It has never been
# followed end to end: `deploy.yml` has failed 100 of its last 100 runs (no AWS
# credentials), so the production path has never once executed. A procedure that
# has never been run is a hypothesis, and the go-live of a school management
# system is a poor place to test one.
#
# This script does not instruct — it EXECUTES and VERIFIES, and writes down what
# it could not check rather than passing over it. That distinction is the whole
# point: the guide already contains checkboxes, and a checkbox is ticked by a
# human who believes the thing is true.
#
# THREE OUTCOMES, and only one of them is silence:
#   PASS  verified, here and now, against the real thing
#   FAIL  verified false — the run exits non-zero
#   SKIP  could not be checked, and WHY — never counted as a pass
#
# A rehearsal that checked nothing must not look like a clean one, so the run
# fails if it recorded no checks at all.
#
# USAGE
#   AWS_PROFILE=rehearsal \
#   REHEARSAL_URL=https://rehearsal.example.com \
#   DOCS_BUCKET=... DB_URL=postgres://... \
#   ./go-live-rehearsal.sh [--phase infra|app|data|all]
#
# Each phase degrades independently: no bucket name, the infra phase SKIPs with
# a reason and the app phase still runs. Run what you can, read the gaps.
# =============================================================================
set -uo pipefail

PHASE="${1:---phase}"; [[ "$PHASE" == "--phase" ]] && PHASE="${2:-all}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
LOG="${REHEARSAL_LOG:-go-live-rehearsal-$STAMP.md}"
PASS=0; FAIL=0; SKIP=0

c_red()  { printf '\033[31m%s\033[0m\n' "$*"; }
c_grn()  { printf '\033[32m%s\033[0m\n' "$*"; }
c_yel()  { printf '\033[33m%s\033[0m\n' "$*"; }

record() { printf '| %s | %s | %s |\n' "$1" "$2" "${3//|/\\|}" >> "$LOG"; }
pass()   { PASS=$((PASS+1)); c_grn "PASS  $1"; record "PASS" "$1" "${2:-}"; }
fail()   { FAIL=$((FAIL+1)); c_red "FAIL  $1 — $2"; record "**FAIL**" "$1" "$2"; }
# A SKIP is a FINDING. It says this rehearsal did not prove the thing, and the
# reason is what somebody has to act on before go-live.
skip()   { SKIP=$((SKIP+1)); c_yel "SKIP  $1 — $2"; record "SKIP" "$1" "$2"; }

# Assert a command's output matches, in one line, so a check reads as a claim.
expect() { # expect <name> <expected> <actual>
  if [[ "$3" == "$2" ]]; then pass "$1" "$3"; else fail "$1" "expected $2, got ${3:-<nothing>}"; fi
}

need() { command -v "$1" >/dev/null 2>&1; }

cat > "$LOG" <<HDR
# Go-live rehearsal — $STAMP

Run of \`infrastructure/scripts/go-live-rehearsal.sh\`, phase \`$PHASE\`.

A **SKIP is a finding**, not a pass: it records something this rehearsal did not
prove and names why. Everything still on the SKIP list at go-live is a thing
being taken on trust.

| Result | Check | Detail |
|---|---|---|
HDR

# -----------------------------------------------------------------------------
# GUARD — this creates, writes and deletes. Never against a live tenant's data.
# -----------------------------------------------------------------------------
if [[ "${I_KNOW_THIS_IS_A_THROWAWAY_ACCOUNT:-}" != "yes" ]]; then
  c_red "REFUSING: set I_KNOW_THIS_IS_A_THROWAWAY_ACCOUNT=yes."
  c_red "This writes probe objects to the bucket and reads the database."
  c_red "Run it against a REHEARSAL account, never one holding a school's records."
  exit 2
fi

# =============================================================================
# PHASE: INFRA — the account, and the controls the guide asserts it has
# =============================================================================
phase_infra() {
  echo; echo "── infra ──"
  if ! need aws; then skip "infra" "aws CLI not installed"; return; fi
  if ! aws sts get-caller-identity >/dev/null 2>&1; then
    skip "infra" "no usable AWS credentials (this is why deploy.yml has never succeeded)"; return
  fi
  local acct; acct="$(aws sts get-caller-identity --query Account --output text)"
  record "INFO" "AWS account" "$acct"

  local B="${DOCS_BUCKET:-}"
  if [[ -z "$B" ]]; then
    skip "documents bucket" "DOCS_BUCKET unset — take it from \`terraform output documents_bucket\`"
  else
    # THE FIX THAT MAKES A DELETE REAL. Without this rule every deletion this
    # platform promises — NDPR erasure, lesson-recording retention, the
    # declined-applicant purge — is a delete marker over intact bytes.
    local rules
    rules="$(aws s3api get-bucket-lifecycle-configuration --bucket "$B" \
             --query 'Rules[].ID' --output text 2>/dev/null)"
    if [[ "$rules" == *"expire-noncurrent-versions"* ]]; then
      pass "S3 lifecycle: deletions actually delete" "rules: $rules"
    else
      fail "S3 lifecycle: deletions actually delete" \
           "rule 'expire-noncurrent-versions' ABSENT — every reported deletion is a delete marker over intact bytes (SEV-2 data protection)"
    fi

    expect "S3 versioning enabled" "Enabled" \
      "$(aws s3api get-bucket-versioning --bucket "$B" --query Status --output text 2>/dev/null)"

    local pab
    pab="$(aws s3api get-public-access-block --bucket "$B" \
           --query 'PublicAccessBlockConfiguration.[BlockPublicAcls,IgnorePublicAcls,BlockPublicPolicy,RestrictPublicBuckets]' \
           --output text 2>/dev/null | tr -d '\t ')"
    expect "S3 block-public-access (all four)" "TrueTrueTrueTrue" "$pab"

    expect "S3 default encryption is KMS" "aws:kms" \
      "$(aws s3api get-bucket-encryption --bucket "$B" \
         --query 'ServerSideEncryptionConfiguration.Rules[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm' \
         --output text 2>/dev/null)"

    # PROVE THE MECHANISM, not just the config. Put an object, delete it the way
    # the application does (no VersionId), and show the bytes are still there —
    # which is exactly why the lifecycle rule above has to exist. The EXPIRY
    # itself is time-based and cannot be rehearsed in an afternoon; that is
    # recorded as a gap rather than glossed.
    local K="rehearsal/${STAMP}/delete-marker-probe.txt"
    if printf 'rehearsal probe\n' | aws s3 cp - "s3://$B/$K" >/dev/null 2>&1; then
      aws s3api delete-object --bucket "$B" --key "$K" >/dev/null 2>&1
      local vers
      vers="$(aws s3api list-object-versions --bucket "$B" --prefix "$K" \
              --query 'length(Versions || `[]`)' --output text 2>/dev/null)"
      if [[ "$vers" == "1" ]]; then
        pass "a plain DeleteObject leaves the bytes behind" \
             "1 noncurrent version survives — the lifecycle rule is what removes it"
      else
        fail "a plain DeleteObject leaves the bytes behind" \
             "expected 1 surviving version, got ${vers:-<none>} — versioning may be off, re-check the assumptions above"
      fi
      # Clean up properly: every version AND the delete marker.
      aws s3api list-object-versions --bucket "$B" --prefix "$K" \
        --query '[Versions,DeleteMarkers][].[Key,VersionId]' --output text 2>/dev/null \
      | while read -r k v; do [[ -n "${v:-}" ]] && aws s3api delete-object --bucket "$B" --key "$k" --version-id "$v" >/dev/null 2>&1; done
      skip "lifecycle EXPIRY actually fires" \
           "time-based (documents_noncurrent_retention_days, default 7) — cannot be rehearsed synchronously. Re-check this bucket after that many days and confirm the version is gone."
    else
      skip "delete-marker mechanism" "could not write a probe object (check the task/user S3 policy)"
    fi
  fi

  local DBID="${RDS_INSTANCE_ID:-}"
  if [[ -z "$DBID" ]]; then
    skip "RDS posture" "RDS_INSTANCE_ID unset — take it from \`terraform output\`"
  else
    local rds
    rds="$(aws rds describe-db-instances --db-instance-identifier "$DBID" \
           --query 'DBInstances[0].[PubliclyAccessible,StorageEncrypted,DeletionProtection]' \
           --output text 2>/dev/null | tr -d '\t ')"
    expect "RDS: private, encrypted, deletion-protected" "FalseTrueTrue" "$rds"
  fi
}

# =============================================================================
# PHASE: APP — what the internet can reach, and what it must not
# =============================================================================
phase_app() {
  echo; echo "── app ──"
  local U="${REHEARSAL_URL:-}"
  if [[ -z "$U" ]]; then skip "application" "REHEARSAL_URL unset"; return; fi
  if ! need curl; then skip "application" "curl not installed"; return; fi
  local code
  code() { curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$@"; }

  # Over TLS only if the address IS https: curl validates the certificate by
  # default, so an https 200 proves it. Given a plain http:// address this used
  # to PASS "over TLS" having checked no TLS at all — found by running the
  # rehearsal against http://localhost.
  case "$U" in
    https://*) expect "homepage answers over TLS" "200" "$(code "$U/")" ;;
    *) skip "homepage answers over TLS" "REHEARSAL_URL is not https:// — TLS was not checked" ;;
  esac

  # THE REAL API PROBE. /api/health is the WEB tier's liveness check and answers
  # 200 with the API down — this codebase records that as a GOTCHA, so the
  # rehearsal must not repeat the mistake it warns about.
  expect "API is genuinely up (/api/public/plan-pricing)" "200" "$(code "$U/api/public/plan-pricing")"
  local h; h="$(code "$U/api/health")"
  record "INFO" "/api/health answered $h" "not evidence the API is up — it is the WEB tier's probe"

  # The BFF demands a session. A 200 here would mean tenant data reachable
  # without one.
  expect "BFF refuses without a session" "401" "$(code "$U/api/sms/students")"

  # An UNSIGNED webhook must be rejected — that is the proof signature
  # verification is actually running in this deployment, not merely written.
  expect "unsigned Paystack webhook is rejected" "401" \
    "$(code -X POST -H 'content-type: application/json' -d '{"event":"charge.success"}' "$U/api/webhooks/paystack")"
  expect "unknown webhook provider is refused" "404" \
    "$(code -X POST -H 'content-type: application/json' -d '{}' "$U/api/webhooks/not-a-provider")"

  # THE PUBLIC ORIGIN CANNOT ANSWER THIS, and that is the point. The ALB
  # forwards only /ws/* to the API (alb.tf priority 1), so `<domain>/metrics`
  # reaches the NEXT APP, where default-deny middleware redirects it to /login.
  # The guide used to say "expect 401/403, and if 200 the task definition lost
  # its METRICS_TOKEN wiring" — but from out here the API is not on the other
  # end at all, so that check could never see the thing it exists for, and the
  # status it predicted (307) was not one it listed.
  local m; m="$(code "$U/metrics")"
  local body; body="$(curl -s --max-time 20 "$U/metrics" | head -c 200)"
  if [[ "$m" != "200" && "$body" != *"# HELP"* && "$body" != *"# TYPE"* ]]; then
    pass "no Prometheus metrics on the public origin" "$m (the API is not reachable here, by design)"
  else
    fail "no Prometheus metrics on the public origin" \
         "got $m and a Prometheus-looking body — the API is exposed to the internet, which the ALB rules say it must not be"
  fi
  skip "METRICS_TOKEN is actually wired on the task" \
       "must be scraped from INSIDE the VPC (Cloud Map / the API target group) — no token should answer 403, a good token 200. From the internet this is unobservable, so a green go-live gate has never proved it."

  skip "role-heavy login + WebSocket LiveDot" \
       "needs a browser and credentials — Step 6 of the guide. The largest session cookie is what once exposed a proxy-header 502."
  skip "document upload + download round trip" \
       "needs an authenticated session; proves S3 presigner + KMS + bucket policy together"
  skip "email: invite arrives, SPF/DKIM pass" "needs a real mailbox and header inspection"
}

# =============================================================================
# PHASE: DATA — the isolation model, in the deployed database
# =============================================================================
phase_data() {
  echo; echo "── data ──"
  local D="${DB_URL:-}"
  if [[ -z "$D" ]]; then skip "database" "DB_URL unset (app role — major_user — not the superuser)"; return; fi
  if ! need psql; then skip "database" "psql not installed"; return; fi
  local q; q() { psql "$D" -tAc "$1" 2>/dev/null | tr -d ' '; }

  if ! q "SELECT 1" >/dev/null; then skip "database" "could not connect with DB_URL"; return; fi

  # Every tenant table must have row security ON. This mirrors the repo's own
  # rls.e2e coverage gate, run here against the DEPLOYED schema rather than a
  # test one — migrations bring TABLES and the RLS policies are applied
  # separately, so a table can land in production with row security off and no
  # CI run would show it.
  #
  # EXEMPT BY NAME, NEVER BY COUNT. `ultimate_participant` is the one documented
  # exemption (the cross-school arena: deliberately cross-tenant, no PII) — and
  # a bare "expect 1" would quietly accept a DIFFERENT table taking its place.
  local off
  off="$(q "SELECT coalesce(string_agg(c.relname, ',' ORDER BY c.relname), '')
            FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity=false
              AND c.relname <> 'ultimate_participant'
              AND EXISTS (SELECT 1 FROM information_schema.columns
                          WHERE table_name=c.relname AND column_name='schoolId')")"
  if [[ -z "$off" ]]; then
    pass "every tenant table has RLS enabled" "only the documented arena exemption"
  else
    fail "every tenant table has RLS enabled" "row security OFF on: $off — these are readable across tenants"
  fi

  # And the carve-out must not go stale: if the exempt table is gone, the
  # exemption above is silently protecting nothing and should be deleted.
  local arena
  arena="$(q "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
              WHERE n.nspname='public' AND c.relname='ultimate_participant'")"
  expect "the one documented RLS exemption still exists" "1" "$arena"

  # Least privilege is real, not intended.
  if psql "$D" -c "CREATE TABLE rehearsal_should_fail(id int)" >/dev/null 2>&1; then
    psql "$D" -c "DROP TABLE rehearsal_should_fail" >/dev/null 2>&1
    fail "app role cannot create tables" "CREATE TABLE SUCCEEDED — the app role is over-privileged (Golden Rule #4)"
  else
    pass "app role cannot create tables" "CREATE TABLE refused"
  fi

  # A tenant table read with NO GUC set must return nothing.
  local leaked; leaked="$(q "SELECT count(*) FROM student_profile")"
  expect "no GUC set ⇒ no tenant rows visible" "0" "$leaked"

  # THE APP ROLE CANNOT READ THIS, and that is correct — least privilege means
  # major_user has no business in the migration history. A rehearsal must not
  # demand a superuser to feel complete, so this SKIPs with the query to run
  # rather than failing on a permission that is working as designed.
  local failed; failed="$(q "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NULL")"
  if [[ -z "$failed" ]]; then
    skip "no migration left unfinished" \
         "_prisma_migrations is not readable by the app role (correct). Run as the migrate role: SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NULL — a failed migration LOCKS the whole history."
  else
    expect "no migration left unfinished" "0" "$failed"
  fi

  # Demo credentials in a live system are a breach waiting.
  local demo; demo="$(q "SELECT count(*) FROM \"user\" WHERE email LIKE '%@demo.school'")"
  expect "no demo accounts present" "0" "$demo"

  skip "cross-tenant probe with a second school's GUC" \
       "needs two provisioned tenants; docs/RUNBOOK-INCIDENT-RESPONSE.md §5.9 has the query"
}

case "$PHASE" in
  infra) phase_infra ;;
  app)   phase_app ;;
  data)  phase_data ;;
  all)   phase_infra; phase_app; phase_data ;;
  *)     c_red "unknown phase: $PHASE"; exit 2 ;;
esac

# Gaps that no rehearsal can close, written down so they are decided rather than
# forgotten. Each is something the product does that has never been exercised.
cat >> "$LOG" <<'GAPS'

## Never exercised anywhere, by anyone

These are not script limitations — they are untested paths in the product, named
here so going live is a decision rather than an assumption.

- **The deploy workflow itself.** `deploy.yml` has failed every run it has ever
  had (no AWS credentials). The first successful production deploy will also be
  its first test.
- **Mobile-money rails.** CLAUDE.md is explicit: no provider sandbox has ever
  been exercised for M-Pesa, MTN MoMo or Airtel. The wire tests pin each
  provider's published contract, which is necessary and not sufficient. Run that
  provider's sandbox before switching a school on.
- **Live card charging.** Paystack/Stripe are verified on the disabled and
  public paths only.
- **Lifecycle expiry.** Time-based; confirm the noncurrent version is gone after
  `documents_noncurrent_retention_days`.
- **Restore drill.** `infrastructure/scripts/restore-drill.sh` exists and is the
  authority — run it against the rehearsal account, not just locally.
GAPS

printf '\n' >> "$LOG"
printf '**%d passed, %d failed, %d skipped.**\n' "$PASS" "$FAIL" "$SKIP" >> "$LOG"

echo
echo "─────────────────────────────────────────────"
printf 'passed %d   failed %d   skipped %d\n' "$PASS" "$FAIL" "$SKIP"
echo "gap log: $LOG"

# A walk that finds nothing must not pass.
if (( PASS + FAIL == 0 )); then
  c_red "NOTHING WAS ACTUALLY CHECKED — every phase degraded to SKIP."
  c_red "That is not a clean rehearsal; it is a rehearsal that did not happen."
  exit 3
fi
(( FAIL > 0 )) && exit 1
exit 0
