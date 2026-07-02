import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import type { PublicBrandingDto } from "@sms/types";
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

  const schoolName = branding?.schoolName ?? "School Management System";
  const initial = schoolName.slice(0, 1).toUpperCase();

  return (
    <main className="grid min-h-screen lg:grid-cols-[1.05fr_1fr]">
      {/* Identity panel — the console's thesis. Hidden on small screens. */}
      <aside className="relative hidden overflow-hidden bg-primary text-primary-foreground lg:flex lg:flex-col lg:justify-between lg:p-12">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.18]"
          style={{
            backgroundImage:
              "linear-gradient(hsl(0 0% 100% / 0.6) 1px, transparent 1px), linear-gradient(90deg, hsl(0 0% 100% / 0.6) 1px, transparent 1px)",
            backgroundSize: "32px 32px",
          }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -right-24 -top-24 h-96 w-96 rounded-full bg-white/10 blur-3xl"
        />
        {/* The red margin rule over the squared paper — the exercise-book page, literal. */}
        <div aria-hidden className="pointer-events-none absolute inset-y-0 left-8 w-px bg-rule/80" />
        <div className="relative flex items-center gap-3">
          {branding?.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- remote tenant logo, not a build asset
            <img src={branding.logoUrl} alt={`${schoolName} logo`} className="h-11 w-11 rounded-xl bg-white/10 object-contain p-1.5" />
          ) : (
            <div className="grid h-11 w-11 place-items-center rounded-xl bg-white/12 text-lg font-bold ring-1 ring-inset ring-white/20">
              {initial}
            </div>
          )}
          <span className="text-sm font-semibold tracking-tight">{schoolName}</span>
        </div>

        <div className="relative max-w-md">
          <p className="eyebrow text-primary-foreground/70">School operations, in one register</p>
          <h1 className="mt-3 text-4xl font-semibold leading-[1.1] tracking-tight">
            Every class, fee, and record — kept in order.
          </h1>
          <p className="mt-4 text-sm leading-relaxed text-primary-foreground/80">
            Attendance, timetables, results, and approvals for your whole school, with the
            privacy and least-privilege controls a school owes its students.
          </p>
        </div>

        <dl className="relative grid grid-cols-3 gap-6 border-t border-white/15 pt-6 text-primary-foreground/90">
          {[
            ["1 sign-in", "for every role"],
            ["Tenant-isolated", "by design"],
            ["Audit-logged", "end to end"],
          ].map(([stat, label]) => (
            <div key={stat}>
              <dt className="text-sm font-semibold tracking-tight">{stat}</dt>
              <dd className="mt-0.5 text-xs text-primary-foreground/65">{label}</dd>
            </div>
          ))}
        </dl>
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
