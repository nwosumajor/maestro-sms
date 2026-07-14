import { CareersBoard } from "@/components/public/CareersBoard";

export const dynamic = "force-dynamic";

const API_BASE = process.env.API_BASE_URL ?? "http://localhost:3001";

// PUBLIC page — no authentication. A school's open vacancies + application form.
// Server-fetches the openings; the form posts through the public BFF proxy.
export default async function CareersPage({ params }: { params: { slug: string } }) {
  let data: { school: string; jobs: { id: string; title: string; department: string | null; description: string | null; openings: number }[] } | null = null;
  try {
    const res = await fetch(`${API_BASE}/public/careers/${params.slug}`, { cache: "no-store" });
    if (res.ok) data = await res.json();
  } catch {
    /* API unreachable — render the not-found state */
  }

  return (
    <main className="force-light mx-auto min-h-screen max-w-3xl bg-background p-6">
      <h1 className="text-2xl font-semibold tracking-tight">
        {data ? `Careers at ${data.school}` : "Careers"}
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {data
          ? "Open positions — apply below. Your application goes straight to the school's HR team."
          : "We couldn't find that school's careers page."}
      </p>
      {data && <CareersBoard slug={params.slug} jobs={data.jobs} />}
    </main>
  );
}
