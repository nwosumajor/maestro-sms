-- Library Management: book catalogue + loans. Tenant-scoped. RLS in prisma/rls/38.
CREATE TABLE "library_book" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "schoolId" UUID NOT NULL,
  "title" TEXT NOT NULL,
  "author" TEXT,
  "isbn" TEXT,
  "barcode" TEXT NOT NULL,
  "category" TEXT,
  "totalCopies" INTEGER NOT NULL DEFAULT 1,
  "availableCopies" INTEGER NOT NULL DEFAULT 1,
  "customFields" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "library_book_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "library_book_schoolId_barcode_key" ON "library_book"("schoolId", "barcode");
CREATE INDEX "library_book_schoolId_idx" ON "library_book"("schoolId");

CREATE TABLE "book_loan" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "schoolId" UUID NOT NULL,
  "bookId" UUID NOT NULL,
  "borrowerId" UUID NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ISSUED',
  "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "dueAt" TIMESTAMP(3) NOT NULL,
  "returnedAt" TIMESTAMP(3),
  "renewedCount" INTEGER NOT NULL DEFAULT 0,
  "fineMinor" INTEGER NOT NULL DEFAULT 0,
  "finePaid" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "book_loan_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "book_loan_schoolId_idx" ON "book_loan"("schoolId");
CREATE INDEX "book_loan_schoolId_borrowerId_idx" ON "book_loan"("schoolId", "borrowerId");
CREATE INDEX "book_loan_bookId_status_idx" ON "book_loan"("bookId", "status");

ALTER TABLE "book_loan" ADD CONSTRAINT "book_loan_bookId_fkey"
  FOREIGN KEY ("bookId") REFERENCES "library_book"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
