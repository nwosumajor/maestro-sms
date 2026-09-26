"use client";
// The platform dashboard's figures are computed at most once a minute
// (PlatformAnalyticsService). This asks for them NOW: it reloads the page with
// `?fresh=<time>`, which the page passes on to the API as `?fresh=1`. A new
// value each press, so pressing twice recomputes twice rather than landing on
// the URL it is already on — a link to the page you are on navigates nowhere.

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export function AnalyticsRefresh() {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = React.useTransition();
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={() => startTransition(() => router.push(`${pathname}?fresh=${Date.now()}`, { scroll: false }))}
    >
      {pending ? "Refreshing…" : "Refresh figures"}
    </Button>
  );
}
