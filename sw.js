const CACHE_NAME = "lista-spesa-offline-v53";

const APP_SHELL = [
  "./",
  "./index.html",
  "./css/style.css?v=53",
  "./js/app.js?v=53",
  "./manifest.json?v=53"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(key => key.startsWith("lista-spesa-") && key !== CACHE_NAME)
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", event => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);
  const isSameOrigin = url.origin === self.location.origin;
  const isAppAsset =
    event.request.mode === "navigate" ||
    (isSameOrigin && (
      url.pathname.endsWith("/index.html") ||
      url.pathname.endsWith("/css/style.css") ||
      url.pathname.endsWith("/js/app.js") ||
      url.pathname.endsWith("/manifest.json")
    ));

  // Online: usa sempre la versione più recente del server e aggiorna la cache.
  // Offline: torna automaticamente all'ultima versione disponibile sul telefono.
  if (isAppAsset) {
    event.respondWith(
      fetch(event.request, { cache: "no-store" })
        .then(response => {
          if (response && response.ok) {
            caches.open(CACHE_NAME).then(cache => {
              cache.put(event.request, response.clone());
            });
          }
          return response;
        })
        .catch(() =>
          caches.match(event.request, { ignoreSearch: true })
            .then(cached => cached || (
              event.request.mode === "navigate"
                ? caches.match("./index.html").then(page => page || caches.match("./"))
                : undefined
            ))
        )
    );
    return;
  }

  // Per le altre risorse manteniamo il comportamento offline-first.
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true })
      .then(cached => cached || fetch(event.request)
        .then(response => {
          if (response && response.ok && isSameOrigin) {
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, response.clone()));
          }
          return response;
        })
      )
    )
  );
});