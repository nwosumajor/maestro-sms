import { auth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { AppShell } from "@/components/shell/AppShell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { MfaSetup } from "@/components/security/MfaSetup";

export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const session = await auth();
  const user = session!.user;
  const mfa = await apiGet<{ enabled: boolean }>("/security/mfa/status");

  return (
    <AppShell schoolName={user.schoolName} userName={user.name ?? "User"} active="account" permissions={user.permissions}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Account &amp; security</h1>
          <p className="mt-1 text-sm text-muted-foreground">{user.name} · {user.email}</p>
        </div>

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
