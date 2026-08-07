import type { LibraryBookDto, BookLoanDto, Serialized, LibraryReportDto } from "@sms/types";
import { hasPermission } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { money } from "@/lib/format";
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

  const [books, loans, report] = await Promise.all([
    apiGet<Serialized<LibraryBookDto>[]>("/library/books"),
    apiGet<Serialized<BookLoanDto>[]>("/library/loans"),
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
              { label: "Fines accrued", value: money(report.finesAccruedMinor) },
              { label: "Fines collected", value: money(report.finesCollectedMinor) },
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
        <LibraryManager books={books ?? []} loans={loans ?? []} apiBaseUrl={API_BASE} canManage={canManage} />
      </div>
    </AppShell>
  );
}
