// Getting the next version of a desktop install ready: download it, check it,
// stage it beside the running app. Installing it is somebody else's job.
//
// The line this file holds is the one server/version.js drew: the server never
// installs anything. What it may do, when the person presses "Update
// available", is fetch the release the update check offered — only from this
// repository's releases, only a version newer than the running one — check
// every byte against that release's manifest, and lay it out under
// `<app>/.update/next`. Nothing downloads without that press, and nothing
// installs without the second one, "Restart to update", which the person
// chooses when nothing important is running. The app's own files are not
// touched here. The swap is desktop/updater.js, a separate process the
// launcher starts after the app has exited, which checks the staged files
// again before it moves anything.
//
// So the most a caller of these endpoints can do is make this install fetch
// and, on "Restart to update", run the newest official release — the same
// thing the person would get by downloading the zip by hand.
//
// HOW LITTLE IT DOWNLOADS. A release zip is ~119 MB, and between two real
// releases ~8 MB of it changes (measured 12 Oct 2026: 1.2.0 → the 8 Oct nightly,
// 363 of 6,857 files; Node and the libraries were identical). The zip's table
// of contents sits at its end and says where each file's bytes are, so the
// changed files are fetched with HTTP Range requests and the rest are taken
// from the running install — after hashing them, so a damaged install is not
// carried forward. A server that will not answer a range gets the whole zip,
// resumed where a cut left it.

import { copyFileSync, chmodSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, readSync, closeSync, rmSync, statSync, statfsSync, writeFileSync, createWriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appVersion, compareVersions, downloadPrefix, readBuildInfo } from './version.js';

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** desktop/updateCore.js, loaded on first use: the Docker image ships no
 *  `desktop/`, and nothing in a container ever downloads an app. */
let corePromise = null;
const loadCore = () => (corePromise ||= import('../desktop/updateCore.js'));

/** Set by desktop/launcher.js: the one thing that can start the updater, because
 *  it is the process that knows how this copy was started and has to get out of
 *  the way. Without it (a checkout, `npm run dev`) this install cannot install. */
let installer = null;
export function setUpdateInstaller(fn) { installer = typeof fn === 'function' ? fn : null; }

const MAX_MANIFEST_BYTES = 1024 * 1024;
const RANGE_TIMEOUT_MS = 120_000;
const RANGE_TRIES = 3;

/** In-memory progress of the one download that may run at a time. Everything
 *  that must survive a restart is a file under `.update/`. */
let job = null;   // { version, phase, received, total, mode, error, controller }

const updateDir = (appRoot) => join(appRoot, '.update');

/**
 * Can THIS copy update itself, and if not, why not — in the words the panel
 * shows. A packaged desktop copy, with the file list a release ships, in a
 * folder this user may write to, started by the launcher.
 */
export function installSupport({ appRoot = APP_ROOT, deployment = appVersion().deployment, hasInstaller = installer !== null } = {}) {
    if (deployment !== 'desktop') return { supported: false, reason: deployment };
    if (!readBuildInfo(appRoot)) return { supported: false, reason: 'checkout' };
    if (!existsSync(join(appRoot, 'files.json'))) return { supported: false, reason: 'no-file-list' };
    if (!hasInstaller) return { supported: false, reason: 'no-launcher' };
    try {
        mkdirSync(updateDir(appRoot), { recursive: true });
        const probe = join(updateDir(appRoot), '.write-test');
        writeFileSync(probe, '');
        rmSync(probe, { force: true });
    } catch {
        return { supported: false, reason: 'read-only' };
    }
    return { supported: true, reason: null };
}

const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };

/** What /api/updates adds about installing: can it, what is happening, what is
 *  staged, and what the last attempt did (`.update/result.json`, written by the
 *  updater, shown once and then dismissed). */
