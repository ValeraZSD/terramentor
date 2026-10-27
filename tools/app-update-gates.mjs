#!/usr/bin/env node
// One-click desktop updates: the download, the checks and the swap, end to end.
//
//   node tools/app-update-gates.mjs
//
// No network and no real install. A stand-in GitHub on loopback serves a
// release's manifest.json and zip (with or without Range support, whole or cut
// short, honest or corrupted), and small fake app folders play two installed
// versions. Three halves:
//
//   1. desktop/updateCore.js — what it refuses (paths, manifests, file lists)
//      and the zip reader against a zip built the way build-desktop builds one.
//   2. server/appUpdate.js `stageUpdate` — the delta download takes ONLY the
//      changed files; no Range → the whole zip; a cut whole-zip download
//      resumes from its `.part`; a corrupted file, a corrupted zip, a manifest
//      for another version or pointing elsewhere: refused, nothing staged.
//   3. desktop/updater.js as a REAL process from a runner copy, the way the
//      launcher starts it: swap in and start (the portable `data/` folder and
//      the library pointer untouched); a version that dies on start is rolled
//      back and the old one started again; a tampered staging area is refused
//      before anything moves. Plus `undoSwap` from a journal alone, which is
//      what the launcher does after a swap was cut short.

import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import JSZip from 'jszip';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(join(tmpdir(), 'app-update-gates-'));
const PLATFORM = `${process.platform}-${process.arch}`;
const TAG = (v) => `v${v}`;

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
    ok ? pass++ : fail++;
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok || !detail ? '' : `  (${detail})`}`);
};
const throwsWith = async (fn, re) => {
    try { await fn(); return `did not throw`; } catch (e) { return re.test(`${e.kind || ''} ${e.message}`) ? true : `${e.kind || ''} ${e.message}`; }
};

// --- the stand-in GitHub --------------------------------------------------------------
const files = new Map();               // url path → Buffer
const served = { bytes: 0, requests: [] };
const behaviour = { ranges: true, cutAfter: null, stall: false };
const stalled = [];
const server = createServer((req, res) => {
    const body = files.get(decodeURIComponent(req.url));
    served.requests.push({ url: req.url, range: req.headers.range || null });
    if (!body) { res.statusCode = 404; return res.end(); }
    const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    if (m && behaviour.ranges) {
        const start = Number(m[1]), end = m[2] ? Number(m[2]) : body.length - 1;
        res.statusCode = 206;
        res.setHeader('Content-Range', `bytes ${start}-${end}/${body.length}`);
        const part = body.subarray(start, end + 1);
        served.bytes += part.length;
        return res.end(part);
    }
    res.statusCode = 200;
    res.setHeader('Content-Length', body.length);
    if (behaviour.stall) {
        // Headers and a first piece, then nothing more: a connection that hangs.
        res.write(body.subarray(0, 1000));
        stalled.push(res);
        return;
    }
    if (behaviour.cutAfter != null) {
        // Send part of it, then drop the connection: a download cut midway.
        const part = body.subarray(0, behaviour.cutAfter);
        served.bytes += part.length;
        res.write(part, () => res.destroy());
        return;
    }
    served.bytes += body.length;
    res.end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const REPO = `${origin}/ValeraZSD/terramentor`;
process.env.UPDATE_REPO_URL = REPO;     // read when server/version.js loads, below
const dl = (v, name) => `/ValeraZSD/terramentor/releases/download/${encodeURIComponent(TAG(v))}/${encodeURIComponent(name)}`;

const core = await import('../desktop/updateCore.js');
const appUpdate = await import('../server/appUpdate.js');

// --- fake app versions --------------------------------------------------------------------
// What a packaged copy holds that matters here: package.json (the version the
// updater compares), build.json (what marks a copy as packaged), files.json,
// the modules the updater runner copies, a pile of files that do NOT change
// between versions (the "node_modules"), and app.js — the stand-in for the real
// launcher, which answers /api/desktop/status like the real one.
const SERVE = `// Like the real public probe (server/desktop.js probeStatus), no version.
http.createServer((q, s) => { s.setHeader('content-type', 'application/json'); s.end(JSON.stringify({ app: 'terramentor', desktop: true, libraryId: 'gate-library' })); }).listen(Number(port), '127.0.0.1');
setTimeout(() => process.exit(0), 60000);`;
// A version that cannot start writes its reason where the updater looks (launcher.js
// \`fatal\` on trial) and stays alive, the way the tray did while it held an
// error box: the updater must end the trial on the file, not wait out its limit.
const FAILS = `writeFileSync(new URL('./.update/start-failed.txt', import.meta.url), 'The server failed to start.');
setInterval(() => {}, 1000);`;
const APP_JS = (dies) => `import http from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
const [port, pidFile] = process.argv.slice(2);
writeFileSync(pidFile, String(process.pid));
${dies ? FAILS : SERVE}
`;

const SHARED = Array.from({ length: 120 }, () => randomBytes(6144).toString('base64'));

function makeApp(dir, version, { dies = false, changed = 'one' } = {}) {
    rmSync(dir, { recursive: true, force: true });
    const put = (rel, text) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); };
    put('package.json', JSON.stringify({ name: 'terramentor', version, type: 'module' }));
    put('build.json', JSON.stringify({ version, commit: 'gate' }));
    put('app.js', APP_JS(dies));
    put('server/version.js', readFileSync(join(repoRoot, 'server/version.js')));
    put('desktop/updateCore.js', readFileSync(join(repoRoot, 'desktop/updateCore.js')));
    put('desktop/updater.js', readFileSync(join(repoRoot, 'desktop/updater.js')));
    put('dist/index.html', `<p>${version} ${changed}</p>`);
    put(`dist/assets/chunk-${version}.js`, `export const v = ${JSON.stringify(version)};`);
    // 120 files of 8 KB that every version shares: what a delta must not fetch.
    // Incompressible, so they weigh in the zip what they would in a real one.
    SHARED.forEach((text, i) => put(`node_modules/pkg${i}/index.js`, text));
    makeAppList(dir, version);
}

/** files.json for a folder, by build-desktop's rule (every file but itself). */
function makeAppList(dir, version) {
    const list = [];
    const walk = (d) => {
        for (const f of readdirSync(d).sort()) {
            const p = join(d, f);
            if (statSync(p).isDirectory()) { walk(p); continue; }
            const rel = relative(dir, p).split(sep).join('/');
            if (rel === 'files.json') continue;
            list.push({ path: rel, size: statSync(p).size, sha256: createHash('sha256').update(readFileSync(p)).digest('hex') });
        }
    };
    walk(dir);
    writeFileSync(join(dir, 'files.json'), JSON.stringify({ schema: 1, version, platform: PLATFORM, files: list }));
}

/** Zip a folder the way tools/build-desktop.mjs does (streamed, data
 *  descriptors, DEFLATE 6, one top folder). */
async function zipApp(dir, top) {
    const zip = new JSZip();
    const walk = (d) => {
        for (const f of readdirSync(d)) {
            const p = join(d, f);
            if (statSync(p).isDirectory()) { walk(p); continue; }
            zip.file(`${top}/${relative(dir, p).split(sep).join('/')}`, readFileSync(p));
        }
    };
    walk(dir);
    return zip.generateAsync({ type: 'nodebuffer', streamFiles: true, compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

const sha = (b) => createHash('sha256').update(b).digest('hex');

/** Publish `version` from `dir` on the stand-in: zip + manifest. */
async function publish(version, dir, { zipBytes } = {}) {
    const name = `Terramentor-${version}-${PLATFORM}.zip`;
    const zip = zipBytes || await zipApp(dir, `Terramentor-${version}-${PLATFORM}`);
    const list = readFileSync(join(dir, 'files.json'));
    const manifest = {
        schema: 1, app: 'Terramentor', channel: 'stable', version, tag: TAG(version),
        assets: { [PLATFORM]: { name, url: `${REPO}/releases/download/${TAG(version)}/${name}`, size: zip.length, sha256: sha(zip), files: { path: 'files.json', size: list.length, sha256: sha(list) } } },
    };
    files.set(dl(version, name), zip);
    files.set(dl(version, 'manifest.json'), Buffer.from(JSON.stringify(manifest)));
    return { zip, manifest, latest: { version, tag: TAG(version), manifestUrl: `${REPO}/releases/download/${TAG(version)}/manifest.json` } };
}

// =============================================================================================
console.log('\n1. updateCore: what it refuses');
check('safeRelPath keeps a plain path', core.safeRelPath('dist/a.js') === 'dist/a.js');
for (const bad of ['../x', 'a/../b', '/etc/x', 'C:/x', 'a\\b', '', 'a//b', './a']) check(`safeRelPath refuses ${JSON.stringify(bad)}`, core.safeRelPath(bad) === null);
const fl = (files) => JSON.stringify({ schema: 1, version: '1.0.0', files });
const h = 'a'.repeat(64);
check('file list: a path out of the folder is refused', await throwsWith(() => core.parseFileList(fl([{ path: '../evil', size: 1, sha256: h }])), /unsafely/) === true);
check('file list: reaching into data/ is refused', await throwsWith(() => core.parseFileList(fl([{ path: 'data/terramentor.db', size: 1, sha256: h }])), /never touches/) === true);
check('file list: the library pointer is refused', await throwsWith(() => core.parseFileList(fl([{ path: 'library-location.txt', size: 1, sha256: h }])), /never touches/) === true);
check('file list: a duplicate (case-folded) is refused', await throwsWith(() => core.parseFileList(fl([{ path: 'A.js', size: 1, sha256: h }, { path: 'a.js', size: 1, sha256: h }])), /twice/) === true);
check('file list: another version\'s list is refused', await throwsWith(() => core.parseFileList(fl([]), { version: '2.0.0' }), /not 2\.0\.0/) === true);

const prefix = `${REPO}/releases/download/`;
const pkg = `Terramentor-1.4.1-${PLATFORM}.zip`;
const goodManifest = {
    schema: 1, app: 'Terramentor', version: '1.4.1', tag: 'v1.4.1',
    assets: { [PLATFORM]: { name: pkg, url: `${prefix}v1.4.1/${pkg}`, size: 10, sha256: h, files: { path: 'files.json', size: 5, sha256: h } } },
};
const am = (patch, want = {}) => () => core.assertManifest({ ...goodManifest, ...patch }, { version: '1.4.1', tag: 'v1.4.1', platform: PLATFORM, downloadPrefix: prefix, ...want });
check('manifest: the offered version passes', core.assertManifest(goodManifest, { version: '1.4.1', tag: 'v1.4.1', platform: PLATFORM, downloadPrefix: prefix }).size === 10);
check('manifest: another version is refused', await throwsWith(am({ version: '1.4.2' }), /offered 1\.4\.1/) === true);
check('manifest: a package outside this repository is refused', await throwsWith(am({ assets: { [PLATFORM]: { ...goodManifest.assets[PLATFORM], url: 'https://evil.example/T.zip' } } }), /outside/) === true);
check('manifest: another tag\'s folder is refused', await throwsWith(am({ assets: { [PLATFORM]: { ...goodManifest.assets[PLATFORM], url: `${prefix}v9.9.9/T.zip` } } }), /outside/) === true);
// A URL is judged as it will be fetched: normalised, then inside this release's
// own folder as one plain file name. Each of these starts with the right prefix.
const leaving = [
    `${prefix}v1.4.1/../../../../other/repo/releases/download/v1.4.1/T.zip`,
    `${prefix}v1.4.1/./T.zip`,
    `${prefix}v1.4.1/%2e%2e/%2e%2e/x/T.zip`,
    `${prefix}v1.4.1/%2E%2E/T.zip`,
    `${prefix}v1.4.1/..%2f..%2fx%2fT.zip`,
    `${prefix}v1.4.1/..%5c..%5cT.zip`,
    `${prefix}v1.4.1/..\\..\\x\\T.zip`,
    `${prefix}v1.4.1/sub/T.zip`,
    `${prefix}v1.4.1/T.zip?x=1`,
    `${prefix}v1.4.1/T.zip#x`,
    `${prefix}v1.4.1/`,
    prefix.replace('://', '://user@') + 'v1.4.1/T.zip',
];
for (const url of leaving) {
    check(`manifest: a package URL that leaves the release's folder is refused: ${url.slice(prefix.length)}`,
        await throwsWith(am({ assets: { [PLATFORM]: { ...goodManifest.assets[PLATFORM], url } } }), /outside/) === true);
}
// The server keeps its own copy of the rule (the Docker image ships no desktop/):
// both copies give the same answer on every case.
const { releaseAssetUrl: serverRule } = await import('../server/version.js');
const ruleCases = [...leaving, `${prefix}v1.4.1/T.zip`, `${prefix}v1.4.1/manifest.json`, `${prefix}v9.9.9/T.zip`, 'https://evil.example/T.zip', 'not a url', ''];
const disagree = ruleCases.filter((u) => (core.releaseAssetUrl?.(u, { downloadPrefix: prefix, tag: 'v1.4.1' }) ?? 'missing') !== (serverRule?.(u, { downloadPrefix: prefix, tag: 'v1.4.1' }) ?? 'missing'));
check('the server and the updater judge a release URL alike', typeof core.releaseAssetUrl === 'function' && typeof serverRule === 'function' && disagree.length === 0, disagree.join(' | '));
check('…and both accept this release\'s own files', !!core.releaseAssetUrl?.(`${prefix}v1.4.1/T.zip`, { downloadPrefix: prefix, tag: 'v1.4.1' })
    && !!serverRule?.(`${prefix}v1.4.1/manifest.json`, { downloadPrefix: prefix, tag: 'v1.4.1' }));
