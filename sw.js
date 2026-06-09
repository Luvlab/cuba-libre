// Cuba Libre — Service Worker
// Offline-first PWA for Cuban users with limited connectivity

const CACHE_NAME = 'cuba-libre-v1';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/css/style.css',
  '/js/app.js',
  '/manifest.json'
];

// ===== INSTALL — cache core assets =====
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// ===== ACTIVATE — clean old caches =====
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// ===== FETCH — cache-first for static, network-first for API =====
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Always go network for Supabase API calls
  if (url.hostname.includes('supabase.co')) {
    event.respondWith(
      fetch(event.request).catch(() =>
        new Response(JSON.stringify({ error: 'offline', message: 'No hay conexión' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        })
      )
    );
    return;
  }

  // Cache-first for all static assets
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;

      return fetch(event.request).then(response => {
        // Only cache successful GET responses
        if (!response || response.status !== 200 || event.request.method !== 'GET') {
          return response;
        }
        const toCache = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, toCache));
        return response;
      }).catch(() => {
        // Return offline fallback for navigation requests
        if (event.request.mode === 'navigate') {
          return caches.match('/index.html');
        }
      });
    })
  );
});

// ===== BACKGROUND SYNC — queue Libre transactions offline =====
self.addEventListener('sync', event => {
  if (event.tag === 'sync-libre-transactions') {
    event.waitUntil(syncPendingTransactions());
  }
});

async function syncPendingTransactions() {
  // When back online, flush any queued offline Libre actions
  // Actual implementation will be wired once backend Edge Functions are live
  console.log('[SW] Syncing pending Libre transactions...');
}
