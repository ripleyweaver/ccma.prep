const CACHE_NAME = "ccma-prep-v1-0-6";

const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./questions.json",
  "./manifest.webmanifest",
  "./favicon.ico",
  "./favicon-16x16.png",
  "./favicon-32x32.png",
  "./favicon-48x48.png",
  "./favicon-96x96.png",
  "./apple-touch-icon.png",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-512-maskable.png",
  "./icon-1024.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // Cache each file individually with cache:"reload" to bypass any stale
      // HTTP-level cache, and tolerate individual failures rather than
      // aborting the whole install (which previously meant a single failed
      // icon fetch could prevent questions.json from ever being cached).
      await Promise.all(
        APP_SHELL.map((url) =>
          fetch(url, { cache: "reload" })
            .then((response) => {
              if (response.ok) return cache.put(url, response);
            })
            .catch(() => {
              // Swallow individual failures; installation continues with
              // whatever files succeeded. Missing files will simply be
              // fetched from the network on first request instead.
            })
        )
      );
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // Only handle same-origin GET requests; let everything else pass through normally.
  if (request.method !== "GET") return;
  if (url.origin !== self.location.origin) return;

  const isQuestionsFile = url.pathname.endsWith("/questions.json");

  if (isQuestionsFile) {
    // Network-first for questions.json specifically: try the network so a
    // fresh deploy or a previously-failed cache entry is recovered
    // automatically, falling back to whatever cached copy exists (if any)
    // only if the network request itself fails. This prevents a stuck
    // "couldn't load" state caused by a stale or missing cache entry when
    // the file is actually reachable.
    event.respondWith(
      fetch(request, { cache: "no-store" })
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
            return response;
          }
          throw new Error(`Bad response: ${response.status}`);
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // Cache-first for the rest of the app shell (HTML/CSS/JS/icons/manifest):
  // fast, and these only change when we bump the cache version anyway.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).catch(() => {
        // Offline navigation fallback: serve the cached app shell page
        // so direct navigation still works instead of showing a browser error.
        if (request.mode === "navigate") {
          return caches.match("./index.html");
        }
        return new Response("", { status: 504, statusText: "Offline" });
      });
    })
  );
});