check('manifest: no checksum is refused', await throwsWith(am({ assets: { [PLATFORM]: { ...goodManifest.assets[PLATFORM], sha256: 'nope' } } }), /checksum/) === true);
check('manifest: another platform only is refused', await throwsWith(am({ assets: { 'plan9-mips': goodManifest.assets[PLATFORM] } }), /no package/) === true);
// The package is the one file release.mjs names for this version and platform,
// and the URL fetches that file: a name or a URL for any other file of the same
// release (another platform's zip, the manifest, SHA256SUMS) is refused.
const withAsset = (patch) => am({ assets: { [PLATFORM]: { ...goodManifest.assets[PLATFORM], ...patch } } });
for (const [why, patch] of [
    ['another platform\'s package', { name: 'Terramentor-1.4.1-plan9-mips.zip', url: `${prefix}v1.4.1/Terramentor-1.4.1-plan9-mips.zip` }],
    ['another version\'s package', { name: `Terramentor-1.4.0-${PLATFORM}.zip`, url: `${prefix}v1.4.1/Terramentor-1.4.0-${PLATFORM}.zip` }],
    ['a name with a path in it', { name: `../${pkg}` }],
    ['no name', { name: undefined }],
    ['a URL to another file than the one named', { url: `${prefix}v1.4.1/SHA256SUMS` }],
]) check(`manifest: ${why} is refused`, await throwsWith(withAsset(patch), /this version's package/) === true);
const asked = (url, name) => [core.releaseAssetUrl(url, { downloadPrefix: prefix, tag: 'v1.4.1', name }), serverRule(url, { downloadPrefix: prefix, tag: 'v1.4.1', name })];
check('both rules hold a URL to the file name asked for', JSON.stringify([
    asked(`${prefix}v1.4.1/manifest.json`, 'manifest.json'), asked(`${prefix}v1.4.1/SHA256SUMS`, 'manifest.json'), asked(`${prefix}v1.4.1/${pkg}`, 'manifest.json'),
]) === JSON.stringify([[`${prefix}v1.4.1/manifest.json`, `${prefix}v1.4.1/manifest.json`], [null, null], [null, null]]));

// A zip entry inflates to the size its directory claims and no further: a few
// kilobytes that would inflate to gigabytes are refused before they are held.
{
    const lfh = Buffer.alloc(30); lfh.writeUInt32LE(0x04034b50, 0);
    const big = deflateRawSync(Buffer.alloc(4 * 1024 * 1024));
    const entry = (usize) => ({ name: 'x', method: 8, csize: big.length, usize });
    check('zip reader refuses an entry that inflates past its stated size', await throwsWith(() => core.entryBytes(entry(1000), Buffer.concat([lfh, big])), /./) === true);
    check('zip reader refuses an entry that inflates short of its stated size', await throwsWith(() => core.entryBytes(entry(5 * 1024 * 1024), Buffer.concat([lfh, big])), /./) === true);
    check('…and returns one that inflates to exactly its size', core.entryBytes(entry(4 * 1024 * 1024), Buffer.concat([lfh, big])).length === 4 * 1024 * 1024);
}

const groups = core.coalesce([{ start: 0, end: 10 }, { start: 20, end: 30 }, { start: 10_000_000, end: 10_000_010 }], { gap: 100 });
check('coalesce merges near ranges and keeps a far one apart', groups.length === 2 && groups[0].end === 30 && groups[0].entries.length === 2);
check('coalesce caps a request', core.coalesce([{ start: 0, end: 10 }, { start: 11, end: 30 }], { gap: 100, max: 20 }).length === 2);

// =============================================================================================
console.log('\n2. server/appUpdate.js: download and stage');
const appA = join(scratch, 'installed');
const srcB = join(scratch, 'src-1.4.1');
const srcC = join(scratch, 'src-1.4.2');
makeApp(appA, '1.4.0');
makeApp(srcB, '1.4.1', { changed: 'two' });
makeApp(srcC, '1.4.2', { dies: true });
const B = await publish('1.4.1', srcB);

// The zip reader against a JSZip archive (data descriptors, one top folder).
{
    const end = core.readEndRecord(B.zip.subarray(Math.max(0, B.zip.length - core.TAIL_BYTES)), B.zip.length);
    const entries = core.readCentralDirectory(B.zip.subarray(end.offset, end.offset + end.size), end.offset);
    const top = core.topFolder(entries);
    const e = entries.find((x) => x.name === `${top}package.json`);
    const fileEntries = entries.filter((x) => !x.name.endsWith('/'));
    check('zip reader finds every file under one top folder', top === `Terramentor-1.4.1-${PLATFORM}/` && fileEntries.length === JSON.parse(readFileSync(join(srcB, 'files.json'))).files.length + 1, `${fileEntries.length}`);
    check('zip reader returns a file\'s exact bytes', core.entryBytes(e, B.zip.subarray(e.start, e.end)).equals(readFileSync(join(srcB, 'package.json'))));
}

// The app's own default is netSafety's safeFetch, which refuses loopback (proved
// below); the stand-in GitHub lives on loopback, so the gate brings plain fetch.
const loopback = (url, init) => fetch(url, init);
const stage = (opts) => appUpdate.stageUpdate({ appRoot: appA, current: '1.4.0', platform: PLATFORM, fetchImpl: loopback, ...opts });
check('by default every download request goes through the outbound guard (it refuses this loopback stand-in)',
    await throwsWith(() => appUpdate.stageUpdate({ appRoot: appA, current: '1.4.0', platform: PLATFORM, latest: { version: '1.4.1', tag: 'v1.4.1', manifestUrl: `${REPO}/releases/download/v1.4.1/manifest.json` } }), /private or loopback/) === true);
const nextDir = join(appA, '.update', 'next');

served.bytes = 0;
const ready = await stage({ latest: B.latest });
const nodeModulesBytes = 120 * 8200;
check('delta: staged and checked', ready.mode === 'delta' && existsSync(join(appA, '.update', 'ready.json')));
check(`delta: downloaded ${served.bytes} bytes of a ${B.zip.length}-byte zip (the shared files were not fetched)`, served.bytes < B.zip.length / 3 && served.bytes < nodeModulesBytes / 4, `${served.bytes}`);
check('delta: the staged tree matches the release, file for file', await core.verifyTree(nextDir, core.parseFileList(readFileSync(join(srcB, 'files.json'), 'utf8'))) === null);
check('delta: the installed app was not touched', JSON.parse(readFileSync(join(appA, 'package.json'))).version === '1.4.0');
check('installState reports it ready', appUpdate.installState({ appRoot: appA, current: '1.4.0' }).phase === 'ready');

// Overtaken: a release newer than the staged one came out after the download
// (22 Oct 2026: 1.3.0-nightly.20261022.1 staged at 06:49, .2 out at 10:31,
// and Restart at 11:59 still installed .1). The staged copy is no longer
// "ready", so Restart cannot install it, and the panel offers the newer one.
{
    const newer = { version: '1.4.2', tag: 'v1.4.2', manifestUrl: `${REPO}/releases/download/v1.4.2/manifest.json` };
    const st = appUpdate.installState({ appRoot: appA, current: '1.4.0', latest: newer });
    check('a staged version a newer release overtook is not ready, and is named', [st.phase, st.overtaken].join() === 'idle,1.4.1', `${st.phase},${st.overtaken}`);
    check('…the same version as the newest is still ready', appUpdate.installState({ appRoot: appA, current: '1.4.0', latest: { version: '1.4.1' } }).phase === 'ready');
    // A nightly published before its manifest is attached cannot be staged;
    // it must not strand the good copy already on disk.
    check('…a newer release with nothing to stage does not overtake it', appUpdate.installState({ appRoot: appA, current: '1.4.0', latest: { version: '1.4.2' } }).phase === 'ready');
    // The newer one's download failed (GitHub down, a manifest 404): the
    // staged copy is still the one Restart can install.
    const asked = [];
    appUpdate.startDownload({ latest: newer, appRoot: appA, fetchImpl: async (url) => { asked.push(String(url)); throw new TypeError('fetch failed'); }, log: {} });
    for (let i = 0; i < 500 && appUpdate.installState({ appRoot: appA, current: '1.4.0' }).phase === 'downloading'; i++) await new Promise((r) => setTimeout(r, 10));
    const afterFail = appUpdate.installState({ appRoot: appA, current: '1.4.0', latest: newer });
    check('…nor does one whose download just failed (at its manifest)', [afterFail.phase, afterFail.overtaken].join() === 'ready,' && asked.join() === newer.manifestUrl, `${afterFail.phase},${afterFail.overtaken} asked ${asked.join()}`);
    check('…and the staged copy survived the failed attempt', existsSync(join(appA, '.update', 'ready.json')));

    // Restart pressed in two tabs at once: one updater, both told "restarting".
    appUpdate.resetForTests();
    let runs = 0;
    appUpdate.setUpdateInstaller(() => { runs++; });
    const press = () => appUpdate.requestInstall({ appRoot: appA, current: '1.4.0', deployment: 'desktop' });
    const a = press();
    const b = press();
    await new Promise((r) => setTimeout(r, 400));
    check('two Restart presses at once start the updater once, and both hear "restarting"', [a.ok, b.ok, runs].join() === 'true,true,1', `${a.ok},${b.ok},${runs} ${JSON.stringify(a)}`);
    appUpdate.resetForTests();
}

// What changed travels with the staged copy, so the version it installs can
// say so after the restart without asking GitHub (installState.notes).
{
    rmSync(join(appA, '.update'), { recursive: true, force: true });
    const notes = { releases: [{ version: '1.4.1', title: null, items: ['A change'], more: 0, libraries: 0 }, { version: '1.3.9', items: ['Old'] }], omitted: 0 };
    await stage({ latest: { ...B.latest, notes } });
    const kept = JSON.parse(readFileSync(join(appA, '.update', 'notes.json'), 'utf8'));
    check('staging keeps the notes of the versions it brings, none older', kept.to === '1.4.1' && kept.from === '1.4.0' && kept.releases.map((n) => n.version).join() === '1.4.1', JSON.stringify(kept));
    check('…and the version they lead to reads them as its own', appUpdate.installState({ appRoot: appA, current: '1.4.1' }).notes?.releases?.[0]?.items?.[0] === 'A change');
    check('…which the version before it does not', appUpdate.installState({ appRoot: appA, current: '1.4.0' }).notes === null);
}

// A damaged installed file (same size, other bytes) is fetched, not carried
// forward: the reuse step hashes the running copy before linking it.
{
    rmSync(join(appA, '.update'), { recursive: true, force: true });
    const victim = join(appA, 'node_modules', 'pkg7', 'index.js');
    const good = readFileSync(victim);
    const bad = Buffer.from(good);
    bad[10] ^= 0x01;
    writeFileSync(victim, bad);
    served.requests.length = 0;
    await stage({ latest: B.latest });
    check('a damaged installed file is downloaded again, not reused', readFileSync(join(nextDir, 'node_modules', 'pkg7', 'index.js')).equals(good));
    writeFileSync(victim, good);
}

// A second run for the same version keeps what is staged.
served.bytes = 0;
await stage({ latest: B.latest });
check(`delta resume: a second run fetched only the table of contents (${served.bytes} bytes)`, served.bytes <= core.TAIL_BYTES + 65536);

// A package that is a valid zip but whose file is not the release's: the zip
// and its size are what the manifest says, the file inflates cleanly, and only
// the per-file hash can tell. Then the same with its file list rewritten to
// match: only the manifest's hash of the list can tell.
{
    const tampered = join(scratch, 'tampered');
    cpSync(srcB, tampered, { recursive: true });
    const html = readFileSync(join(tampered, 'dist', 'index.html'), 'utf8');
    writeFileSync(join(tampered, 'dist', 'index.html'), html.replace('two', 'evi'));       // same length
    const top = `Terramentor-1.4.1-${PLATFORM}`;
    const pub = async (zip, listBytes) => {
        const m = JSON.parse(JSON.stringify(B.manifest));
        Object.assign(m.assets[PLATFORM], { size: zip.length, sha256: sha(zip) });
        if (listBytes) m.assets[PLATFORM].files = { path: 'files.json', size: listBytes.length, sha256: sha(listBytes) };
        files.set(dl('1.4.1', B.manifest.assets[PLATFORM].name), zip);
        files.set(dl('1.4.1', 'manifest.json'), Buffer.from(JSON.stringify(m)));
    };
    rmSync(join(appA, '.update'), { recursive: true, force: true });
    await pub(await zipApp(tampered, top));                       // files.json still the release's
    check('a file that inflates cleanly but is not the release\'s: refused by its hash', await throwsWith(() => stage({ latest: B.latest }), /^hash .*index\.html does not match the release/) === true);
    makeAppList(tampered, '1.4.1');                                // the list now agrees with the file…
    await pub(await zipApp(tampered, top), readFileSync(join(srcB, 'files.json')));   // …the manifest does not
    rmSync(join(appA, '.update'), { recursive: true, force: true });
    check('a file list rewritten to match: refused by the manifest\'s hash of it', await throwsWith(() => stage({ latest: B.latest }), /^hash .*file list does not match the release manifest/) === true);
    files.set(dl('1.4.1', B.manifest.assets[PLATFORM].name), B.zip);
    files.set(dl('1.4.1', 'manifest.json'), Buffer.from(JSON.stringify(B.manifest)));
    rmSync(join(appA, '.update'), { recursive: true, force: true });
}

// Corrupted: one changed file's bytes inside the zip altered, manifest unchanged.
{
    rmSync(join(appA, '.update'), { recursive: true, force: true });
    const bad = Buffer.from(B.zip);
    const end = core.readEndRecord(bad.subarray(bad.length - core.TAIL_BYTES > 0 ? bad.length - core.TAIL_BYTES : 0), bad.length);
    const e = core.readCentralDirectory(bad.subarray(end.offset, end.offset + end.size), end.offset).find((x) => x.name.endsWith('dist/index.html'));
    bad[e.end - 20] ^= 0xff;                         // inside its compressed data
    files.set(dl('1.4.1', B.manifest.assets[PLATFORM].name), bad);
    check('corrupted file in the zip: refused as a mismatch', await throwsWith(() => stage({ latest: B.latest }), /^hash /) === true);
    check('corrupted file in the zip: nothing marked ready', !existsSync(join(appA, '.update', 'ready.json')));
    // Without ranges the whole zip is downloaded, and its hash catches it.
    behaviour.ranges = false;
    check('corrupted whole zip: refused by the manifest hash', await throwsWith(() => stage({ latest: B.latest }), /hash .*does not match the release manifest/) === true);
    check('corrupted whole zip: the bad download is deleted', !existsSync(join(appA, '.update', 'download', `${B.manifest.assets[PLATFORM].name}.part`)));
    files.set(dl('1.4.1', B.manifest.assets[PLATFORM].name), B.zip);
}

// No Range support: the whole zip, then unpacked and checked.
rmSync(join(appA, '.update'), { recursive: true, force: true });
served.bytes = 0;
const full = await stage({ latest: B.latest });
check('no Range support: falls back to the whole zip, staged and checked', full.mode === 'full' && served.bytes >= B.zip.length);
check('no Range support: the zip is deleted once unpacked', !existsSync(join(appA, '.update', 'download')));

// Cut midway, then resumed from the .part file.
rmSync(join(appA, '.update'), { recursive: true, force: true });
behaviour.cutAfter = Math.floor(B.zip.length / 2);
check('cut midway: reported as a network failure', await throwsWith(() => stage({ latest: B.latest }), /^network /) === true);
const partFile = join(appA, '.update', 'download', `${B.manifest.assets[PLATFORM].name}.part`);
const kept = existsSync(partFile) ? statSync(partFile).size : 0;
check(`cut midway: the first ${kept} bytes are kept`, kept > 0 && kept <= behaviour.cutAfter);
behaviour.cutAfter = null;
behaviour.ranges = true;           // the resume itself is a Range request
served.requests.length = 0;
// A server that answers ranges would take the delta path; force the whole-zip
// path the cut download was on by refusing ranges ONLY for the 1-byte probe.
const probeRefusing = (url, init) => (init?.headers?.Range === 'bytes=0-0'
    ? Promise.resolve(new Response('', { status: 200 })) : fetch(url, init));
const resumed = await stage({ latest: B.latest, fetchImpl: probeRefusing });
const resumeReq = served.requests.find((r) => r.range && r.range !== 'bytes=0-0');
check('cut midway: the retry resumes where it stopped', resumed.mode === 'full' && resumeReq?.range === `bytes=${kept}-`, JSON.stringify(resumeReq));

// Large reads go in pieces, each its own request (a changed runtime is ~80 MB
// in one entry, and one request for it could not finish on a slow line).
rmSync(join(appA, '.update'), { recursive: true, force: true });
served.requests.length = 0;
const chunked = await stage({ latest: B.latest, chunkBytes: 16 * 1024 });
const rangeRequests = served.requests.filter((r) => r.range).length;
check(`a large read is split into pieces (${rangeRequests} range requests) and still staged and checked`, chunked.mode === 'delta' && rangeRequests > 8
    && await core.verifyTree(nextDir, core.parseFileList(readFileSync(join(srcB, 'files.json'), 'utf8'))) === null, `${rangeRequests}`);

// A connection that stops sending ends with a failure instead of hanging.
rmSync(join(appA, '.update'), { recursive: true, force: true });
behaviour.ranges = false;
behaviour.stall = true;
check('a stalled download ends as "stopped responding" instead of hanging', await throwsWith(() => stage({ latest: B.latest, idleMs: 400 }), /^network .*stopped responding/) === true);
behaviour.stall = false;
behaviour.ranges = true;
for (const r of stalled) r.destroy();

// Refusals before any download.
// 1.4.1's manifest in 1.4.9's folder: the URL is right, what it says is not.
files.set(dl('1.4.9', 'manifest.json'), files.get(dl('1.4.1', 'manifest.json')));
check('a manifest for another version is refused', await throwsWith(() => stage({ latest: { ...B.latest, version: '1.4.9', tag: 'v1.4.9', manifestUrl: `${REPO}/releases/download/v1.4.9/manifest.json` } }), /^origin /) === true);
files.delete(dl('1.4.9', 'manifest.json'));
check('a manifest URL in another release\'s folder is refused', await throwsWith(() => stage({ latest: { ...B.latest, version: '1.4.9', tag: 'v1.4.9', manifestUrl: B.latest.manifestUrl } }), /^manual /) === true);
served.requests.length = 0;
check('a "manifest" URL naming another file of the release is refused, nothing fetched',
    await throwsWith(() => stage({ latest: { ...B.latest, manifestUrl: `${REPO}/releases/download/v1.4.1/Terramentor-1.4.1-${PLATFORM}.zip` } }), /^manual /) === true
    && served.requests.length === 0);
check('a manifest URL outside this repository is refused',await throwsWith(() => stage({ latest: { ...B.latest, manifestUrl: 'https://evil.example/manifest.json' } }), /^manual /) === true);
// A manifest URL that starts right and normalises into another repository's
// release, where an honest-looking manifest and package wait: refused before
// anything is fetched.
{
    const elsewhere = '/other/repo/releases/download/v1.4.1/';
    const other = { ...B.manifest, assets: { [PLATFORM]: { ...B.manifest.assets[PLATFORM], url: `${REPO}/releases/download/v1.4.1/../../../../../other/repo/releases/download/v1.4.1/O.zip` } } };
    files.set(`${elsewhere}manifest.json`, Buffer.from(JSON.stringify(other)));
    files.set(`${elsewhere}O.zip`, B.zip);
    rmSync(join(appA, '.update'), { recursive: true, force: true });
    served.requests.length = 0;
    const got = await throwsWith(() => stage({ latest: { ...B.latest, manifestUrl: `${REPO}/releases/download/v1.4.1/../../../../../other/repo/releases/download/v1.4.1/manifest.json` } }), /^manual /);
    check('a manifest URL that normalises out of the release\'s folder is refused, nothing fetched', got === true && served.requests.length === 0,
        `${got}; fetched ${served.requests.map((r) => r.url).join(', ')}`);
    files.delete(`${elsewhere}manifest.json`);
    files.delete(`${elsewhere}O.zip`);
}
check('an older version is refused', await throwsWith(() => stage({ latest: B.latest, current: '1.5.0' }), /no newer version/) === true);
check('not enough disk space is refused before downloading', await throwsWith(() => stage({ latest: B.latest, freeBytes: () => 10, fetchImpl: probeRefusing }), /^space /) === true);

// "Stop download": back to available, not a failure, and nothing reported.
{
    rmSync(join(appA, '.update'), { recursive: true, force: true });
    // A server that never answers; like real fetch, an already-aborted signal rejects at once.
    const hanging = (url, init) => new Promise((_, reject) => {
        if (init.signal.aborted) return reject(init.signal.reason);
        init.signal.addEventListener('abort', () => reject(init.signal.reason));
    });
    appUpdate.startDownload({ latest: B.latest, appRoot: appA, fetchImpl: hanging, log: {} });
    const during = appUpdate.installState({ appRoot: appA, current: '1.4.0' }).phase;
    const stopped = appUpdate.cancelDownload();
    await new Promise((r) => setTimeout(r, 50));
    const after = appUpdate.installState({ appRoot: appA, current: '1.4.0' });
    check('stop download: a running download stops and the button is back to "available"', during === 'downloading' && stopped && after.phase === 'idle' && after.error === null, JSON.stringify({ during, stopped, phase: after.phase }));
}

check('a checkout cannot install', appUpdate.installSupport({ appRoot: repoRoot, deployment: 'desktop', hasInstaller: true }).reason === 'checkout');
check('docker cannot install', appUpdate.installSupport({ appRoot: appA, deployment: 'docker', hasInstaller: true }).reason === 'docker');
check('a copy not started by the launcher cannot install', appUpdate.installSupport({ appRoot: appA, deployment: 'desktop', hasInstaller: false }).reason === 'no-launcher');
check('a packaged copy with a file list can install', appUpdate.installSupport({ appRoot: appA, deployment: 'desktop', hasInstaller: true }).supported === true);

// =============================================================================================
console.log('\n3. desktop/updater.js: swap, start, roll back');
// The portable library and the pointer must survive every swap untouched.
mkdirSync(join(appA, 'data'), { recursive: true });
writeFileSync(join(appA, 'data', 'terramentor.db'), 'the library');
writeFileSync(join(appA, 'library-location.txt'), 'D:/elsewhere');

const port = 39000 + Math.floor(Math.random() * 900);
const pidFile = join(scratch, 'app.pid');
function runUpdater() {
    // The runner layout the launcher builds (desktop/launcher.js startUpdater).
    const runner = join(appA, '.update', 'runner');
    rmSync(runner, { recursive: true, force: true });
    mkdirSync(join(runner, 'desktop'), { recursive: true });
    mkdirSync(join(runner, 'server'), { recursive: true });
    cpSync(join(appA, 'desktop', 'updater.js'), join(runner, 'desktop', 'updater.js'));
    cpSync(join(appA, 'desktop', 'updateCore.js'), join(runner, 'desktop', 'updateCore.js'));
    cpSync(join(appA, 'server', 'version.js'), join(runner, 'server', 'version.js'));
    writeFileSync(join(runner, 'package.json'), '{"type":"module"}');
    const plan = {
        appRoot: appA, waitPids: [], ports: [port], libraryId: 'gate-library', timeoutMs: 15_000,
        relaunch: { target: process.execPath, args: [join(appA, 'app.js'), String(port), pidFile] },
        logFile: join(scratch, 'updater.log'),
    };
    writeFileSync(join(runner, 'plan.json'), JSON.stringify(plan));
    const r = spawnSync(process.execPath, [join(runner, 'desktop', 'updater.js'), join(runner, 'plan.json')], { cwd: runner, encoding: 'utf8', timeout: 60_000 });
    return { ...r, result: JSON.parse(readFileSync(join(appA, '.update', 'result.json'), 'utf8')) };
}
/** Stop the fake app the updater started. After a refused update the updater
 *  starts the old version without waiting for it, so wait for its pid first. */
const killApp = async () => {
    for (let i = 0; i < 50 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 100));
    try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* gone */ }
    rmSync(pidFile, { force: true });
};
const installedVersion = () => JSON.parse(readFileSync(join(appA, 'package.json'), 'utf8')).version;

