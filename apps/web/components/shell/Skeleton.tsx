// =============================================================================
// Skeleton — the shape of a page that has not arrived yet
// =============================================================================
// Every page in this app is `force-dynamic`, so every navigation is a server
// render. Without a route-level `loading.tsx`, the App Router holds the OLD page
// on screen, frozen, for the whole of that render — no spinner, no dimming,
// nothing. A 300ms render reads as a broken click, and a click that appears to
// do nothing gets clicked again.
//
// These are the pieces those loading files are built from. They are deliberately
// crude: a skeleton that tries to mimic the real layout closely is worse, because
// the shift when real content replaces it is more jarring than an obvious
// placeholder. It only has to say "this is arriving, in roughly this shape".
//
// `aria-hidden` throughout with one live region at the top level — a screen
// reader should hear "Loading", not forty empty boxes.
// =============================================================================

export function SkeletonBar({ className = "" }: { className?: string }) {
  return <div aria-hidden className={`animate-pulse rounded bg-muted ${className}`} />;
}

/** A card-shaped block: header line, then a few rows. */
export function SkeletonCard({ rows = 3 }: { rows?: number }) {
  return (
    <div aria-hidden className="rounded-lg border border-border p-4">
      <SkeletonBar className="h-4 w-40" />
      <div className="mt-4 space-y-2.5">
        {Array.from({ length: rows }).map((_, i) => (
          // Widths vary so the block reads as content rather than a grid.
          <SkeletonBar key={i} className={`h-3 ${["w-full", "w-11/12", "w-4/5", "w-2/3"][i % 4]}`} />
        ))}
      </div>
    </div>
  );
}

/** A table-shaped block. */
export function SkeletonTable({ rows = 6 }: { rows?: number }) {
  return (
    <div aria-hidden className="overflow-hidden rounded-lg border border-border">
      <div className="border-b border-border bg-muted/40 p-3">
        <SkeletonBar className="h-3.5 w-32" />
      </div>
      <div className="divide-y divide-border">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 p-3">
            <SkeletonBar className="h-3 w-24" />
            <SkeletonBar className="h-3 w-16" />
            <SkeletonBar className="h-3 flex-1" />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The default page skeleton: a title, then a couple of blocks.
 *
 * The status role is on the WRAPPER, once, so assistive tech announces a single
 * "Loading" rather than reading the placeholder furniture.
 */
export function PageSkeleton({ children }: { children?: React.ReactNode }) {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className="space-y-6">
      <span className="sr-only">Loading</span>
      <div className="space-y-2">
        <SkeletonBar className="h-7 w-56" />
        <SkeletonBar className="h-3.5 w-80" />
      </div>
      {children ?? (
        <>
          <SkeletonCard />
          <SkeletonTable />
        </>
      )}
    </div>
  );
}
