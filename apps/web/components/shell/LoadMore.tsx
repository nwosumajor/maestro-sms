"use client";

import { Button } from "@/components/ui/button";

/** Shared "next page" control for the keyset-paginated lists (see lib/paged.ts). */
export function LoadMore({ hasMore, loading, onClick }: { hasMore: boolean; loading: boolean; onClick: () => void }) {
  if (!hasMore) return null;
  return (
    <div className="flex justify-center pt-2">
      <Button variant="outline" size="sm" disabled={loading} onClick={onClick}>
        {loading ? "Loading…" : "Load more"}
      </Button>
    </div>
  );
}
