// The libraries of a site: one folder and, while its person is using it, one
// `node server/index.js` per account.
//
// Separation. On Linux each library has its own numeric user id (no
// /etc/passwd entry is needed, so ids survive a new container), its folder is
// mode 0700 and owned by that id, and the library listens on a socket inside
// that folder. Another library's process therefore cannot read its files or
// reach its socket. Only the front desk, running as root, can open every
// folder. Node's own permission flags are not used for this: the native
// add-ons (better-sqlite3, sqlite-vec) sit outside them.
// `separate: false` runs every library as the front desk's own user; it is for
// development on one's own machine (and the only choice on Windows, where the
// socket is a named pipe).
//
// Waking. A library is started on its person's first request and stopped after
// a quiet period with no open stream and no running task. At most `maxAwake`
// run at once; past that the longest-idle one that may stop is stopped, and if
// none may, the request is told to wait. Each library's V8 heap is capped
// (`heapMb`), and one whose resident memory passes `memoryMb` is stopped when it
// is next idle, so its next request starts it fresh.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { nowIso } from './siteDb.js';
import { makeNote } from '../siteLibrary.js';
import { sitePaths } from '../paths.js';

/** Environment a library is given from the front desk's own: the model the operator pays for, and the basics. */
const PASSED_ENV = /^(PATH|LANG|LC_ALL|TZ|NODE_ENV|AI_[A-Z_]+|EMBEDDING_[A-Z_]+|OLLAMA_[A-Z_]+|SYSTEMROOT|WINDIR|TEMP|TMP)$/i;

