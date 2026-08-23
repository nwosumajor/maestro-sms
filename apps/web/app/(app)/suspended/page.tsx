import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { SignOutButton } from "@/components/shell/SignOutButton";

export const dynamic = "force-dynamic";

/**
 * What a school sees once the platform has switched it off.
 *
 * Every authenticated read returns 403 in that state, and `apiGet` answers a
 * plain 403 with `null` — correct for a missing permission, and useless here:
 * the user would get a whole app of empty panels and no reason for any of it.
 * `apiGet` recognises the suspension code and sends them here instead.
 *
 * DELIBERATELY READS NOTHING. Every request this page could make would be
 * refused, so it asks for nothing and says only what is true and useful: what
 * has happened, that their data is intact, and who can undo it.
 */
export default async function SuspendedPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-6 p-6">
      <Alert variant="destructive">
        <AlertTitle>This school&apos;s access has been suspended</AlertTitle>
        <AlertDescription>
          <p className="mt-2">
            {session.user.schoolName ?? "Your school"} cannot be used at the moment. This was done by
            the platform operator, not by anyone at your school, and nobody here can undo it.
          </p>
          <p className="mt-3">
            <strong>Nothing has been deleted.</strong> Your records, invoices and balances are
            exactly as you left them, and everything returns as it was once access is restored.
          </p>
          <p className="mt-3">
            Please contact your provider to have it reinstated. If you believe this is a mistake,
            quote your school name when you get in touch.
          </p>
        </AlertDescription>
      </Alert>
      <div>
        <SignOutButton />
      </div>
    </main>
  );
}
