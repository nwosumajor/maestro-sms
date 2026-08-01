"use client";

// =============================================================================
// RegionProvider — the school's locale, timezone and currency, for client islands
// =============================================================================
// Server components read the region straight off the session. Client components
// cannot, so AppShell publishes it here and they take it with `useRegion()`.
//
// Passed down from the SAME session value the server render used — not read from
// the browser — because if the two disagreed React would throw a hydration
// mismatch, which surfaces to a user as a blank page rather than a wrong date.
// =============================================================================

import * as React from "react";
import { PLATFORM_REGION, formattersFor, type DisplayRegion } from "@/lib/format";

const RegionContext = React.createContext<DisplayRegion>(PLATFORM_REGION);

export function RegionProvider({ region, children }: { region: DisplayRegion; children: React.ReactNode }) {
  // Memoised on the three primitives: a fresh object each render would re-render
  // every consumer of this context on every parent render.
  const value = React.useMemo(
    () => ({ locale: region.locale, timezone: region.timezone, currency: region.currency }),
    [region.locale, region.timezone, region.currency],
  );
  return <RegionContext.Provider value={value}>{children}</RegionContext.Provider>;
}

/** The school's region. Falls back to the platform's home for any component
 *  rendered outside the shell (e.g. the public site), which is correct: those
 *  pages belong to the platform, not to a school. */
export function useRegion(): DisplayRegion {
  return React.useContext(RegionContext);
}

/** Formatters already bound to the school's region — `const { money, shortDate } = useFormat()`. */
export function useFormat() {
  const region = useRegion();
  return React.useMemo(() => formattersFor(region), [region]);
}
