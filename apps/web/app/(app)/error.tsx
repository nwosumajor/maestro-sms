"use client";

// =============================================================================
// Error boundary for the signed-in app
// =============================================================================
// There was none — anywhere. A thrown render produced Next's default screen,
// which is why every page instead swallows failure and renders a confident
// empty state: "No disputes", "Nothing waiting on you", "None received yet".
// Those sentences are produced by a failed HTTP request as readily as by an
// empty table, and somebody acts on them.
//
// A boundary is what makes failing honestly affordable. Until one exists, every
// caller has a reason to pretend nothing went wrong.
// =============================================================================

import * as React from "react";
import { Button } from "@/components/ui/button";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  React.useEffect(() => {
    // The server-side digest is the only handle on what actually failed —
    // the message itself is redacted in production.
    console.error("app error", error.digest ?? error.message);
  }, [error]);

  return (
    <div className="mx-auto max-w-lg space-y-4 py-16 text-center">
      <h1 className="text-xl font-semibold">This page could not be loaded</h1>
      <p className="text-sm text-muted-foreground">
        Something went wrong reading your school&apos;s data. Nothing has been changed. This is a failure to load —
        not a report that there is nothing here.
      </p>
      <div className="flex justify-center gap-2">
        <Button onClick={reset}>Try again</Button>
        <Button variant="outline" onClick={() => window.location.assign("/dashboard")}>
          Back to dashboard
        </Button>
      </div>
      {error.digest && (
        <p className="text-xs text-muted-foreground">
          Reference <span className="font-mono">{error.digest}</span> — quote this if you report it.
        </p>
      )}
    </div>
  );
}
