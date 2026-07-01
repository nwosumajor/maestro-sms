import { auth, signOut } from "@/lib/auth";
import { ChangePasswordForm } from "@/components/auth/ChangePasswordForm";

export const dynamic = "force-dynamic";

// Standalone (no AppShell) so a password-expired user — held here by middleware —
// has a clean, focused screen with only "change password" or "sign out".
export default async function ChangePasswordPage({ searchParams }: { searchParams: { expired?: string } }) {
  const session = await auth();
  const expired = searchParams.expired === "1" || session?.user.passwordExpired;

  return (
    <main className="grid min-h-screen place-items-center bg-background bg-brand-wash p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-primary text-sm font-bold text-primary-foreground">
            {(session?.user.schoolName ?? "S").slice(0, 1).toUpperCase()}
          </span>
          <span className="text-sm font-semibold tracking-tight">{session?.user.schoolName ?? "Account"}</span>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {expired ? "Your password has expired" : "Change your password"}
        </h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          {expired
            ? "For security, passwords must be reset every 30 days. Set a new one to continue."
            : "Choose a new password (at least 8 characters, different from your current one)."}
        </p>
        <div className="mt-7">
          <ChangePasswordForm />
        </div>
        <form
          action={async () => {
            "use server";
            await signOut({ redirectTo: "/login" });
          }}
          className="mt-6"
        >
          <button type="submit" className="text-xs font-medium text-muted-foreground hover:text-foreground">
            Sign out instead
          </button>
        </form>
      </div>
    </main>
  );
}
