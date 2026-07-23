import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ThemeToggle } from "@/components/shell/ThemeToggle";

export const dynamic = "force-dynamic";

const API_BASE = process.env.API_BASE_URL ?? "http://localhost:3001";

// PUBLIC careers index — lists every active school's jobs board. Linked from the
// landing page header; each school's own board lives at /careers/[slug].
export default async function CareersIndexPage() {
  let schools: { id: string; name: string; slug: string }[] = [];
  try {
    const res = await fetch(`${API_BASE}/public/schools`, { cache: "no-store" });
    if (res.ok) schools = await res.json();
  } catch {
    /* API unreachable — render the empty state */
  }

  return (
    <main className="relative mx-auto min-h-screen max-w-3xl bg-background p-6">
      <ThemeToggle className="absolute right-4 top-4 z-20" />
      <h1 className="pr-14 text-2xl font-semibold tracking-tight">Careers</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Work at a school on the platform — pick a school to see its open positions.
      </p>
      <div className="mt-6 space-y-3">
        {schools.length === 0 && <p className="text-sm text-muted-foreground">No schools are listed right now.</p>}
        {schools.map((s) => (
          <Card key={s.id}>
            <CardHeader>
              <CardTitle className="text-base">{s.name}</CardTitle>
              <CardDescription>View open positions and apply online.</CardDescription>
            </CardHeader>
            <CardContent>
              <Link href={`/careers/${s.slug}`} className="text-sm font-medium underline underline-offset-2">
                View vacancies →
              </Link>
            </CardContent>
          </Card>
        ))}
      </div>
    </main>
  );
}
