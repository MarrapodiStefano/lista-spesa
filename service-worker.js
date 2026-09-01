const CACHE_NAME = "la-mia-spesa-v6";

const APP_SHELL = [
  "./",
  "./index.html",
  "./css/style.css",
  "./js/app.js",
  "./manifest.webmanifest"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key.startsWith("la-mia-spesa-") && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const request = event.request;

  event.respondWith(
    caches.match(request).then(async (cached) => {
      if (cached) return cached;

      if (request.mode === "navigate") {
        return (
          (await caches.match("./")) ||
          (await caches.match("./index.html"))
        );
      }

      try {
        const response = await fetch(request);
        if (response && response.ok && response.type === "basic") {
          const copy = response.clone();
          const cache = await caches.open(CACHE_NAME);
          cache.put(request, copy);
        }
        return response;
      } catch {
        return Response.error();
      }
    })
  );
});