import Link from "next/link";
import { SetPasswordForm } from "@/components/public/SetPasswordForm";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

// PUBLIC page — no authentication. A provisioned admin lands here from the
// one-time set-password link emailed at provisioning and activates their account.
export default function WelcomePage({ searchParams }: { searchParams: { token?: string } }) {
  const token = searchParams.token ?? "";
  return (
    <main className="grid min-h-screen place-items-center bg-background p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Welcome — activate your account</CardTitle>
          <CardDescription>
            Choose the password you&apos;ll use to sign in. This link works once and expires after 7 days.{" "}
            <Link href="/" className="text-primary hover:underline">← Back home</Link>
          </CardDescription>
        </CardHeader>
        <CardContent>
          {token ? (
            <SetPasswordForm token={token} />
          ) : (
            <p className="text-sm text-muted-foreground">
              This page needs the invite link from your welcome email. If yours has expired, ask your platform
              contact for a one-time temporary password instead.
            </p>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
