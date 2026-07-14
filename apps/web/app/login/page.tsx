import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import type { PublicBrandingDto } from "@sms/types";
import { LoginForm } from "@/components/auth/LoginForm";
import { LoginShowcase } from "@/components/auth/LoginShowcase";
import { ThemeToggle } from "@/components/shell/ThemeToggle";


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

  return (
    <main className="grid min-h-screen lg:grid-cols-[1.05fr_1fr]">
      {/* Identity panel — FULL-BLEED sliding photography; text takes each
          image's own colour palette. No brand colour field at all. */}
      {/* bg matches the scrim so any subpixel gap at the panel edge is invisible. */}
      <aside className="relative hidden overflow-hidden bg-neutral-950 lg:block">
        <LoginShowcase logoUrl={branding?.logoUrl ?? null} schoolName={schoolName} />
      </aside>

      {/* Sign-in panel — theme-adaptive (tokens); the photo panel is theme-free.
          Depth is layered from the design system's own devices: the squared-paper
          "register" grid + a two-tone navy/green ambient glow, both token-driven
          so they read correctly in light AND dark. The form sits in a lifted card
          so it's a deliberate object, not text floating on an empty field. */}
      {/* isolate + the inset-0 decorative layers are self-bounding, so no clip is
          needed on the section — leaving it unclipped lets short mobile screens
          scroll the card/footer instead of truncating them. */}
      <section className="relative isolate flex min-h-screen flex-col bg-background px-6 py-8">
        {/* Ambient brand glow: navy from the top-right, the logo green from the
            bottom-left — the same two-tone identity the rest of the app carries. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundImage:
              "radial-gradient(60% 55% at 100% 0%, hsl(var(--primary) / 0.14), transparent 60%)," +
              "radial-gradient(52% 45% at 0% 100%, hsl(var(--accent-2) / 0.12), transparent 58%)",
          }}
        />
        {/* Squared-paper register grid — the platform's "handwriting", faded out
            toward the centre with a radial mask so it never fights the form. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.5] dark:opacity-[0.35]"
          style={{
            backgroundImage:
              "linear-gradient(to right, hsl(var(--border)) 1px, transparent 1px)," +
              "linear-gradient(to bottom, hsl(var(--border)) 1px, transparent 1px)",
            backgroundSize: "30px 30px",
            maskImage: "radial-gradient(120% 90% at 50% 30%, transparent 30%, black 100%)",
            WebkitMaskImage: "radial-gradient(120% 90% at 50% 30%, transparent 30%, black 100%)",
          }}
        />

        <ThemeToggle className="absolute right-4 top-4 z-20" />

        {/* TOP zone — brand lockup (shown on desktop too now, so the panel has an
            anchor instead of dead space; the mobile mark folds into the same row). */}
        <header className="relative z-10 flex items-center gap-2.5">
          {branding?.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- remote tenant logo
            <img src={branding.logoUrl} alt={`${schoolName} logo`} className="h-8 w-8 rounded-lg border border-border/60 bg-white object-contain p-0.5" />
          ) : (
            <img src="/images/platform-mark.png" alt="MajorGBN" width={128} height={128} className="h-8 w-8 object-contain" />
          )}
          <span className="text-sm font-semibold tracking-tight">{schoolName}</span>
        </header>

        {/* CENTER zone — the sign-in card. */}
        <div className="relative z-10 flex flex-1 items-center justify-center py-8">
          <div className="w-full max-w-sm rounded-2xl border border-border/70 bg-card/70 p-6 shadow-lg backdrop-blur-sm sm:p-8">
            <span className="eyebrow text-primary">Sign in</span>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight">Welcome back</h2>
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
        </div>

        {/* BOTTOM zone — quiet trust line + attribution (mirrors the homepage
            footer), filling the space with credibility instead of emptiness. */}
        <footer className="relative z-10 space-y-2 text-center">
          <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[0.7rem] text-muted-foreground">
            {["Tenant-isolated", "Audit-logged", "NDPR-aligned"].map((t) => (
              <span key={t} className="inline-flex items-center gap-1.5">
                <span aria-hidden className="h-1 w-1 rounded-full bg-brand2/80" />
                {t}
              </span>
            ))}
          </div>
          <p className="text-[0.7rem] text-muted-foreground/80">
            Powered by <span className="font-medium text-foreground/70">MajorGBN Innovations Limited</span>
          </p>
        </footer>
      </section>
    </main>
  );
}
