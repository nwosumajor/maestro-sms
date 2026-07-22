"use client";

import * as React from "react";

// Keeps the sidebar's scroll position across navigations.
//
// Why this is needed even though the nav links are now <Link> (client-side):
// AppShell is a SERVER component rendered by every page, so a navigation can
// still remount the nav subtree — and a genuine full load (first paint, the
// post-login redirect, the idle-logout return, someone pasting a URL) always
// rebuilds the document. Without this, a user who scrolled down to reach a
// lower nav item is thrown back to the top of the list on arrival and has to
// scroll down again.
//
// sessionStorage (not local) so the position is per-tab and does not outlive
// the session. Restores BEFORE paint via useLayoutEffect so there is no
// visible jump.
const KEY = "sms.sidebarScroll";

export function SidebarScroll({ children, className }: { children: React.ReactNode; className?: string }) {
  const ref = React.useRef<HTMLElement>(null);

  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const saved = Number(sessionStorage.getItem(KEY) ?? "0");
    // Only restore when the list is actually scrollable and the value is sane —
    // a stale position from a longer nav (e.g. a role with more items) must not
    // strand a shorter one at the bottom.
    if (saved > 0) {
      el.scrollTop = Math.min(saved, Math.max(0, el.scrollHeight - el.clientHeight));
    }

    // rAF-throttled: scroll fires far more often than we need to persist.
    let queued = false;
    const onScroll = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        try {
          sessionStorage.setItem(KEY, String(el.scrollTop));
        } catch {
          // private mode / storage full — position persistence is a nicety,
          // never worth breaking the nav over.
        }
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <nav ref={ref} aria-label="Primary" className={className}>
      {children}
    </nav>
  );
}
