import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import type { PublicBrandingDto } from "@sms/types";
import { LoginForm } from "@/components/auth/LoginForm";
import { LoginShowcase } from "@/components/auth/LoginShowcase";


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

  const schoolName = branding?.schoolName ?? "School Management System";
  const initial = schoolName.slice(0, 1).toUpperCase();

  return (
    <main className="grid min-h-screen lg:grid-cols-[1.05fr_1fr]">
      {/* Identity panel — FULL-BLEED sliding photography; text takes each
          image's own colour palette. No brand colour field at all. */}
      <aside className="relative hidden overflow-hidden lg:block">
        <LoginShowcase logoUrl={branding?.logoUrl ?? null} schoolName={schoolName} initial={initial} />
      </aside>

      {/* Sign-in panel */}
      <section className="flex min-h-screen items-center justify-center bg-background bg-brand-wash px-6 py-12">
        <div className="w-full max-w-sm">
          {/* Compact brand mark for the mobile view (the identity panel is hidden). */}
          <div className="mb-8 flex items-center gap-2.5 lg:hidden">
            <div className="grid h-9 w-9 place-items-center rounded-xl bg-primary text-sm font-bold text-primary-foreground">
              {initial}
            </div>
            <span className="text-sm font-semibold tracking-tight">{schoolName}</span>
          </div>

          <h2 className="text-2xl font-semibold tracking-tight">Welcome back</h2>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {branding ? `Sign in to ${schoolName}.` : "Sign in to your school account."}
          </p>

          <div className="mt-7">
            <LoginForm />
          </div>

          <p className="mt-6 rounded-lg border border-border/70 bg-muted/50 px-3 py-2.5 text-xs text-muted-foreground">
            <span className="font-medium text-foreground/70">Demo accounts</span> · principal@demo.school ·
            teacher@demo.school — password <span className="tnum font-mono text-foreground/70">password123</span>
          </p>
        </div>
      </section>
    </main>
  );
}
