// =============================================================================
// The loading state for every signed-in page
// =============================================================================
// One file at the group level, so all 100+ routes get instant feedback rather
// than each needing its own. A route with a more specific shape can still add
// its own loading.tsx beside its page.tsx and that one wins.
//
// This deliberately does NOT render AppShell. The shell (nav, header, school
// branding) is part of the layout, which the App Router keeps mounted across a
// navigation — re-rendering a skeleton of it would make the chrome flash on
// every click, which is the opposite of the point.
// =============================================================================

import { PageSkeleton } from "@/components/shell/Skeleton";

export default function Loading() {
  return <PageSkeleton />;
}
