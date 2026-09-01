/* La mia spesa - PWA offline con aggiornamenti affidabili */
const CACHE_NAME = "la-mia-spesa-v4";

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

  // Strategia principale: rete prima.
  // Così, quando Internet è disponibile, l'app riceve sempre
  // la versione più recente pubblicata su GitHub Pages.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.ok && response.type === "basic") {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, copy);
          });
        }

        return response;
      })
      .catch(async () => {
        // Senza Internet usiamo la copia locale.
        const cached = await caches.match(request);
        if (cached) return cached;

        // Per l'apertura dell'app offline, ripieghiamo sulla home.
        if (request.mode === "navigate") {
          return (
            (await caches.match("./")) ||
            (await caches.match("./index.html"))
          );
        }

        return Response.error();
      })
  );
});