-- =============================================================================
-- A renewal erased the fine that had already accrued
-- =============================================================================
-- The overdue fine is computed ONLY at return, as
-- `max(0, floor((now - dueAt) / day)) * perDay`, and `renew` sets
-- `dueAt = max(dueAt, now) + RENEW_DAYS`. So renewing an overdue loan pushes the
-- due date into the future and the days already late stop existing.
--
-- `library.borrow` is held by STUDENT, and `renew` accepts the borrower
-- themselves (`loan.borrowerId === p.userId`), so this needed no staff at all.
-- Measured live on one 30-day-overdue loan of the same book:
--
--   returned without renewing        -> fine NGN 1,500.00
--   pupil renews their own, returns  -> fine NGN 0.00
--
-- The days already late are a FACT about a loan, and a renewal is not a reason
-- for a fact to stop being true. They are carried here instead of being
-- recomputed from a due date that has moved.
--
-- Deliberately NOT a refusal to renew while overdue: whether a school extends an
-- overdue loan is its own policy, and a librarian granting one to an ill pupil is
-- legitimate. What must not happen is the charge quietly disappearing when they
-- do.
-- =============================================================================

ALTER TABLE "book_loan"
  ADD COLUMN IF NOT EXISTS "lateDaysCarried" INTEGER NOT NULL DEFAULT 0;
