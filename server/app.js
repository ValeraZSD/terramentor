// The Express app: every middleware and every route, in the order the server has
// always registered them, built by createApp() WITHOUT listening. server/index.js
// is what binds a port; a test can import this file and walk the app instead.
import express from 'express';
import cors from 'cors';
import db, { DB_PATH } from './database.js';
import { aiConcurrency } from './ai.js';
import { requireAuth } from './auth.js';
import * as tasks from './tasks.js';
import { failureFacts, logActivity } from './activityLog.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAllowedOrigin, originGuard } from './originGuard.js';
import { compressJson, precompressedStatic } from './httpCompression.js';
import { slowRequestLog } from './slowLog.js';
import { buildId } from './buildId.js';
import { appVersion } from './version.js';
import { createDesktop, isDesktop, libraryFallbackFromEnv, NOT_DESKTOP } from './desktop.js';
import { createAppIconRouter } from './appIcon.js';
import { dataPaths } from './paths.js';
import { getSetting } from './settingsStore.js';
import { currentAppIcon, currentManifestColors } from './appIconSettings.js';
import { assertEveryBlockMounted, mountRoutes, routeTable } from './routes/routeTable.js';
import * as authApi from './routes/auth.js';
import * as projectsApi from './routes/projects.js';
import * as tasksApi from './routes/tasks.js';
import * as catalogApi from './routes/catalog.js';
import * as nodesApi from './routes/nodes.js';
import * as onboardingApi from './routes/onboarding.js';
import * as captureApi from './routes/capture.js';
import * as systemApi from './routes/system.js';
import * as settingsApi from './routes/settings.js';
import * as providersApi from './routes/providers.js';
import * as chatApi from './routes/chat.js';
import * as quizzesApi from './routes/quizzes.js';
import * as visualsApi from './routes/visuals.js';
import * as flashcardsApi from './routes/flashcards.js';
import * as bulkGenerationApi from './routes/bulkGeneration.js';
import * as optimizersApi from './routes/optimizers.js';
import * as insightsApi from './routes/insights.js';
import * as todayApi from './routes/today.js';
import * as createProjectApi from './routes/createProject.js';
import * as searchApi from './routes/search.js';
import * as documentsApi from './routes/documents.js';
import * as embeddingsApi from './routes/embeddings.js';
import * as atlasApi from './routes/atlas.js';
import * as studyTimeApi from './routes/studyTime.js';
import * as importExportApi from './routes/importExport.js';
import * as authoringApi from './routes/authoring.js';
import * as mediaApi from './routes/media.js';
import * as ankiApi from './routes/anki.js';
import * as bundleApi from './routes/bundle.js';
import * as scheduleApi from './routes/schedule.js';
import * as completionApi from './routes/completion.js';
import * as decksApi from './routes/decks.js';
import * as studyDashboardApi from './routes/studyDashboard.js';
import * as masteryApi from './routes/mastery.js';
import * as placementApi from './routes/placement.js';
import * as feedApi from './routes/feed.js';
import * as paperApi from './routes/paper.js';
import * as calendarApi from './routes/calendar.js';

const app = routeTable('app');

// The queue asks this on every pump, so switching provider in Settings changes
// the parallelism on the next task: one slot on a local model, three on a
// hosted API (see aiConcurrency in ai.js).
tasks.setConcurrencyProvider(aiConcurrency);

// Every background job leaves one line behind: what kind it was, how long it
// ran, and why it stopped. The task's LABEL never travels — it is the topic's
// title, which is the learner's content; the kind and the project id say enough
// to find it again. `origin` is a closed-vocabulary word (a surface or one of
// the app's own jobs — tasks.js drops anything else), so it travels too. A
// failure travels as its FACTS (the task's failure record, read through
// failureFacts), never its message: that is a provider's free text, and
// providers echo the request back.
tasks.setTaskObserver(({ phase, id, kind, projectId, ms, origin }) => {
    const what = origin ? `${kind} · from ${origin}` : kind;
    const why = phase === 'error'
        ? failureFacts(tasks.listTasks().find(t => t.id === id)?.failure)
        : null;
    logActivity({
        area: 'task',
        event: `task.${phase}`,
        level: phase === 'error' ? 'error' : 'info',
        ms,
        projectId: projectId ?? undefined,
        detail: why ? `${what} · ${why}` : what,
    });
});

// Trust a loopback proxy only (e.g. `tailscale serve` → localhost). This lets
// req.secure / X-Forwarded-Proto be honoured for the cookie Secure flag without
// trusting arbitrary client-supplied forwarding headers.
app.set('trust proxy', 'loopback');
// First in the chain on purpose: this measures what the CLIENT waited for, so it
// has to start counting before the body parser and the auth gate. Silent unless
// a request crosses a second. See server/slowLog.js.
app.use(slowRequestLog());

