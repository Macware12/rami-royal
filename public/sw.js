// Service worker Ramy Gasy — le solo reste jouable hors connexion
// Stratégie : réseau d'abord (toujours à jour), cache en secours (hors ligne)
const CACHE = "ramy-gasy-v1";
const ASSETS = ["/", "/solo.html", "/regles.html", "/confidentialite.html", "/manifest.json",
  "/favicon.png", "/icon-180.png", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Les bibliothèques CDN sont mises en cache aussi (indispensables hors ligne)
  const isCDN = url.hostname === "cdnjs.cloudflare.com" || url.hostname === "cdn.tailwindcss.com";
  // On ne touche pas au temps réel (socket.io)
  if (e.request.method !== "GET" || (!isCDN && url.origin !== self.location.origin) || url.pathname.startsWith("/socket.io")) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok || res.type === "opaque") {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: url.pathname === "/" }))
  );
});