export function installState({ appRoot = APP_ROOT, current = appVersion().version } = {}) {
    const support = installSupport({ appRoot });
    const ready = readJson(join(updateDir(appRoot), 'ready.json'));
    const staged = ready && compareVersions(ready.version, current) > 0 ? ready.version : null;
    const result = readJson(join(updateDir(appRoot), 'result.json'));
    const phase = job && job.phase === 'downloading' ? 'downloading'
        : staged ? 'ready'
            : job && job.phase === 'failed' ? 'failed'
                : 'idle';
    return {
        ...support,
        phase,
        version: phase === 'ready' ? staged : job?.version || null,
        step: job?.step || null,
        received: job?.received || 0,
        total: job?.total || 0,
        mode: job?.mode || ready?.mode || null,
        downloadBytes: ready?.bytes ?? null,
        error: phase === 'failed' ? job.error : null,
        result: result && typeof result === 'object' ? result : null,
        // This server is a new version the updater is still watching: the
        // result above is written a moment after this server first answers,
        // so a page that loads now asks again until the trial ends.
        trial: existsSync(join(updateDir(appRoot), 'swap.json')),
    };
}

export function dismissResult({ appRoot = APP_ROOT } = {}) {
    rmSync(join(updateDir(appRoot), 'result.json'), { force: true });
}

/** A failure the panel can explain. `kind` picks the sentence; `detail` is for
 *  the log and the Details line, never the headline. */
class UpdateError extends Error {
    constructor(kind, message) { super(message); this.kind = kind; }
}

function classify(e) {
    if (e instanceof UpdateError) return { kind: e.kind, message: e.message };
    if (e?.name === 'AbortError' || e?.name === 'TimeoutError') return { kind: 'network', message: 'The download stopped responding.' };
    if (e?.code === 'ENOSPC') return { kind: 'space', message: 'The disk is full.' };
    if (['EACCES', 'EPERM', 'EROFS'].includes(e?.code)) return { kind: 'disk', message: 'Terramentor could not write into its own folder.' };
    if (e?.cause || e instanceof TypeError) return { kind: 'network', message: 'Could not reach GitHub. Check the internet connection.' };
    return { kind: 'other', message: e?.message || String(e) };
}

/** One HTTP Range read, retried on a dropped connection. GitHub answers a
 *  release download with a redirect to its file host, which `fetch` follows;
 *  the bytes are checked against the manifest whatever host served them. */
async function rangeRead(fetchImpl, url, start, end, signal) {
    for (let i = 1; ; i++) {
        try {
            const res = await fetchImpl(url, {
                headers: { Range: `bytes=${start}-${end}`, 'User-Agent': `Terramentor/${appVersion().version}` },
                redirect: 'follow',
                signal: AbortSignal.any([signal, AbortSignal.timeout(RANGE_TIMEOUT_MS)]),
            });
            if (res.status !== 206) {
                await res.body?.cancel();
                throw new UpdateError('no-range', `The download server answered ${res.status} to a partial request.`);
            }
            const buf = Buffer.from(await res.arrayBuffer());
            if (buf.length !== end - start + 1) throw new UpdateError('network', 'A part of the download arrived cut short.');
            const total = Number(/\/(\d+)\s*$/.exec(res.headers.get('content-range') || '')?.[1]);
            return { buf, total };
        } catch (e) {
            if (signal.aborted || e instanceof UpdateError && e.kind !== 'network' || i >= RANGE_TRIES) throw e;
            await new Promise((r) => setTimeout(r, 1000 * i));
        }
    }
}

async function getJson(fetchImpl, url, signal) {
    const res = await fetchImpl(url, {
        headers: { 'User-Agent': `Terramentor/${appVersion().version}`, Accept: 'application/json' },
        redirect: 'follow',
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    });
    if (!res.ok) throw new UpdateError('network', `GitHub answered ${res.status} for the release manifest.`);
    const text = await res.text();
    if (text.length > MAX_MANIFEST_BYTES) throw new UpdateError('origin', 'The release manifest is implausibly large.');
    try { return JSON.parse(text); } catch { throw new UpdateError('origin', 'The release manifest is not valid JSON.'); }
}

