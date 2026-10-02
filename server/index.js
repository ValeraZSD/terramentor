// The server's entry point: builds the app (server/app.js), listens, and starts
// the background work a running server owns. Importing this file opens the port;
// importing server/app.js does not.
import { closeDatabase, DB_PATH } from './database.js';
import { announceSetupCode, isAuthEnabled } from './auth.js';
import { syncBuiltinProviders } from './searchProviders.js';
import * as feedGen from './feedGen.js';
import { logActivity } from './activityLog.js';
import { scheduleNodeSync } from './nodeEmbeddings.js';
import { scheduleTransferSweep } from './masteryTransfer.js';
import { sweepOrphanMedia } from './ankiImport.js';
import { buildAtlas } from './atlas.js';
import { backfillNodeRoles } from './nodeRole.js';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { resumePendingRecovery } from './pdfRecovery.js';
import { startEventLoopMonitor } from './slowLog.js';
import { isDesktop } from './desktop.js';
import { refreshDesktopIcon } from './desktopIcon.js';
import { createApp, distDir, servingSPA } from './app.js';
import { getGateConfig } from './settingsStore.js';
import { currentAppIcon } from './appIconSettings.js';
import { startUpdatePoll } from './updatePoll.js';

// Process-level error handlers
// Unhandled rejections are logged but NOT fatal — they typically
// come from async route handlers (SSE streams, AI calls, etc.)
// that Express 4.x cannot catch.  Killing the process here causes
// a cascade where Express tries to clean up mid-shutdown and
// triggers "Cannot read properties of undefined (reading 'method')".

process.on('unhandledRejection', (err) => {
    console.error('[ERROR] Unhandled Rejection (non-fatal):', err);
    // Individual request errors should be handled by Express error
    // middleware and route-level try/catch.
});

process.on('uncaughtException', (err) => {
    // Truly unexpected synchronous errors are still fatal,
    // but we log extra context to aid debugging.
    console.error('[FATAL] Uncaught Exception:', err);
    console.error('[FATAL] This is likely caused by a bug in Express or a native module.');
    console.error('[FATAL] Try: rm -rf node_modules && npm install');
    process.exit(1);
});

// The port this process actually bound (it can move under PORT_FALLBACK); the
// desktop lifecycle inside the app asks for it.
let boundPort = Number(process.env.PORT) || 3001;
const app = createApp({ port: () => boundPort, onShutdown: shutdownProcess });

const PORT = Number(process.env.PORT) || 3001;

// In standalone mode, serve over HTTPS when locally-trusted certs exist in ./.certs
// (mkcert) — a secure context is required for the PWA to install from a phone on the
// LAN. We only do this when serving the SPA: in dev, Express must stay plain http so
// Vite's proxy (target http://localhost:3001) keeps working.
const certDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.certs');
const keyPath = path.join(certDir, 'key.pem');
const certPath = path.join(certDir, 'cert.pem');
const httpsOpts = servingSPA && fs.existsSync(keyPath) && fs.existsSync(certPath)
    ? { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }
    : null;

// Bind to loopback by default so the server is NOT directly reachable from the
// LAN or internet — remote access should go through an authenticated tunnel
// (e.g. `tailscale serve`, which proxies to localhost). Override with HOST=0.0.0.0
// only if you explicitly want to expose it on all interfaces (and then a password
// via the security settings is strongly recommended).
const HOST = process.env.HOST || '127.0.0.1';

// Refresh the shipped add-on manifests before serving. The user's enabled/
// disabled choices survive; only the manifests themselves are updated, so a
// corrected URL template reaches existing installs.
try { syncBuiltinProviders(); } catch (e) { console.warn('[SearchProviders] Built-in sync failed:', e.message); }

