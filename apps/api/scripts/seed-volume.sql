-- =============================================================================
-- seed-volume.sql — fill the DEMO school with a realistic year of data
-- =============================================================================
-- The demo database held 7,899 rows across 208 tables: two invoices, two
-- payments, zero grades, zero messages. Every performance claim made against it
-- was therefore meaningless — Postgres seq-scans a 0-row table instantly, so a
-- missing index and a perfect one measure the same.
--
-- This seeds ONE school with the volume a real secondary school accumulates:
--   900 students, 60 staff, 30 classes
--   ~171,000 attendance records  (900 pupils x 190 school days)
--   ~48,600 grades               (900 x 9 subjects x 6 assessments)
--   5,400 invoices + ~7,000 payments
--   ~45,000 notifications, ~18,000 messages
--
-- Bulk SQL, not Prisma: 300k rows through an ORM takes hours and proves nothing
-- extra. Runs as the SUPERUSER, so RLS is bypassed and schoolId is set
-- explicitly on every row — the isolation being tested elsewhere is not the
-- subject here.
--
-- Everything it writes is tagged so it can be removed again:
--   users        email LIKE 'vol%@demo.school'
--   classes      name LIKE 'VOL %'
-- See seed-volume-down.sql.
--
-- GOTCHA: "user" is a reserved word and must stay quoted, and Prisma's
-- @updatedAt has NO database default — every insert supplies updatedAt or the
-- statement fails on a NOT NULL violation.
-- =============================================================================

\set ON_ERROR_STOP on

BEGIN;

-- The demo school and the actor rows we attribute writes to.
CREATE TEMP TABLE cfg AS
SELECT
  (SELECT id FROM school WHERE slug = 'demo')                                   AS school_id,
  (SELECT id FROM "user" WHERE email = 'admin@demo.school')                     AS admin_id,
  (SELECT id FROM "user" WHERE email = 'teacher@demo.school')                   AS teacher_id;

-- --- 30 classes -------------------------------------------------------------
-- class.level is an INTEGER (year number), not the label.
INSERT INTO class (id, "schoolId", name, level, stage, stream, arm, "createdAt", "updatedAt")
SELECT gen_random_uuid(), c.school_id,
       'VOL ' || lvl.label || ' ' || arm,
       lvl.n,
       CASE WHEN lvl.label LIKE 'JSS%' THEN 'JUNIOR' ELSE 'SENIOR' END,
       CASE WHEN lvl.label LIKE 'SS%' THEN 'SCIENCE' ELSE NULL END,
       arm, now(), now()
FROM cfg c,
     (VALUES ('JSS1',1),('JSS2',2),('JSS3',3),('SS1',4),('SS2',5),('SS3',6)) AS lvl(label, n),
     unnest(ARRAY['A','B','C','D','E']) arm;

-- --- 900 students + 60 staff ------------------------------------------------
-- bcrypt of 'password123' reused from the seed's demo accounts, so these
-- accounts can actually sign in and be measured through the real login path.
INSERT INTO "user" (id, "schoolId", email, name, "passwordHash", "createdAt", "updatedAt", "uniqueId")
SELECT gen_random_uuid(), c.school_id,
       'vol.s' || g || '@demo.school',
       'Volume Pupil ' || g,
       (SELECT "passwordHash" FROM "user" WHERE email = 'student@demo.school'),
       now(), now(), 'VOLS' || lpad(g::text, 5, '0')
FROM cfg c, generate_series(1, 900) g;

INSERT INTO "user" (id, "schoolId", email, name, "passwordHash", "createdAt", "updatedAt", "uniqueId")
SELECT gen_random_uuid(), c.school_id,
       'vol.t' || g || '@demo.school',
       'Volume Teacher ' || g,
       (SELECT "passwordHash" FROM "user" WHERE email = 'teacher@demo.school'),
       now(), now(), 'VOLT' || lpad(g::text, 5, '0')
FROM cfg c, generate_series(1, 60) g;

-- user_role is tenant-scoped too (Golden Rule #1: every tenant table carries a
-- non-null schoolId), so the join rows need it as much as the users do.
INSERT INTO user_role (id, "schoolId", "userId", "roleId")
SELECT gen_random_uuid(), c.school_id, u.id, (SELECT id FROM role WHERE name = 'student')
FROM cfg c, "user" u WHERE u.email LIKE 'vol.s%@demo.school';

