// =============================================================================
// LibraryService — book catalogue + loans
// =============================================================================
// Tenant-scoped (RLS). The librarian (library.manage) manages the barcode-keyed
// catalogue, issues/returns/renews for anyone, runs issued/due reports, exports
// CSV, and records fine receipts. Students (library.borrow) search and self-issue/
// renew/return from their dashboard. Relationship scoping: a non-librarian may
// only act on their OWN loans. Overdue fines accrue per day on return. Audited.
// =============================================================================

import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
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

  /** Return a book; compute any overdue fine. Librarian or the borrower. */
  async returnLoan(p: Principal, loanId: string): Promise<BookLoanDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const loan = await tx.bookLoan.findFirst({ where: { id: loanId } });
      if (!loan) throw new NotFoundException("Loan not found");
      if (!this.isLibrarian(p) && loan.borrowerId !== p.userId) throw new NotFoundException("Loan not found");
      if (loan.status !== "ISSUED") throw new BadRequestException("Loan already returned");
      const now = new Date();
      const daysLate = Math.max(0, Math.floor((now.getTime() - loan.dueAt.getTime()) / DAY_MS));
      const fineMinor = daysLate * FINE_PER_DAY_MINOR;
      await tx.bookLoan.update({ where: { id: loanId }, data: { status: "RETURNED", returnedAt: now, fineMinor } });
      await tx.libraryBook.update({ where: { id: loan.bookId }, data: { availableCopies: { increment: 1 } } });
      await this.log(tx, p, "library.return", loanId, { daysLate, fineMinor });
      return this.loanDto(tx, loanId);
    });
  }

  /** Record payment of an overdue fine → a digital receipt. Librarian. */
  async payFine(p: Principal, loanId: string): Promise<FineReceiptDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const loan = await tx.bookLoan.findFirst({ where: { id: loanId } });
      if (!loan) throw new NotFoundException("Loan not found");
      if (loan.fineMinor <= 0) throw new BadRequestException("No fine to pay");
      if (loan.finePaid) throw new BadRequestException("Fine already paid");
      await tx.bookLoan.update({ where: { id: loanId }, data: { finePaid: true } });
      await this.log(tx, p, "library.fine.pay", loanId, { fineMinor: loan.fineMinor });
      const book = await tx.libraryBook.findFirstOrThrow({ where: { id: loan.bookId }, select: { title: true } });
      const borrower = await tx.user.findFirst({ where: { id: loan.borrowerId }, select: { name: true } });
      return {
        loanId,
        bookTitle: book.title,
        borrowerName: borrower?.name ?? "",
        fineMinor: loan.fineMinor,
        paidAt: new Date(),
        reference: `FINE-${loanId.slice(0, 8).toUpperCase()}`,
      };
    });
  }

  /** A borrower's loans (self), or all loans (librarian). */
  async listLoans(p: Principal, opts: { borrowerId?: string; status?: string } = {}): Promise<BookLoanDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const borrowerId = this.isLibrarian(p) ? opts.borrowerId : p.userId;
      const where: Record<string, unknown> = {};
      if (borrowerId) where.borrowerId = borrowerId;
      if (opts.status) where.status = opts.status;
      const loans = await tx.bookLoan.findMany({ where, orderBy: { issuedAt: "desc" }, take: 300 });
      return Promise.all(loans.map((l: { id: string }) => this.loanDto(tx, l.id)));
    });
  }

  // --- reports + CSV (librarian) --------------------------------------------

  /** Tally issued/returned/overdue + fine totals over an optional window. */
  async report(p: Principal, opts: { from?: string; to?: string } = {}): Promise<LibraryReportDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const issuedRange: Record<string, Date> = {};
      if (opts.from) issuedRange.gte = new Date(opts.from);
      if (opts.to) issuedRange.lte = new Date(opts.to);
      const loanWhere = Object.keys(issuedRange).length ? { issuedAt: issuedRange } : {};
      const loans = await tx.bookLoan.findMany({ where: loanWhere });
      const now = Date.now();
      let issued = 0, returned = 0, overdue = 0, finesAccruedMinor = 0, finesCollectedMinor = 0;
      for (const l of loans as Array<{ status: string; dueAt: Date; fineMinor: number; finePaid: boolean }>) {
        if (l.status === "ISSUED") {
          issued++;
          if (l.dueAt.getTime() < now) overdue++;
        } else returned++;
        finesAccruedMinor += l.fineMinor;
        if (l.finePaid) finesCollectedMinor += l.fineMinor;
      }
      const books = await tx.libraryBook.findMany({ select: { totalCopies: true, availableCopies: true } });
      const totalCopies = books.reduce((s: number, b: { totalCopies: number }) => s + b.totalCopies, 0);
      const availableCopies = books.reduce((s: number, b: { availableCopies: number }) => s + b.availableCopies, 0);
      return { issued, returned, overdue, finesAccruedMinor, finesCollectedMinor, totalTitles: books.length, totalCopies, availableCopies };
    });
  }

  /** Export the catalogue as CSV. Librarian. */
  async exportCsv(p: Principal): Promise<{ csv: string; filename: string }> {
    const books = await this.searchBooks(p, undefined);
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
    return { csv: [header, ...rows].join("\n"), filename: `library-catalogue-${new Date().toISOString().slice(0, 10)}.csv` };
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
    return {
      id: l.id,
      bookId: l.bookId,
      bookTitle: book.title,
      barcode: book.barcode,
      borrowerId: l.borrowerId,
      borrowerName: borrower?.name ?? "",
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

  private log(tx: TenantTx, p: Principal, action: string, entityId: string, metadata: Record<string, unknown>) {
    return this.audit.record(
      { actorId: p.userId, action, entity: "library", entityId, schoolId: p.schoolId, metadata },
      tx,
    );
  }
}
