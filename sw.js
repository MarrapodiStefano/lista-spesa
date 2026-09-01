const CACHE_NAME = "lista-spesa-offline-v3";

const APP_SHELL = [
  "./",
  "./index.html",
  "./css/style.css",
  "./js/app.js",
  "./manifest.json"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith("lista-spesa-") && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  event.respondWith(
    caches.match(event.request, { ignoreSearch: true })
      .then((cached) => {
        if (cached) return cached;

        if (event.request.mode === "navigate") {
          return caches.match("./index.html")
            .then((page) => page || caches.match("./"));
        }

        return fetch(event.request)
          .then((response) => {
            if (!response || !response.ok) return response;
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
            return response;
          });
      })
      .catch(() => {
        if (event.request.mode === "navigate") {
          return caches.match("./index.html").then((page) => page || caches.match("./"));
        }
      })
  );
});
