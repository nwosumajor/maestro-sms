import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import type { PublicBrandingDto } from "@sms/types";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { LoginForm } from "@/components/auth/LoginForm";

export const dynamic = "force-dynamic";

const API_BASE = process.env.API_BASE_URL ?? "http://localhost:3001";

/** Public, pre-auth fetch of a school's branding by slug (?school=slug). */
async function getBranding(slug: string | undefined): Promise<PublicBrandingDto | null> {
  if (!slug) return null;
  try {
    const res = await fetch(`${API_BASE}/public/schools/${encodeURIComponent(slug)}/branding`, { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as PublicBrandingDto;
  } catch {
    return null;
  }
}

export default async function LoginPage({ searchParams }: { searchParams: { school?: string } }) {
  // Already signed in -> straight to the app.
  const session = await auth();
  if (session?.user) redirect("/dashboard");

  const branding = await getBranding(searchParams.school);

  return (
    <main className="grid min-h-screen place-items-center bg-background p-6">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center text-center">
          {/* Per-school logo (paid perk; hidden by the API when the subscription lapses). */}
          {branding?.logoUrl && (
            // eslint-disable-next-line @next/next/no-img-element -- remote tenant logo, not a build asset
            <img src={branding.logoUrl} alt={`${branding.schoolName} logo`} className="mb-3 h-16 w-16 rounded-md object-contain" />
          )}
          <CardTitle>{branding?.schoolName ?? "School Management System"}</CardTitle>
          <CardDescription>
            {branding ? `Sign in to ${branding.schoolName}.` : "Sign in to your school account."}
          </CardDescription>
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
