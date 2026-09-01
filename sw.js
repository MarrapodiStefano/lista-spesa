const CACHE_NAME = "lista-spesa-offline-v6";

const APP_SHELL = [
  "./",
  "./index.html",
  "./css/style.css?v=6",
  "./js/app.js?v=6",
  "./manifest.json?v=6"
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

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);
  const isAppAsset =
    event.request.mode === "navigate" ||
    (url.origin === self.location.origin &&
      (url.pathname.endsWith("/index.html") ||
       url.pathname.endsWith("/css/style.css") ||
       url.pathname.endsWith("/js/app.js") ||
       url.pathname.endsWith("/manifest.json")));

  if (isAppAsset) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response && response.ok) {
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, response.clone()));
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

  event.respondWith(
    caches.match(event.request, { ignoreSearch: true })
      .then(cached => cached || fetch(event.request)
        .then(response => {
          if (response && response.ok && url.origin === self.location.origin) {
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, response.clone()));
          }
          return response;
        })
      )
    )
  );
});