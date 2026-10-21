// Stores nothing of its own.
//
// It exists for two reasons: Chrome only offers its own "Install app" prompt
// when a service worker with a real fetch handler is registered, and this is
// the only place we can control caching of our own files.
//
// GitHub Pages serves every file with Cache-Control: max-age=600, and each one
// is cached independently. A plain `fetch(event.request)` honours that, so for
// ten minutes after a deploy a browser can pair a fresh index.html with a
// ten-minute-old app.js — the new markup renders, the code wiring it up is
// missing, and absolutely nothing logs an error. New buttons simply do nothing.
// So same-origin requests always revalidate against the network.

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const request = event.request;

  if (request.method !== "GET") {
    event.respondWith(fetch(request));
    return;
  }

  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    // Fetch by href rather than passing the Request through: a navigation
    // request has mode "navigate", which cannot be re-constructed with new
    // init options. Falling back to the plain request keeps the page working
    // if a revalidation fails (offline, flaky network).
    event.respondWith(
      fetch(url.href, { cache: "reload", credentials: "same-origin" })
        .catch(() => fetch(request)),
    );
    return;
  }

  // Cross-origin keeps normal caching on purpose: the barcode decoder is a
  // ~1 MB wasm binary from a CDN, and re-downloading it on every load would be
  // a far worse problem than the one above.
  event.respondWith(fetch(request));
});
