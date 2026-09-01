/* La mia spesa - modalità offline */
const CACHE_NAME = "la-mia-spesa-v2";

const APP_SHELL = [
  "./",
  "./index.html",
  "./css/style.css",
  "./js/app.js",
  "./manifest.webmanifest"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // Cache ogni risorsa separatamente: un singolo errore non blocca
      // l'installazione completa del Service Worker.
      await Promise.all(
        APP_SHELL.map((url) =>
          cache.add(url).catch(() => console.warn("Non memorizzato:", url))
        )
      );
    })
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

  // Per la navigazione dell'app: prima la copia salvata.
  if (event.request.mode === "navigate") {
    event.respondWith(
      caches.match("./index.html").then(
        (cached) => cached || fetch(event.request)
      )
    );
    return;
  }

  // Per CSS e JavaScript: usa la cache, altrimenti scarica e conserva.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;

      return fetch(event.request)
        .then((response) => {
          if (response && response.ok && response.type === "basic") {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => caches.match("./index.html"));
    })
  );
});