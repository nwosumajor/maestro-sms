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
--   ~175,000 attendance records  (900 pupils x ~195 school days)
--   5,400 invoices + line items + ~4,500 payments
--   ~45,000 notifications
--   900 SIS profiles + ~1,800 emergency contacts + ~150 medical records
--
-- NOT SEEDED, and named here because this header used to claim two of them:
--   grades / submissions / assessments  — so the gradebook, report cards, term
--                                         results and the grade analytics have
--                                         still never been measured at volume
--   messages                            — the messaging module likewise
-- Adding those needs assessments and a term structure to hang them from; until
-- someone does, treat any performance claim about those modules as unmeasured.
-- An earlier version of this comment listed "~48,600 grades" and "~18,000
-- messages" that no statement in the file ever wrote, which is worse than
-- listing nothing: it retires the question.
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
-- totalMinor is left at 0 and DERIVED from the line items below, the way the
-- application builds an invoice. Writing a total and no lines produced an
-- invoice page showing a figure above an empty "Line items" table.
INSERT INTO invoice (id, "schoolId", "studentId", reference, status, currency,
                     "totalMinor", "dueDate", "issuedAt", "createdById", "createdAt", "updatedAt")
SELECT gen_random_uuid(), c.school_id, vs.id,
       'VOL-' || vs.n || '-' || t,
       (CASE WHEN t < 6 THEN 'PAID' ELSE 'ISSUED' END)::"InvoiceStatus",
       'NGN', 0,
       (CURRENT_DATE - ((6 - t) * 90))::date,
       now() - ((6 - t) * INTERVAL '90 days'),
       c.admin_id, now(), now()
FROM cfg c, vol_student vs, generate_series(1, 6) t;

-- --- the fee catalog the line items are drawn from --------------------------
INSERT INTO fee_item (id, "schoolId", name, description, "amountMinor", currency, active, "createdAt", "updatedAt")
SELECT gen_random_uuid(), c.school_id, f.name, f.name || ' (volume fixture)', f.amount, 'NGN', true, now(), now()
FROM cfg c, (VALUES
  ('VOL Tuition',           10500000),
  ('VOL Development Levy',   2500000),
  ('VOL Books & Materials',  1200000),
  ('VOL Examination Fee',     800000)
) AS f(name, amount);

