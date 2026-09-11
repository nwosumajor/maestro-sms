-- The school's own local hour for the register reminder. NULL means the
-- platform default (14:00 local), so every school already live is unchanged.
ALTER TABLE "school" ADD COLUMN "registerReminderHour" INTEGER;
