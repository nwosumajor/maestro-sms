import Link from "next/link";
import { notFound } from "next/navigation";
import { LEGAL_DOCS_VERSION } from "@sms/types";
import { LEGAL_DOCS } from "@/content/legal";
import { LegalMarkdown } from "@/components/legal/LegalMarkdown";
import { ThemeToggle } from "@/components/shell/ThemeToggle";

// PUBLIC legal pages rendered from the versioned pack (single source of truth:
// docs/LEGAL.md → content/legal.ts). Clickwrap acceptance elsewhere records
// LEGAL_DOCS_VERSION against these documents.
//
// RENDERED PER REQUEST rather than prerendered, and it costs nothing: the
// content is a constant. The CSP in middleware.ts carries a per-request nonce,
// and a page built ONCE cannot carry a matching one — so every script on it is
// refused. These pages still SHOWED their text, being static HTML, while the
// theme script and all interactivity were dead. That is the quietest possible
// failure, which is why the rule is now pinned by a test.
export const dynamic = "force-dynamic";

export default function LegalPage({ params }: { params: { slug: string } }) {
  const doc = LEGAL_DOCS.find((d) => d.slug === params.slug);
  if (!doc) notFound();

  return (
    <main className="relative min-h-screen bg-background">
      <ThemeToggle className="absolute right-4 top-4 z-20" />
      <div className="mx-auto max-w-4xl px-5 py-10 sm:px-8">
        <p className="text-xs text-muted-foreground">
          <Link href="/" className="hover:text-foreground">← MAESTRO-SMS</Link>
          {" · "}
          {LEGAL_DOCS.map((d, i) => (
            <span key={d.slug}>
              {i > 0 && " · "}
              {d.slug === doc.slug ? (
                <span className="font-medium text-foreground">{d.title}</span>
              ) : (
                <Link href={`/legal/${d.slug}`} className="hover:text-foreground">{d.title}</Link>
              )}
            </span>
          ))}
        </p>
        <h1 className="mt-6 font-display text-3xl font-semibold tracking-tight">{doc.title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Version {LEGAL_DOCS_VERSION} · MajorGBN Innovations Limited · MAESTRO-SMS
        </p>
        <div className="mt-6">
          <LegalMarkdown body={doc.body} />
        </div>
      </div>
    </main>
  );
}
