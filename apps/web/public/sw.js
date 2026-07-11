// =============================================================================
// SMS service worker — installable PWA + low-bandwidth static caching
// =============================================================================
// SECURITY / PRIVACY (multi-tenant, minors' PII — defense in depth):
//   - We cache ONLY content-hashed, non-sensitive static assets (JS/CSS/fonts/
//     images). These are immutable and carry no tenant data.
//   - The BFF (/api/*) is NETWORK-ONLY — authenticated/tenant responses are
//     never written to Cache Storage (no student-data remnants on a shared
//     device).
//   - Authenticated navigations are network-first with a STATIC offline page as
//     the only fallback — we never persist rendered student PII.
// The low-bandwidth win is the cache-first static layer; content correctness is
// never served from a stale authenticated cache.
// =============================================================================

const VERSION = "v1";
const STATIC_CACHE = `sms-static-${VERSION}`;
const PRECACHE = ["/offline.html", "/icon.svg", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== STATIC_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function isCacheableStatic(url) {
  return (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/images/") ||
    url.pathname === "/icon.svg" ||
    url.pathname === "/manifest.webmanifest" ||
    /\.(?:woff2?|css|js|png|jpe?g|svg|webp|ico|gif)$/.test(url.pathname)
  );
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never touch cross-origin
  if (url.pathname.startsWith("/api/")) return; // SECURITY: tenant data — network only

  if (isCacheableStatic(url)) {
    // Cache-first: content-hashed assets are safe to serve from cache and this
    // is the low-bandwidth / offline-shell win.
    event.respondWith(
      caches.match(req).then((hit) => {
        if (hit) return hit;
        return fetch(req).then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(STATIC_CACHE).then((cache) => cache.put(req, copy));
          }
          return res;
        });
      }),
    );
    return;
  }

  if (req.mode === "navigate") {
    // Network-first; on failure fall back to the STATIC offline page (never a
    // cached authenticated page).
    event.respondWith(fetch(req).catch(() => caches.match("/offline.html")));
  }
});
