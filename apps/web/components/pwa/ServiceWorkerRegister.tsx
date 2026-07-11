"use client";

// Registers the service worker (installable PWA + static caching) and shows an
// unobtrusive banner when the device goes offline. The SW itself never caches
// authenticated/tenant data — see public/sw.js.
import * as React from "react";

export function ServiceWorkerRegister() {
  const [offline, setOffline] = React.useState(false);

  React.useEffect(() => {
    if ("serviceWorker" in navigator) {
      // Register after load so it never competes with first paint.
      const onLoad = () => navigator.serviceWorker.register("/sw.js").catch(() => {});
      if (document.readyState === "complete") onLoad();
      else window.addEventListener("load", onLoad, { once: true });
    }
    const sync = () => setOffline(!navigator.onLine);
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);

  if (!offline) return null;
  return (
    <div
      role="status"
      className="fixed inset-x-0 top-0 z-[60] bg-amber-500 px-3 py-1.5 text-center text-xs font-medium text-amber-950 print:hidden"
    >
      You’re offline — showing what’s cached. School data will refresh when you reconnect.
    </div>
  );
}
