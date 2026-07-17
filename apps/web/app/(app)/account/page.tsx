import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { MfaSetup } from "@/components/security/MfaSetup";
import { ChangePasswordForm } from "@/components/auth/ChangePasswordForm";
import { PhoneCard } from "@/components/account/PhoneCard";

export const dynamic = "force-dynamic";

export default async function AccountPage({ searchParams }: { searchParams: { enroll2fa?: string } }) {
  const session = await auth();
  const user = session!.user;
  const [mfa, myPhone] = await Promise.all([
    apiGet<{ enabled: boolean }>("/security/mfa/status"),
    apiGet<{ phone: string | null }>("/notifications/me/phone"),
  ]);
  const mustEnroll = user.mfaEnrollRequired || searchParams.enroll2fa === "1";

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="account" permissions={user.permissions}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Account &amp; security</h1>
          <p className="mt-1 text-sm text-muted-foreground">{user.name} · {user.email}</p>
        </div>

        {mustEnroll && !mfa?.enabled && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm">
            <p className="font-medium text-destructive">Two-factor authentication is required for your account.</p>
            <p className="mt-1 text-muted-foreground">
              Your administrator has mandated 2FA. Set it up below to regain access to the rest of the app.
            </p>
          </div>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Password</CardTitle>
            <CardDescription>
              Change your password any time. Everyone must reset at least every 30 days; you&apos;ll be signed out
              afterwards to sign back in with the new one.
            </CardDescription>
          </CardHeader>
          <CardContent className="max-w-sm">
            <ChangePasswordForm />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Two-factor authentication (TOTP)</CardTitle>
            <CardDescription>
              Adds an authenticator-app code to every login. Strongly recommended
              for staff and required before high-risk actions via step-up.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <MfaSetup enabled={Boolean(mfa?.enabled)} />
          </CardContent>
        </Card>

        <PhoneCard initialPhone={myPhone?.phone ?? null} />

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Your roles</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-1.5">
              {user.roles.map((r) => <Badge key={r} variant="secondary">{r}</Badge>)}
            </div>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
