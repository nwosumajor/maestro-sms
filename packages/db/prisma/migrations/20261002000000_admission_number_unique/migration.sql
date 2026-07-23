-- Admission number unique within a school.
--
-- Postgres treats NULLs as DISTINCT by default, so legacy profiles without a
-- number do not collide; the constraint binds only real, assigned numbers.
-- Verified zero existing duplicates before adding.
CREATE UNIQUE INDEX "student_profile_schoolId_admissionNumber_key"
  ON "student_profile" ("schoolId", "admissionNumber");