-- --- line items: 4 per invoice ----------------------------------------------
-- This is the table that grows FASTEST in a real school — one-to-many with
-- invoices, so it ends up LARGER than payment. The first version of this seeder
-- created none, which made invoice_line_item look trivially small and hid that
-- its FK to invoice had no index (#123).
INSERT INTO invoice_line_item (id, "schoolId", "invoiceId", "feeItemId",
                               description, "amountMinor", quantity, "createdAt")
SELECT gen_random_uuid(), c.school_id, i.id, fi.id,
       fi.name,
       -- A little per-pupil variation so the totals are not all identical.
       fi."amountMinor" + ((abs(hashtext(i.id::text)) % 5) * 100000),
       1,
       i."createdAt"
FROM cfg c
JOIN invoice i ON i."schoolId" = c.school_id AND i.reference LIKE 'VOL-%'
JOIN fee_item fi ON fi."schoolId" = c.school_id AND fi.name LIKE 'VOL %';

-- The invoice total IS the sum of its lines. Deriving it rather than asserting
-- it means the fixture can never disagree with itself.
UPDATE invoice i
SET "totalMinor" = l.total
FROM (SELECT "invoiceId", sum("amountMinor" * quantity)::int AS total
      FROM invoice_line_item GROUP BY "invoiceId") l
WHERE l."invoiceId" = i.id AND i.reference LIKE 'VOL-%';

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

-- --- SIS: the pupil RECORD behind every roster row --------------------------
-- Without these the SIS pages were still being measured against an EMPTY table:
-- 906 pupils and 5 profiles, so /students/[id], the contacts list and every
-- profile-completion query seq-scanned nothing and returned in no time. The
-- roster looked seeded; the records behind it were not.
--
-- `vol_student.n` is the deterministic per-pupil index the rest of this file
-- already uses, so every derived value below is stable across re-runs.
--
-- profileStatus is spread across the real vocabulary rather than all-APPROVED,
-- because the nudge sweep and the completion dashboard FILTER on it — a column
-- with a single value cannot exercise its own index.
INSERT INTO student_profile (id, "schoolId", "studentId", "admissionNumber", "dateOfBirth",
                             gender, phone, email, "addressLine1", city, state, country,
                             "profileStatus", "submittedAt", "createdAt", "updatedAt")
SELECT gen_random_uuid(), c.school_id, vs.id,
       'VOL/' || to_char(vs.n, 'FM0000'),
       -- Secondary-school ages: a birth date 11-18 years back, spread by pupil.
       (now() - (((11 * 365) + (vs.n * 7 % 2555)) * INTERVAL '1 day'))::date,
       CASE WHEN vs.n % 2 = 0 THEN 'FEMALE' ELSE 'MALE' END,
       '080' || lpad(vs.n::text, 8, '0'),
       u.email,
       (vs.n % 400)::text || ' Volume Street',
       'Lagos', 'Lagos', 'NG',
       CASE vs.n % 5
         WHEN 0 THEN 'INCOMPLETE'
         WHEN 1 THEN 'SUBMITTED'
         WHEN 2 THEN 'CHANGES_REQUESTED'
         ELSE 'APPROVED'
       END,
       CASE WHEN vs.n % 5 = 0 THEN NULL ELSE now() - INTERVAL '30 days' END,
       now(), now()
FROM cfg c, vol_student vs
JOIN "user" u ON u.id = vs.id;

-- Two contacts per pupil. The emergency-contact list is what a school opens in
-- the situation it least wants to be slow, and priority ordering is the whole
-- point of the table — one contact each would never exercise it.
INSERT INTO emergency_contact (id, "schoolId", "profileId", name, relationship, phone, email,
                               priority, "createdAt", "updatedAt")
SELECT gen_random_uuid(), c.school_id, sp.id,
       CASE WHEN p.n = 1 THEN 'Guardian of ' ELSE 'Second contact for ' END || u.name,
       CASE WHEN p.n = 1 THEN 'parent' ELSE 'aunt' END,
       '070' || lpad((vs.n * 10 + p.n)::text, 8, '0'),
       NULL, p.n, now(), now()
FROM cfg c, vol_student vs
JOIN "user" u ON u.id = vs.id
JOIN student_profile sp ON sp."studentId" = vs.id,
     generate_series(1, 2) p(n);

-- Medical records for a MINORITY (~1 in 6). Every read of these is decrypted
-- and audit-logged, so giving every pupil one would overstate how often that
-- path runs; giving none left it untested at volume.
-- NOTE: seeded as PLAINTEXT. decryptField passes anything without the
-- ciphertext prefix through untouched, so reads work — but this does NOT
-- exercise the decrypt cost that real, app-written records carry.
INSERT INTO medical_record (id, "schoolId", "profileId", "bloodGroup", allergies, conditions,
                            "createdAt", "updatedAt")
SELECT gen_random_uuid(), c.school_id, sp.id,
       (ARRAY['O+','A+','B+','AB+','O-','A-'])[1 + (vs.n % 6)],
       'Seeded volume allergy note', 'Seeded volume condition note',
       now(), now()
FROM cfg c, vol_student vs
JOIN student_profile sp ON sp."studentId" = vs.id
WHERE vs.n % 6 = 0;


-- --- ACADEMICS: subjects, offerings, and a term of marks ---------------------
-- The gradebook, the report card, term results and the grade-band analytics all
-- read from here, and until now NONE of them had ever been measured against
-- more than a single row. This is the part the header used to claim and never
-- wrote.
--
-- Nine subjects per class is a realistic secondary-school load, and it is the
-- multiplier that matters: every per-term read is pupils x subjects, so nine
-- turns 900 pupils into 8,100 rows per term.
CREATE TEMP TABLE vol_subject AS
SELECT gen_random_uuid() AS id, name, 'VOL' || to_char(n, 'FM00') AS code, n
FROM (VALUES
  ('VOL Mathematics', 1), ('VOL English Language', 2), ('VOL Biology', 3),
  ('VOL Chemistry', 4), ('VOL Physics', 5), ('VOL Geography', 6),
  ('VOL Economics', 7), ('VOL Civic Education', 8), ('VOL Agricultural Science', 9)
) AS t(name, n);

INSERT INTO subject (id, "schoolId", name, code, "createdAt", "updatedAt")
SELECT vsub.id, c.school_id, vsub.name, vsub.code, now(), now()
FROM cfg c, vol_subject vsub;

-- Every class offers every subject, taught by one of the 60 VOL teachers. This
-- is what makes the timetable, the syllabus panel and subject scoping real.
CREATE TEMP TABLE vol_teacher AS
SELECT id, row_number() OVER (ORDER BY email) AS n FROM "user" WHERE email LIKE 'vol.t%@demo.school';

INSERT INTO class_subject_teacher (id, "schoolId", "classId", "subjectId", "teacherId",
                                   "lessonsPerWeek", "createdAt")
SELECT gen_random_uuid(), c.school_id, vc.id, vsub.id, vt.id, 4, now()
FROM cfg c, vol_class vc, vol_subject vsub
JOIN vol_teacher vt ON vt.n = ((vsub.n - 1) % 60) + 1;

-- --- subject results: 900 pupils x 9 subjects x 3 terms ---------------------
-- PUBLISHED, because every read path that matters filters on it — the report
-- card, the broadsheet and the class-position ranking all ignore DRAFT, so
-- seeding DRAFT rows would leave those queries measuring nothing again.
--
-- Marks are derived from the pupil and subject index rather than random, so a
-- re-run produces the same school and a regression in the weighting maths is
-- visible as a changed number rather than noise. Exam is out of 60, midterm 20,
-- assignment 10, class note 10 — the GRADE_COMPONENTS split in @sms/types.
-- Terms that have already started, numbered oldest-first so marks can MOVE
-- from one to the next. Without an ordinal every term got identical marks and
-- the cumulative session report showed [70, 70, 70] — three terms that cannot
-- disagree cannot exercise a session average, a progression, or a report card
-- that claims a pupil improved.
CREATE TEMP TABLE vol_term AS
SELECT t.id, t."sessionId", row_number() OVER (ORDER BY t."startDate") AS n
FROM term t
JOIN academic_session sess ON sess.id = t."sessionId"
WHERE sess."schoolId" = (SELECT school_id FROM cfg) AND t."startDate" <= current_date;

INSERT INTO subject_result (id, "schoolId", "sessionId", "termId", "classId", "subjectId",
                            "studentId", exam, midterm, assignment, "classNote", total, grade,
                            status, "gradedById", "gradedAt", "updatedAt")
SELECT gen_random_uuid(), c.school_id, sess.id, t.id, e."classId", vsub.id, vs.id,
       ex.v, mid.v, asg.v, note.v,
       ex.v + mid.v + asg.v + note.v,
       CASE WHEN ex.v + mid.v + asg.v + note.v >= 70 THEN 'A'
            WHEN ex.v + mid.v + asg.v + note.v >= 60 THEN 'B'
            WHEN ex.v + mid.v + asg.v + note.v >= 50 THEN 'C'
            WHEN ex.v + mid.v + asg.v + note.v >= 45 THEN 'D'
            WHEN ex.v + mid.v + asg.v + note.v >= 40 THEN 'E'
            ELSE 'F' END,
       'PUBLISHED', c.teacher_id, now(), now()
-- EVERY TERM THAT HAS ALREADY STARTED, not just the current one.
--
-- Seeding only the CURRENT term put the marks in a term with no attendance:
-- the demo school's current term begins after today, while the 5,820 seeded
-- registers land in the three terms before it. So a report card at volume had
-- marks OR attendance and never both, and its attendance section went on being
-- measured against nothing. Anchoring to "terms that have started" puts both
-- halves in the same place, and gives the cumulative session report more than
-- one term to add up.
FROM cfg c
CROSS JOIN vol_student vs
CROSS JOIN vol_subject vsub
CROSS JOIN vol_term t
JOIN enrollment e ON e."studentId" = vs.id
JOIN academic_session sess ON sess.id = t."sessionId"
-- Marks derived from (pupil, subject, TERM) rather than random: a re-run
-- rebuilds the same school, so a regression in the weighting maths shows up as
-- a changed number instead of noise. The term ordinal nudges each component,
-- so a pupil's totals move across the year the way a real one's do. Exam is out
-- of 60, midterm 20, assignment 10, class note 10 — the GRADE_COMPONENTS split.
CROSS JOIN LATERAL (SELECT LEAST(60, 25 + ((vs.n * 7 + vsub.n * 13 + t.n * 5) % 36))::float8 AS v) ex
CROSS JOIN LATERAL (SELECT LEAST(20, 8 + ((vs.n * 3 + vsub.n * 5 + t.n * 3) % 13))::float8 AS v) mid
CROSS JOIN LATERAL (SELECT LEAST(10, 4 + ((vs.n + vsub.n + t.n) % 7))::float8 AS v) asg
CROSS JOIN LATERAL (SELECT LEAST(10, 4 + ((vs.n * 2 + vsub.n + t.n * 2) % 7))::float8 AS v) note;

-- --- assessments + submissions + grades -------------------------------------
-- The OTHER grade path: Grade hangs off a Submission, and it is what the
-- analytics grade-band aggregate and the assessment list read. Six assessments
-- per class per term is what a real subject teacher sets.
INSERT INTO assessment (id, "schoolId", title, description, "classId", "termId",
                        "createdById", "createdAt", "updatedAt")
SELECT gen_random_uuid(), c.school_id,
       'VOL ' || vsub.name || ' test ' || a.n, 'Seeded volume assessment',
       vc.id, t.id, c.teacher_id, now() - (a.n * INTERVAL '10 days'), now()
FROM cfg c, vol_class vc, vol_subject vsub, generate_series(1, 2) a(n)
JOIN academic_session sess ON sess."schoolId" = (SELECT school_id FROM cfg) AND sess."isCurrent"
JOIN term t ON t."sessionId" = sess.id AND t."isCurrent";

INSERT INTO submission (id, "schoolId", "assessmentId", "studentId", status, "submittedAt",
                        "createdAt", "updatedAt")
SELECT gen_random_uuid(), c.school_id, a.id, e."studentId", 'SUBMITTED'::"SubmissionStatus",
       a."createdAt" + INTERVAL '3 days', a."createdAt", now()
FROM cfg c
JOIN assessment a ON a."schoolId" = c.school_id AND a.title LIKE 'VOL %'
JOIN enrollment e ON e."classId" = a."classId";

INSERT INTO grade (id, "schoolId", "submissionId", score, "maxScore", status,
                   "gradedById", "gradedAt", "updatedAt")
SELECT gen_random_uuid(), c.school_id, sub.id,
       (35 + (('x' || substr(md5(sub.id::text), 1, 6))::bit(24)::bigint % 66))::float8,
       100, 'PUBLISHED', c.teacher_id, now(), now()
FROM cfg c
JOIN submission sub ON sub."schoolId" = c.school_id
JOIN assessment a ON a.id = sub."assessmentId" AND a.title LIKE 'VOL %';


-- --- messaging: threads, participants, messages ------------------------------
-- The last module with no volume behind it. A school's inbox is the page staff
-- keep open all day, and its cost is per-PARTICIPANT rather than per-school:
-- what matters is how many threads ONE person is in, not how many exist.
--
-- 2,600 threads, and the demo admin sits in ALL of them ON PURPOSE.
-- MessagingService scans a caller's threads with `take: THREAD_SCAN_CAP` (2000)
-- — an inbox below that ceiling can never show what happens at it, and every
-- real school has someone (a principal, an office account) who crosses it.
CREATE TEMP TABLE vol_thread AS
SELECT gen_random_uuid() AS id, n
FROM generate_series(1, 2600) AS n;

INSERT INTO message_thread (id, "schoolId", subject, "createdById", "createdAt", "updatedAt")
SELECT vt.id, c.school_id, 'VOL thread ' || vt.n, c.admin_id,
       now() - (vt.n * INTERVAL '3 hours'), now() - (vt.n * INTERVAL '3 hours')
FROM cfg c, vol_thread vt;

-- Two participants per thread: the office account and one guardian-side pupil,
-- which is the shape real threads take (staff <-> family).
INSERT INTO thread_participant (id, "schoolId", "threadId", "userId", "lastReadAt", "createdAt")
SELECT gen_random_uuid(), c.school_id, vt.id, c.admin_id,
       -- A third of the inbox unread, so the unread groupBy has real work.
       CASE WHEN vt.n % 3 = 0 THEN NULL ELSE now() END,
       now()
FROM cfg c, vol_thread vt;

INSERT INTO thread_participant (id, "schoolId", "threadId", "userId", "lastReadAt", "createdAt")
SELECT gen_random_uuid(), c.school_id, vt.id, vs.id, now(), now()
FROM cfg c, vol_thread vt
JOIN vol_student vs ON vs.n = ((vt.n - 1) % 900) + 1;

-- ~7 messages per thread, alternating sender, newest last.
INSERT INTO message (id, "schoolId", "threadId", "senderId", body, "createdAt")
SELECT gen_random_uuid(), c.school_id, vt.id,
       CASE WHEN m.n % 2 = 0 THEN c.admin_id ELSE vs.id END,
       'Seeded volume message ' || m.n || ' about term arrangements and attendance.',
       now() - (vt.n * INTERVAL '3 hours') + (m.n * INTERVAL '5 minutes')
FROM cfg c, vol_thread vt
JOIN vol_student vs ON vs.n = ((vt.n - 1) % 900) + 1,
     generate_series(1, 7) m(n);

COMMIT;

ANALYZE;
