import Link from "next/link";
import type { PublicSchoolPageDto } from "@sms/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ThemeToggle } from "@/components/shell/ThemeToggle";
import { apiBaseUrl } from "@/lib/env";

export const dynamic = "force-dynamic";

// NULL means "we could not ask", [] means "there genuinely are none". Both were
// returned as [], so an API blip told a prospective parent this platform has no
// schools — on the page whose whole job is to show them there are.
//
// SEARCHED AND PAGED IN THE DATABASE. This fetched EVERY active school and
// rendered all of them: 678 KB and a 631 ms render at 5,003 schools, growing
// with the fleet, on an unauthenticated page. It was also unusable at that size
// — nobody finds their child's school by scrolling five thousand names.
async function getSchools(q: string, page: number): Promise<PublicSchoolPageDto | null> {
  try {
    const qs = new URLSearchParams({ page: String(page) });
    if (q) qs.set("q", q);
    const res = await fetch(`${apiBaseUrl()}/public/schools?${qs}`, { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as PublicSchoolPageDto;
  } catch {
    return null;
  }
}

// PUBLIC page — no authentication. Parents browse onboarded schools.
export default async function SchoolsPage({
  searchParams,
}: {
  searchParams: { q?: string; page?: string };
}) {
  const q = (searchParams.q ?? "").trim();
  const page = Math.max(1, Number(searchParams.page ?? 1) || 1);
  const result = await getSchools(q, page);
  const schools = result?.items ?? null;
  const total = result?.total ?? 0;
  const pages = result ? Math.max(1, Math.ceil(total / result.pageSize)) : 1;

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

      {/* A SEARCH THAT REACHES THE WHOLE DIRECTORY, not the page below it. A
          plain GET form, so it works with no JavaScript — this is the public
          front door and a family may be on anything. */}
      <form method="GET" action="/schools" className="mb-5 flex flex-wrap gap-2">
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Search by school name…"
          aria-label="Search by school name"
          className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
        />
        <button type="submit" className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">
          Search
        </button>
        {q && (
          <Link href="/schools" className="self-center text-sm text-muted-foreground hover:text-foreground">
            Clear
          </Link>
        )}
      </form>

      {schools === null ? (
        <p className="text-sm text-destructive">
          We couldn&rsquo;t load the school list just now — this isn&rsquo;t a sign that none are available.
          Please refresh in a moment.
        </p>
      ) : schools.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {q
            ? `No school matches “${q}”. Try part of the name.`
            : "No schools are available right now. Please check back soon."}
        </p>
      ) : (
        <>
          {/* WHAT IS NOT SHOWN. A page of fifty out of five thousand with no
              total reads as the whole directory. */}
          <p className="mb-3 text-sm text-muted-foreground">
            {q ? <>{total.toLocaleString()} matching “{q}”</> : <>{total.toLocaleString()} schools</>}
            {pages > 1 && <> · page {page} of {pages}</>}
          </p>
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
          {pages > 1 && (
            <nav className="mt-6 flex items-center gap-3 text-sm" aria-label="Pagination">
              {page > 1 && (
                <Link
                  href={`/schools?${new URLSearchParams({ ...(q ? { q } : {}), page: String(page - 1) })}`}
                  className="font-medium text-primary hover:underline"
                >
                  ← Previous
                </Link>
              )}
              {page < pages && (
                <Link
                  href={`/schools?${new URLSearchParams({ ...(q ? { q } : {}), page: String(page + 1) })}`}
                  className="font-medium text-primary hover:underline"
                >
                  Next →
                </Link>
              )}
            </nav>
          )}
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
