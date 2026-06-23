import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { LoginForm } from "@/components/auth/LoginForm";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  // Already signed in -> straight to the app.
  const session = await auth();
  if (session?.user) redirect("/dashboard");

  return (
    <main className="grid min-h-screen place-items-center bg-background p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>School Management System</CardTitle>
          <CardDescription>Sign in to your school account.</CardDescription>
        </CardHeader>
        <CardContent>
          <LoginForm />
          <p className="mt-4 text-xs text-muted-foreground">
            Demo: principal@demo.school / teacher@demo.school (password
            <span className="font-mono"> password123</span>)
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
