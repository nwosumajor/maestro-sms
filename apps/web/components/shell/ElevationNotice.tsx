// A quiet, always-visible reminder that some of what you can do right now is
// BORROWED. Not the impersonation banner's alarm — an elevation is legitimate,
// requested, approved by somebody else and time-limited — but it should never be
// silent either, for two reasons.
//
// It ends. A screen that appeared without explanation disappears the same way,
// and somebody halfway through a task deserves to know the clock is running
// rather than meet it as a refusal.
//
// And every use of it is audited against your name. That is the deal elevation
// makes, and the person acting under it should be able to see that they are.
//
// Deliberately not dismissible and deliberately not styled as an error: the
// state is fine, it is just temporary.

import Link from "next/link";

export function ElevationNotice({ permissions, canReview }: { permissions: string[]; canReview: boolean }) {
  if (permissions.length === 0) return null;
  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 border-b border-amber-500/30 bg-amber-500/10 px-4 py-1.5 text-center text-xs text-foreground"
    >
      <span className="font-medium">Temporary access in use:</span>
      <span className="flex flex-wrap items-center justify-center gap-1">
        {permissions.map((p) => (
          <code key={p} className="rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[11px]">{p}</code>
        ))}
      </span>
      <span className="text-muted-foreground">
        Granted for a limited time, and audited to you.
      </span>
      {canReview && (
        <Link href="/admin/security" className="font-medium underline underline-offset-2">
          See when it ends
        </Link>
      )}
    </div>
  );
}
