// =============================================================================
// LibraryService — book catalogue + loans
// =============================================================================
// Tenant-scoped (RLS). The librarian (library.manage) manages the barcode-keyed
// catalogue, issues/returns/renews for anyone, runs issued/due reports, exports
// CSV, and records fine receipts. Students (library.borrow) search and self-issue/
// renew/return from their dashboard. Relationship scoping: a non-librarian may
// only act on their OWN loans. Overdue fines accrue per day on return. Audited.
// =============================================================================

import {ConflictException, BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException} from "@nestjs/common";
import { Prisma } from "@sms/db";
import type { BookLoanDto, FineReceiptDto, LibraryBookDto, LibraryReportDto } from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";

type Json = Record<string, string>;

// Library policy (sensible defaults; could become per-school settings later).
/** Ceiling on a catalogue CSV. Well past any school library, but a CSV must still
 *  fit in memory and in one response — and when it bites, the file says so. */
const CATALOGUE_EXPORT_MAX = 20_000;

const LOAN_DAYS = 14;
const RENEW_DAYS = 7;
const MAX_RENEWALS = 2;
const FINE_PER_DAY_MINOR = 5000; // ₦50 / day overdue
const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class LibraryService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }
  private isLibrarian(p: Principal): boolean {
    return p.permissions.includes("library.manage");
  }
  private cf(v: unknown): Json {
    return (v ?? {}) as Json;
  }

  // --- catalogue (librarian) ------------------------------------------------

  async createBook(
    p: Principal,
    input: { title: string; author?: string | null; isbn?: string | null; barcode: string; category?: string | null; totalCopies: number; customFields?: Json },
  ): Promise<LibraryBookDto> {
    if (input.totalCopies < 1) throw new BadRequestException("totalCopies must be at least 1");
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const dup = await tx.libraryBook.findFirst({ where: { barcode: input.barcode }, select: { id: true } });
      if (dup) throw new BadRequestException("A book with that barcode already exists");
      const b = await tx.libraryBook.create({
        data: {
          schoolId: p.schoolId,
          title: input.title,
          author: input.author ?? null,
          isbn: input.isbn ?? null,
          barcode: input.barcode,
          category: input.category ?? null,
          totalCopies: input.totalCopies,
          availableCopies: input.totalCopies,
          customFields: (input.customFields ?? {}) as Prisma.InputJsonValue,
        },
      });
      await this.log(tx, p, "library.book.create", b.id, { title: input.title, barcode: input.barcode });
      return this.bookDto(b);
    });
  }

  async updateBook(
    p: Principal,
    id: string,
    input: { title?: string; author?: string | null; category?: string | null; totalCopies?: number; customFields?: Json },
  ): Promise<LibraryBookDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const b = await tx.libraryBook.findFirst({ where: { id } });
      if (!b) throw new NotFoundException("Book not found");
      // Adjust availableCopies by the delta if totalCopies changes (never below 0).
      let available = b.availableCopies;
      if (input.totalCopies !== undefined) {
        if (input.totalCopies < 1) throw new BadRequestException("totalCopies must be at least 1");
        const onLoan = b.totalCopies - b.availableCopies;
        available = Math.max(0, input.totalCopies - onLoan);
      }
      const updated = await tx.libraryBook.update({
        where: { id },
        data: {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.author !== undefined ? { author: input.author } : {}),
          ...(input.category !== undefined ? { category: input.category } : {}),
          ...(input.totalCopies !== undefined ? { totalCopies: input.totalCopies, availableCopies: available } : {}),
          ...(input.customFields !== undefined ? { customFields: input.customFields as Prisma.InputJsonValue } : {}),
        },
      });
      await this.log(tx, p, "library.book.update", id, { fields: Object.keys(input) });
      return this.bookDto(updated);
    });
  }

  /** Search the catalogue by title/author/isbn/barcode (everyone). */
  async searchBooks(p: Principal, q?: string): Promise<LibraryBookDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const where = q?.trim()
        ? {
            OR: [
              { title: { contains: q.trim(), mode: Prisma.QueryMode.insensitive } },
              { author: { contains: q.trim(), mode: Prisma.QueryMode.insensitive } },
              { isbn: { contains: q.trim(), mode: Prisma.QueryMode.insensitive } },
              { barcode: { contains: q.trim(), mode: Prisma.QueryMode.insensitive } },
            ],
          }
        : {};
      const books = await tx.libraryBook.findMany({ where, orderBy: { title: "asc" }, take: 200 });
      return books.map((b) => this.bookDto(b));
    });
  }

  /** Delete a book that has NO lending history (duplicate/typo cleanup). A book
   *  with any loan rows (even returned) is a ledger the school keeps — 409. */
  async deleteBook(p: Principal, id: string): Promise<{ ok: boolean }> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const b = await tx.libraryBook.findFirst({ where: { id } });
      if (!b) throw new NotFoundException("Book not found");
      const loans = await tx.bookLoan.count({ where: { bookId: id } });
      if (loans > 0) {
        throw new ConflictException(
          `"${b.title}" has ${loans} loan record${loans === 1 ? "" : "s"} (including returned ones) — books with lending history can't be deleted; edit the title instead`,
        );
      }
      await tx.libraryBook.delete({ where: { id } });
      await this.log(tx, p, "library.book.delete", id, { title: b.title, barcode: b.barcode });
      return { ok: true };
    });
  }

  // --- loans ----------------------------------------------------------------

  /** Issue a book. Librarians issue to any borrower; students self-issue only. */
  async issue(p: Principal, input: { bookId: string; borrowerId?: string }): Promise<BookLoanDto> {
    const borrowerId = input.borrowerId ?? p.userId;
    if (!this.isLibrarian(p) && borrowerId !== p.userId) {
      throw new ForbiddenException("You can only issue books to yourself");
    }
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const book = await tx.libraryBook.findFirst({ where: { id: input.bookId } });
      if (!book) throw new NotFoundException("Book not found");
      const borrower = await tx.user.findFirst({ where: { id: borrowerId }, select: { id: true } });
      if (!borrower) throw new NotFoundException("Borrower not found in this school");
      // Atomically CLAIM a copy: the availability guard and the decrement are ONE
      // statement, so two concurrent issues can't both pass a stale
      // `availableCopies >= 1` read and drive the count negative. Claim first,
      // then record the loan; if nothing was claimed, no copy was free.
      const claimed = await tx.libraryBook.updateMany({
        where: { id: input.bookId, availableCopies: { gte: 1 } },
        data: { availableCopies: { decrement: 1 } },
      });
      if (claimed.count === 0) throw new BadRequestException("No copies available");
      const dueAt = new Date(Date.now() + LOAN_DAYS * DAY_MS);
      const loan = await tx.bookLoan.create({
        data: { schoolId: p.schoolId, bookId: input.bookId, borrowerId, status: "ISSUED", dueAt },
      });
      await this.log(tx, p, "library.issue", loan.id, { bookId: input.bookId, borrowerId });
      return this.loanDto(tx, loan.id);
    });
  }

  async renew(p: Principal, loanId: string): Promise<BookLoanDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const loan = await tx.bookLoan.findFirst({ where: { id: loanId } });
      if (!loan) throw new NotFoundException("Loan not found");
      if (!this.isLibrarian(p) && loan.borrowerId !== p.userId) throw new NotFoundException("Loan not found");
      if (loan.status !== "ISSUED") throw new BadRequestException("Loan is not active");
      if (loan.renewedCount >= MAX_RENEWALS) throw new BadRequestException("Maximum renewals reached");
      const dueAt = new Date(Math.max(loan.dueAt.getTime(), Date.now()) + RENEW_DAYS * DAY_MS);
      await tx.bookLoan.update({ where: { id: loanId }, data: { dueAt, renewedCount: { increment: 1 } } });
      await this.log(tx, p, "library.renew", loanId, { renewedCount: loan.renewedCount + 1 });
      return this.loanDto(tx, loanId);
    });
  }

  /**
   * Return a book; compute any overdue fine. LIBRARY STAFF ONLY.
   *
   * A return record asserts a physical fact: the book is back on the shelf. It
   * used to accept the borrower too, and every consequence followed from that
   * one assertion — the copy went back into `availableCopies`, the fine stopped
   * accruing at that instant, and the loan left the overdue list. So a pupil
   * could mark a book returned and keep it: the shelf count says the library has
   * a copy it does not have, the next borrower is issued a phantom, the fine is
   * frozen at whatever it had reached, and no overdue report ever names them
   * again. Nothing here is malicious-only — a pupil who has simply LOST a book
   * can close their own liability with one button.
   *
   * The platform already draws this line for the same reason: who may take an
   * attendance register is restricted because the register records who
   * physically looked at the room. Renewal stays self-service — extending a due
   * date asserts nothing about where the book is.
   */
  async returnLoan(p: Principal, loanId: string): Promise<BookLoanDto> {
    if (!this.isLibrarian(p)) {
      throw new ForbiddenException(
        "A return is recorded by the library when the book is handed in. Take it to the library desk.",
      );
    }
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const loan = await tx.bookLoan.findFirst({ where: { id: loanId } });
      if (!loan) throw new NotFoundException("Loan not found");
      if (loan.status !== "ISSUED") throw new BadRequestException("Loan already returned");
      const now = new Date();
      const daysLate = Math.max(0, Math.floor((now.getTime() - loan.dueAt.getTime()) / DAY_MS));
      const fineMinor = daysLate * FINE_PER_DAY_MINOR;
      // A FINE IS A CHARGE, so it goes on the ledger like every other charge.
      //
      // It used to live only on the loan row: `payFine` marked a boolean and
      // printed a receipt, and no Payment or invoice was ever written. The money
      // was therefore invisible to the finance reports, the receivables ageing,
      // the journal export and reconciliation — a school could not tell you what
      // it was owed in fines, or what it had collected, from the place it keeps
      // every other figure.
      //
      // It also made "what does this leaver owe" a lie: the exit preview reads
      // the invoice ledger, so a pupil with unpaid fines showed as owing nothing.
      if (fineMinor > 0) await this.billFine(tx, p, loan, fineMinor, daysLate);
      await tx.bookLoan.update({ where: { id: loanId }, data: { status: "RETURNED", returnedAt: now, fineMinor } });
      await tx.libraryBook.update({ where: { id: loan.bookId }, data: { availableCopies: { increment: 1 } } });
      await this.log(tx, p, "library.return", loanId, { daysLate, fineMinor });
      return this.loanDto(tx, loanId);
    });
  }

  /**
   * Put an overdue fine on the borrower's invoice.
   *
   * IDEMPOTENT on a marker description keyed to the loan, the same guard the
   * late-fee sweep and the hostel rent run use: returning a book is a single
   * act, but a retry or a replay must not charge the fine twice, and two lines
   * saying the same thing is exactly what a bursar cannot untangle afterwards.
   *
   * Staff borrow books too. Only a charge against a real invoice makes sense, so
   * this bills whoever borrowed it — the ledger is per-user, not per-pupil.
   */
  private async billFine(
    tx: TenantTx,
    p: Principal,
    loan: { id: string; borrowerId: string; bookId: string },
    fineMinor: number,
    daysLate: number,
  ): Promise<void> {
    const description = `Library fine — loan ${loan.id.slice(0, 8).toUpperCase()}`;
    const existing = await tx.invoiceLineItem.findFirst({
      where: { description, invoice: { studentId: loan.borrowerId } },
      select: { id: true },
    });
    if (existing) return; // already billed — a replay, not a second fine
    // The SCHOOL's currency: settlement refuses a charge whose currency differs
    // from the invoice, so a fine raised in the column default could never be
    // paid online by a school billing in anything else.
    const school = await tx.school.findFirst({ where: { id: p.schoolId }, select: { currency: true } });
    let invoice = await tx.invoice.findFirst({ where: { studentId: loan.borrowerId, status: "DRAFT" } });
    if (!invoice) {
      invoice = await tx.invoice.create({
        data: {
          schoolId: p.schoolId,
          studentId: loan.borrowerId,
          createdById: p.userId,
          reference: `FINE-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          status: "DRAFT",
          totalMinor: 0,
          currency: school?.currency ?? "NGN",
          dueDate: new Date(),
        },
      });
    }
    await tx.invoiceLineItem.create({
      data: { schoolId: p.schoolId, invoiceId: invoice.id, description, amountMinor: fineMinor, quantity: 1 },
    });
    await tx.invoice.update({ where: { id: invoice.id }, data: { totalMinor: { increment: fineMinor } } });
    await this.log(tx, p, "library.fine.billed", loan.id, { fineMinor, daysLate, invoiceId: invoice.id });
  }

  /** Record payment of an overdue fine → a digital receipt. Librarian. */
  async payFine(p: Principal, loanId: string): Promise<FineReceiptDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const loan = await tx.bookLoan.findFirst({ where: { id: loanId } });
      if (!loan) throw new NotFoundException("Loan not found");
      if (loan.fineMinor <= 0) throw new BadRequestException("No fine to pay");
      if (loan.finePaid) throw new BadRequestException("Fine already paid");
      const paidAt = new Date();
      await tx.bookLoan.update({ where: { id: loanId }, data: { finePaid: true, finePaidAt: paidAt } });

      // POST THE MONEY, do not just tick a box.
      //
      // This used to set a boolean and print a receipt, and write nothing to the
      // ledger — cash over the desk that the finance reports, the journal export
      // and reconciliation never saw. The charge is billed on return; this is
      // the settlement of it, and it goes through the same Payment table as
      // every other payment so a fine is countable in the same place as a fee.
      const line = await tx.invoiceLineItem.findFirst({
        where: {
          description: `Library fine — loan ${loanId.slice(0, 8).toUpperCase()}`,
          invoice: { studentId: loan.borrowerId },
        },
        select: { invoiceId: true },
      });
      if (line) {
        await tx.payment.create({
          data: {
            schoolId: p.schoolId,
            invoiceId: line.invoiceId,
            amountMinor: loan.fineMinor,
            method: "CASH",
            kind: "PAYMENT",
            status: "POSTED",
            recordedById: p.userId,
            reference: `FINE-${loanId.slice(0, 8).toUpperCase()}`,
          },
        });
        await this.settleInvoiceIfPaid(tx, line.invoiceId);
      }
      await this.log(tx, p, "library.fine.pay", loanId, { fineMinor: loan.fineMinor, invoiceId: line?.invoiceId ?? null });
      const book = await tx.libraryBook.findFirstOrThrow({ where: { id: loan.bookId }, select: { title: true } });
      const borrower = await tx.user.findFirst({ where: { id: loan.borrowerId }, select: { name: true } });
      return {
        loanId,
        bookTitle: book.title,
        borrowerName: borrower?.name ?? "",
        fineMinor: loan.fineMinor,
        paidAt,
        reference: `FINE-${loanId.slice(0, 8).toUpperCase()}`,
      };
    });
  }

  /**
   * Re-issue the receipt for a fine already paid.
   *
   * `payFine` was the ONLY source of the receipt and refuses a second call, so
   * a librarian who closed the dialog, or a parent asking for a copy the next
   * day, had no way to get it back — for money the school had taken. This is a
   * read: it prints what was recorded, and cannot mark anything paid.
   */
  async fineReceipt(p: Principal, loanId: string): Promise<FineReceiptDto> {
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      const loan = await tx.bookLoan.findFirst({ where: { id: loanId } });
      // 404 rather than 403 for someone else's loan — the same posture as the
      // rest of this service.
      if (!loan) throw new NotFoundException("Loan not found");
      if (!this.isLibrarian(p) && loan.borrowerId !== p.userId) throw new NotFoundException("Loan not found");
      if (!loan.finePaid) throw new BadRequestException("This fine has not been paid");
      const book = await tx.libraryBook.findFirstOrThrow({ where: { id: loan.bookId }, select: { title: true } });
      const borrower = await tx.user.findFirst({ where: { id: loan.borrowerId }, select: { name: true } });
      return {
        loanId,
        bookTitle: book.title,
        borrowerName: borrower?.name ?? "",
        fineMinor: loan.fineMinor,
        // The recorded date. Older rows backfilled to the return date, and NULL
        // where even that is unknown — an absent date is visibly absent, an
        // invented one is not.
        paidAt: loan.finePaidAt,
        reference: `FINE-${loanId.slice(0, 8).toUpperCase()}`,
      };
    });
  }

  /**
   * Move the invoice to PARTIALLY_PAID / PAID once a fine payment lands.
   *
   * The fees module owns this lifecycle; a fine paid at the library desk must
   * not leave an invoice sitting DRAFT with money against it, or the receivables
   * ageing reports a debt that has been settled.
   */
  private async settleInvoiceIfPaid(tx: TenantTx, invoiceId: string): Promise<void> {
    const invoice = await tx.invoice.findFirst({
      where: { id: invoiceId },
      select: { totalMinor: true, status: true },
    });
    if (!invoice) return;
    const paid = await tx.payment.aggregate({
      where: { invoiceId, status: "POSTED", kind: "PAYMENT" },
      _sum: { amountMinor: true },
    });
    const settled = paid._sum?.amountMinor ?? 0;
    const status = settled >= invoice.totalMinor ? "PAID" : settled > 0 ? "PARTIALLY_PAID" : invoice.status;
    if (status !== invoice.status) {
      await tx.invoice.update({ where: { id: invoiceId }, data: { status } });
    }
  }

  /** A borrower's loans (self), or all loans (librarian). */
  async listLoans(p: Principal, opts: { borrowerId?: string; status?: string } = {}): Promise<BookLoanDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const borrowerId = this.isLibrarian(p) ? opts.borrowerId : p.userId;
      const where: Record<string, unknown> = {};
      if (borrowerId) where.borrowerId = borrowerId;
      if (opts.status) where.status = opts.status;
      const loans = await tx.bookLoan.findMany({ where, orderBy: { issuedAt: "desc" }, take: 300 });
      if (loans.length === 0) return [];
      // Batch the book + borrower lookups into ONE query each (was 3 queries per
      // loan via loanDto — up to ~900 for a full page).
      const books = await tx.libraryBook.findMany({
        where: { id: { in: [...new Set(loans.map((l) => l.bookId))] } },
        select: { id: true, title: true, barcode: true },
      });
      const borrowers = await tx.user.findMany({
        where: { id: { in: [...new Set(loans.map((l) => l.borrowerId))] } },
        select: { id: true, name: true },
      });
      const bookById = new Map(books.map((b) => [b.id, b]));
      const nameById = new Map(borrowers.map((u) => [u.id, u.name]));
      return loans.map((l) => {
        const b = bookById.get(l.bookId);
        return mapLoanDto(l, b?.title ?? "", b?.barcode ?? "", nameById.get(l.borrowerId) ?? "");
      });
    });
  }

  // --- reports + CSV (librarian) --------------------------------------------

  /** Tally issued/returned/overdue + fine totals over an optional window. */
  async report(p: Principal, opts: { from?: string; to?: string } = {}): Promise<LibraryReportDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const issuedRange: Record<string, Date> = {};
      if (opts.from) issuedRange.gte = new Date(opts.from);
      if (opts.to) issuedRange.lte = new Date(opts.to);
      // Counted and summed IN POSTGRES. This used to pull every loan row and every
      // book row into Node to add them up — two unbounded reads that grow with the
      // school's entire lending history, on a page whose whole output is eight
      // numbers. A library keeping five years of loans paid for all of them to
      // render a tally.
      const from = issuedRange.gte ?? null;
      const to = issuedRange.lte ?? null;
      const [loanAgg, bookAgg] = await Promise.all([
        tx.$queryRaw`
          SELECT
            COUNT(*) FILTER (WHERE status = 'ISSUED')::int                              AS issued,
            COUNT(*) FILTER (WHERE status <> 'ISSUED')::int                             AS returned,
            COUNT(*) FILTER (WHERE status = 'ISSUED' AND "dueAt" < now())::int          AS overdue,
            COALESCE(SUM("fineMinor"), 0)::float8                                       AS "finesAccruedMinor",
            COALESCE(SUM("fineMinor") FILTER (WHERE "finePaid"), 0)::float8             AS "finesCollectedMinor"
          FROM book_loan
          WHERE (${from}::timestamptz IS NULL OR "issuedAt" >= ${from}::timestamptz)
            AND (${to}::timestamptz   IS NULL OR "issuedAt" <= ${to}::timestamptz)
        ` as Promise<Array<{ issued: number; returned: number; overdue: number; finesAccruedMinor: number; finesCollectedMinor: number }>>,
        tx.$queryRaw`
          SELECT COUNT(*)::int                              AS "totalTitles",
                 COALESCE(SUM("totalCopies"), 0)::int       AS "totalCopies",
                 COALESCE(SUM("availableCopies"), 0)::int   AS "availableCopies"
          FROM library_book
        ` as Promise<Array<{ totalTitles: number; totalCopies: number; availableCopies: number }>>,
      ]);
      const l = loanAgg[0] ?? { issued: 0, returned: 0, overdue: 0, finesAccruedMinor: 0, finesCollectedMinor: 0 };
      const b = bookAgg[0] ?? { totalTitles: 0, totalCopies: 0, availableCopies: 0 };
      return {
        issued: l.issued,
        returned: l.returned,
        overdue: l.overdue,
        // Fines are minor units; ::float8 for the same reason as the fees aggregate
        // (int8 comes back as BigInt, which the JSON layer cannot serialize).
        finesAccruedMinor: Math.round(l.finesAccruedMinor),
        finesCollectedMinor: Math.round(l.finesCollectedMinor),
        totalTitles: b.totalTitles,
        totalCopies: b.totalCopies,
        availableCopies: b.availableCopies,
      };
    });
  }

  /**
   * Export the catalogue as CSV. Librarian.
   *
   * Reads the catalogue DIRECTLY rather than through searchBooks, which caps at 200
   * for the on-screen list. Routed through it, a 2,000-title library exported 200
   * rows and said nothing — the file looked complete, so the truncation would only
   * surface as a stock-take that never reconciled.
   *
   * An export is bounded too (a CSV must fit in memory and in a response), but at a
   * ceiling appropriate to a whole catalogue, and it says so when it bites.
   */
  async exportCsv(p: Principal): Promise<{ csv: string; filename: string; truncated: boolean }> {
    const rowsRaw = await this.db.runAsTenantReadOnly(this.ctx(p), (tx) =>
      tx.libraryBook.findMany({ orderBy: { title: "asc" }, take: CATALOGUE_EXPORT_MAX + 1 }),
    );
    const truncated = rowsRaw.length > CATALOGUE_EXPORT_MAX;
    const books = (truncated ? rowsRaw.slice(0, CATALOGUE_EXPORT_MAX) : rowsRaw).map((b) => this.bookDto(b));
    // Quote + neutralise spreadsheet formula injection (OWASP CSV injection).
    const esc = (v: string | number | null) => {
      let s = String(v ?? "");
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return `"${s.replace(/"/g, '""')}"`;
    };
    const header = "Title,Author,ISBN,Barcode,Category,TotalCopies,AvailableCopies";
    const rows = books.map((b) =>
      [b.title, b.author, b.isbn, b.barcode, b.category, b.totalCopies, b.availableCopies].map(esc).join(","),
    );
    // A truncated export announces itself IN THE FILE. A librarian reconciling
    // stock will not read an HTTP header, but they will see the last line.
    const note = truncated ? [`"NOTE: truncated at ${CATALOGUE_EXPORT_MAX} titles — narrow the catalogue and export again"`] : [];
    return {
      csv: [header, ...rows, ...note].join("\n"),
      filename: `library-catalogue-${new Date().toISOString().slice(0, 10)}.csv`,
      truncated,
    };
  }

  // --- helpers --------------------------------------------------------------

  private bookDto(b: {
    id: string; title: string; author: string | null; isbn: string | null; barcode: string;
    category: string | null; totalCopies: number; availableCopies: number; customFields: unknown; createdAt: Date;
  }): LibraryBookDto {
    return {
      id: b.id, title: b.title, author: b.author, isbn: b.isbn, barcode: b.barcode, category: b.category,
      totalCopies: b.totalCopies, availableCopies: b.availableCopies, customFields: this.cf(b.customFields), createdAt: b.createdAt,
    };
  }

  private async loanDto(tx: TenantTx, id: string): Promise<BookLoanDto> {
    const l = await tx.bookLoan.findFirstOrThrow({ where: { id } });
    const book = await tx.libraryBook.findFirstOrThrow({ where: { id: l.bookId }, select: { title: true, barcode: true } });
    const borrower = await tx.user.findFirst({ where: { id: l.borrowerId }, select: { name: true } });
    return mapLoanDto(l, book.title, book.barcode, borrower?.name ?? "");
  }

  private log(tx: TenantTx, p: Principal, action: string, entityId: string, metadata: Record<string, unknown>) {
    return this.audit.record(
      { actorId: p.userId, action, entity: "library", entityId, schoolId: p.schoolId, metadata },
      tx,
    );
  }
}

/**
 * Pure loan-row → DTO. The book title/barcode and borrower name are supplied by
 * the caller — fetched once for a single loan (loanDto) or batched across a page
 * (listLoans) — so listing never fans out into a per-row query storm.
 */
function mapLoanDto(
  l: {
    id: string;
    bookId: string;
    borrowerId: string;
    status: string;
    issuedAt: Date;
    dueAt: Date;
    returnedAt: Date | null;
    renewedCount: number;
    fineMinor: number;
    finePaid: boolean;
  },
  bookTitle: string,
  barcode: string,
  borrowerName: string,
): BookLoanDto {
  return {
    id: l.id,
    bookId: l.bookId,
    bookTitle,
    barcode,
    borrowerId: l.borrowerId,
    borrowerName,
    status: l.status,
    issuedAt: l.issuedAt,
    dueAt: l.dueAt,
    returnedAt: l.returnedAt,
    renewedCount: l.renewedCount,
    fineMinor: l.fineMinor,
    finePaid: l.finePaid,
    overdue: l.status === "ISSUED" && l.dueAt.getTime() < Date.now(),
  };
}
