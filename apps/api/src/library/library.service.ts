// =============================================================================
// LibraryService — book catalogue + loans
// =============================================================================
// Tenant-scoped (RLS). The librarian (library.manage) manages the barcode-keyed
// catalogue, issues/returns/renews for anyone, runs issued/due reports, exports
// CSV, and records fine receipts. Students (library.borrow) search and self-issue/
// renew/return from their dashboard. Relationship scoping: a non-librarian may
// only act on their OWN loans. Overdue fines accrue per day on return. Audited.
// =============================================================================

import {
  ConflictException,
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { NotificationService } from "../notifications/notification.service";
import { csvCell } from "../common/csv";
import { Prisma } from "@sms/db";
import type { BookLoanDto, FineReceiptDto, LibraryBookDto, LibraryReportDto } from "@sms/types";
import { formatMoney, effectiveLibraryFinePerDayMinor, FEE_SOURCES } from "@sms/types";
import type { PaymentMethodValue } from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";
import { dateWindow } from "../common/status-filter";

type Json = Record<string, string>;

// Library policy (sensible defaults; could become per-school settings later).
/** Ceiling on a catalogue CSV. Well past any school library, but a CSV must still
 *  fit in memory and in one response — and when it bites, the file says so. */
const CATALOGUE_EXPORT_MAX = 20_000;

const LOAN_DAYS = 14;
const RENEW_DAYS = 7;
const MAX_RENEWALS = 2;
/**
 * The DEFAULT overdue fine per day, in the platform's HOME currency: ₦50.
 *
 * // GOTCHA: this was applied to every school whatever `school.currency` says.
 * 5,000 minor units is ₦50 as intended, £50 in a British school and 5,000
 * francs in a Senegalese one — a charge that lands on a family's fee invoice.
 * The DISPLAY side of this was made currency-aware (see `returnLoan`); the
 * AMOUNT was not, so the fine was correctly formatted and wrong.
 *
 * A school states its own figure in `school.libraryFinePerDayMinor`. Unset
 * FAILS TO ZERO for any other currency — no fine — because an unset CHARGE
 * must not bill a family, and charging nothing is recoverable in a way that
 * putting £50 a day on an invoice is not. (The payment-approval threshold
 * beside it fails the OTHER way for exactly this reason: it is a control.)
 */
const FINE_PER_DAY_MINOR = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class LibraryService {
  private readonly logger = new Logger("LibraryService");

  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly notifications: NotificationService,
  ) {}

  /**
   * Tell the borrower — and a pupil's guardians — about their fine.
   *
   * A charge the family cannot see is the defect this module just fixed by
   * making fines a real ISSUED debt; a charge nobody MENTIONS is the quieter
   * half of it. Every other charge on this ledger announces itself: the fees
   * module notifies guardians when an invoice is issued and receipts every
   * posted payment. A library fine did neither, so the first a parent knew of
   * it was finding it on their invoice list, if they looked.
   *
   * Staff borrow books too, so the BORROWER is always told and guardians are
   * added only when there are any — nobody is a special case, they simply have
   * no parentChild rows.
   *
   * Best-effort, and after the transaction: a notification failure must never
   * undo a return or a payment that already happened.
   */
  private async notifyFine(
    p: Principal,
    borrowerId: string,
    msg: { type: string; title: string; body: string; data?: Record<string, unknown> },
  ): Promise<void> {
    try {
      const guardians = (await this.db.runAsTenant(this.ctx(p), (tx) =>
        tx.parentChild.findMany({ where: { studentId: borrowerId }, select: { parentId: true } }),
      )) as Array<{ parentId: string }>;
      const recipients = [...new Set([borrowerId, ...guardians.map((g) => g.parentId)])];
      for (const recipientId of recipients) {
        await this.notifications.enqueue(this.ctx(p), {
          recipientId,
          type: msg.type,
          title: msg.title,
          body: msg.body,
          data: msg.data,
          channels: ["EMAIL"],
        });
      }
    } catch (err) {
      this.logger.error(`Library fine notification failed for ${borrowerId}: ${String(err)}`);
    }
  }

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

  /** Whole days a loan is past `dueAt` — never negative. One definition, read by
   *  the renewal (which banks them) and the return (which charges them). */
  private lateDaysAt(dueAt: Date, at: Date): number {
    return Math.max(0, Math.floor((at.getTime() - dueAt.getTime()) / DAY_MS));
  }

  async renew(p: Principal, loanId: string): Promise<BookLoanDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const loan = await tx.bookLoan.findFirst({ where: { id: loanId } });
      if (!loan) throw new NotFoundException("Loan not found");
      if (!this.isLibrarian(p) && loan.borrowerId !== p.userId) throw new NotFoundException("Loan not found");
      // Read for the MESSAGE, claim for the RULE. The two checks below tell a
      // borrower exactly why they were refused; the conditional update is what
      // actually enforces it, because both of them are reads and two concurrent
      // renewals at READ COMMITTED both pass them before either commits — and
      // the cap is then exceeded by whoever commits second.
      if (loan.status !== "ISSUED") throw new BadRequestException("Loan is not active");
      if (loan.renewedCount >= MAX_RENEWALS) throw new BadRequestException("Maximum renewals reached");
      const dueAt = new Date(Math.max(loan.dueAt.getTime(), Date.now()) + RENEW_DAYS * DAY_MS);
      // BANK THE DAYS ALREADY LATE BEFORE MOVING THE DUE DATE.
      //
      // The fine is computed at RETURN from `dueAt`, and this line moves `dueAt`
      // into the future — so without carrying them, the days already late simply
      // stopped existing. `library.borrow` is held by STUDENT and the check above
      // lets a borrower renew their OWN loan, so this needed no staff: measured
      // live, a 30-day-overdue loan returned without renewing charged NGN
      // 1,500.00, and the same loan renewed by the pupil charged NGN 0.00.
      //
      // Days already late are a fact about a loan; a renewal is not a reason for
      // a fact to stop being true.
      const alreadyLate = this.lateDaysAt(loan.dueAt, new Date());
      const claimed = await tx.bookLoan.updateMany({
        where: { id: loanId, status: "ISSUED", renewedCount: { lt: MAX_RENEWALS } },
        data: {
          dueAt,
          renewedCount: { increment: 1 },
          ...(alreadyLate > 0 ? { lateDaysCarried: { increment: alreadyLate } } : {}),
        },
      });
      if (claimed.count === 0) {
        // The row moved between the read and the write — another renewal or a
        // return landed first.
        throw new BadRequestException("This loan changed while you were renewing it — reload and try again");
      }
      await this.log(tx, p, "library.renew", loanId, {
        renewedCount: loan.renewedCount + 1,
        // Recorded, so a fine that survives a renewal can be explained from the
        // trail rather than looking like a mistake at the desk.
        lateDaysCarried: alreadyLate,
      });
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
    let lateDays = 0;
    // THE SCHOOL'S currency, never a hard-coded one: money is scaled by the
    // currency and eleven of the catalogued African currencies have no minor
    // unit at all, so a divide-by-100 or an assumed NGN prints a CFA-franc fine
    // at a hundredth of its value.
    let fineCurrency = "NGN";
    const dto = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const loan = await tx.bookLoan.findFirst({ where: { id: loanId } });
      if (!loan) throw new NotFoundException("Loan not found");
      if (loan.status !== "ISSUED") throw new BadRequestException("Loan already returned");
      const now = new Date();
      // The days late SINCE the current due date, plus any banked by a renewal.
      // `?? 0` is arithmetic hygiene, not a fallback with an opinion: the column
      // is NOT NULL DEFAULT 0, so it is only ever absent on a hand-built stub —
      // and `undefined + n` is NaN, which would reach a fine and an invoice.
      const daysLate = (loan.lateDaysCarried ?? 0) + this.lateDaysAt(loan.dueAt, now);
      // The school's own daily rate, in the school's own currency.
      const school = await tx.school.findFirst({
        where: { id: p.schoolId },
        select: { libraryFinePerDayMinor: true, currency: true },
      });
      const perDayMinor = effectiveLibraryFinePerDayMinor({
        configuredMinor: school?.libraryFinePerDayMinor,
        currency: school?.currency,
        homeDefaultMinor: FINE_PER_DAY_MINOR,
      });
      const fineMinor = daysLate * perDayMinor;
      lateDays = daysLate;
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
      // CLAIM THE RETURN BEFORE ACTING ON IT.
      //
      // The `status !== "ISSUED"` check above is a read, and issuing was made
      // atomic against exactly this while returning was not. At READ COMMITTED
      // two returns of the same loan both read ISSUED before either commits,
      // both pass, and both do everything below. Proven against the database by
      // interleaving the service's own statements in two sessions: a book with
      // THREE copies finished with FOUR available — stock the library does not
      // own, and it never comes back, because nothing ever recounts.
      //
      // (Six concurrent HTTP returns did NOT reproduce it — the window is
      // narrow. That is a reason to close it cheaply, not a reason to call it
      // safe: a double-clicked button, a retried request or a slower database
      // widens it, and the same read-then-write shape was worth hardening on
      // the issue side.)
      //
      // The conditional update is the serialisation point: exactly one caller
      // gets count 1, so exactly one bills the fine and exactly one puts the
      // copy back. Everything with a consequence happens after it.
      const claimed = await tx.bookLoan.updateMany({
        where: { id: loanId, status: "ISSUED" },
        data: { status: "RETURNED", returnedAt: now, fineMinor },
      });
      if (claimed.count === 0) throw new BadRequestException("Loan already returned");
      if (fineMinor > 0) fineCurrency = await this.billFine(tx, p, loan, fineMinor, daysLate);
      await tx.libraryBook.update({ where: { id: loan.bookId }, data: { availableCopies: { increment: 1 } } });
      await this.log(tx, p, "library.return", loanId, { daysLate, fineMinor });
      return this.loanDto(tx, loanId);
    });
    // After the transaction, and never inside it: the return and the charge are
    // committed facts by now, so a notification that fails costs a message and
    // not a book.
    if (dto.fineMinor > 0) {
      await this.notifyFine(p, dto.borrowerId, {
        type: "INVOICE_ISSUED",
        title: "Library fine",
        body:
          `${dto.bookTitle} was returned ${lateDays} day${lateDays === 1 ? "" : "s"} late. ` +
          `A fine of ${formatMoney(dto.fineMinor, fineCurrency)} has been added to the invoice.`,
        data: { loanId, fineMinor: dto.fineMinor },
      });
    }
    return dto;
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
  ): Promise<string> {
    const description = `Library fine — loan ${loan.id.slice(0, 8).toUpperCase()}`;
    const existing = await tx.invoiceLineItem.findFirst({
      where: { description, invoice: { studentId: loan.borrowerId } },
      select: { id: true },
    });
    if (existing) {
      // Already billed — a replay, not a second fine. Still report the currency
      // the charge is denominated in, because the caller announces it.
      const inv = await tx.invoice.findFirst({ where: { lineItems: { some: { description } } }, select: { currency: true } });
      return inv?.currency ?? "NGN";
    }
    // The SCHOOL's currency: settlement refuses a charge whose currency differs
    // from the invoice, so a fine raised in the column default could never be
    // paid online by a school billing in anything else.
    const school = await tx.school.findFirst({ where: { id: p.schoolId }, select: { currency: true } });
    // A FINE IS DUE THE MOMENT THE BOOK IS LATE, so it goes onto a LIVE debt.
    //
    // This used to attach the fine to a DRAFT invoice, or create one — and a
    // DRAFT is not a bill. The fees service says so itself, in both directions:
    // it hides DRAFT invoices from families ("A DRAFT IS NOT A BILL YET, so a
    // family must not be shown one") and refuses to record a payment against
    // one ("Issue the invoice before recording payment"). So the fine was a
    // charge nobody could see and the library then took cash against an invoice
    // the finance module would not have accepted a payment on.
    //
    // Reproduced end to end before this change: a book returned seven days
    // late billed 35,000 to a DRAFT invoice; the parent's invoice list showed
    // two invoices and neither was the fine; paying at the desk posted against
    // the DRAFT and took it straight to PAID without ever being ISSUED; and the
    // school's own figures — invoiced 185,000, collected 85,000 — contained
    // neither the charge nor the cash, because the billable set excludes DRAFT.
    // Which is the exact opposite of why the fine was put on the ledger.
    //
    // PARTIALLY_PAID counts as a live debt and PAID deliberately does not:
    // adding a line to a settled invoice would silently reopen it as underpaid.
    let invoice = await tx.invoice.findFirst({
      where: { studentId: loan.borrowerId, status: { in: ["ISSUED", "PARTIALLY_PAID"] } },
      orderBy: { createdAt: "desc" },
    });
    if (!invoice) {
      invoice = await tx.invoice.create({
        data: {
          schoolId: p.schoolId,
          studentId: loan.borrowerId,
          createdById: p.userId,
          reference: `FINE-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          status: "ISSUED",
          totalMinor: 0,
          currency: school?.currency ?? "NGN",
          dueDate: new Date(),
        },
      });
    }
    await tx.invoiceLineItem.create({
      data: { schoolId: p.schoolId, invoiceId: invoice.id, description, amountMinor: fineMinor, quantity: 1, source: FEE_SOURCES.LIBRARY },
    });
    await tx.invoice.update({ where: { id: invoice.id }, data: { totalMinor: { increment: fineMinor } } });
    await this.log(tx, p, "library.fine.billed", loan.id, { fineMinor, daysLate, invoiceId: invoice.id });
    return invoice.currency;
  }

  /** Record payment of an overdue fine → a digital receipt. Librarian. */
  /**
   * Record payment of a fine — and HOW it arrived.
   *
   * The method was hard-coded CASH. The fees journal export has a Method
   * column, so every fine a school ever collected reached its accountant as
   * cash whether it was handed over at the desk, transferred, or paid by card —
   * and the endpoint accepted no method, so it could not be recorded correctly
   * even by somebody who noticed. A ledger that cannot say how the money
   * arrived is wrong in the one column reconciliation reads.
   *
   * CASH stays the default: it is what a library desk mostly takes, and it is
   * what every existing row says.
   */
  async payFine(p: Principal, loanId: string, method: PaymentMethodValue = "CASH"): Promise<FineReceiptDto> {
    let paidCurrency = "NGN";
    let payerId = "";
    const receipt = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const loan = await tx.bookLoan.findFirst({ where: { id: loanId } });
      if (!loan) throw new NotFoundException("Loan not found");
      if (loan.fineMinor <= 0) throw new BadRequestException("No fine to pay");
      if (loan.finePaid) throw new BadRequestException("Fine already paid");
      const paidAt = new Date();
      // CLAIM THE SETTLEMENT. `finePaid` is read above and the Payment is
      // written below, so at READ COMMITTED two callers both see false, both
      // set it true — which is idempotent and looks harmless — and both POST A
      // PAYMENT. Nothing on `payment` prevents it: the table has no unique
      // constraint that a duplicate fine would violate, so the invoice is
      // credited twice for one fine and can tip into PAID or an overpayment
      // credit off the back of money that was handed over once.
      //
      // The two reads above stay because they say WHICH refusal it is; this is
      // what enforces it.
      const claimed = await tx.bookLoan.updateMany({
        where: { id: loanId, finePaid: false, fineMinor: { gt: 0 } },
        data: { finePaid: true, finePaidAt: paidAt },
      });
      if (claimed.count === 0) throw new BadRequestException("Fine already paid");

      // POST THE MONEY, do not just tick a box.
      //
      // This used to set a boolean and print a receipt, and write nothing to the
      // ledger — cash over the desk that the finance reports, the journal export
      // and reconciliation never saw. The charge is billed on return; this is
      // the settlement of it, and it goes through the same Payment table as
      // every other payment so a fine is countable in the same place as a fee.
      const findLine = () =>
        tx.invoiceLineItem.findFirst({
          where: {
            description: `Library fine — loan ${loanId.slice(0, 8).toUpperCase()}`,
            invoice: { studentId: loan.borrowerId },
          },
          select: { invoiceId: true },
        });
      // CASH IS NEVER TAKEN WITH NOTHING ON THE LEDGER.
      //
      // The posting was conditional on finding the charge, and a miss was
      // silent: the fine was marked paid, a receipt was printed, and no Payment
      // existed. There is a loan on the live database in exactly that state —
      // `fineMinor` set with no line item, because it predates fines being
      // billed at all — so the first person to pay it would have handed over
      // money the ledger never heard about.
      //
      // Billing here rather than refusing: the school IS owed this, the
      // librarian has the borrower in front of them, and `billFine` is
      // idempotent on the same marker, so it either creates the missing charge
      // or finds it already there.
      let line = await findLine();
      if (!line) {
        await this.billFine(tx, p, { id: loanId, borrowerId: loan.borrowerId, bookId: loan.bookId }, loan.fineMinor, 0);
        line = await findLine();
      }
      if (line) {
        await tx.payment.create({
          data: {
            schoolId: p.schoolId,
            invoiceId: line.invoiceId,
            amountMinor: loan.fineMinor,
            method,
            kind: "PAYMENT",
            status: "POSTED",
            recordedById: p.userId,
            reference: `FINE-${loanId.slice(0, 8).toUpperCase()}`,
          },
        });
        await this.settleInvoiceIfPaid(tx, line.invoiceId);
        paidCurrency =
          (await tx.invoice.findFirst({ where: { id: line.invoiceId }, select: { currency: true } }))?.currency ??
          paidCurrency;
      }
      await this.log(tx, p, "library.fine.pay", loanId, { fineMinor: loan.fineMinor, invoiceId: line?.invoiceId ?? null });
      const book = await tx.libraryBook.findFirstOrThrow({ where: { id: loan.bookId }, select: { title: true } });
      const borrower = await tx.user.findFirst({ where: { id: loan.borrowerId }, select: { name: true } });
      payerId = loan.borrowerId;
      return {
        loanId,
        bookTitle: book.title,
        borrowerName: borrower?.name ?? "",
        fineMinor: loan.fineMinor,
        paidAt,
        reference: `FINE-${loanId.slice(0, 8).toUpperCase()}`,
      };
    });
    // A RECEIPT, like every other payment on this ledger. Cash handed over at a
    // desk is the payment least likely to leave the payer with anything in
    // writing, and the fees module already receipts every posted payment — this
    // one went through the same Payment table and told nobody.
    await this.notifyFine(p, payerId, {
      type: "PAYMENT_RECEIVED",
      title: "Library fine paid",
      body: `${formatMoney(receipt.fineMinor, paidCurrency)} received for ${receipt.bookTitle}. Receipt ${receipt.reference}.`,
      data: { loanId, reference: receipt.reference },
    });
    return receipt;
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
      const window = dateWindow(opts.from, opts.to);
      const issuedRange: Record<string, Date> = {
        ...(window.from ? { gte: window.from } : {}),
        ...(window.to ? { lte: window.to } : {}),
      };
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
    const header = "Title,Author,ISBN,Barcode,Category,TotalCopies,AvailableCopies";
    const rows = books.map((b) =>
      [b.title, b.author, b.isbn, b.barcode, b.category, b.totalCopies, b.availableCopies].map(csvCell).join(","),
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