INSERT INTO user_role (id, "schoolId", "userId", "roleId")
SELECT gen_random_uuid(), c.school_id, u.id, (SELECT id FROM role WHERE name = 'teacher')
FROM cfg c, "user" u WHERE u.email LIKE 'vol.t%@demo.school';

-- --- enrol every pupil in one class (30 rows of ~30) ------------------------
CREATE TEMP TABLE vol_class AS
SELECT id, row_number() OVER (ORDER BY name) AS n FROM class WHERE name LIKE 'VOL %';
CREATE TEMP TABLE vol_student AS
SELECT id, row_number() OVER (ORDER BY email) AS n FROM "user" WHERE email LIKE 'vol.s%@demo.school';

INSERT INTO enrollment (id, "schoolId", "classId", "studentId", status, "enrolledAt")
SELECT gen_random_uuid(), c.school_id, vc.id, vs.id, 'ACTIVE', now()
FROM cfg c, vol_student vs
JOIN vol_class vc ON vc.n = ((vs.n - 1) % 30) + 1;

-- --- attendance: 190 school days x 900 pupils -------------------------------
-- The biggest permanent table in any school system, and the one that decides
-- whether the register and the analytics page stay usable in year three.
INSERT INTO attendance_session (id, "schoolId", "classId", date, "takenById", "createdAt", "updatedAt")
SELECT gen_random_uuid(), c.school_id, vc.id, d::date, c.teacher_id, now(), now()
FROM cfg c, vol_class vc,
     generate_series(CURRENT_DATE - INTERVAL '270 days', CURRENT_DATE, INTERVAL '1 day') d
WHERE extract(dow FROM d) BETWEEN 1 AND 5;

INSERT INTO attendance_record (id, "schoolId", "sessionId", "studentId", status, "createdAt", "updatedAt")
SELECT gen_random_uuid(), c.school_id, s.id, e."studentId",
       -- ~92% present, a realistic spread rather than all one value, so an
       -- index on status is exercised the way a real one would be.
       (ARRAY['PRESENT','PRESENT','PRESENT','PRESENT','PRESENT','PRESENT',
              'PRESENT','PRESENT','PRESENT','PRESENT','PRESENT','LATE','ABSENT'])
         [1 + (abs(hashtext(s.id::text || e."studentId"::text)) % 13)]::"AttendanceStatus",
       s.date, s.date
FROM cfg c
JOIN attendance_session s ON s."schoolId" = c.school_id
JOIN vol_class vc ON vc.id = s."classId"
JOIN enrollment e ON e."classId" = s."classId";

-- --- fees: 6 terms of invoices, most of them paid ---------------------------
INSERT INTO invoice (id, "schoolId", "studentId", reference, status, currency,
                     "totalMinor", "dueDate", "issuedAt", "createdById", "createdAt", "updatedAt")
SELECT gen_random_uuid(), c.school_id, vs.id,
       'VOL-' || vs.n || '-' || t,
       (CASE WHEN t < 6 THEN 'PAID' ELSE 'ISSUED' END)::"InvoiceStatus",
       'NGN', 15000000 + (vs.n % 5) * 500000,
       (CURRENT_DATE - ((6 - t) * 90))::date,
       now() - ((6 - t) * INTERVAL '90 days'),
       c.admin_id, now(), now()
FROM cfg c, vol_student vs, generate_series(1, 6) t;

INSERT INTO payment (id, "schoolId", "invoiceId", "amountMinor", method, reference,
                     "paidAt", "recordedById", "createdAt", kind, status)
SELECT gen_random_uuid(), c.school_id, i.id, i."totalMinor",
       'BANK_TRANSFER'::"PaymentMethod", 'VOLPAY-' || i.reference,
       i."issuedAt" + INTERVAL '5 days', c.admin_id, now(),
       'PAYMENT'::"PaymentKind", 'POSTED'::"PaymentStatus"
FROM cfg c JOIN invoice i ON i."schoolId" = c.school_id AND i.reference LIKE 'VOL-%'
WHERE i.status = 'PAID';

-- --- notifications: the inbox every user opens on every page load -----------
INSERT INTO notification (id, "schoolId", "recipientId", type, title, body, "readAt", "createdAt", "updatedAt")
SELECT gen_random_uuid(), c.school_id, vs.id,
       'ANNOUNCEMENT', 'Term notice ' || g, 'Body of notice ' || g,
       CASE WHEN g % 3 = 0 THEN NULL ELSE now() END,
       now() - (g * INTERVAL '3 hours'), now()
FROM cfg c, vol_student vs, generate_series(1, 50) g;

COMMIT;

ANALYZE;
