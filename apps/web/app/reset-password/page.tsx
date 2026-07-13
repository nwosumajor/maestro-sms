import Link from "next/link";
import { ResetPasswordFlow } from "@/components/public/ResetPasswordFlow";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

// PUBLIC page — no authentication. "Forgot password": request a reset email, or
// (arriving from the emailed link) set the new password.
export default function ResetPasswordPage({ searchParams }: { searchParams: { token?: string } }) {
  const token = searchParams.token ?? "";
  return (
    <main className="grid min-h-screen place-items-center bg-background p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{token ? "Set a new password" : "Forgot your password?"}</CardTitle>
          <CardDescription>
            {token
              ? "Choose the new password for your account."
              : "Enter your account email and we'll send you a one-time reset link."}{" "}
            <Link href="/login" className="text-primary hover:underline">← Back to sign in</Link>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ResetPasswordFlow token={token} />
        </CardContent>
      </Card>
    </main>
  );
}
