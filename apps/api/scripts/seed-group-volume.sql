-- =============================================================================
-- seed-group-volume.sql — a multi-campus group with years of history
-- =============================================================================
-- The group console and the ledger-integrity check read across many campuses,
-- and "owed now" reads every billable invoice a campus has EVER raised (the
-- finance report's definition). Neither had been timed on more than a dozen
-- invoices. This builds what a large proprietor's chain looks like:
--
--   :campuses campuses (default 30), each with
--     :pupils pupils (default 500), 25 staff, 20 classes, enrolments
--     ten academic years of THREE dated terms, the current one flagged
--     one invoice per pupil per term for ten years  (~15,000 per campus)
--       90% PAID in full, 7% part-paid, 3% unpaid; payments to match
--     a register per class per school day for the last ~11 months, every pupil
--       marked (~100,000 marks per campus)
--   one school_group over all of them, and a second over the first ten, both
--   directed by staff at campus 1.
--
-- RUN IT AGAINST A THROWAWAY DATABASE, never a shared one:
--   docker exec sms-test-pg psql -U postgres -c "CREATE DATABASE sms_perf TEMPLATE sms_test"
--   docker exec -i sms-test-pg psql -U postgres -d sms_perf -v campuses=30 -v pupils=500 \
--     < apps/api/scripts/seed-group-volume.sql
-- and drop it afterwards. It writes no teardown of its own for that reason.
--
-- Bulk SQL as the SUPERUSER (RLS bypassed, schoolId explicit on every row), as
-- seed-volume.sql does. `docker exec` needs `-i` or the heredoc is ignored.
-- =============================================================================

\set ON_ERROR_STOP on
\if :{?campuses} \else \set campuses 30 \endif
\if :{?pupils} \else \set pupils 500 \endif

BEGIN;

-- --- monthly partitions for every month the registers will fill -------------
-- A mark landing in DEFAULT would later block that month's partition.
DO $$
DECLARE m date;
BEGIN
  FOR m IN SELECT generate_series(date_trunc('month', current_date - interval '12 months'), date_trunc('month', current_date), interval '1 month')::date LOOP
    IF to_regclass('attendance_record_' || to_char(m, 'YYYY_MM')) IS NULL THEN
      EXECUTE format('CREATE TABLE %I PARTITION OF attendance_record FOR VALUES FROM (%L) TO (%L)',
        'attendance_record_' || to_char(m, 'YYYY_MM'), m, (m + interval '1 month')::date);
    END IF;
  END LOOP;
END $$;

-- --- campuses ----------------------------------------------------------------
CREATE TEMP TABLE campus AS
SELECT gen_random_uuid() AS id, g AS n FROM generate_series(1, :campuses) g;

INSERT INTO school (id, name, slug, country, "updatedAt")
SELECT id, 'VOLG Campus ' || lpad(n::text, 2, '0'), 'volg-' || n, 'NG', now() FROM campus;

INSERT INTO school_subscription (id, "schoolId", plan, status, "currentPeriodEnd", "updatedAt")
SELECT gen_random_uuid(), id, 'ENTERPRISE', 'ACTIVE', now() + interval '200 days', now() FROM campus;

-- --- people --------------------------------------------------------------------
CREATE TEMP TABLE pupil AS
SELECT gen_random_uuid() AS id, c.id AS school_id, c.n AS campus, g AS n
  FROM campus c, generate_series(1, :pupils) g;
CREATE TEMP TABLE staff AS
SELECT gen_random_uuid() AS id, c.id AS school_id, c.n AS campus, g AS n
  FROM campus c, generate_series(1, 25) g;

INSERT INTO "user" (id, "schoolId", email, name, "passwordHash", "updatedAt")
SELECT id, school_id, 'volg' || campus || '.s' || n || '@volg.test', 'VOLG Pupil ' || n, '!no-password-set', now() FROM pupil;
INSERT INTO "user" (id, "schoolId", email, name, "passwordHash", "updatedAt")
SELECT id, school_id, 'volg' || campus || '.t' || n || '@volg.test', 'VOLG Teacher ' || n, '!no-password-set', now() FROM staff;

INSERT INTO user_role (id, "schoolId", "userId", "roleId")
SELECT gen_random_uuid(), school_id, id, (SELECT id FROM role WHERE name = 'student') FROM pupil;
INSERT INTO user_role (id, "schoolId", "userId", "roleId")
SELECT gen_random_uuid(), school_id, id, (SELECT id FROM role WHERE name = 'teacher') FROM staff;

-- --- classes and the roll --------------------------------------------------------
CREATE TEMP TABLE klass AS
SELECT gen_random_uuid() AS id, c.id AS school_id, c.n AS campus, g AS n FROM campus c, generate_series(1, 20) g;
INSERT INTO class (id, "schoolId", name, "updatedAt")
SELECT id, school_id, 'VOLG Class ' || n, now() FROM klass;

-- Pupil n sits in class ((n - 1) % 20) + 1, enrolled two years ago.
INSERT INTO enrollment (id, "schoolId", "classId", "studentId", "enrolledAt")
SELECT gen_random_uuid(), p.school_id, k.id, p.id, now() - interval '2 years'
  FROM pupil p JOIN klass k ON k.school_id = p.school_id AND k.n = ((p.n - 1) % 20) + 1;

-- --- ten academic years of three dated terms ---------------------------------------
-- Year y starts in September of (this year - y): terms Sep–Dec, Jan–Apr, Apr–Jul.
CREATE TEMP TABLE yr AS
SELECT y, (date_trunc('year', current_date)::date - make_interval(years => y) + interval '8 months')::date AS starts
  FROM generate_series(0, 9) y;
-- The current academic year began LAST September if today is before September.
UPDATE yr SET starts = (starts - interval '1 year')::date WHERE (SELECT min(starts) FROM yr) > current_date;

CREATE TEMP TABLE acyear AS
SELECT gen_random_uuid() AS id, c.id AS school_id, yr.y, yr.starts FROM campus c, yr;
INSERT INTO academic_session (id, "schoolId", name, "startDate", "endDate", "isCurrent", "updatedAt")
SELECT id, school_id, 'VOLG ' || extract(year FROM starts) || '/' || (extract(year FROM starts) + 1),
       starts, (starts + interval '11 months')::date, y = 0, now()
  FROM acyear;

CREATE TEMP TABLE vterm AS
SELECT gen_random_uuid() AS id, a.school_id, a.id AS session_id, a.y, t.seq,
       (a.starts + t.from_off)::date AS start_date, (a.starts + t.to_off)::date AS end_date
  FROM acyear a,
       (VALUES (1, interval '0 days',   interval '105 days'),
               (2, interval '120 days', interval '215 days'),
               (3, interval '230 days', interval '320 days')) AS t(seq, from_off, to_off);
INSERT INTO term (id, "schoolId", "sessionId", name, sequence, "isCurrent", "startDate", "endDate", "updatedAt")
SELECT id, school_id, session_id, 'Term ' || seq, seq, false, start_date, end_date, now()
  FROM vterm;
-- The CURRENT term: the most recently started one at each campus.
UPDATE term SET "isCurrent" = true
 WHERE id IN (SELECT DISTINCT ON (school_id) id FROM vterm WHERE start_date <= current_date ORDER BY school_id, start_date DESC);

-- A mid-term holiday in the current year at every campus.
INSERT INTO school_holiday (id, "schoolId", name, "startDate", "endDate", "createdById", "updatedAt")
SELECT gen_random_uuid(), t.school_id, 'VOLG mid-term', (t.start_date + 50), (t.start_date + 54),
       (SELECT s.id FROM staff s WHERE s.school_id = t.school_id AND s.n = 1), now()
  FROM vterm t WHERE t.y = 0 AND t.seq = 1;

-- --- ten years of invoices and payments ---------------------------------------------
-- One per pupil per term. ~90% paid in full, ~7% part-paid, ~3% unpaid, chosen
-- by a hash so the mix is stable run to run.
CREATE TEMP TABLE vinv AS
SELECT gen_random_uuid() AS id, p.school_id, p.id AS pupil_id, t.end_date AS due,
       150000 + (abs(hashtext(p.id::text || t.id::text)) % 5) * 10000 AS total,
       abs(hashtext(t.id::text || p.id::text)) % 100 AS roll
  FROM pupil p JOIN vterm t ON t.school_id = p.school_id AND t.start_date <= current_date;

INSERT INTO invoice (id, "schoolId", "studentId", reference, "dueDate", "createdById", "totalMinor", status, currency, "issuedAt", "createdAt", "updatedAt")
SELECT i.id, i.school_id, i.pupil_id, 'VOLG-' || left(i.id::text, 13), i.due,
       (SELECT s.id FROM staff s WHERE s.school_id = i.school_id AND s.n = 1), i.total,
       (CASE WHEN i.roll < 90 THEN 'PAID' WHEN i.roll < 97 THEN 'PARTIALLY_PAID' ELSE 'ISSUED' END)::"InvoiceStatus",
       'NGN', i.due - 60, i.due - 60, i.due - 60
  FROM vinv i;

INSERT INTO payment (id, "schoolId", "invoiceId", "amountMinor", method, "recordedById", kind, status, "paidAt", "createdAt")
SELECT gen_random_uuid(), i.school_id, i.id,
       CASE WHEN i.roll < 90 THEN i.total ELSE i.total / 2 END,
       'CASH', (SELECT s.id FROM staff s WHERE s.school_id = i.school_id AND s.n = 1),
       'PAYMENT', 'POSTED', i.due - 20, i.due - 20
  FROM vinv i WHERE i.roll < 97;

-- --- a year of registers: every class, every school day, every pupil marked ----------
CREATE TEMP TABLE vday AS
SELECT DISTINCT t.school_id, d::date AS d
  FROM vterm t, generate_series(greatest(t.start_date, current_date - 330), least(t.end_date, current_date), interval '1 day') d
 WHERE extract(dow FROM d) BETWEEN 1 AND 5
   AND NOT EXISTS (SELECT 1 FROM school_holiday h WHERE h."schoolId" = t.school_id AND d::date BETWEEN h."startDate" AND h."endDate");

CREATE TEMP TABLE vsess AS
SELECT gen_random_uuid() AS id, k.school_id, k.id AS class_id, v.d
  FROM klass k JOIN vday v ON v.school_id = k.school_id;
INSERT INTO attendance_session (id, "schoolId", "classId", date, "takenById", "takenAt", "updatedAt")
SELECT s.id, s.school_id, s.class_id, s.d, (SELECT st.id FROM staff st WHERE st.school_id = s.school_id AND st.n = 1),
       s.d + time '08:30', now()
  FROM vsess s;

INSERT INTO attendance_record ("schoolId", "sessionId", "studentId", status, date, "updatedAt")
SELECT s.school_id, s.id, p.id,
       (CASE abs(hashtext(p.id::text || s.d::text)) % 20 WHEN 0 THEN 'ABSENT' WHEN 1 THEN 'LATE' WHEN 2 THEN 'EXCUSED' ELSE 'PRESENT' END)::"AttendanceStatus",
       s.d, now()
  FROM vsess s
  JOIN klass k ON k.id = s.class_id
  JOIN pupil p ON p.school_id = s.school_id AND ((p.n - 1) % 20) + 1 = k.n;

-- --- the groups -------------------------------------------------------------------
INSERT INTO school_group (id, name, "updatedAt") VALUES
  ('00000000-0000-4000-8000-000000000030', 'VOLG All Campuses', now()),
  ('00000000-0000-4000-8000-000000000010', 'VOLG First Ten', now());
INSERT INTO school_group_member (id, "groupId", "schoolId")
SELECT gen_random_uuid(), '00000000-0000-4000-8000-000000000030', id FROM campus;
INSERT INTO school_group_member (id, "groupId", "schoolId")
SELECT gen_random_uuid(), '00000000-0000-4000-8000-000000000010', id FROM campus WHERE n <= 10;
INSERT INTO school_group_director (id, "groupId", "userId")
SELECT gen_random_uuid(), g, (SELECT s.id FROM staff s JOIN campus c ON c.id = s.school_id WHERE c.n = 1 AND s.n = 1)
  FROM unnest(ARRAY['00000000-0000-4000-8000-000000000030', '00000000-0000-4000-8000-000000000010']::uuid[]) g;

COMMIT;

-- Fresh statistics, or the first measurement plans against an empty table.
VACUUM ANALYZE invoice;
VACUUM ANALYZE payment;
VACUUM ANALYZE attendance_session;
VACUUM ANALYZE attendance_record;
VACUUM ANALYZE enrollment;
VACUUM ANALYZE term;

SELECT (SELECT count(*) FROM school WHERE slug LIKE 'volg-%') AS campuses,
       (SELECT count(*) FROM invoice WHERE reference LIKE 'VOLG-%') AS invoices,
       (SELECT count(*) FROM payment p JOIN school s ON s.id = p."schoolId" WHERE s.slug LIKE 'volg-%') AS payments,
       (SELECT count(*) FROM attendance_session s JOIN school sc ON sc.id = s."schoolId" WHERE sc.slug LIKE 'volg-%') AS registers,
       (SELECT count(*) FROM attendance_record r JOIN school sc ON sc.id = r."schoolId" WHERE sc.slug LIKE 'volg-%') AS marks,
       (SELECT count(*) FROM term t JOIN school sc ON sc.id = t."schoolId" WHERE sc.slug LIKE 'volg-%' AND t."isCurrent") AS current_terms;
