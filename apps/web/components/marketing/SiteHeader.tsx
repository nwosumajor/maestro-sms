import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/shell/ThemeToggle";

// Shared PUBLIC marketing header. Extracted from the homepage once /for-owners
// needed the same bar — section anchors are ROOT-RELATIVE (`/#modules`) so they
// work identically from the homepage and from any marketing sub-page.
export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 sm:px-8">
        <Link href="/" className="flex shrink-0 items-center gap-2.5">
          {/* Platform default mark (MajorGBN) — a school's own logo appears
              only inside THEIR portal, never here. */}
          <img
            src="/images/platform-mark.png"
            alt="MajorGBN"
            width={128}
            height={128}
            className="h-9 w-9 object-contain"
          />
          <span className="whitespace-nowrap text-sm font-semibold tracking-tight">MAESTRO-SMS</span>
        </Link>
        <nav className="hidden items-center gap-6 whitespace-nowrap text-sm font-medium text-muted-foreground md:flex">
          {/* Audience labels are bare nouns ("School owners", "Parents"): the
              nav is already a list of audiences, so a "For " prefix on each was
              length without meaning — and it wrapped the bar onto two lines. */}
          <Link href="/for-owners" className="transition-colors hover:text-foreground">School owners</Link>
          <Link href="/#modules" className="transition-colors hover:text-foreground">Modules</Link>
          <Link href="/#security" className="transition-colors hover:text-foreground">Security</Link>
          <Link href="/#plans" className="transition-colors hover:text-foreground">Plans</Link>
          <Link href="/schools" className="transition-colors hover:text-foreground">Parents</Link>
          <Link href="/careers" className="transition-colors hover:text-foreground">Careers</Link>
        </nav>
        <div className="flex shrink-0 items-center gap-2.5">
          <ThemeToggle className="hidden sm:inline-flex" />
          <Link
            href="/login"
            className="hidden whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground sm:block"
          >
            Sign in
          </Link>
          <Link href="/#onboard">
            <Button size="sm" className="whitespace-nowrap">Onboard your school</Button>
          </Link>
        </div>
      </div>
    </header>
  );
}
