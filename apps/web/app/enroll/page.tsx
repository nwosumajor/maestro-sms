import Link from "next/link";
import type { PublicSchoolPageDto } from "@sms/types";
import { EnrollForm } from "@/components/public/EnrollForm";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ThemeToggle } from "@/components/shell/ThemeToggle";
import { apiBaseUrl } from "@/lib/env";

export const dynamic = "force-dynamic";

// NULL means "we could not ask", [] means "there genuinely are none". Collapsed
// into [], a failed fetch rendered "No schools are available right now" — on an
// application form, that reads as a closed admissions season rather than a
// broken page, and the parent leaves instead of retrying.
// ONE PAGE, plus whichever school the link named. It used to fetch every active
// school on the platform to draw a checkbox each — 678 KB at 5,003 schools, and
// a form nobody could use at that size. The form searches the rest.
async function getSchools(preselect?: string): Promise<PublicSchoolPageDto | null> {
  try {
    const [pageRes, oneRes] = await Promise.all([
      fetch(`${apiBaseUrl()}/public/schools`, { cache: "no-store" }),
      preselect
        ? fetch(`${apiBaseUrl()}/public/schools/by-slug?slugs=${encodeURIComponent(preselect)}`, { cache: "no-store" })
        : Promise.resolve(null),
    ]);
    if (!pageRes.ok) return null;
    const page = (await pageRes.json()) as PublicSchoolPageDto;
    // A school arrived at from its OWN link must be on the form even if it is
    // not on the first page — otherwise the link silently loses the school.
    if (oneRes?.ok) {
      const one = (await oneRes.json()) as PublicSchoolPageDto["items"];
      for (const s of one) {
        if (!page.items.some((x) => x.slug === s.slug)) page.items = [s, ...page.items];
      }
    }
    return page;
  } catch {
    return null;
  }
}

// PUBLIC page — no authentication. A parent applies to enrol their child.
export default async function EnrollPage({ searchParams }: { searchParams: { school?: string } }) {
  const result = await getSchools(searchParams.school);
  const schools = result?.items ?? null;

  return (
    <main className="relative mx-auto min-h-screen max-w-2xl bg-background p-6">
      {/* Toggle sits IN the header row: as `absolute right-4 top-4` it landed on
          top of the "All schools" link. Same fix as /schools. */}
      <header className="flex items-center justify-between gap-4 py-4">
        <Link href="/" className="whitespace-nowrap text-lg font-semibold tracking-tight">MAESTRO-SMS</Link>
        <div className="flex shrink-0 items-center gap-3">
          <ThemeToggle />
          <Link href="/schools" className="whitespace-nowrap text-sm text-muted-foreground hover:text-foreground">All schools</Link>
        </div>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Apply for enrolment</CardTitle>
          <CardDescription>
            Select up to two schools and submit one application for your child. Each school reviews it
            (admissions → HR → principal) and emails you the entrance-exam date once decided. Your details are
            kept separate from enrolled-student records until accepted.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {schools === null ? (
            <p className="text-sm text-destructive">
              We couldn&rsquo;t load the list of schools just now, so this form can&rsquo;t be completed yet.
              This is a temporary problem on our side, not a closed admissions list — please refresh in a moment.
            </p>
          ) : schools.length === 0 ? (
            <p className="text-sm text-muted-foreground">No schools are available right now. Please check back soon.</p>
          ) : (
            <EnrollForm schools={schools} total={result?.total ?? schools.length} preselect={searchParams.school} />
          )}
        </CardContent>
      </Card>
    </main>
  );
}