// 3a. A good update (1.4.1 is staged from section 2).
await stage({ latest: B.latest });
let run = runUpdater();
check('swap: the updater installed 1.4.1 and it answered', run.result.ok === true && installedVersion() === '1.4.1', run.stdout + run.stderr);
check('swap: the old version is kept for rollback', JSON.parse(readFileSync(join(appA, '.update', 'previous', 'package.json'), 'utf8')).version === '1.4.0');
check('swap: the old file list goes with it, the new one takes its place', JSON.parse(readFileSync(join(appA, '.update', 'previous', 'files.json'), 'utf8')).version === '1.4.0'
    && JSON.parse(readFileSync(join(appA, 'files.json'), 'utf8')).version === '1.4.1');
check('swap: the portable library and the pointer were not moved', readFileSync(join(appA, 'data', 'terramentor.db'), 'utf8') === 'the library' && existsSync(join(appA, 'library-location.txt')));
check('swap: the staging area and the journal are cleaned up', !existsSync(join(appA, '.update', 'next')) && !existsSync(join(appA, '.update', 'swap.json')) && !existsSync(join(appA, '.update', 'ready.json')));
await killApp();

// 3b. 1.4.2 dies on start: rolled back to 1.4.1, which is started again.
const C = await publish('1.4.2', srcC);
await appUpdate.stageUpdate({ appRoot: appA, current: '1.4.1', platform: PLATFORM, latest: C.latest, fetchImpl: loopback });
run = runUpdater();
check('failed start: rolled back to 1.4.1', run.result.ok === false && run.result.step === 'start' && run.result.failed === '1.4.2' && installedVersion() === '1.4.1', JSON.stringify(run.result));
check('failed start: ended on the version\'s own report, which the note carries', /stopped while starting/.test(run.result.reason) && run.result.said === 'The server failed to start.', JSON.stringify(run.result));
check('failed start: 1.4.1 is running again', (run.stdout || '').includes('1.4.1 is running again'), run.stdout);
check('failed start: the library was not moved', readFileSync(join(appA, 'data', 'terramentor.db'), 'utf8') === 'the library');
check('failed start: the restored copy keeps its own file list, so it can still update itself', existsSync(join(appA, 'files.json'))
    && JSON.parse(readFileSync(join(appA, 'files.json'), 'utf8')).version === '1.4.1'
    && appUpdate.installSupport({ appRoot: appA, deployment: 'desktop', hasInstaller: true }).supported === true);