const server = httpsOpts ? https.createServer(httpsOpts, app) : http.createServer(app);
// Socket timeouts. Nothing here may bound a RESPONSE: SSE streams stay open as
// long as what they stream takes, and the long-lived paths decide this per
// connection themselves — startSseResponse and startAiStream both re-zero their
// own socket timeouts and send keepalive comments, so a thinking model's silent
// minutes are safe without a global free pass. What the defaults below restore
// is the REQUEST half: headers and body must arrive within bounded time, or a
// slow-drip socket parks a connection (and, with memoryStorage uploads, its
// bytes) indefinitely. requestTimeout is raised above Node's 5-minute default
// because a 500 MB deck on a slow link is a real upload here, not an attack.
server.timeout = 0;               // Node default — no socket-inactivity kill (SSE)
server.headersTimeout = 60_000;   // Node default — the slowloris bound
server.keepAliveTimeout = 5_000;  // Node default — idle keep-alive sockets close
server.requestTimeout = 900_000;  // 15 min to RECEIVE a request; Node default is 5 min

/**
 * Listen, and when the port is taken, try the next ones — but only when asked
 * (PORT_FALLBACK=1, which the desktop launcher sets). A developer who starts a
 * second server by mistake wants EADDRINUSE, loudly, on the port they named:
 * silently moving means the Vite proxy keeps talking to the OLD process, with
 * whatever database IT was started against. A desktop user who happens to run
 * something else on 3001 wants the app to open, and the launcher learns the
 * real port from the promise below rather than assuming one.
 */
const PORT_ATTEMPTS = process.env.PORT_FALLBACK === '1' ? 10 : 1;

function listenWithFallback(port, attemptsLeft) {
    return new Promise((resolve, reject) => {
        const onError = (err) => {
            server.off('listening', onListening);
            if (err.code === 'EADDRINUSE' && attemptsLeft > 1) {
                console.warn(`[server] Port ${port} is in use — trying ${port + 1}`);
                resolve(listenWithFallback(port + 1, attemptsLeft - 1));
            } else {
                reject(err);
            }
        };
        const onListening = () => {
            server.off('error', onError);
            resolve(port);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, HOST);
    });
}

/**
 * Resolves with `{port, host, proto, url}` once the server is accepting
 * connections; rejects when it never will. The desktop launcher awaits this to
 * learn where to point the window. In every other deployment nothing reads it.
 */
export const serverReady = listenWithFallback(PORT, PORT_ATTEMPTS).then((port) => {
    boundPort = port;
    const proto = httpsOpts ? 'https' : 'http';
    console.log(`Server running at ${proto}://localhost:${port} (bound to ${HOST})`);
    if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
        console.log(`[security] Listening on ${HOST} — reachable beyond this machine. Set a password in Settings → Data → Security.`);
        // Printed up front here, where a remote first visit is the likely one
        // (a container is always this case): the operator reading the start-up
        // log already has what the other device will ask for.
        if (!isAuthEnabled() && process.env.AUTH_ALLOW_OPEN_REMOTE !== '1') announceSetupCode();
    }
    if (servingSPA) {
        console.log(`Serving standalone app from ${distDir}`);
    } else {
        console.log('API-only (dev mode) — run `npm run build` to serve the installable standalone app from here.');
    }
    console.log(`Data: ${DB_PATH}`);
    // A restart is the boundary between two runs, and half of reading a log is
    // knowing which run a line belongs to. No path here: `DB_PATH` is a place on
    // someone's disk, which is exactly the kind of fact the export must not carry.
    logActivity({
        area: 'server',
        event: 'server.started',
        detail: `${servingSPA ? 'standalone' : 'api-only'} · node ${process.versions.node} · ${process.platform}`,
    });
    // Catch the shell up on a boot, not only on a change: an install that was
    // packaged before this existed still has the built-in mark on disk, and a
    // setting written by a copy that has since exited left the file behind. Off
    // the desktop this is one environment-variable read and a return.
    void refreshDesktopIcon(currentAppIcon());
    return { port, host: HOST, proto, url: `${proto}://127.0.0.1:${port}` };
});
serverReady.catch((err) => {
    console.error(`[FATAL] Could not listen on ${HOST}:${PORT}: ${err.message}`);
    process.exit(1);
});

