#!/usr/bin/env node
/**
 * The three proofs site mode stands on, on Linux, as root (a container run
 * with --user 0, or CI). Each prints one line starting "proof":
 *
 *   a. separation: library A's process cannot read library B's files, list its
 *      folder, connect to its socket, read its environment (where its note key
 *      is) or read the site's database; and, as a control, it can do the same
 *      to itself, so the refusals are not a broken test;
 *   b. waking an existing library: process start to first answer, measured;
 *   c. a wake starts no model work: a library holding a course, pointed at a
 *      local stand-in for a model that counts requests, is woken by the front
 *      desk and gets none; the same library started as a plain hosted copy
 *      (the control) does reach the stand-in, so the counter can see a call.
 *      No real model is called: the stand-in answers 503 to everything.
 *
 *   docker run --rm --user 0 -v "$PWD/tools:/app/tools:ro" terramentor:ci node tools/site-proofs.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'linux' || process.getuid() !== 0) {
    console.error('site-proofs: needs Linux and root (each library runs as its own user)');
    process.exit(2);
}
const { openSiteDb } = await import('../server/site/siteDb.js');
const { createFrontDesk } = await import('../server/site/frontDesk.js');
const { makeNote } = await import('../server/siteLibrary.js');

let failed = 0;
const proof = (line, good) => { console.log(`proof ${line}`); if (!good) { failed++; console.log('  ^ FAILED'); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Under /tmp, made by root: the site folder must be passable for libraries.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'site-proofs-'));
fs.chmodSync(scratch, 0o711);
const siteDir = path.join(scratch, 'site');

// A stand-in for a model: counts every request, answers 503.
let modelHits = [];
const model = http.createServer((req, res) => { modelHits.push(`${req.method} ${req.url}`); req.resume(); res.writeHead(503); res.end('{}'); });
await new Promise((r) => model.listen(0, '127.0.0.1', r));
const MODEL_ENV = {
    AI_PROVIDER: 'openai', AI_BASE_URL: `http://127.0.0.1:${model.address().port}/v1`, AI_MODEL: 'stand-in', AI_API_KEY: 'none',
    SITE_BREACH_CHECK: '0',
};

const lines = [];
const log = { log: (l) => lines.push(l), error: (l) => lines.push(l), warn: (l) => lines.push(l) };
const db = openSiteDb(siteDir);
const desk = createFrontDesk({
    db, siteDir, appRoot: repoRoot, separate: true, env: { ...process.env, ...MODEL_ENV }, log, sweepEveryMs: 3_600_000,
});
const { pool } = desk;

/** Run a small script as a library's user; resolves its JSON output. */
function asUser(uid, code) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', code], { uid, gid: uid, env: { PATH: process.env.PATH }, cwd: '/' });
        let out = '', err = '';
        child.stdout.on('data', (c) => { out += c; });
        child.stderr.on('data', (c) => { err += c; });
        child.on('exit', () => { try { resolve(JSON.parse(out)); } catch { reject(new Error(err || out)); } });
    });
}
const PROBE = (target, socket, pid, siteDb) => `
const fs = require('fs'), net = require('net');
const r = {};
const code = (fn) => { try { fn(); return 'ok'; } catch (e) { return e.code || e.message; } };
r.read = code(() => fs.readFileSync(${JSON.stringify(target.db)}));
r.list = code(() => fs.readdirSync(${JSON.stringify(target.dir)}));
r.write = code(() => fs.writeFileSync(${JSON.stringify(path.join(target.dir, 'planted'))}, 'x'));
r.environ = code(() => fs.readFileSync('/proc/${pid}/environ'));
r.siteDb = code(() => fs.readFileSync(${JSON.stringify(siteDb)}));
const s = net.connect(${JSON.stringify(socket)});
s.on('connect', () => { r.socket = 'ok'; s.destroy(); console.log(JSON.stringify(r)); });
s.on('error', (e) => { r.socket = e.code; console.log(JSON.stringify(r)); });
`;