check('failed start: no update is offered as ready any more', !existsSync(join(appA, '.update', 'ready.json')));
await killApp();

// 3c. A staged file altered after the download: refused before anything moves.
await appUpdate.stageUpdate({ appRoot: appA, current: '1.4.1', platform: PLATFORM, latest: C.latest, fetchImpl: loopback });
writeFileSync(join(appA, '.update', 'next', 'dist', 'index.html'), 'tampered');
run = runUpdater();
check('tampered staging: refused at verify, nothing changed', run.result.ok === false && run.result.step === 'verify' && installedVersion() === '1.4.1', JSON.stringify(run.result));
check('tampered staging: the staging area is thrown away', !existsSync(join(appA, '.update', 'next')));
await killApp();

// 3d. A swap cut short (a kill between renames) is undone from its journal.
{
    const app = join(scratch, 'cut');
    makeApp(app, '2.0.0');
    const next = join(scratch, 'cut-next');
    makeApp(next, '2.0.1');
    const prev = join(scratch, 'cut-prev');
    mkdirSync(prev, { recursive: true });
    const journal = { moves: [] };
    // Two of the app's entries moved out, one new entry moved in, then "killed".
    for (const [from, to] of [[join(app, 'dist'), join(prev, 'dist')], [join(app, 'package.json'), join(prev, 'package.json')], [join(next, 'dist'), join(app, 'dist')]]) {
        journal.moves.push({ from, to });
        renameSync(from, to);
    }
    const jf = join(scratch, 'cut-swap.json');
    writeFileSync(jf, JSON.stringify(journal));
    await core.undoSwap({ journal: JSON.parse(readFileSync(jf, 'utf8')), journalFile: jf });
    check('interrupted swap: undone from the journal alone', JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')).version === '2.0.0'
        && readFileSync(join(app, 'dist', 'index.html'), 'utf8').includes('2.0.0') && existsSync(join(next, 'dist', 'index.html')) && !existsSync(jf));
}