/** Write bytes to `file` under `root`, making folders, keeping the exec bit. */
function put(root, rel, buf, exec) {
    const file = join(root, ...rel.split('/'));
    mkdirSync(dirname(file), { recursive: true });
    // Unlink first: a staged file can be a hard link to the INSTALLED copy, and
    // writing through it would change the running app's file in place.
    rmSync(file, { force: true });
    writeFileSync(file, buf);
    if (exec && process.platform !== 'win32') chmodSync(file, 0o755);
}

/** An unchanged file is a hard link to the running install's copy when the
 *  file system allows it (same volume, NTFS/ext4/APFS), else a copy. */
function reuse(fromRoot, toRoot, rel) {
    const from = join(fromRoot, ...rel.split('/'));
    const to = join(toRoot, ...rel.split('/'));
    mkdirSync(dirname(to), { recursive: true });
    rmSync(to, { force: true });
    try { linkSync(from, to); } catch { copyFileSync(from, to); }
}

/**
 * Download and stage `latest` (the update check's answer) into
 * `<appRoot>/.update/next`, ending with `.update/ready.json`. Resolves when
 * done; throws an UpdateError (or a file-system error) otherwise. Re-running
 * after a cut keeps every staged file whose hash still matches.
 */
export async function stageUpdate({
    latest, appRoot = APP_ROOT, current = appVersion().version, platform = `${process.platform}-${process.arch}`,
    fetchImpl = globalThis.fetch, signal = new AbortController().signal, onProgress = () => {}, freeBytes = defaultFreeBytes,
}) {
    const core = await loadCore();
    if (!latest || compareVersions(latest.version, current) <= 0) throw new UpdateError('origin', 'There is no newer version to download.');
    const prefix = downloadPrefix();
    if (typeof latest.manifestUrl !== 'string' || !latest.manifestUrl.startsWith(prefix)) {
        throw new UpdateError('manual', 'This release has no manifest, so it can only be installed by downloading it.');
    }
    const manifest = await getJson(fetchImpl, latest.manifestUrl, signal);
    let asset;
    try {
        asset = core.assertManifest(manifest, { version: latest.version, tag: latest.tag, platform, downloadPrefix: prefix });
    } catch (e) {
        throw new UpdateError('origin', e.message);
    }
    if (!asset.files) throw new UpdateError('manual', 'This release was built before one-click updates, so it can only be installed by downloading it.');

    const upd = updateDir(appRoot);
    const nextDir = join(upd, 'next');
    // A staging area for another version (an older offer, a failed try) is
    // thrown away; one for this version is resumed.
    const marker = join(upd, 'next.version');
    if (!existsSync(marker) || readFileSync(marker, 'utf8') !== latest.version) {
        rmSync(nextDir, { recursive: true, force: true });
        rmSync(join(upd, 'download'), { recursive: true, force: true });
        mkdirSync(nextDir, { recursive: true });
        writeFileSync(marker, latest.version);
    }
    rmSync(join(upd, 'ready.json'), { force: true });

    let staged;
    try {
        staged = await stageByRanges({ core, asset, appRoot, nextDir, fetchImpl, signal, onProgress, freeBytes, version: latest.version });
    } catch (e) {
        if (!(e instanceof UpdateError) || e.kind !== 'no-range') throw e;
        staged = await stageFromZip({ core, asset, appRoot, nextDir, upd, fetchImpl, signal, onProgress, freeBytes, version: latest.version });
    }

    const problem = await core.verifyTree(nextDir, staged.list, { linkedFrom: appRoot });
    if (problem) throw new UpdateError('hash', `The staged update failed its check: ${problem}.`);
    const ready = {
        schema: 1, version: latest.version, tag: latest.tag, platform, from: current,
        files: asset.files, mode: staged.mode, bytes: staged.bytes, stagedAt: new Date().toISOString(),
    };
    writeFileSync(join(upd, 'ready.json'), JSON.stringify(ready, null, 2));
    return ready;
}

function defaultFreeBytes(dir) {
    try { const s = statfsSync(dir); return s.bavail * s.bsize; } catch { return Infinity; }
}

