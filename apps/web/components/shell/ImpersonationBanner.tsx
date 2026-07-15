"use client";

// A loud, always-visible reminder that you are NOT yourself right now. The whole
// app looks exactly like the target's — that's the point of impersonation and
// also its danger: acting here writes real data into a real school as a real
// person. Sticky and high-contrast on purpose; this is not a dismissible notice.
//
// Exit = sign out, then log back in as yourself. Deliberately not a one-click
// "return to owner": that would mean stashing the owner's own claims inside the
// impersonated session, and a short re-login is a cheap price for not doing that.

import { signOut } from "next-auth/react";
import { Button } from "@/components/ui/button";

export function ImpersonationBanner({ userName, schoolName }: { userName: string; schoolName: string }) {
  return (
    <div
      role="status"
      className="sticky top-0 z-50 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-destructive px-4 py-1.5 text-center text-xs font-medium text-destructive-foreground"
    >
      <span>
        Viewing as <strong>{userName}</strong>
        {schoolName ? <> at <strong>{schoolName}</strong></> : null} — everything you do is audited and attributed to you.
      </span>
      <Button
        size="sm"
        variant="secondary"
        className="h-6 px-2 text-xs"
        onClick={() => signOut({ callbackUrl: "/login?returned=1" })}
      >
        Stop and sign out
      </Button>
    </div>
  );
}
