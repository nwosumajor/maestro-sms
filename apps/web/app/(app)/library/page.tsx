import type { LibraryBookPageDto, BookLoanPageDto, Serialized, LibraryReportDto } from "@sms/types";
import { hasPermission } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { money, regionOf } from "@/lib/format";
import { AppShell } from "@/components/shell/AppShell";
import { LibraryManager } from "@/components/library/LibraryManager";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "/api/sms";

export default async function LibraryPage() {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "library.read")) redirect("/dashboard");
  const canManage = hasPermission(user.permissions, "library.manage");
  // The reader's own locale, so the strip and the loan table beside it render
  // the same money the same way — the table is a client island on `useFormat()`
  // and was already doing this. Currency alone left the strip saying
  // "GHS 300,000.00" above a row saying "GH₵200.00".
  const { locale } = regionOf(user);

  const [books, loans, report] = await Promise.all([
    apiGet<Serialized<LibraryBookPageDto>>("/library/books"),
    apiGet<Serialized<BookLoanPageDto>>("/library/loans"),
    // /library/report was built and never rendered: the librarian could see
    // individual loans but not whether the library as a whole was healthy.
    // Manage-gated, so a student or junior_admin holding only library.read was
    // asking for a report they can never have — the strip then vanished with no
    // explanation, which read as "the library has no stats" rather than "this
    // is not yours to see".
    canManage ? apiGet<Serialized<LibraryReportDto>>("/library/report") : Promise.resolve(null),
  ]);

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="library" permissions={user.permissions}>
      <div className="space-y-6">
        <PageHeader title={<>Library</>} subtitle={<>{canManage
              ? "Barcode catalogue, issue/return/renew, overdue fines + receipts, and CSV export."
              : "Search the catalogue, issue books to yourself, and manage your loans."}</>} />

        {/* The library at a glance. Individual loans were visible; whether the
            collection was healthy — overdue, fines, availability — was not. */}
        {report && (
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {[
              { label: "On loan", value: report.issued },
              { label: "Returned", value: report.returned },
              { label: "Overdue", value: report.overdue, alert: report.overdue > 0 },
              { label: "Titles", value: report.totalTitles },
              { label: "Copies", value: report.totalCopies },
              { label: "Available now", value: report.availableCopies },
              // THE SCHOOL'S OWN CURRENCY. Bare `money()` falls back to the
              // platform's, so this strip read "Fines accrued ₦300,000.00" on a
              // Ghanaian school's page — directly above a loan table printing
              // the very same fines as GH₵200.00. The fine is charged in the
              // school's currency; the total of it is too.
              { label: "Fines accrued", value: money(report.finesAccruedMinor, report.currency, locale) },
              { label: "Fines collected", value: money(report.finesCollectedMinor, report.currency, locale) },
            ].map((t) => (
              <div key={t.label} className="rounded-lg border border-border bg-card p-3">
                <div className="text-xs text-muted-foreground">{t.label}</div>
                <div className={`text-lg font-semibold ${"alert" in t && t.alert ? "text-destructive" : ""}`}>
                  {t.value}
                </div>
              </div>
            ))}
          </div>
        )}
        {/* NULL means the read FAILED — `apiGet` returns null when it could not
            ask — and that is NOT the same as an empty library. Coerced to `[]`
            it told a librarian "The catalogue is empty", which is a statement
            about their school that nobody here is in a position to make. It
            goes through as null and the manager says so. */}
        <LibraryManager books={books} loans={loans} apiBaseUrl={API_BASE} canManage={canManage} />
      </div>
    </AppShell>
  );
}
