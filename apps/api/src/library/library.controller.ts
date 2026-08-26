import { RequireModule } from "../auth/require-module.decorator";
import { BadRequestException, Delete, Body, Controller, Get, Param, Post, Put, Query, Res, StreamableFile } from "@nestjs/common";
import type { Response } from "express";
import { BOOK_LOAN_STATUSES, LIBRARY_PERMISSIONS, MODULES, PAYMENT_METHODS } from "@sms/types";
import { narrowStatus } from "../common/status-filter";
import type { BookLoanDto, FineReceiptDto, LibraryBookDto, LibraryReportDto } from "@sms/types";
import { z } from "zod";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { LibraryService } from "./library.service";
import { safeFilename } from "../documents/safe-content-type";

const customFields = z.record(z.string()).optional();
/** How the money arrived. Optional, defaulting to CASH — the same value every
 *  existing row carries, so an old caller behaves exactly as it did. */
const payFineSchema = z.object({
  method: z.enum(PAYMENT_METHODS).optional().default("CASH"),
});

const bookSchema = z.object({
  title: z.string().min(1).max(300),
  author: z.string().max(200).nullish(),
  isbn: z.string().max(40).nullish(),
  barcode: z.string().min(1).max(60),
  category: z.string().max(80).nullish(),
  totalCopies: z.number().int().min(1).max(10000),
  customFields,
});
const bookUpdateSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  author: z.string().max(200).nullish(),
  category: z.string().max(80).nullish(),
  totalCopies: z.number().int().min(1).max(10000).optional(),
  customFields,
});
const issueSchema = z.object({ bookId: z.string().uuid(), borrowerId: z.string().uuid().optional() });

@RequireModule(MODULES.LIBRARY)
@Controller("library")
export class LibraryController {
  constructor(private readonly library: LibraryService) {}

  // catalogue
  @Get("books")
  @RequirePermission(LIBRARY_PERMISSIONS.LIBRARY_READ)
  search(@CurrentPrincipal() p: Principal, @Query("q") q?: string): Promise<LibraryBookDto[]> {
    return this.library.searchBooks(p, q);
  }
  @Post("books")
  @RequirePermission(LIBRARY_PERMISSIONS.LIBRARY_MANAGE)
  createBook(@CurrentPrincipal() p: Principal, @Body(new ZodValidationPipe(bookSchema)) b: z.infer<typeof bookSchema>): Promise<LibraryBookDto> {
    return this.library.createBook(p, b);
  }
  @Put("books/:id")
  @RequirePermission(LIBRARY_PERMISSIONS.LIBRARY_MANAGE)
  updateBook(@CurrentPrincipal() p: Principal, @Param("id") id: string, @Body(new ZodValidationPipe(bookUpdateSchema)) b: z.infer<typeof bookUpdateSchema>): Promise<LibraryBookDto> {
    return this.library.updateBook(p, id, b);
  }

  /** Delete a book with no lending history (409 with the reason otherwise). */
  @Delete("books/:id")
  @RequirePermission(LIBRARY_PERMISSIONS.LIBRARY_MANAGE)
  deleteBook(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    return this.library.deleteBook(p, id);
  }

  // CSV export (librarian)
  @Get("books/export.csv")
  @RequirePermission(LIBRARY_PERMISSIONS.LIBRARY_MANAGE)
  async exportCsv(@CurrentPrincipal() p: Principal, @Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
    const { csv, filename } = await this.library.exportCsv(p);
    res.set({ "Content-Type": "text/csv", "Content-Disposition": `attachment; filename="${safeFilename(filename)}"` });
    return new StreamableFile(Buffer.from(csv, "utf8"));
  }

  // loans
  @Get("loans")
  @RequirePermission(LIBRARY_PERMISSIONS.LIBRARY_READ)
  loans(@CurrentPrincipal() p: Principal, @Query("borrowerId") borrowerId?: string, @Query("status") status?: string): Promise<BookLoanDto[]> {
    // Live: `?status=OUT` — a plausible guess — turned 26 loans into 0, with a
    // 200, so the page reported that the school has no books on loan.
    return this.library.listLoans(p, { borrowerId, status: narrowStatus(status, BOOK_LOAN_STATUSES) });
  }

  /** Issue: librarians (library.manage) to anyone; students (library.borrow) self only. */
  @Post("loans/issue")
  @RequirePermission(LIBRARY_PERMISSIONS.LIBRARY_BORROW)
  issue(@CurrentPrincipal() p: Principal, @Body(new ZodValidationPipe(issueSchema)) b: z.infer<typeof issueSchema>): Promise<BookLoanDto> {
    return this.library.issue(p, b);
  }
  @Post("loans/:id/renew")
  @RequirePermission(LIBRARY_PERMISSIONS.LIBRARY_BORROW)
  renew(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<BookLoanDto> {
    return this.library.renew(p, id);
  }
  /** Library staff only: a return records that the book is physically back. */
  @Post("loans/:id/return")
  @RequirePermission(LIBRARY_PERMISSIONS.LIBRARY_MANAGE)
  returnLoan(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<BookLoanDto> {
    return this.library.returnLoan(p, id);
  }
  /** Body is optional: an existing caller that sends nothing still records CASH,
   *  which is what every row said before the method could be given at all. */
  @Post("loans/:id/pay-fine")
  @RequirePermission(LIBRARY_PERMISSIONS.LIBRARY_MANAGE)
  payFine(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(payFineSchema)) body: z.infer<typeof payFineSchema>,
  ): Promise<FineReceiptDto> {
    return this.library.payFine(p, id, body.method);
  }

  /**
   * Re-print a receipt for a fine already paid.
   *
   * `payFine` was the only source of it and refuses a second call, so closing
   * the dialog lost the receipt permanently — for money the school had taken.
   * A read: it cannot mark anything paid.
   */
  @Get("loans/:id/fine/receipt")
  @RequirePermission(LIBRARY_PERMISSIONS.LIBRARY_BORROW)
  fineReceipt(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<FineReceiptDto> {
    return this.library.fineReceipt(p, id);
  }

  // reports (librarian)
  @Get("report")
  @RequirePermission(LIBRARY_PERMISSIONS.LIBRARY_MANAGE)
  report(@CurrentPrincipal() p: Principal, @Query("from") from?: string, @Query("to") to?: string): Promise<LibraryReportDto> {
    return this.library.report(p, { from, to });
  }
}
