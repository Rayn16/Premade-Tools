// Keeps the phone app on the phone, so the Premade icon opens with no PC and no signal. Only used when the pages come
// from the relay (https); the PC serves them over plain http, where browsers don't run this.
// Our own pages: network first, so updates arrive, else the saved copy. The engines fetched from cdn.jsdelivr.net
// (FFmpeg, PDF and Whisper code): saved copy first, they never change at a fixed version.
const NAME = 'premade-__BUILD__';
const SHELL = ['/m/', '/m/index.html', '/pt.css', '/dl.css', '/cv.css', '/pdf.css', '/tr.css', '/drop.css', '/friends.css', '/icon.svg', '/m/m.css',
  '/m/common.js', '/m/pdf-core.js', '/m/pdf-edit.js', '/m/tr-core.js', '/m/drop-core.js', '/m/friends-core.js', '/m/local.js', '/m/m.js', '/m/mdl.js', '/m/mcv.js',
  '/m/mpdf.js', '/m/mtr.js', '/m/mdrop.js', '/m/mfriends.js', '/m/icon-180.png', '/m/pdfjs/pdf.min.mjs', '/m/pdfjs/pdf.worker.min.mjs',
  '/m/whisper.js', '/m/lib/pdf-lib.min.mjs', '/m/lib/pdf-local.mjs', '/m/lib/pdf-edit.mjs', ...['classes', 'const', 'errors', 'index', 'types', 'utils', 'worker'].map((f) => `/m/ffmpeg/${f}.js`)];

self.addEventListener('install', (e) => e.waitUntil(caches.open(NAME).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('premade-') && k !== NAME).map((k) => caches.delete(k)))).then(() => self.clients.claim())));

self.addEventListener('fetch', (e) => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET') return;
  if (u.origin === location.origin) {
    if (!u.pathname.startsWith('/m/') && !/^\/[\w-]+\.(css|svg)$/.test(u.pathname)) return; // relay calls go straight through
    e.respondWith(fetch(r, { cache: 'no-cache' }).then((res) => { // always ask the relay, never the phone's web cache
      if (res.ok) { const copy = res.clone(); caches.open(NAME).then((c) => c.put(r, copy)); }
      return res;
    }).catch(() => caches.match(r, { ignoreSearch: true }).then((m) => m || caches.match('/m/index.html'))));
  } else if (u.hostname === 'cdn.jsdelivr.net') {
    e.respondWith(caches.open('engines').then(async (c) => {
      const hit = await c.match(r);
      if (hit) return hit;
      const res = await fetch(r);
      if (res.ok) c.put(r, res.clone());
      return res;
    }));
  }
});