// 3e. A rename that keeps failing undoes what the swap had done.
{
    const app = join(scratch, 'busy');
    makeApp(app, '3.0.0');
    const next = join(scratch, 'busy-next');
    makeApp(next, '3.0.1');
    // The fourth rename fails with an error no retry can help (EIO); the
    // retried kinds (EBUSY, EPERM, EACCES) are what renameWithRetry waits out.
    let calls = 0;
    const flaky = (a, b) => { if (++calls === 4) { const e = new Error('busy'); e.code = 'EIO'; throw e; } renameSync(a, b); };
    const names = core.appTopLevel(core.parseFileList(readFileSync(join(app, 'files.json'), 'utf8')));
    const result = await throwsWith(() => core.swapIn({ appRoot: app, nextDir: next, previousDir: join(scratch, 'busy-prev'), names, journalFile: join(scratch, 'busy.json'), rename: (a, b) => flaky(a, b) }), /busy/);
    const back = ['app.js', 'build.json', 'desktop', 'dist', 'node_modules', 'package.json', 'server'].every((n) => existsSync(join(app, n)));
    check('a locked file mid-swap: the swap is undone and the old version stands, whole', result === true && back
        && JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')).version === '3.0.0' && readdirSync(join(scratch, 'busy-prev')).length === 0);
}

// 3f. A staged version that is not newer than the installed one is refused
// by the updater itself, whatever the server staged.
{
    const older = join(appA, '.update', 'next');
    rmSync(join(appA, '.update'), { recursive: true, force: true });
    makeApp(older, '1.3.0');
    const list = readFileSync(join(older, 'files.json'));
    writeFileSync(join(appA, '.update', 'ready.json'), JSON.stringify({ schema: 1, version: '1.3.0', files: { path: 'files.json', size: list.length, sha256: sha(list) } }));
    const r = runUpdater();
    check('an older staged version: refused at verify, nothing changed', r.result.ok === false && r.result.step === 'verify' && /not newer/.test(r.result.reason) && installedVersion() === '1.4.1', JSON.stringify(r.result));
    await killApp();
}

// 3g. An installed file list the updater cannot read does not stop it half way
// (the app has already closed by then): it swaps by the new list, here into
// 1.4.2, which fails to start, and the rollback runs to the end.
{
    rmSync(join(appA, '.update'), { recursive: true, force: true });
    await appUpdate.stageUpdate({ appRoot: appA, current: '1.4.1', platform: PLATFORM, latest: C.latest, fetchImpl: loopback });
    const good = readFileSync(join(appA, 'files.json'));
    writeFileSync(join(appA, 'files.json'), '{ not json');
    const r = runUpdater();
    check('an unreadable installed file list: the update still runs to a result', r.result.step === 'start' && r.result.failed === '1.4.2' && installedVersion() === '1.4.1', JSON.stringify(r.result));
    writeFileSync(join(appA, 'files.json'), good);
    await killApp();
}

// 3h. "Updated" lasts until the next launch: a server that starts drops a
// result that worked if it was written before that process began, and keeps
// one that failed, which still asks for a press. Fixed times, no clock.
{
    const app = join(scratch, 'expire');
    const file = join(app, '.update', 'result.json');
    const startedAt = Date.parse('2026-10-26T12:00:00Z');
    const put = (r) => writeFileSync(file, JSON.stringify(r));
    const expire = () => appUpdate.expireResult({ appRoot: app, startedAt });
    mkdirSync(join(app, '.update'), { recursive: true });
    put({ ok: true, from: '1.4.0', to: '1.4.1', at: '2026-10-26T11:59:59Z' });
    expire();
    check('a later launch drops an update that worked', !existsSync(file));
    put({ ok: true, from: '1.4.0', to: '1.4.1', at: '2026-10-26T12:00:05Z' });
    expire();
    check('...but not one written after it began (a second launch while the new version started)', existsSync(file));
    put({ ok: true, from: '1.4.0', to: '1.4.1' });
    expire();
    check('...and a success with no time is an old one', !existsSync(file));
    put({ ok: false, step: 'start', failed: '1.4.2', to: '1.4.2', at: '2026-10-26T11:00:00Z' });
    expire();
    check('...and keeps one that failed', existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).ok === false);
    writeFileSync(file, '{ not json');
    let threw = false;
    try { expire(); } catch { threw = true; }
    const unreadableKept = existsSync(file);
    rmSync(file, { force: true });
    try { expire(); } catch { threw = true; }
    check('an unreadable result is left alone and an absent one is fine, never a throw', unreadableKept && !threw);
    const index = readFileSync(join(repoRoot, 'server', 'index.js'), 'utf8');
    check('the server calls it when it starts', /^[^/\n]*\bexpireResult\(\)/m.test(index));
    // An open page asks again only while the journal is there, so the result
    // goes first: written after the journal, it landed after the asking stopped.
    const updater = readFileSync(join(repoRoot, 'desktop', 'updater.js'), 'utf8');
    const good = updater.slice(updater.indexOf('if (up.ok) {'));
    check('the updater writes a success before it removes the journal', good.includes('finish(') && good.indexOf('finish(') < good.indexOf('rmSync(journalFile'));
}

server.close();
// Windows lets a just-killed process hold its folder for a moment.
try { rmSync(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); } catch (e) { console.log(`  (scratch not removed: ${e.code})`); }
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