/**
 * Stop cleanly: no new connections, the WAL folded into the database file, and
 * the process gone. Used by the desktop lifecycle and by SIGINT/SIGTERM under
 * the launcher. A hard deadline covers a connection that never closes (an SSE
 * stream a browser forgot about) — `server.close` waits for those forever.
 *
 * EXPORTED for one caller: the desktop launcher, which under a Windows tray
 * icon is asked to stop by having its standard input closed. Windows has no
 * SIGTERM to send a child, and the HTTP quit endpoint is behind the password
 * gate — which is right, because that gate is what stops someone on the tailnet
 * shutting the app down, and a tray menu must not need an exception to it.
 */
export function shutdownProcess(reason = 'signal') {
    console.log(`[server] Shutting down (${reason})`);
    const deadline = setTimeout(() => process.exit(0), 3_000);
    deadline.unref();
    try { server.closeAllConnections?.(); } catch { /* older Node */ }
    server.close(() => {
        closeDatabase();
        process.exit(0);
    });
}
if (isDesktop()) {
    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => shutdownProcess(sig));
}

// Warm the learning feed's teaching buffer once the server has settled.
feedGen.startupKick();

// Nodes written before `nodes.role` existed: demote the stages the Anki importer
// cut out of card order. One shot (it records a flag), synchronous because it is
// a single indexed UPDATE over one transaction, and here rather than in
// database.js because the rule for what a stage IS lives with the rest of the
// role logic and database.js is what nodeRole.js imports.
try {
    const { updated, skipped } = backfillNodeRoles();
    if (!skipped && updated) console.log(`[Migration] marked ${updated} imported stage node(s) as pagination`);
} catch (e) {
    console.error('[Migration] node role backfill failed (non-fatal):', e.message);
}

// The opt-in update poll. A no-op unless the learner turned it on, which is what
// keeps SECURITY.md's idle-and-capture procedure true on a default install.
startUpdatePoll();

// Reconcile the topic space. Nodes can change while the server is down (a
// restored backup, a hand-edited DB, an upgrade that adds this feature to a
// library built over months), and the sweep is a no-op when nothing drifted —
// so startup is the one place that guarantees the map is never permanently
// behind the curriculum. Deferred well past boot: it wants the model, and the
// feed buffer asked first.
scheduleNodeSync({ delay: 20000 });

// ...and the head starts that ride on it. Behind the embedding sweep, because a
// topic with no vector yet has no twins to find.
scheduleTransferSweep({ delay: 45000, ...getGateConfig() });

// Resume any PDF math recovery interrupted by a restart (its in-memory queue was
// lost but the DB still shows it running/pending). Deferred so it doesn't compete
// with startup; runs on its own serial chain and yields to interactive work.
setTimeout(() => { try { resumePendingRecovery(); } catch { /* never fatal */ } }, 8000);

// Card media the database no longer points at. A staged import holds its blobs
// in memory-free storage rather than in memory, so a crash or a restart between
// inspect and commit strands them; startup is the only place that is guaranteed
// to run afterwards. Deferred past boot because it walks the media directory.
setTimeout(() => {
    const { removed, bytes } = sweepOrphanMedia();
    if (removed) console.log(`[Media] swept ${removed} unreferenced file(s), ${(bytes / 1048576).toFixed(1)} MB`);
}, 12000);
// Draw the atlas before anyone asks for it. Building it from cold takes ~1.8 s
// on a real library (measured 2026-09-09) and 13 ms once the cache behind
// `buildAtlas` is warm — so the only person who ever waited was whoever opened
// the map first after a restart. It reads vectors that are already on disk and
// calls no model, so warming costs nothing but the CPU it would have spent
// anyway; a library with no embeddings resolves immediately with
// `available:false`. Behind the embedding sweep, which may change the answer.
setTimeout(() => {
    buildAtlas().catch(() => { /* nothing has asked yet: a failure is not news */ });
}, 25000);

// Started last, and after the warm-up timers above, so the sweeps this file
// schedules on purpose are not reported as if they were the problem. Silent
// until the one thread actually stops answering. See server/slowLog.js.
startEventLoopMonitor();
