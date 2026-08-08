import Link from "next/link";
import type { PublicSchoolDto } from "@sms/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ThemeToggle } from "@/components/shell/ThemeToggle";

export const dynamic = "force-dynamic";

const API_BASE = process.env.API_BASE_URL ?? "http://localhost:3001";

// NULL means "we could not ask", [] means "there genuinely are none". Both were
// returned as [], so an API blip told a prospective parent this platform has no
// schools — on the page whose whole job is to show them there are.
async function getSchools(): Promise<PublicSchoolDto[] | null> {
  try {
    const res = await fetch(`${API_BASE}/public/schools`, { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as PublicSchoolDto[];
  } catch {
    return null;
  }
}

// PUBLIC page — no authentication. Parents browse onboarded schools.
export default async function SchoolsPage() {
  const schools = await getSchools();

  return (
    <main className="relative mx-auto min-h-screen max-w-4xl bg-background p-6">
      {/* The toggle sits IN the header row, not absolutely positioned over it —
          as `absolute right-4 top-4` it landed on top of the "Sign in" link. */}
      <header className="flex items-center justify-between gap-4 py-4">
        <Link href="/" className="whitespace-nowrap text-lg font-semibold tracking-tight">MAESTRO-SMS</Link>
        <div className="flex shrink-0 items-center gap-3">
          <ThemeToggle />
          <Link href="/login" className="whitespace-nowrap text-sm text-muted-foreground hover:text-foreground">Sign in</Link>
        </div>
      </header>

      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Find a school</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Browse schools on the platform. Select one or two and submit an enrolment application for your child.
        </p>
      </div>

      {schools === null ? (
        <p className="text-sm text-destructive">
          We couldn&rsquo;t load the school list just now — this isn&rsquo;t a sign that none are available.
          Please refresh in a moment.
        </p>
      ) : schools.length === 0 ? (
        <p className="text-sm text-muted-foreground">No schools are available right now. Please check back soon.</p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {schools.map((s) => (
              <Card key={s.id}>
                <CardHeader>
                  <CardTitle className="text-base">{s.name}</CardTitle>
                </CardHeader>
                <CardContent>
                  <Link
                    href={`/enroll?school=${encodeURIComponent(s.slug)}`}
                    className="text-sm font-medium text-primary hover:underline"
                  >
                    Apply to enrol →
                  </Link>
                </CardContent>
              </Card>
            ))}
          </div>
          <div className="mt-6">
            <Link href="/enroll" className="text-sm font-medium text-primary hover:underline">
              Or apply to up to two schools at once →
            </Link>
          </div>
        </>
      )}
    </main>
  );
}
