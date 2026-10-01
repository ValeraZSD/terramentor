/* eslint-disable */
// Service worker SOURCE. Not shipped as-is: `tools/vite-plugin-sw.mjs` fills the
// two placeholders below at build time and emits the result as `dist/sw.js`. It
// is not a module the app imports — the placeholders would be nonsense inside
// the bundle — and it lives in `src/` only because it is app source, not a
// static file to copy.
//
// The placeholder spellings appear exactly once each, in the two lines that use
// them, and nowhere in this prose: the substitution is a plain string replace,
// and the first version of this file spelled them in the comment above, so the
// comment was stamped and the constants shipped unreplaced. `freshness-gates`
// asserts that no placeholder survives into the emitted worker.
//
// Why it is generated rather than a fixed file in `public/`:
//
//   A browser looks for a new worker by BYTE-COMPARING the script it fetches
//   with the one it has. `public/sw.js` was identical in every build, so there
//   was never a new worker, the "Update available" prompt could not fire, and
//   the cache — one fixed name, never keyed to anything — kept every build's
//   assets side by side forever. A slow launch would then time out to the
//   CACHED shell of some previous build, whose asset hashes were still sitting
//   in that cache, and the whole old app would come up looking perfectly
//   healthy. That is the "empty or wrong things until a hard reload" report.
//
//   Both halves are fixed by one change: the cache is named after the build, so
//   a new build is a new worker (different bytes), a new cache, and the old
//   cache is deleted on activate. The shell that a timed-out launch falls back
//   to is now, by construction, this build's shell.

const BUILD = '__BUILD__';
const CACHE = `terramentor-${BUILD}`;

// The shell this build needs before it can paint: the document and the entry
// chunks Vite marked as loaded up front. Precached on install so the fallback
// below is never a guess.
const PRECACHE = __PRECACHE__;

self.addEventListener('install', (event) => {
    event.waitUntil(
        (async () => {
            const cache = await caches.open(CACHE);
            // Individually, not `addAll`: one 404 must not fail the install and
            // leave the app with no worker at all.
            await Promise.all(PRECACHE.map((url) => cache.add(url).catch(() => { })));
        })()
    );
});

// The app asks for the handover (the "Update available → Reload" prompt, and the
// automatic reload when a new build is detected — see src/utils/freshness.ts).
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        (async () => {
            const keys = await caches.keys();
            await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
            await self.clients.claim();
        })()
    );
});

// fetch() that rejects if the network hasn't answered within `ms`, so a stuck
// request can fall back to cache instead of hanging the app launch.
function fetchWithTimeout(req, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    return fetch(req, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

// Requests we must never cache or intercept: live data (API/SSE) and Vite's
// dev-only module/HMR machinery. Caching those would break data freshness and HMR.
function isBypassed(url) {
    return (
        url.pathname.startsWith('/api') ||
        // The manifest is GENERATED from the icon settings (server/appIcon.js).
        // Everything below is cached first-and-forever within a build, which for
        // this one document would mean an icon that cannot be changed until the
        // next release. The icons it names are under /api and already bypassed.
        url.pathname === '/manifest.webmanifest' ||
        url.pathname.startsWith('/@') ||        // /@vite, /@react-refresh, /@fs/...
        url.pathname.startsWith('/src/') ||     // dev: unbundled source modules
        url.pathname.startsWith('/node_modules') ||
        url.searchParams.has('t') ||            // Vite HMR cache-busting query
        url.searchParams.has('import')          // Vite import-analysis requests
    );
}

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);
    // Leave cross-origin requests (Ollama, web search, CDNs) entirely alone.
    if (url.origin !== self.location.origin) return;
    if (isBypassed(url)) return;

    // Top-level navigations: network-first, falling back to the cached shell so the
    // installed app still launches when offline. The network attempt is capped by a
    // timeout so an awake-but-slow desktop (e.g. over Tailscale) doesn't hang the
    // launch — a dead server rejects fast, a slow one falls back after the timeout.
    // The fallback is safe now that the cache is this build's alone: it can only
    // serve the shell that matches the assets sitting beside it.
    if (req.mode === 'navigate') {
        event.respondWith(
            (async () => {
                const cache = await caches.open(CACHE);
                try {
                    const res = await fetchWithTimeout(req, 3500);
                    cache.put('/', res.clone()).catch(() => { });
                    return res;
                } catch {
                    return (await cache.match('/')) || (await cache.match('/index.html')) || Response.error();
                }
            })()
        );
        return;
    }

    // Everything else same-origin (the hashed JS/CSS bundles, icons, fonts):
    // cache-first, because a hashed name IS its content — there is nothing to
    // revalidate, and the background refetch the old stale-while-revalidate did
    // was a second download of a file that cannot have changed. A miss goes to
    // the network and is stored.
    event.respondWith(
        (async () => {
            const cache = await caches.open(CACHE);
            const cached = await cache.match(req);
            if (cached) return cached;
            try {
                const res = await fetch(req);
                if (res && res.ok && res.type === 'basic') cache.put(req, res.clone()).catch(() => { });
                return res;
            } catch {
                return Response.error();
            }
        })()
    );
});
