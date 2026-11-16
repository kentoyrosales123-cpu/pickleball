// CourtSide service worker.
// - API, Socket.IO and health checks always go to the network (never cached),
//   so scores, queues and registrations are always live.
// - App pages, scripts and styles are network-first with a short timeout, then
//   fall back to the cached copy: fresh after every deploy, fast on weak signal.
// - Vendor libraries and icons are cache-first (they only change on upgrades;
//   bump VERSION to refresh them).
const VERSION = "courtside-v1";
const SHELL = [
  "/",
  "/offline.html",
  "/js/offline.js",
  "/css/app.css",
  "/js/app.js",
  "/js/api.js",
  "/js/theme.js",
  "/js/theme-init.js",
  "/js/pwa.js",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/favicon-32.png",
  "/vendor/bootstrap.css",
  "/vendor/chart.js",
  "/vendor/sweetalert.js",
  "/vendor/lucide.js",
];
const NETWORK_TIMEOUT = 4000;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(request, fallbackUrl) {
  const cache = await caches.open(VERSION);
  try {
    const response = await Promise.race([
      fetch(request),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), NETWORK_TIMEOUT),
      ),
    ]);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    const cached =
      (await cache.match(request, { ignoreSearch: true })) ||
      (fallbackUrl && (await cache.match(fallbackUrl)));
    if (cached) return cached;
    return (await cache.match("/offline.html")) || Response.error();
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(VERSION);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/socket.io/") ||
    url.pathname === "/health"
  )
    return; // live data: browser handles it normally, never cached
  if (request.mode === "navigate") {
    // Single-page app: every page is index.html + a #route.
    event.respondWith(networkFirst(request, "/"));
    return;
  }
  if (url.pathname.startsWith("/vendor/") || url.pathname.startsWith("/icons/"))
    event.respondWith(cacheFirst(request));
  else event.respondWith(networkFirst(request));
});
