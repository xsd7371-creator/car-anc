const CACHE = 'car-anc-v6';
const ASSETS = ['/', '/index.html', '/css/style.css',
  '/js/main.js', '/js/AudioEngine.js', '/js/FFTAnalyzer.js',
  '/js/AdaptiveEQ.js', '/js/MaskingToneGenerator.js',
  '/js/CalibrationEngine.js', '/js/Verification.js', '/manifest.json'];

self.addEventListener('install', e => {
  self.skipWaiting(); // activate immediately, don't wait for old tabs to close
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim()) // take control of all open tabs immediately
  );
});

self.addEventListener('fetch', e =>
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request))));
