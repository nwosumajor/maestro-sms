# HR staff attendance

> HR program Phase 3 — anti-spoofing staff attendance (admin register + TOTP kiosk clock-in, IP flag signals); 2 new RLS tables (file 59); live-verified, UNCOMMITTED

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

**HR enhancement program Phase 3 (feature #6 staff attendance, anti-spoofing design)** — built 2026-07-12, live-verified, **UNCOMMITTED**. The design answers the user's "can staff clock in from home?" concern: presence must be attested by something physically at school.

Two new tables (migration `20260817000000_staff_attendance`, RLS `59_staff_attendance_rls.sql`, sentinel `attendance_kiosk_update`, both SELECT/INSERT/UPDATE no DELETE): **`staff_attendance`** — UNIFIED across capture modes (`source`: ADMIN | SELF_KIOSK | BIOMETRIC-future), unique(userId,date), `flagged` = anomaly SIGNAL (never auto-punitive, Golden Rule #8), corrections are updates; **`attendance_kiosk`** — one per school: field-ENCRYPTED TOTP secret (never leaves server; rotate invalidates codes), allowedIps (comma/prefix list), windowStart/End, lateAfter.

**Mode A** (default): `POST /hr/attendance/mark` (hr.write) upserts; `GET register/:date` (all ACTIVE employees × mark), `GET summary?year&month`, `GET me` (hr.self). **Mode B**: reuses the hand-rolled RFC-6238 `auth/totp.ts` (30s step, ±1 window). `GET kiosk/code` (hr.read — the gate display) returns {code, secondsRemaining}; `POST clock-in {code}` (hr.self): requires ACTIVE employee record, window enforced (409), wrong code 409 + AUDITED as `hr.attendance.clockin.badcode` (signal), status derived server-side from lateAfter, **off-allowlist IP → flagged=true (signal, not block)**, idempotent per day (existing mark returned, incl. an ADMIN mark). IP from first x-forwarded-for hop. Pure `attendance.util.ts` (hhmmToMinutes/inClockInWindow/deriveClockInStatus/ipMatchesAllowlist) — 4 unit tests.

Web: `/hr/attendance` page (register w/ P/L/A buttons + ⚑ review badges; kiosk card w/ big rotating display code polled 5s, enable/rotate/IPs/lateAfter; monthly summary) + `MyAttendance` on /leave (code entry + history; hides form once marked today). Nav: "Attendance →" from /hr.

Verified live: admin mark ABSENT → register/self-history/summary consistent; teacher mark → 403; secret hidden from config DTO; wrong code 409; real code accepted; clock-in with existing mark → same row (idempotent); fresh clock-in → **LATE** (after lateAfter) + **flagged** (IP off '10.99.'); outside window 409; **rotated secret kills old codes** (409); summary P/L/A/F counts exact. RLS **125/125** (2 new cases), attendance.util 4/4, api+web tsc 0, route smoke 69 routes green.

Phases done: [hr-money-cluster](hr-money-cluster.md) (1), [hr-runtypes-remittance](hr-runtypes-remittance.md) (2), this (3). Next: #7 duty rostering, #8 contracts/confirmation, #9 exit management (Tier 2 remainder), then Tier 3 + #15 biometric ingestion (device registry + HMAC events → same staff_attendance table with source BIOMETRIC).
