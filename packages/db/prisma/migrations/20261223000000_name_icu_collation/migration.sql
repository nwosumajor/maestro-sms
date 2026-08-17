-- =============================================================================
-- Names sort ALPHABETICALLY, not by byte value
-- =============================================================================
-- Every list of people in the product is `ORDER BY name`, and every one of them
-- was sorting by byte value. Proven against the running database:
--
--     SELECT 'apple' < 'Zebra';   ->  f     (byte order: 'Z'=90 < 'a'=97)
--     SELECT 'Head'  < 'HR';      ->  f     ('R'=82 < 'e'=101)
--
-- so the staff list read "... Demo HR Clerk, Demo HR Manager, Demo Head Driver"
-- and a school with real names gets "Vance" before "van der Berg", every
-- lowercase-initial surname after every uppercase one, and every accented name
-- (José, Ngozi Ekwueme-Íkè) dumped at the end.
--
-- `datcollate` SAYS `en_US.utf8`, which is why this is not obvious. The Postgres
-- image is Alpine, and musl libc has no real locale support, so glibc-style
-- locale names silently degrade to C — byte order. It is a property of the
-- IMAGE, not a setting anyone got wrong, and it would differ between a
-- developer's machine and RDS: a sort order that changes with the base image is
-- worse than one that is consistently wrong.
--
-- ICU does not depend on the C library's locales and is compiled into Postgres
-- 16 (908 collations are present here, and RDS has them too). `und-x-icu` is the
-- root/language-neutral ICU collation: A a B b C c ..., accents folded to their
-- base letter for the primary comparison. Applying it to the COLUMN means every
-- existing `ORDER BY name` in the application — Prisma's `orderBy: { name:
-- "asc" }`, which cannot express COLLATE — starts sorting correctly with no
-- application change, and any list added later is correct by default.
--
-- It is DETERMINISTIC (`collisdeterministic = true`), so equality is still byte
-- equality: unique constraints, joins, LIKE and the trigram index behave exactly
-- as before. Only comparison ORDER changes. The dependent indexes
-- (`user_name_trgm_idx`) are rebuilt by the ALTER automatically.
--
-- Not applied to every text column on purpose — only the ones a human is
-- expected to scan as an alphabetical list.
-- =============================================================================

ALTER TABLE "user" ALTER COLUMN "name" TYPE text COLLATE "und-x-icu";

-- The other names read as lists: a class picker, a subject list, a hostel or
-- route list are all scanned the same way.
ALTER TABLE "class" ALTER COLUMN "name" TYPE text COLLATE "und-x-icu";
ALTER TABLE "subject" ALTER COLUMN "name" TYPE text COLLATE "und-x-icu";
