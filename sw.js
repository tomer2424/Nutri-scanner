// Deliberately caches nothing.
//
// It exists only because Chrome won't offer its own "Install app" prompt unless
// a service worker with a real fetch handler is registered. Every request goes
// straight to the network, so there is no stale-cache trap while iterating on a
// phone — a reload always gets the current code.

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  event.respondWith(fetch(event.request));
});
