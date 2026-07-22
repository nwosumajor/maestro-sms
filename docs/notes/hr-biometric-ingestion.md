# HR biometric ingestion

> HR program Phase 10 (FINAL) — biometric terminal ingestion (device registry, HMAC-signed events, code→staff mapping → staff_attendance BIOMETRIC); RLS file 63; simulated-device verified, UNCOMMITTED. COMPLETES the 15-item HR program.

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

**HR enhancement program Phase 10 (feature #15 biometric ingestion)** — built 2026-07-12, verified with a SIMULATED terminal, **UNCOMMITTED**. **The 15-item HR program is COMPLETE** (#12 covered by staff_document).

Two new tables (migration `20260822000000_biometric_ingestion`, RLS `63_biometric_rls.sql`, full CRUD — config not ledger; sentinel `biometric_enrollment_delete`): **`attendance_device`** (name, deviceId hex-6 unique per school, `secretEnc` — HMAC secret shown ONCE at registration, encrypted at rest, never readable again; enabled; lastSeenAt) + **`biometric_enrollment`** (schoolId+deviceUserId unique → userId; the terminal's own user codes mapped to staff). RLS-e2e 130/130.

**PRIVACY (the selling point)**: fingerprint/face templates NEVER enter the system — matching happens ON the device; we store only events (who/when/which device). Stated in schema comments + UI copy.

Ingestion: `PublicBiometricController` `@Public POST /public/biometric/:slug/events` (headers `x-device-id` + `x-device-signature`): school by slug (ZERO GUC) → device under school GUC (enabled; unknown→404) → **HMAC-SHA256 over the EXACT raw body** (`verifyDeviceSignature` in attendance.util: timingSafeEqual, needs main.ts `rawBody:true` which already exists for Paystack; bad sig→403) → **replay guard** `isFreshTimestamp` (batch timestamp ±10min; stale→409) → per event: enrollment map (unknown codes counted+skipped — a device can never create staff), date from event time, **existing (userId,date) mark wins** (idempotent alreadyMarked), else create `staff_attendance` source=BIOMETRIC, status via kiosk lateAfter, markedById=ZERO. Updates device.lastSeenAt. Response {accepted, alreadyMarked, unknown}. 6 attendance.util tests (2 new suites: HMAC + freshness).

Admin endpoints on `/hr/attendance`: POST/GET/DELETE `devices` (register returns {deviceId, secret} once; list hides secrets), POST/GET/DELETE `enrollments` (enroll requires ACTIVE employee; upsert by code). Web: `BiometricAdmin` card on /hr/attendance (register w/ one-time secret banner, device list w/ lastSeen, code→staff mapping).

Verified w/ simulated device (`scratchpad/verify-hr10.mjs` — signs batches like a ZKTeco push agent): register→secret once, hidden after; enroll 42→warden; signed batch → {accepted:1, unknown:1}; register shows **BIOMETRIC LATE** (kiosk lateAfter applied); replay → alreadyMarked:1; bad sig 403; stale ts 409; unknown device 404; wrong secret 403. Real-hardware validation deferred until the user has a physical terminal — the protocol surface is ready.

Full program: [hr-money-cluster](hr-money-cluster.md) [hr-runtypes-remittance](hr-runtypes-remittance.md) [hr-staff-attendance](hr-staff-attendance.md) [hr-duty-roster](hr-duty-roster.md) [hr-employment-lifecycle](hr-employment-lifecycle.md) [hr-exit-management](hr-exit-management.md) [hr-letter-generator](hr-letter-generator.md) [hr-careers-page](hr-careers-page.md) [hr-org-analytics-v2](hr-org-analytics-v2.md) + this. RLS files 58-63; migrations 20260815-20260822. ALL UNCOMMITTED (as is the LMS program + earlier work).