// Baseline response headers, set first so every response carries them, the
// refusals and the parser's own errors included. The CSP half is deliberately REPORT-ONLY: the app
// has never carried one, and turning one on blind would break KaTeX's injected
// styles, Mermaid's, and the sandboxed visual frames before anything is
// measured to need it. Report-only puts every violation in the browser console
// while breaking nothing, which is how an enforced policy gets written later.
// `no-referrer` is the one with teeth today: saved links open external sites,
// and a local origin has no business being announced to them.
const CSP_REPORT_ONLY = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "media-src 'self' blob:",
    "frame-src 'self' blob:",
    "frame-ancestors 'self'",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
].join('; ');
// The part of the policy that is ENFORCED already: four directives no feature
// of the app relies on — it embeds no plugins, sets no <base>, posts no form
// anywhere, and is framed only by itself — and each shuts a door that injected
// markup would otherwise have (an <object>, a <base href> re-pointing every
// relative URL, a <form action> carrying typed text off the machine).
const CSP_ENFORCED = [
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
].join('; ');
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', CSP_ENFORCED);
    res.setHeader('Content-Security-Policy-Report-Only', CSP_REPORT_ONLY);
    next();
});

// Refuse the request itself, not just the answer. Mounted before the auth gate
// so a drive-by cannot even spend a login attempt, and before the body parser so
// a refused request does not get 25 MB of JSON parsed first.
app.use('/api', originGuard);
// Cross-origin access is refused rather than granted by default: both supported
// deployments (Vite's /api proxy in dev, the single-origin standalone build) are
// same-origin, and a browser never consults CORS headers on a same-origin
// response — so reflection here serves ONLY the explicit embedders listed in
// ALLOWED_ORIGINS. Everything else was refused outright by originGuard above.
app.use(cors({
    origin: (origin, cb) => cb(null, isAllowedOrigin(origin)),
    credentials: true,
}));
// 25 MB of JSON is a full curriculum with materials several times over (the
// largest project in a real library measures well under 10 MB of text) — the
// old 50 MB asked a request to be able to park 50 MB of parsed objects in RAM
// for no payload anyone has.
app.use(express.json({ limit: '25mb' }));
// Gzip the large answers (the atlas is 677 KB of JSON, the project list 333 KB).
// Mounted here so it wraps `res.json` for every route mounted after it, including the ones
// that answer before the auth gate. See server/httpCompression.js.
app.use(compressJson());

const headMiddleware = app.takeRoutes();

// Production standalone mode: once `npm run build` has produced ./dist, serve the
// built SPA from this same Express origin. That turns the project into a real
// single-origin installable app (no Vite dev server, no two-port mixed-content
// dance) — the difference between a genuine standalone app and a shortcut that
// just reopens the dev server in a window. Stays API-only (dev) when dist is absent.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, '..', 'dist');
const servingSPA = fs.existsSync(path.join(distDir, 'index.html'));

// Which build is on disk. The page polls this and reloads itself when the answer
// stops matching what it started with — see `src/utils/freshness.ts` and the note
// in server/buildId.js. Deliberately the cheapest endpoint in the app (a stat,
// then a cached string) because it is asked on every focus.
//
// `null` in a dev checkout: there is no dist, Vite's HMR is the freshness story
// there, and the client does nothing with a null.
app.get('/api/build', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ buildId: servingSPA ? buildId(path.join(distDir, 'index.html')) : null });
});

if (servingSPA) {
    // Serve the build's own `.br`/`.gz` twin when the caller takes one. Written
    // by `tools/precompress.mjs` at build time, so this costs a stat, not a
    // compression — and falls through untouched when the files aren't there.
    app.use(precompressedStatic(distDir));
    // Hashed assets are immutable; index.html / sw.js must always revalidate so a
    // rebuild is picked up instead of being pinned by a stale cache.
    app.use(express.static(distDir, {
        setHeaders: (res, filePath) => {
            if (filePath.includes(`${path.sep}assets${path.sep}`)) {
                res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
            } else {
                res.setHeader('Cache-Control', 'no-cache');
            }
        },
    }));
    // SPA history fallback: any non-API GET returns index.html so deep links and
    // client-side routing work. Registered before the error handler below.
    //
    // `no-store`, not express's default `max-age=0`: this is the one response
    // that names every other file by hash, and a deep link served from a
    // heuristically-cached copy is a whole app from the previous build. The
    // static handler above says `no-cache` for the same reason; a fallback that
    // did not would have made deep links the stale door.
    app.use((req, res, next) => {
        if (req.method === 'GET' && !req.path.startsWith('/api')) {
            res.setHeader('Cache-Control', 'no-store');
            return res.sendFile(path.join(distDir, 'index.html'));
        }
        next();
    });
}

