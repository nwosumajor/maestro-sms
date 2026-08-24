-- Two money figures that were platform constants applied to every school.
--
-- `PAYMENT_APPROVAL_THRESHOLD_MINOR` (5,000,000) and the library's
-- `FINE_PER_DAY_MINOR` (5,000) are both written in kobo, and both were applied
-- whatever `school.currency` says. 5,000,000 minor units is £50,000 in a
-- British school (a maker-checker rule that never fires) and 5,000 minor units
-- is £50 a day on a family's invoice for an overdue library book.
--
-- Both NULLABLE, because NULL means "not set" and the two resolve in OPPOSITE
-- directions: an unset CONTROL tightens, an unset CHARGE goes to zero. A
-- default here would erase that distinction, which is why neither column has
-- one.
ALTER TABLE "school" ADD COLUMN "paymentApprovalThresholdMinor" INTEGER;
ALTER TABLE "school" ADD COLUMN "libraryFinePerDayMinor" INTEGER;
