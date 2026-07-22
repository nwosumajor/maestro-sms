# Payments completion program

> Six-item payments hardening (2026-07-21): lost-webhook recovery + event log, virtual accounts, installments/credit, USD invoices, fee ops — PLUS web UI, live per-role verification, help/API.md docs; all pushed

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

The user asked "anything missing in the payments system", picked all six gaps
I identified, and everything was built + pushed to origin/main (through
`38ebf48`, CI green) on 2026-07-21. Details in CLAUDE.md ("Payments completion
program"). Same session also shipped: dual-gateway chargeback disputes,
idle-session auto-logout (10min/60s-warning/return-to-page), analytics SQL
push-down, report-card vault persistence — all pushed, CI green.

Non-obvious facts:
- `InvoiceSettlementService` (SettlementModule) is the ONLY place an online
  invoice payment posts — webhook, verify-on-return, reconciliation, Stripe
  kind=invoice, and NUBAN transfers ALL route through it, idempotent on the
  gateway reference. New payment flows must reuse it, never re-implement.
- Paystack webhook dispatch order in PaymentGatewayService matters:
  gateway_event log → charge.dispute.* → metadata.kind (subscription/
  admission_form/credits/prepay) → dedicated-NUBAN (customer_code, no kind) →
  invoice charge. Stripe (BillingController): log → dispute → kind=invoice →
  subscription.
- RLS files go to 82; entrypoint registered through
  `82_invoice_adjustment_rls.sql invoice_adjustment_update`.
- SEED GOTCHA (bit us live): a permission in ROLE_PERMISSIONS but not seeded
  to the DB means 403 even for super_admin. seed.ts now upserts the UNION
  (ALL_PERMS) so the seed can't crash/miss, but a LIVE DB still needs the
  seed re-run after adding a permission (compose only seeds first provision).
  Run inside the container: PATH="/app/packages/db/node_modules/.bin:$PATH"
  cd /app/packages/db && DATABASE_URL="$DATABASE_MIGRATE_URL" tsx prisma/seed.ts
- Live per-role verification technique: docker exec into sms-backend-1, login
  via /auth/login, sign an HS256 JWT with jsonwebtoken (absolute path
  /app/node_modules/.pnpm/jsonwebtoken@9.0.3/... — bare require fails) using
  claims {userId, school_id, roles, permissions}, then hit localhost:3001.
  For UI: NextAuth CSRF login via curl cookie jar, grep rendered pages for
  role-scoped markers (beware substring false-positives like "Approve" in
  prose — use precise markers like '>Reject</button>').
- The live stack (rebuilt through the CreditPanel fix `38ebf48`) serves
  everything EXCEPT the docs/help commit that follows this memory write.
- API suite: 104 suites / 812 tests. API.md now says 605 endpoints / 74
  controllers. /help finance+parent+operator sections cover the new flows.
- [test-db-container](test-db-container.md) for how suites run locally.
