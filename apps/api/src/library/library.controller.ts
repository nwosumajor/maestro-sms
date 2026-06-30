import { Body, Controller, Get, Param, Post, Put, Query, Res, StreamableFile } from "@nestjs/common";
import type { Response } from "express";
import { LIBRARY_PERMISSIONS } from "@sms/types";
import type { BookLoanDto, FineReceiptDto, LibraryBookDto, LibraryReportDto } from "@sms/types";
import { z } from "zod";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { LibraryService } from "./library.service";

const customFields = z.record(z.string()).optional();
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

  // CSV export (librarian)
  @Get("books/export.csv")
  @RequirePermission(LIBRARY_PERMISSIONS.LIBRARY_MANAGE)
  async exportCsv(@CurrentPrincipal() p: Principal, @Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
    const { csv, filename } = await this.library.exportCsv(p);
    res.set({ "Content-Type": "text/csv", "Content-Disposition": `attachment; filename="${filename}"` });
    return new StreamableFile(Buffer.from(csv, "utf8"));
  }

  // loans
  @Get("loans")
  @RequirePermission(LIBRARY_PERMISSIONS.LIBRARY_READ)
  loans(@CurrentPrincipal() p: Principal, @Query("borrowerId") borrowerId?: string, @Query("status") status?: string): Promise<BookLoanDto[]> {
    return this.library.listLoans(p, { borrowerId, status });
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
  @Post("loans/:id/return")
  @RequirePermission(LIBRARY_PERMISSIONS.LIBRARY_BORROW)
  returnLoan(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<BookLoanDto> {
    return this.library.returnLoan(p, id);
  }
  @Post("loans/:id/pay-fine")
  @RequirePermission(LIBRARY_PERMISSIONS.LIBRARY_MANAGE)
  payFine(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<FineReceiptDto> {
    return this.library.payFine(p, id);
  }

  // reports (librarian)
  @Get("report")
  @RequirePermission(LIBRARY_PERMISSIONS.LIBRARY_MANAGE)
  report(@CurrentPrincipal() p: Principal, @Query("from") from?: string, @Query("to") to?: string): Promise<LibraryReportDto> {
    return this.library.report(p, { from, to });
  }
}
