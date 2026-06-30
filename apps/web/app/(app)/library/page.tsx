import type { LibraryBookDto, BookLoanDto, Serialized } from "@sms/types";
import { hasPermission } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { LibraryManager } from "@/components/library/LibraryManager";

export const dynamic = "force-dynamic";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "/api/sms";

export default async function LibraryPage() {
  const session = await auth();
  const user = session!.user;
  if (!hasPermission(user.permissions, "library.read")) redirect("/dashboard");
  const canManage = hasPermission(user.permissions, "library.manage");

  const [books, loans] = await Promise.all([
    apiGet<Serialized<LibraryBookDto>[]>("/library/books"),
    apiGet<Serialized<BookLoanDto>[]>("/library/loans"),
  ]);

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="library" permissions={user.permissions}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Library</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {canManage
              ? "Barcode catalogue, issue/return/renew, overdue fines + receipts, and CSV export."
              : "Search the catalogue, issue books to yourself, and manage your loans."}
          </p>
        </div>
        <LibraryManager books={books ?? []} loans={loans ?? []} apiBaseUrl={API_BASE} canManage={canManage} />
      </div>
    </AppShell>
  );
}