function needSpace(freeBytes, dir, bytes) {
    // Twice what it will write: the swap itself writes nothing, but a disk this
    // close to full will fail the app's own database next.
    if (freeBytes(dir) < bytes * 2) throw new UpdateError('space', `The update needs about ${Math.ceil(bytes * 2 / 1e6)} MB free on this disk.`);
}

/** The delta path: the zip's table of contents, the file list, then only the
 *  files that changed. */
async function stageByRanges({ core, asset, appRoot, nextDir, fetchImpl, signal, onProgress, freeBytes, version }) {
    // Every byte this path takes off the network, for the "downloaded N MB" line.
    let fetched = 0;
    const read = async (start, end) => {
        const r = await rangeRead(fetchImpl, asset.url, start, end, signal);
        fetched += r.buf.length;
        return r;
    };
    const head = await read(0, 0);
    if (head.total !== asset.size) throw new UpdateError('hash', 'The package on GitHub is not the size its manifest says.');
    const tailStart = Math.max(0, asset.size - core.TAIL_BYTES);
    const { buf: tail } = await read(tailStart, asset.size - 1);
    let entries, top;
    try {
        const end = core.readEndRecord(tail, asset.size);
        const cd = end.offset >= tailStart
            ? tail.subarray(end.offset - tailStart, end.offset - tailStart + end.size)
            : (await read(end.offset, end.offset + end.size - 1)).buf;
        entries = core.readCentralDirectory(cd, end.offset);
        top = core.topFolder(entries);
    } catch (e) {
        if (e instanceof UpdateError) throw e;
        throw new UpdateError('hash', e.message);
    }
    const byPath = new Map(entries.filter((e) => !e.name.endsWith('/')).map((e) => [e.name.slice(top.length), e]));
    const listEntry = byPath.get(asset.files.path);
    if (!listEntry) throw new UpdateError('hash', 'The package has no file list.');
    const listBytes = core.entryBytes(listEntry, (await read(listEntry.start, listEntry.end - 1)).buf);
    if (core.sha256(listBytes) !== asset.files.sha256) throw new UpdateError('hash', 'The package\'s file list does not match the release manifest.');
    let list;
    try { list = core.parseFileList(listBytes.toString('utf8'), { version }); } catch (e) { throw new UpdateError('hash', e.message); }
    put(nextDir, asset.files.path, listBytes, false);

    let installed = null;
    try { installed = core.parseFileList(readFileSync(join(appRoot, 'files.json'), 'utf8')); } catch { /* fetch everything */ }
    const plan = core.planFiles(list, installed);

    // Reuse: hash the running install's copy first. On a hard disk with a cold
    // cache this is the slow step (measured: ~40 s for 6,124 files, nearly all
    // of it seeking), so it reports progress of its own.
    // Eight files at a time: on a fresh install every first read waits for the
    // antivirus as well as the disk (measured: ~28 files a second one by one).
    // Progress in BYTES checked, not files: one large file (the runtime is
    // ~80 MB) otherwise holds a file count still long enough to look stuck.
    const toFetch = [...plan.fetch];
    const reuseBytes = plan.reuse.reduce((n, f) => n + f.size, 0);
    let checked = 0, next = 0, since = 0;
    onProgress({ step: 'checking', received: 0, total: reuseBytes, mode: 'delta' });
    const worker = async () => {
        while (next < plan.reuse.length) {
            if (signal.aborted) throw signal.reason;
            const f = plan.reuse[next++];
            const local = join(appRoot, ...f.path.split('/'));
            const ok = existsSync(local) && statSync(local).size === f.size && await core.sha256File(local) === f.sha256;
            if (ok) reuse(appRoot, nextDir, f.path); else toFetch.push(f);
            checked += f.size;
            if (++since >= 50) { since = 0; onProgress({ step: 'checking', received: checked, total: reuseBytes, mode: 'delta' }); }
        }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
    // Resume: a file already staged with the right hash stays.
    const todo = [];
    for (const f of toFetch) {
        const p = join(nextDir, ...f.path.split('/'));
        if (existsSync(p) && statSync(p).size === f.size && await core.sha256File(p) === f.sha256) continue;
        const entry = byPath.get(f.path);
        if (!entry || entry.usize !== f.size) throw new UpdateError('hash', `The package and its file list disagree about ${f.path}.`);
        todo.push({ ...entry, file: f });
    }
    const groups = core.coalesce(todo);
    const total = groups.reduce((n, g) => n + (g.end - g.start), 0);
    needSpace(freeBytes, appRoot, todo.reduce((n, e) => n + e.usize, 0));
    let received = 0;
    onProgress({ step: 'downloading', received, total, mode: 'delta' });
    for (const g of groups) {
        const { buf } = await read(g.start, g.end - 1);
        for (const e of g.entries) {
            let bytes;
            try {
                bytes = core.entryBytes(e, buf.subarray(e.start - g.start, e.end - g.start));
            } catch {
                throw new UpdateError('hash', `${e.file.path} is damaged in the package.`);
            }
            if (core.sha256(bytes) !== e.file.sha256) throw new UpdateError('hash', `${e.file.path} does not match the release.`);
            put(nextDir, e.file.path, bytes, e.file.exec);
        }
        received += g.end - g.start;
        onProgress({ step: 'downloading', received, total, mode: 'delta' });
    }
    return { list, mode: 'delta', bytes: fetched };
}

/** The fallback: the whole zip, appended to a `.part` file so a cut resumes,
 *  checked against the manifest's hash, then unpacked into the staging area. */
async function stageFromZip({ core, asset, appRoot, nextDir, upd, fetchImpl, signal, onProgress, freeBytes, version }) {
    const dlDir = join(upd, 'download');
    mkdirSync(dlDir, { recursive: true });
    const part = join(dlDir, `${asset.name}.part`);
    let have = existsSync(part) ? statSync(part).size : 0;
    if (have > asset.size) { rmSync(part, { force: true }); have = 0; }
    needSpace(freeBytes, appRoot, asset.size * 4);
    onProgress({ step: 'downloading', received: have, total: asset.size, mode: 'full' });
    if (have < asset.size) {
        const res = await fetchImpl(asset.url, {
            headers: { 'User-Agent': `Terramentor/${appVersion().version}`, ...(have ? { Range: `bytes=${have}-` } : {}) },
            redirect: 'follow',
            signal,
        });
        if (!res.ok) throw new UpdateError('network', `GitHub answered ${res.status} for the package.`);
        if (have && res.status !== 206) have = 0;      // the server restarted it from the top
        const out = createWriteStream(part, { flags: have ? 'a' : 'w' });
        let idle;
        const ctrlIdle = new AbortController();
        const arm = () => { clearTimeout(idle); idle = setTimeout(() => ctrlIdle.abort(), 60_000); };
        try {
            arm();
            for await (const chunk of res.body) {
                if (ctrlIdle.signal.aborted) throw new UpdateError('network', 'The download stopped responding.');
                arm();
                if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
                have += chunk.length;
                onProgress({ step: 'downloading', received: have, total: asset.size, mode: 'full' });
            }
        } catch (e) {
            // What arrived stays in the .part file; the next try resumes there.
            if (e instanceof UpdateError || signal.aborted) throw e;
            throw new UpdateError('network', 'The download was cut off before it finished.');
        } finally {
            clearTimeout(idle);
            await new Promise((r) => out.end(r));
        }
    }
    if (statSync(part).size !== asset.size) throw new UpdateError('network', 'The download ended before the whole package arrived.');
    if (await core.sha256File(part) !== asset.sha256) {
        rmSync(part, { force: true });
        throw new UpdateError('hash', 'The downloaded package does not match the release manifest, so it was deleted.');
    }

    // Unpack from the local file with the same reader the delta path uses.
    const fd = openSync(part, 'r');
    try {
        const read = (start, len) => { const b = Buffer.alloc(len); readSync(fd, b, 0, len, start); return b; };
        const tailStart = Math.max(0, asset.size - core.TAIL_BYTES);
        const end = core.readEndRecord(read(tailStart, asset.size - tailStart), asset.size);
        const entries = core.readCentralDirectory(read(end.offset, end.size), end.offset);
        const top = core.topFolder(entries);
        const files = entries.filter((e) => !e.name.endsWith('/'));
        const listEntry = files.find((e) => e.name.slice(top.length) === asset.files.path);
        if (!listEntry) throw new UpdateError('hash', 'The package has no file list.');
        const listBytes = core.entryBytes(listEntry, read(listEntry.start, listEntry.end - listEntry.start));
        if (core.sha256(listBytes) !== asset.files.sha256) throw new UpdateError('hash', 'The package\'s file list does not match the release manifest.');
        const list = core.parseFileList(listBytes.toString('utf8'), { version });
        const want = new Map(list.files.map((f) => [f.path, f]));
        for (const e of files) {
            const rel = core.safeRelPath(e.name.slice(top.length));
            if (!rel) throw new UpdateError('hash', `The package names an unsafe path: ${e.name}`);
            const f = want.get(rel);
            if (!f && rel !== asset.files.path) throw new UpdateError('hash', `${rel} is in the package but not in its file list.`);
            put(nextDir, rel, core.entryBytes(e, read(e.start, e.end - e.start)), f?.exec);
        }
        return { list, mode: 'full', bytes: asset.size };
    } finally {
        closeSync(fd);
        // Unpacked or not, the zip is not kept: it is the size of the app.
        rmSync(dlDir, { recursive: true, force: true });
    }
}

/**
 * Start a download in the background if none is running. Returns at once; the
 * panel reads progress from `installState`. `latest` comes from the stored
 * update check, never from the request.
 */
export function startDownload({ latest, appRoot = APP_ROOT, fetchImpl, log = console } = {}) {
    if (job?.phase === 'downloading') return false;
    const controller = new AbortController();
    job = { version: latest?.version || null, phase: 'downloading', received: 0, total: 0, mode: null, error: null, controller };
    const mine = job;
    stageUpdate({
        latest, appRoot, fetchImpl, signal: controller.signal,
        onProgress: ({ step, received, total, mode }) => { Object.assign(mine, { step, received, total, mode }); },
    }).then((ready) => {
        mine.phase = 'ready';
        log.log?.(`[update] ${ready.version} is ready (${ready.mode}, ${(ready.bytes / 1e6).toFixed(1)} MB downloaded)`);
    }, (e) => {
        // Stopped by the person: back to "available", and what arrived stays
        // (staged files, a .part) so the next press continues from there.
        if (controller.signal.aborted) {
            if (job === mine) job = null;
            log.log?.(`[update] download of ${mine.version} stopped`);
            return;
        }
        mine.phase = 'failed';
        mine.error = classify(e);
        log.warn?.(`[update] download of ${mine.version} failed: ${mine.error.kind}: ${e?.message || e}`);
    });
    return true;
}

/** "Stop download". Nothing staged so far is thrown away. */
export function cancelDownload() {
    if (job?.phase !== 'downloading') return false;
    job.controller.abort();
    return true;
}

/** "Restart to update": hand over to the launcher, which starts the updater and
 *  then stops this process. Refused unless a newer version is staged. */
export function requestInstall({ appRoot = APP_ROOT, current = appVersion().version } = {}) {
    const state = installState({ appRoot, current });
    if (!state.supported) return { ok: false, status: 409, error: 'This copy of Terramentor cannot install updates itself.' };
    if (state.phase !== 'ready') return { ok: false, status: 409, error: 'No downloaded update is ready to install.' };
    const run = installer;
    // After the answer has gone out, so the page hears "restarting" before the
    // connection drops.
    setTimeout(() => run({ appRoot, version: state.version }), 250);
    return { ok: true, version: state.version };
}

/** For the gates: forget the in-memory job. */
export function resetForTests() { job = null; installer = null; }
