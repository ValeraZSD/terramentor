// Start a site's front desk: `node server/site/index.js`.
//
//   SITE_DIR                 the site's folder (site.db, libraries/); required
//   PORT, HOST               where the front desk listens (3001, 127.0.0.1)
//   SITE_HOSTS               the names it answers to, comma-separated; required unless
//                            HOST is loopback (then any name is answered)
//   SITE_SEPARATE            1 (default on Linux): each library runs as its own user,
//                            which needs the front desk to run as root. 0 runs them all
//                            as this user: development on your own machine only
//   SITE_MAX_AWAKE           libraries running at once (20)
//   SITE_LIBRARY_HEAP_MB     V8 heap cap per library (256)
//   SITE_LIBRARY_MEMORY_MB   resident memory past which an idle library is stopped (400)
//   SITE_IDLE_MINUTES        quiet minutes before a library is stopped (10)
//   SITE_UID_BASE            first user id given to a library (100000)
//   SITE_LIBRARY_LOG_KB      size of a library's server.log before it is rotated (1024, at least 4);
//                            two files at most, in the library's own folder
//   SITE_BREACH_CHECK        0 turns off the breached-password check
//   AI_*                     the model every library uses (as for a hosted copy)
//
// docs/HOSTING.md, "Many people at one address", is the operator's guide.
import '../ownerOnlyUmask.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSiteDb } from './siteDb.js';
import { createFrontDesk } from './frontDesk.js';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The settings as the front desk reads them, one parse for both the start-up
 * check and the start, so a value the check accepted is the value that runs.
 */
export function siteSettings(env = process.env, { platform = process.platform } = {}) {
    const sepRaw = String(env.SITE_SEPARATE ?? '').trim();
    return {
        sepRaw,
        separate: sepRaw === '' ? platform === 'linux' : sepRaw === '1',
        host: String(env.HOST || '127.0.0.1').trim(),
        hosts: String(env.SITE_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
    };
}

/** Why this front desk must not start, or null. */
export function siteStartProblem(env = process.env, { platform = process.platform, uid = process.getuid?.() } = {}) {
    if (!env.SITE_DIR) return 'SITE_DIR is not set: name the folder this site keeps its accounts and libraries in.';
    const { sepRaw, separate, host: rawHost, hosts } = siteSettings(env, { platform });
    if (sepRaw !== '' && sepRaw !== '0' && sepRaw !== '1') return `SITE_SEPARATE is "${sepRaw}"; it must be 1 or 0.`;
    if (separate && platform !== 'linux') return 'SITE_SEPARATE=1 (each library as its own user) works on Linux only. Use SITE_SEPARATE=0 to try a site on this machine.';
    if (separate && uid !== 0) return 'each library runs as its own user, which needs the front desk to run as root (docker run --user 0). SITE_SEPARATE=0 runs them all as one user, for development only.';
    // Reachable from other machines, it must know its own names, or a page of
    // another name pointed at this address would be answered as this site.
    const host = rawHost.toLowerCase();
    const loopback = host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
    if (!loopback && !hosts.length) return `HOST is ${host}, so other machines can reach this site: set SITE_HOSTS to the names it answers to (learn.example.org).`;
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 24 || (major === 24 && minor < 7)) return `Node ${process.versions.node} has no built-in argon2; the front desk needs Node 24.7 or later.`;
    return null;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    const env = process.env;
    const problem = siteStartProblem(env);
    if (problem) {
        console.error(`[site] Refusing to start: ${problem}`);
        process.exit(1);
    }
    const { separate, hosts, host } = siteSettings(env);
    if (!separate) console.warn('[site] SITE_SEPARATE=0: every library runs as this user and can read the others. Development only.');
    const siteDir = path.resolve(env.SITE_DIR);
    const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
    const desk = createFrontDesk({
        db: openSiteDb(siteDir), siteDir, appRoot, separate,
        hosts,
        maxAwake: num(env.SITE_MAX_AWAKE, 20),
        heapMb: num(env.SITE_LIBRARY_HEAP_MB, 256),
        memoryMb: num(env.SITE_LIBRARY_MEMORY_MB, 400),
        idleMs: num(env.SITE_IDLE_MINUTES, 10) * 60_000,
        uidBase: num(env.SITE_UID_BASE, 100000),
        // At least 4 KB (a smaller value would rotate at every line).
        libraryLogBytes: Math.max(4, num(env.SITE_LIBRARY_LOG_KB, 1024)) * 1024,
    });
    const port = Number(env.PORT) || 3001;
    desk.server.listen(port, host, () => console.log(`[site] Front desk listening on ${host}:${port}`));
    for (const sig of ['SIGINT', 'SIGTERM']) {
        process.on(sig, () => {
            console.log(`[site] Shutting down (${sig})`);
            setTimeout(() => process.exit(0), 8000).unref();
            desk.close().finally(() => process.exit(0));
        });
    }
}