app.use((err, req, res, next) => {
    // Log the full error for debugging
    console.error('[Express Error Handler]', err.message || err);

    // If headers haven't been sent yet, send a proper error response. A client
    // error the middleware already classified (the body parser's 400 for bad
    // JSON, 413 for too large) keeps its status: it is not the server's fault.
    if (!res.headersSent) {
        const status = Number(err?.status || err?.statusCode);
        if (status >= 400 && status < 500) {
            return res.status(status).json({ error: err.expose === false ? 'Bad request' : (err.message || 'Bad request') });
        }
        res.status(500).json({
            error: 'Internal server error',
            detail: process.env.NODE_ENV !== 'production'
                ? (err.message || String(err))
                : undefined,
        });
    }
    // If headers were already sent (e.g. SSE stream), just end the response
    else {
        try { res.end(); } catch (_) { /* connection already closed */ }
    }
});

const tailMiddleware = app.takeRoutes();

/**
 * Build the Express app: the recorded route blocks mounted in the order the
 * server has always registered them, with the desktop routers, the icon router
 * and the auth gate between them. Opens no socket and starts no job.
 *
 * `port` answers the port the server actually bound and `onShutdown` stops the
 * process; both are used only by the desktop lifecycle (server/desktop.js), which
 * exists only when the desktop launcher started this process.
 *
 * Every call mounts the same handler functions and the same middleware
 * instances, which is what a second app in a test wants.
 */
export function createApp({ port = () => Number(process.env.PORT) || 3001, onShutdown = () => {} } = {}) {
    const app = express();
    const mounted = new Set();
    const mount = (block) => { mountRoutes(app, block); mounted.add(block); };
    mount(headMiddleware);
    mount(authApi.routes);

    // --- Desktop lifecycle (server/desktop.js) ------------------------------------
    // Present only when the desktop launcher started this process. The status probe
    // and the heartbeat are public: the launcher is not a browser and holds no
    // session, and the locked screen must count as an open window too.
    const desktop = isDesktop()
        ? createDesktop({
            dataDir: dataPaths().dataDir,
            dbPath: DB_PATH,
            version: appVersion().version,
            port,
            getSetting,
            setSetting: (key, value) =>
                db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value),
            onShutdown,
            libraryFallback: libraryFallbackFromEnv(),
            libraryEmpty: () => {
                try { return db.prepare('SELECT COUNT(*) AS n FROM projects').get().n === 0; }
                catch { return false; }
            },
        })
        : null;
    if (desktop) app.use(desktop.publicRouter);
    else app.get('/api/desktop/status', (req, res) => res.json(NOT_DESKTOP));

    // --- The app's icon (server/appIcon.js) ---------------------------------------
    // The manifest and the icon PNGs, rendered from the three settings rows that say
    // which cut of the mark, what colour its tile is and how round it is.
    //
    // PUBLIC, and above the auth gate on purpose: a locked app still has a tab and
    // still has to be installable, and the one thing these endpoints disclose is a
    // logo. They are also the reason the pictures live under `/api` at all — the
    // service worker caches every other same-origin GET cache-FIRST, which would
    // pin an icon to the build rather than to the setting.
    app.use(createAppIconRouter({ readIcon: currentAppIcon, readColors: currentManifestColors }));

    // Everything below this line requires a valid session/bearer when a password is set.
    app.use('/api', requireAuth);
    if (desktop) app.use(desktop.protectedRouter);

    mount(projectsApi.listRoutes);
    mount(tasksApi.routes);
    mount(projectsApi.editRoutes);
    mount(catalogApi.routes);
    mount(projectsApi.deleteRoutes);
    mount(nodesApi.nodeRoutes);
    mount(onboardingApi.routes);
    mount(captureApi.routes);
    mount(nodesApi.labelRoutes);
    mount(systemApi.routes);
    mount(settingsApi.routes);
    mount(providersApi.routes);
    mount(chatApi.routes);
    mount(quizzesApi.quizRoutes);
    mount(visualsApi.routes);
    mount(flashcardsApi.generationRoutes);
    mount(bulkGenerationApi.routes);
    mount(flashcardsApi.cardRoutes);
    mount(optimizersApi.routes);
    mount(insightsApi.routes);
    mount(todayApi.briefingRoutes);
    mount(createProjectApi.routes);
    mount(searchApi.routes);
    mount(documentsApi.routes);
    mount(embeddingsApi.routes);
    mount(atlasApi.routes);
    mount(studyTimeApi.routes);
    mount(importExportApi.routes);
    mount(authoringApi.routes);
    mount(mediaApi.routes);
    mount(ankiApi.routes);
    mount(bundleApi.routes);
    mount(scheduleApi.scheduleRoutes);
    mount(completionApi.routes);
    mount(scheduleApi.scheduleEditRoutes);
    mount(decksApi.routes);
    mount(studyDashboardApi.routes);
    mount(flashcardsApi.projectCardRoutes);
    mount(quizzesApi.projectQuizRoutes);
    mount(masteryApi.routes);
    mount(placementApi.routes);
    mount(todayApi.todayRoutes);
    mount(feedApi.feedRoutes);
    mount(paperApi.routes);
    mount(feedApi.feedItemRoutes);
    mount(flashcardsApi.dueRoutes);
    mount(calendarApi.routes);
    mount(tailMiddleware);
    assertEveryBlockMounted(mounted);
    return app;
}

export { distDir, servingSPA };