export function createLibraryPool({
    db, siteDir, appRoot, separate,
    maxAwake = 20, heapMb = 256, memoryMb = 400, idleMs = 10 * 60 * 1000,
    uidBase = 100000, allowedHosts = '', env = process.env, log = console,
}) {
    const layout = sitePaths(siteDir);
    fs.mkdirSync(layout.libraries, { recursive: true, mode: 0o711 });
    if (process.platform !== 'win32') fs.chmodSync(layout.libraries, 0o711);
    const pipeTag = crypto.createHash('sha256').update(layout.root).digest('hex').slice(0, 8);

    const q = {
        get: db.prepare('SELECT * FROM libraries WHERE id = ?'),
        maxUid: db.prepare('SELECT MAX(uid) AS uid FROM libraries'),
        add: db.prepare('INSERT INTO libraries (id, uid, note_key, created_at) VALUES (?, ?, ?, ?)'),
    };
    const awake = new Map(); // id -> { child, pid, startedAt, lastActive, streams, wakeMs }
    const waking = new Map(); // id -> Promise
    const stopping = new Map(); // id -> Promise, until the old process has exited
    const children = new Set(); // every process started and not yet exited, awake or starting
    let starting = 0; // slots taken by wakes that passed the cap and are starting
    const wakeTimes = [];

    const libDir = layout.library;
    const socketPath = (id) => (process.platform === 'win32'
        ? `\\\\.\\pipe\\terramentor-site-${pipeTag}-${id}`
        : path.join(libDir(id), 'app.sock'));

    /** Make a new, empty library folder and its row. Returns its id. */
    function create() {
        const id = crypto.randomBytes(16).toString('hex');
        const uid = separate ? Math.max(uidBase - 1, q.maxUid.get().uid ?? 0) + 1 : null;
        q.add.run(id, uid, crypto.randomBytes(32).toString('hex'), nowIso());
        const dir = libDir(id);
        fs.mkdirSync(dir, { mode: 0o700 });
        if (process.platform !== 'win32') {
            if (separate) fs.chownSync(dir, uid, uid);
            fs.chmodSync(dir, 0o700);
        }
        return id;
    }

    /** One request to a library over its socket; resolves `{ status, body }`. */
    function ask(id, urlPath, { timeoutMs = 2000 } = {}) {
        const row = q.get.get(id);
        return new Promise((resolve, reject) => {
            const req = http.request({
                socketPath: socketPath(id), path: urlPath, method: 'GET',
                headers: { host: 'localhost', 'x-terramentor-note': makeNote({ key: Buffer.from(row.note_key, 'hex'), libraryId: id, accountId: 0, sessionId: 0 }) },
                timeout: timeoutMs,
            }, (res) => {
                let body = '';
                res.setEncoding('utf8');
                res.on('data', (c) => { body += c; });
                res.on('end', () => resolve({ status: res.statusCode, body }));
            });
            req.on('timeout', () => req.destroy(new Error('timed out')));
            req.on('error', reject);
            req.end();
        });
    }

    function childEnv(id, row) {
        const out = {};
        for (const [k, v] of Object.entries(env)) if (PASSED_ENV.test(k)) out[k] = v;
        const dir = libDir(id);
        return {
            ...out,
            HOME: dir,
            DATA_DIR: dir,
            // Its own temporary folder: /tmp is shared by every library.
            TMPDIR: path.join(dir, 'tmp'),
            TERRAMENTOR_HOSTED: '1',
            TERRAMENTOR_SITE_LIBRARY: '1',
            SITE_LIBRARY_ID: id,
            SITE_SOCKET: socketPath(id),
            SITE_NOTE_KEY: row.note_key,
            ...(allowedHosts ? { ALLOWED_HOSTS: allowedHosts } : {}),
        };
    }

    async function start(id) {
        const row = q.get.get(id);
        if (!row) throw new Error(`no library ${id}`);
        // A library made while separate users were off has no user of its own;
        // started now it would run as the front desk (root) and could read every library.
        if (separate && row.uid == null) throw new Error(`library ${id.slice(0, 8)} was made without a user of its own (SITE_SEPARATE=0) and is not started with separate users on`);
        const tmp = path.join(libDir(id), 'tmp');
        fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
        if (separate && process.platform !== 'win32') fs.chownSync(tmp, row.uid, row.uid);
        const started = performance.now();
        const child = spawn(process.execPath, [`--max-old-space-size=${heapMb}`, path.join(appRoot, 'server', 'index.js')], {
            cwd: appRoot,
            env: childEnv(id, row),
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            ...(separate ? { uid: row.uid, gid: row.uid } : {}),
        });
        children.add(child);
        const tag = `[library ${id.slice(0, 8)}]`;
        let tail = '';
        const relay = (chunk) => {
            const text = String(chunk);
            tail = (tail + text).slice(-2000);
            for (const line of text.split('\n')) if (line.trim()) log.log(`${tag} ${line}`);
        };
        child.stdout.on('data', relay);
        child.stderr.on('data', relay);
        let exited = null;
        const ended = (code, signal) => {
            exited ??= { code, signal };
            children.delete(child);
            if (awake.get(id)?.child === child) awake.delete(id);
        };
        child.once('exit', ended);
        // A process that could not be started at all (EAGAIN, EPERM) emits error, not exit.
        child.once('error', (e) => { tail += `\n${e.message}`; ended(e.code || 'error', null); });
        // First answer: the status probe answers as soon as the app is listening.
        for (;;) {
            if (exited) throw new Error(`the library stopped while starting (${exited.code ?? exited.signal}): ${tail.trim().split('\n').pop() || 'no output'}`);
            if (performance.now() - started > 60_000) { child.kill('SIGKILL'); throw new Error('the library did not answer within 60 s'); }
            try {
                const r = await ask(id, '/api/auth/status', { timeoutMs: 1000 });
                if (r.status === 200) break;
            } catch { /* not listening yet */ }
            await new Promise((r) => setTimeout(r, 20));
        }
        const wakeMs = performance.now() - started;
        wakeTimes.push(wakeMs);
        if (wakeTimes.length > 100) wakeTimes.shift();
        const entry = { child, pid: child.pid, startedAt: Date.now(), lastActive: Date.now(), streams: 0, wakeMs };
        awake.set(id, entry);
        return entry;
    }

    async function isBusy(id) {
        try {
            const r = await ask(id, '/api/tasks');
            if (r.status !== 200) return false; // a broken library is better restarted than kept
            return JSON.parse(r.body).some((t) => t.status === 'running' || t.status === 'queued');
        } catch {
            return false; // not answering: nothing to protect by keeping it
        }
    }

    function residentMb(pid) {
        if (process.platform !== 'linux') return 0;
        try {
            const m = /VmRSS:\s+(\d+) kB/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'));
            return m ? Number(m[1]) / 1024 : 0;
        } catch { return 0; }
    }

    // A wake of the same library waits for this to finish: the old process
    // removes its socket as it exits, which would take the new one's with it.
    function stop(id, why = 'idle') {
        if (stopping.has(id)) return stopping.get(id);
        const entry = awake.get(id);
        if (!entry) return Promise.resolve();
        awake.delete(id);
        log.log(`[site] Stopping library ${id.slice(0, 8)} (${why})`);
        const p = (async () => {
            const gone = entry.child.exitCode !== null || entry.child.signalCode !== null
                ? Promise.resolve() : new Promise((r) => entry.child.once('exit', r));
            entry.child.kill('SIGTERM');
            const timer = setTimeout(() => entry.child.kill('SIGKILL'), 5000);
            await gone;
            clearTimeout(timer);
        })();
        stopping.set(id, p);
        return p.finally(() => stopping.delete(id));
    }

    /** May this awake library be stopped now? No open stream and no running task. */
    async function mayStop(id, entry) {
        return entry.streams === 0 && !(await isBusy(id));
    }

    async function makeRoom() {
        const idle = [...awake.entries()].sort((a, b) => a[1].lastActive - b[1].lastActive);
        for (const [id, entry] of idle) {
            if (await mayStop(id, entry)) { await stop(id, 'making room'); return true; }
        }
        return false;
    }

    /** The library awake and answering; starts it if it is not. Throws code FULL when no room can be made. */
    async function wake(id) {
        const entry = awake.get(id);
        if (entry) { entry.lastActive = Date.now(); return entry; }
        if (waking.has(id)) return waking.get(id);
        const p = (async () => {
            if (stopping.has(id)) await stopping.get(id);
            // Starting wakes hold a slot too, so a burst of cold requests cannot pass the cap.
            while (awake.size + starting >= maxAwake) {
                if (!(await makeRoom())) throw Object.assign(new Error('every library slot is in use'), { code: 'FULL' });
            }
            starting += 1;
            try { return await start(id); } finally { starting -= 1; }
        })();
        waking.set(id, p);
        try { return await p; } finally { waking.delete(id); }
    }

    async function sweep(now = Date.now()) {
        for (const [id, entry] of [...awake.entries()]) {
            const tooBig = residentMb(entry.pid) > memoryMb;
            if ((now - entry.lastActive > idleMs || tooBig) && await mayStop(id, entry)) {
                await stop(id, tooBig ? 'over its memory cap' : 'idle');
            }
        }
    }

    return {
        create, wake, stop, sweep, ask, isBusy, socketPath, libDir,
        noteKey: (id) => Buffer.from(q.get.get(id).note_key, 'hex'),
        isAwake: (id) => awake.has(id),
        awakeCount: () => awake.size,
        wakeTimes: () => [...wakeTimes],
        touch: (id) => { const e = awake.get(id); if (e) e.lastActive = Date.now(); },
        streamOpened: (id) => { const e = awake.get(id); if (e) e.streams += 1; },
        streamClosed: (id) => { const e = awake.get(id); if (e) { e.streams = Math.max(0, e.streams - 1); e.lastActive = Date.now(); } },
        stopAll: async () => {
            await Promise.all([...awake.keys()].map((id) => stop(id, 'shutting down')));
            // And any still starting.
            await Promise.all([...children].map((c) => new Promise((r) => {
                if (c.exitCode !== null || c.signalCode !== null) return r();
                c.once('exit', r);
                c.kill('SIGKILL');
            })));
        },
        awakeOrStarting: () => awake.size + starting,
        uidOf: (id) => q.get.get(id)?.uid ?? null,
    };
}