try {
    // --- a. separation --------------------------------------------------------
    const a = pool.create();
    const b = pool.create();
    const firstStart = performance.now();
    const ea = await pool.wake(a);
    const newLibraryS = (performance.now() - firstStart) / 1000;
    const eb = await pool.wake(b);
    const dbFile = (id) => fs.readdirSync(pool.libDir(id)).find((f) => f.endsWith('.db'));
    const target = (id) => ({ dir: pool.libDir(id), db: path.join(pool.libDir(id), dbFile(id)) });
    const uidA = pool.uidOf(a);
    const st = fs.statSync(pool.libDir(b));
    const other = await asUser(uidA, PROBE(target(b), pool.socketPath(b), eb.pid, path.join(siteDir, 'site.db')));
    const self = await asUser(uidA, PROBE(target(a), pool.socketPath(a), ea.pid, path.join(siteDir, 'site.db')));
    const refused = ['read', 'list', 'write', 'socket', 'environ', 'siteDb'].every((k) => other[k] === 'EACCES');
    const control = self.read === 'ok' && self.list === 'ok' && self.socket === 'ok' && self.environ === 'ok';
    proof(`a: library A (uid ${uidA}) refused reading library B (uid ${pool.uidOf(b)}, folder mode ${(st.mode & 0o777).toString(8)}): `
        + `read its database ${other.read}, list its folder ${other.list}, write into it ${other.write}, connect to its socket ${other.socket}, `
        + `read its environment ${other.environ}, read site.db ${other.siteDb}; control, A on itself: read ${self.read}, list ${self.list}, socket ${self.socket}`,
    refused && control);

    // --- b. waking an existing library ------------------------------------------
    const times = [];
    for (let i = 0; i < 3; i++) {
        await pool.stop(a, 'proof');
        const entry = await pool.wake(a);
        times.push(entry.wakeMs / 1000);
    }
    const median = [...times].sort((x, y) => x - y)[1];
    proof(`b: waking an existing library, process start to first answer: ${times.map((t) => `${t.toFixed(2)} s`).join(', ')} `
        + `(median ${median.toFixed(2)} s; a new library's first start ${newLibraryS.toFixed(2)} s; ${os.cpus().length} CPUs, Node ${process.versions.node})`,
    median < 3);

    // --- c. no model work on a wake ---------------------------------------------
    // A course with topics under way, written through the front desk's own note.
    const call = (id, method, url, body) => new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const r = http.request({
            socketPath: pool.socketPath(id), method, path: url,
            headers: {
                host: 'localhost', 'content-type': 'application/json',
                'x-terramentor-note': makeNote({ key: pool.noteKey(id), libraryId: id, accountId: 1, sessionId: 1 }),
            },
        }, (res) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, body: t })); });
        r.on('error', reject);
        if (data) r.write(data);
        r.end();
    });
    // Not a proof line, a check: a wake during a stop of the same library. The
    // old process removes its socket as it exits, so the wake must wait for it,
    // or the new process is left with no socket anyone can reach.
    {
        const stopping = pool.stop(a, 'proof');
        await pool.wake(a);
        await stopping;
        const after = await call(a, 'GET', '/api/auth/status').catch((e) => ({ status: e.code }));
        console.log(`check: a wake during a stop answers on its socket: ${after.status}`);
        if (after.status !== 200) { failed++; console.log('  ^ FAILED'); }
    }
    const project = JSON.parse((await call(a, 'POST', '/api/projects', { name: 'Proof course' })).body);
    for (const title of ['First topic', 'Second topic', 'Third topic']) {
        await call(a, 'POST', '/api/nodes', { project_id: project.id, parent_id: null, title, status: 'in_progress' });
    }
    const WATCH_MS = 45_000;
    await pool.stop(a, 'proof');
    modelHits = [];
    await pool.wake(a);
    await sleep(WATCH_MS);
    const onWake = modelHits.length;
    // What a library prints goes to its own log, not the front desk's.
    let said = false;
    try { said = fs.readFileSync(path.join(pool.libDir(a), 'server.log'), 'utf8').includes('[site] Woken: start-up model work is not started'); } catch { /* no log: no line */ }
    await pool.stop(a, 'proof');

    // The control: the same library, started the way a hosted copy starts.
    modelHits = [];
    const libEnv = {
        PATH: process.env.PATH, HOME: pool.libDir(a), DATA_DIR: pool.libDir(a), TERRAMENTOR_HOSTED: '1',
        HOST: '127.0.0.1', PORT: '39517', ...MODEL_ENV,
    };
    const plain = spawn(process.execPath, [path.join(repoRoot, 'server', 'index.js')], {
        cwd: repoRoot, env: libEnv, uid: uidA, gid: uidA, stdio: 'ignore',
    });
    // The control has no password and no port anyone reaches; it only runs its start-up work.
    const deadline = Date.now() + WATCH_MS;
    while (Date.now() < deadline && modelHits.length === 0) await sleep(250);
    const control2 = modelHits.length;
    const firstHit = modelHits[0] || 'none';
    plain.kill('SIGKILL');
    proof(`c: no generation on wake: ${onWake} request(s) reached the model stand-in in ${WATCH_MS / 1000} s after a wake of a library holding a course `
        + `(library log: ${said ? '"start-up model work is not started"' : 'no wake line'}); control, the same library started as a plain hosted copy: `
        + `${control2} request(s) (first: ${firstHit})`, onWake === 0 && said && control2 > 0);
} catch (e) {
    console.error(e);
    failed++;
} finally {
    await desk.close().catch(() => {});
    model.close();
    db.close();
    fs.rmSync(scratch, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
