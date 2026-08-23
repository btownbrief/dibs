// Dibs service worker — app shell only. Map tiles (cross-origin) are NEVER cached:
// CARTO/OSM tile policy, and a stale board is worse than no board.
const VERSION = 'dibs-v1';
const SHELL = ['./', 'index.html', 'css/style.css', 'js/app.js', 'js/core.js', 'js/hex.js', 'js/map.js', 'js/net.js', 'js/fake-backend.js', 'data/hexes.json', 'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css', 'icon.svg', 'manifest.webmanifest'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== 'GET') return;   // tiles, fonts, Supabase: straight through
  if (!url.pathname.startsWith(new URL('./', location.href).pathname)) return;
  e.respondWith((async () => {
    try {
      const fresh = await fetch(e.request);
      if (fresh.ok) { const c = await caches.open(VERSION); c.put(e.request, fresh.clone()); }
      return fresh;
    } catch {
      const hit = await caches.match(e.request, { ignoreSearch: true });
      return hit || Response.error();
    }
  })());
});
