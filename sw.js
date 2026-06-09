const CACHE = 'car-anc-v1';
const ASSETS = ['/', '/index.html', '/css/style.css',
  '/js/main.js', '/js/AudioEngine.js', '/js/FFTAnalyzer.js',
  '/js/AdaptiveEQ.js', '/js/MaskingToneGenerator.js', '/manifest.json'];

self.addEventListener('install', e =>
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS))));

self.addEventListener('fetch', e =>
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request))));
