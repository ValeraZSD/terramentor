#!/usr/bin/env node
/**
 * Opening a course file from outside the app: a `.studyvault` double-clicked
 * in the file manager, dropped on the program or named on the command line.
 *
 * The path travels launcher → server, never into a URL: the launcher registers
 * it under the library's key and the window opens on a single-use token
 * (server/openedFiles.js says why). This suite holds each step to that:
 *
 *   - which argument is the file (desktop/lib.js `openRequest`), and on Windows
 *     that the tray program (desktop/wrappers/Launcher.cs `SplitOpenRequest`)
 *     reads the same arguments the same way;
 *   - the proof: right key, nonce, port and path, or refused;
 *   - which paths are refused before anything is read;
 *   - the waiting tokens: single use, a time limit, a cap, no replayed nonce;
 *   - the whole door on a scratch desktop server: registered, fetched once,
 *     refused to a device and to a request from elsewhere;
 *   - the page's side (src/utils/openedCourseLink.ts, courseBundle.ts): the
 *     token found in the address, and the course read out of the file for the
 *     preview, refused when damaged, encrypted, ambiguous or inflating past
 *     its ceiling.
 *
 *   node tools/open-file-gates.mjs
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, posix, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { request } from 'node:http';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

// The scratch library comes first: importing the server opens the database
// named here, never the learner's.
const scratch = mkdtempSync(join(tmpdir(), 'open-file-gates-'));
process.env.DATA_DIR = scratch;
process.env.DB_PATH = join(scratch, 'gate.db');
process.env.VAULT_ROOT = join(scratch, 'vault');
process.env.TERRAMENTOR_DESKTOP = '1';

const { openRequest, openFileUrl, registerOpenFile, OPEN_FILE_PARAM } = await import('../desktop/lib.js');
const { openFileProof, provesOpenFile, instanceProof, loadInstanceKey, newNonce } = await import('../server/instanceKey.js');
const { openRefusal, createOpenedFiles, OPENABLE, MAX_OPENED_BYTES, TOKEN_TTL_MS, MAX_WAITING } = await import('../server/openedFiles.js');

let pass = 0, fail = 0;
const check = (name, got, want) => {
    const good = JSON.stringify(got) === JSON.stringify(want);
    good ? pass++ : fail++;
    console.log(`${good ? '  ok  ' : ' FAIL '} ${name}${good ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};
const ok = (name, cond, detail = '') => check(name + (detail && !cond ? ` — ${detail}` : ''), !!cond, true);

// ---------------------------------------------------------------------------
console.log('\n--- which argument is the file ---');
// [arguments, the file, what the tray program passes on]. The registered
// Windows file type sends `--open "%1"`; the Linux menu entry's `%f` and a
// file dropped on the program send the bare path.
const WIN_FILE = 'C:\\Users\\a b\\Курс été.studyvault';
const ARGS = [
    [['--open', WIN_FILE], WIN_FILE, []],
    [[WIN_FILE], WIN_FILE, []],
    [['--autostart'], null, ['--autostart']],
    [['--data-dir', 'D:\\lib', WIN_FILE], WIN_FILE, ['--data-dir', 'D:\\lib']],
    [['--port', '3005', '--no-window'], null, ['--port', '3005', '--no-window']],
    [['--data-dir', 'D:\\x.studyvault'], null, ['--data-dir', 'D:\\x.studyvault']],
    [['C:\\a.studyvault', '--open', 'C:\\b.studyvault'], 'C:\\b.studyvault', []],
    [['C:\\a.studyvault', 'C:\\b.studyvault', '--no-window'], 'C:\\a.studyvault', ['--no-window']],
    [['--open', 'C:\\b.studyvault', '--open', 'C:\\c.studyvault'], 'C:\\b.studyvault', []],
    [['--open'], null, []],
    [['--open', '--no-window'], null, ['--no-window']],
    [['--open', '', WIN_FILE], WIN_FILE, []],
    [['', '--check'], null, ['', '--check']],
];
for (const [argv, want] of ARGS) check(`openRequest ${JSON.stringify(argv)}`, openRequest(argv), want);

// The window's address carries a token and the fragment name, nothing else.
{
    const token = 'a'.repeat(64);
    check('the window opens on the token, in the fragment', openFileUrl('http://127.0.0.1:3001/', token), `http://127.0.0.1:3001/#${OPEN_FILE_PARAM}=${token}`);
    const launcher = readFileSync(join(repoRoot, 'desktop', 'launcher.js'), 'utf8');
    const windowCalls = [...launcher.matchAll(/openWindow\(([^\n]*)\)/g)].map((m) => m[1]);
    ok('no window the launcher opens is handed the file itself', windowCalls.length > 0 && windowCalls.every((a) => !/\bopening\b/.test(a)), windowCalls.join(' | '));
}

// The tray program on Windows (desktop/wrappers/Launcher.cs) splits the same
// arguments before it starts the launcher script; the two must agree, or a
// double-click opens nothing. Compiled here the way the build compiles it.
if (process.platform === 'win32') {
    // The long form of the folder: .NET expands a short (8.3) name in a path, Node does not.
    mkdirSync(join(scratch, 'cwd'));
    const cwd = realpathSync.native(join(scratch, 'cwd'));
    const cases = [...ARGS.map(([argv]) => argv), ['relative.studyvault']];
    const input = join(scratch, 'split-in.json');
    const output = join(scratch, 'split-out.json');
    writeFileSync(input, JSON.stringify(cases), 'utf8');
    const ps = join(scratch, 'split.ps1');
    writeFileSync(ps, [
        '$ErrorActionPreference = "Stop"',
        'Add-Type -AssemblyName System.Web.Extensions',
        `$src = [IO.File]::ReadAllText('${join(repoRoot, 'desktop', 'wrappers', 'Launcher.cs').replace(/'/g, "''")}', [Text.Encoding]::UTF8)`,
        '$types = Add-Type -TypeDefinition $src -ReferencedAssemblies System.Windows.Forms.dll, System.Drawing.dll -PassThru',
        '$t = $types[0].Assembly.GetType("Launcher")',
        '$m = $t.GetMethod("SplitOpenRequest")',
        '$ser = New-Object System.Web.Script.Serialization.JavaScriptSerializer',
        `$cases = $ser.DeserializeObject([IO.File]::ReadAllText('${input.replace(/'/g, "''")}', [Text.Encoding]::UTF8))`,
        '$out = New-Object System.Collections.Generic.List[object]',
        'foreach ($c in $cases) {',
        '  $p = [object[]]@([string[]]@($c), $null)',
        '  $rest = $m.Invoke($null, $p)',
        '  $out.Add([object[]]@($p[1], [object[]]$rest))',
        '}',
        `[IO.File]::WriteAllText('${output.replace(/'/g, "''")}', $ser.Serialize($out), (New-Object Text.UTF8Encoding $false))`,
    ].join('\r\n'), 'utf8');
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps], { cwd, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
    let split = null;
    try { split = JSON.parse(readFileSync(output, 'utf8')); } catch { /* reported below */ }
    ok('Launcher.cs compiles and its SplitOpenRequest runs', Array.isArray(split) && split.length === cases.length, (r.stderr || r.stdout || '').trim().slice(0, 400));
    if (Array.isArray(split)) {
        cases.forEach((argv, i) => {
            const js = openRequest(argv);
            const want = js == null ? null : win32.resolve(cwd, js);
            check(`Launcher.cs reads ${JSON.stringify(argv)} as the launcher does`, split[i][0], want);
            if (i < ARGS.length) check('…and passes on the rest', split[i][1], ARGS[i][2]);
        });
        // What the tray program passes on is replayed on every later "Open":
        // only flags and the values of --data-dir/--port, never a file.
        const files = (rest) => (rest || []).filter((a, j) => a && !a.startsWith('--') && !['--data-dir', '--port'].includes(rest[j - 1]));
        const leaked = cases.map((argv, i) => [argv, files(split[i][1])]).filter(([, f]) => f.length);
        ok('no file argument is kept for a later "Open"', !leaked.length, JSON.stringify(leaked));
    }
} else {
    console.log('  (skipped: Launcher.cs is compiled and run on Windows only)');
}

// ---------------------------------------------------------------------------
console.log('\n--- the launcher\'s proof ---');
{
    const key = Buffer.alloc(32, 7);
    const other = Buffer.alloc(32, 8);
    const nonce = newNonce();
    const path = 'C:\\Courses\\Dutch.studyvault';
    const proof = openFileProof(key, nonce, 3001, path);
    ok('the right proof is accepted', provesOpenFile(proof, { key, nonce, port: 3001, path }));
    ok('another library\'s key is refused', !provesOpenFile(openFileProof(other, nonce, 3001, path), { key, nonce, port: 3001, path }));
    ok('a proof made for another nonce is refused', !provesOpenFile(proof, { key, nonce: newNonce(), port: 3001, path }));
    ok('…for another port', !provesOpenFile(proof, { key, nonce, port: 3002, path }));
    ok('…for another file', !provesOpenFile(proof, { key, nonce, port: 3001, path: 'C:\\Courses\\Other.studyvault' }));
    ok('…and the instance check\'s own proof never doubles as one', !provesOpenFile(
        instanceProof(key, nonce, 3001), { key, nonce, port: 3001, path }));
    ok('no key here: nothing is proved', !provesOpenFile(proof, { key: null, nonce, port: 3001, path }));
    ok('a malformed nonce is refused', !provesOpenFile(openFileProof(key, 'x', 3001, path), { key, nonce: 'x', port: 3001, path }));
    ok('a proof that is not a string is refused', !provesOpenFile(null, { key, nonce, port: 3001, path }) && !provesOpenFile(['a'], { key, nonce, port: 3001, path }));
    ok('a path that is not a string is refused', !provesOpenFile(proof, { key, nonce, port: 3001, path: { toString: () => path } }));
}

// ---------------------------------------------------------------------------
console.log('\n--- which paths are refused ---');
{
    const file = (size) => () => ({ isFile: () => true, size });
    const at = (p, { stat = file(1000), absolute = win32.isAbsolute } = {}) => openRefusal(p, { stat, absolute });
    check('a course file opens', at('C:\\Courses\\Dutch.studyvault'), null);
    check('the extension in capitals too', at('C:\\Courses\\DUTCH.STUDYVAULT'), null);
    check('a file on a share too (a double-click there is a person\'s choice)', at('\\\\nas\\courses\\Dutch.studyvault'), null);
    check('a POSIX path on Linux and macOS', openRefusal('/home/u/Dutch.studyvault', { stat: file(1000), absolute: posix.isAbsolute }), null);
    check('nothing', at(undefined), 'not a path');
    check('an empty string', at(''), 'not a path');
    check('a number', at(42), 'not a path');
    check('a NUL byte', at('C:\\a\0.studyvault'), 'not a path');
    check('a path longer than any file system names', at(`C:\\${'a'.repeat(5000)}.studyvault`), 'not a path');
    check('a relative path', at('Dutch.studyvault'), 'not an absolute path');
    check('a drive-relative path', at('C:Dutch.studyvault'), 'not an absolute path');
    check('the device namespace', at('\\\\.\\pipe\\x.studyvault'), 'not a file path');
    check('the raw namespace', at('\\\\?\\C:\\x.studyvault'), 'not a file path');
    check('the device namespace with forward slashes', at('//./COM1/x.studyvault'), 'not a file path');
    check('a program dressed as a course', at('C:\\Downloads\\Dutch.studyvault.exe'), 'not a .studyvault file');
    check('a zip', at('C:\\Downloads\\Dutch.zip'), 'not a .studyvault file');
    check('a folder named like a course is not one', at('C:\\Courses\\x.studyvault\\'), 'not a .studyvault file');
    check('a name that only starts like one', at('C:\\Courses\\.studyvault-notes.txt'), 'not a .studyvault file');
    check('a file that is not there', at('C:\\Courses\\Gone.studyvault', { stat: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); } }), 'not there');
    check('a folder', at('C:\\Courses\\Dir.studyvault', { stat: () => ({ isFile: () => false, size: 0 }) }), 'not a file');
    check('an empty file', at('C:\\Courses\\Empty.studyvault', { stat: file(0) }), 'empty');
    check('one byte over the import door\'s ceiling', at('C:\\Courses\\Huge.studyvault', { stat: file(MAX_OPENED_BYTES + 1) }), 'too large');
    check('exactly the ceiling', at('C:\\Courses\\Big.studyvault', { stat: file(MAX_OPENED_BYTES) }), null);
    ok('the ceiling is the import door\'s', readFileSync(join(repoRoot, 'server', 'routes', 'bundle.js'), 'utf8').includes('1024 * 1024 * 1024'));
    ok('the file type is .studyvault and only that', OPENABLE.test('a.studyvault') && !OPENABLE.test('a.studyvaultx') && !OPENABLE.test('a.zip'));
    // The stat is the last thing asked: nothing refused above touched the disk.
    let touched = 0;
    for (const p of ['', 'rel.studyvault', '\\\\.\\x.studyvault', 'C:\\a.exe']) openRefusal(p, { stat: () => { touched++; return { isFile: () => true, size: 1 }; }, absolute: win32.isAbsolute });
    check('a path refused by its shape is never looked up', touched, 0);
}

// ---------------------------------------------------------------------------
console.log('\n--- files waiting for a window ---');
{
    let t = 1_000_000;
    let n = 0;
    const tokenOf = () => (n++).toString(16).padStart(64, '0');
    const make = () => createOpenedFiles({ now: () => t, stat: () => ({ isFile: () => true, size: 10 }), absolute: win32.isAbsolute, newToken: tokenOf });
    const files = make();
    const a = files.register('C:\\Courses\\Dutch.studyvault');
    ok('a registered file gets a token', typeof a.token === 'string' && /^[0-9a-f]{64}$/.test(a.token));
    const entry = files.take(a.token);
    check('the token stands for the file, by name too', entry && { path: entry.path, name: entry.name }, { path: 'C:\\Courses\\Dutch.studyvault', name: 'Dutch.studyvault' });
    check('…once: the second ask gets nothing', files.take(a.token), null);
    check('a refused path gets no token', files.register('C:\\x.exe'), { refused: 'not a .studyvault file' });
    check('…and waits for nothing', files.size(), 0);
    check('a token in the wrong shape is not looked up', files.take('A'.repeat(64)), null);
    check('…nor one that is not a string', files.take(['0'.repeat(64)]), null);

    const late = files.register('C:\\Courses\\Late.studyvault');
    t += TOKEN_TTL_MS - 1;
    const early = files.register('C:\\Courses\\Early.studyvault');
    ok('a token is good until its time is up', files.take(early.token) !== null);
    t += 1;
    check('…and gone after', files.take(late.token), null);

    const full = make();
    const tokens = [];
    for (let i = 0; i < MAX_WAITING; i++) tokens.push(full.register(`C:\\Courses\\c${i}.studyvault`).token);
    ok(`${MAX_WAITING} files may wait at once`, tokens.every(Boolean));
    check('the next is refused', full.register('C:\\Courses\\more.studyvault'), { refused: 'too many files waiting' });
    full.take(tokens[0]);
    ok('one opened makes room for one more', !!full.register('C:\\Courses\\more.studyvault').token);
    t += TOKEN_TTL_MS;
    ok('…and the lapsed ones make room too', !!full.register('C:\\Courses\\later.studyvault').token && full.size() === 1);

    const nonces = make();
    const nonce = newNonce();
    ok('a nonce is fresh the first time', nonces.freshNonce(nonce));
    ok('…and never again while a proof made with it could still count', !nonces.freshNonce(nonce));
    t += TOKEN_TTL_MS - 1;
    ok('…not even at the last moment', !nonces.freshNonce(nonce));

    const real = createOpenedFiles();
    const tok = () => real.register(join(scratch, 'missing.studyvault'));
    check('the real file system is asked by default', tok(), { refused: 'not there' });
}

// ---------------------------------------------------------------------------
console.log('\n--- the whole door, on a scratch desktop server ---');
/** A course file the app itself exported, and what the door served for it: read by the page below. */
let exportedBundle = null;
let openedViaDoor = null;
{
    const { createApp } = await import('../server/app.js');
    const server = createApp().listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const port = server.address().port;
    const url = `http://127.0.0.1:${port}`;
    const key = loadInstanceKey(scratch);
    ok('the server made the library\'s key in the scratch folder', Buffer.isBuffer(key) && key.length >= 32);

    const call = (path, { method = 'GET', body, headers = {} } = {}) => new Promise((resolveCall, reject) => {
        const req = request({ host: '127.0.0.1', port, path, method, headers: { 'Content-Type': 'application/json', Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const raw = Buffer.concat(chunks);
                let json = null;
                try { json = JSON.parse(raw.toString('utf8')); } catch { /* the file's bytes */ }
                resolveCall({ status: res.statusCode, headers: res.headers, raw, json });
            });
        });
        req.on('error', reject);
        if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
        req.end();
    });

    const course = join(scratch, 'Курс été.studyvault');
    const bytes = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 251))]);
    writeFileSync(course, bytes);

    const reg = await registerOpenFile({ url, port, key, path: course });
    ok('the launcher registers a course file', typeof reg.token === 'string', JSON.stringify(reg));
    const fetched = await call(`/api/desktop/opened-file/${reg.token}`);
    check('the window gets the file\'s bytes', fetched.status === 200 && fetched.raw.equals(bytes), true);
    check('…named, in any script', decodeURIComponent(fetched.headers['x-file-name'] || ''), 'Курс été.studyvault');
    check('…never kept by a cache', fetched.headers['cache-control'], 'no-store');
    check('…as bytes, never as a page', fetched.headers['content-type'], 'application/octet-stream');
    const again = await call(`/api/desktop/opened-file/${reg.token}`);
    check('a token is spent on its first read', again.status, 404);
    check('…and the page is told to open the file again', again.json?.messageKey, 'This file is no longer waiting to be opened. Open it again.');

    const wrongKey = await registerOpenFile({ url, port, key: Buffer.alloc(32, 9), path: course });
    check('another library\'s key registers nothing', wrongKey, { error: 'Not proved by this library\'s key' });
    const noKey = await registerOpenFile({ url, port, key: null, path: course });
    ok('no key, no request', !!noKey.error && !noKey.token);
    const otherPort = (() => { const nonce = newNonce(); return { path: course, nonce, proof: openFileProof(key, nonce, port + 1, course) }; })();
    check('a proof made for another port is refused', (await call('/api/desktop/open-file', { method: 'POST', body: otherPort })).status, 403);
    const nonce = newNonce();
    const once = { path: course, nonce, proof: openFileProof(key, nonce, port, course) };
    const first = await call('/api/desktop/open-file', { method: 'POST', body: once });
    check('a proved request is answered with a token', first.status === 200 && /^[0-9a-f]{64}$/.test(first.json?.token || ''), true);
    const replay = await call('/api/desktop/open-file', { method: 'POST', body: once });
    check('the same request sent again is refused', [replay.status, replay.json?.error], [403, 'That proof was already used']);
    const swapped = { ...once, path: join(scratch, 'other.studyvault') };
    check('…and its proof does not open another file', (await call('/api/desktop/open-file', { method: 'POST', body: swapped })).status, 403);

    const text = join(scratch, 'notes.txt');
    writeFileSync(text, 'secret');
    const refused = await registerOpenFile({ url, port, key, path: text });
    check('a proved request for a file that is not a course is refused', refused, { error: 'Cannot open that file: not a .studyvault file' });
    const rel = await registerOpenFile({ url, port, key, path: 'Курс été.studyvault' });
    check('…and so is a relative path', rel, { error: 'Cannot open that file: not an absolute path' });
    check('a body that is not JSON is refused', (await call('/api/desktop/open-file', { method: 'POST', body: 'path=x', headers: { 'Content-Type': 'text/plain' } })).status, 403);

    // Read only on the computer itself: a device in without the password may
    // read the desktop panel, never a file off the computer's disk.
    const held = await registerOpenFile({ url, port, key, path: course });
    const { addDevice, DEVICE_COOKIE } = await import('../server/devices.js');
    const device = addDevice({ name: 'Phone', via: 'qr' });
    const asDevice = { 'X-Forwarded-For': '192.168.1.50', Cookie: `${DEVICE_COOKIE}=${device.token}` };
    check('control: the device is in', (await call('/api/desktop/info', { headers: asDevice })).status, 200);
    const fromDevice = await call(`/api/desktop/opened-file/${held.token}`, { headers: asDevice });
    check('a device is refused the file', [fromDevice.status, fromDevice.json?.messageKey], [403, 'Only on the computer itself, or with the password']);
    check('…from elsewhere, without a device, too', (await call(`/api/desktop/opened-file/${held.token}`, { headers: { 'X-Forwarded-For': '192.168.1.51' } })).status, 401);
    const stillThere = await call(`/api/desktop/opened-file/${held.token}`);
    ok('…and neither spent the token the window holds', stillThere.status === 200 && stillThere.raw.equals(bytes), String(stillThere.status));

    // A file that changed after it was registered.
    const shrinking = join(scratch, 'Shrinking.studyvault');
    writeFileSync(shrinking, bytes);
    const gone = await registerOpenFile({ url, port, key, path: shrinking });
    writeFileSync(shrinking, '');
    check('a file emptied since it was registered is not served', (await call(`/api/desktop/opened-file/${gone.token}`)).status, 404);
    const removed = join(scratch, 'Removed.studyvault');
    writeFileSync(removed, bytes);
    const removedTok = await registerOpenFile({ url, port, key, path: removed });
    rmSync(removed);
    check('…nor one deleted since', (await call(`/api/desktop/opened-file/${removedTok.token}`)).status, 404);

    // A real course file, as the app exports one, through the door and into
    // the page's own reader: what the preview shows is the course inside.
    const made = await call('/api/import', { method: 'POST', body: {
        project: { name: 'Nederlands A2 — été', description: 'Words' },
        nodes: [{ title: 'Greetings', flashcards: [{ front: 'Hallo', back: 'Hello' }] }],
    } });
    ok('control: a course to export', made.status === 200 && Number.isInteger(made.json?.id), String(made.status));
    const exported = await call(`/api/export/${made.json?.id}/bundle`);
    ok('control: the app exports it as a .studyvault', exported.status === 200 && exported.raw.length > 100, String(exported.status));
    exportedBundle = exported.raw;
    const real = join(scratch, 'Nederlands A2 (1) & more.studyvault');
    writeFileSync(real, exportedBundle);
    const realTok = await registerOpenFile({ url, port, key, path: real });
    openedViaDoor = await call(`/api/desktop/opened-file/${realTok.token}`);

    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
}

// ---------------------------------------------------------------------------
console.log('\n--- what the page reads before anything is added ---');
// The page's own modules (src/utils), bundled as the app ships them. The
// preview shows a file's course from these bytes; nothing is imported until a
// press, and the importer reads the file again from the start.
{
    const esbuild = require('esbuild');
    const JSZip = require('jszip');
    const outdir = join(scratch, 'page');
    await esbuild.build({
        entryPoints: {
            courseBundle: join(repoRoot, 'src', 'utils', 'courseBundle.ts'),
            openedCourseLink: join(repoRoot, 'src', 'utils', 'openedCourseLink.ts'),
        },
        bundle: true, format: 'esm', platform: 'node', outdir, logLevel: 'silent',
    });
    const { readCourseBundle, MAX_MANIFEST_BYTES } = await import(pathToFileURL(join(outdir, 'courseBundle.js')).href);
    const { openedFileToken } = await import(pathToFileURL(join(outdir, 'openedCourseLink.js')).href);

    const token = 'c0ffee'.padEnd(64, '9');
    check('the page finds the token in the address the launcher opens', openedFileToken(openFileUrl('http://127.0.0.1:3001', token)), token);
    for (const [label, link] of [
        ['a course link', 'http://127.0.0.1:3001/#course=1.abc'],
        ['a short token', `http://127.0.0.1:3001/#open-file=${token.slice(1)}`],
        ['capital letters', `http://127.0.0.1:3001/#open-file=${token.toUpperCase()}`],
        ['more after the token', `http://127.0.0.1:3001/#open-file=${token}&x=1`],
        ['the token outside the fragment', `http://127.0.0.1:3001/?open-file=${token}`],
        ['nothing', null],
    ]) check(`…and nothing in ${label}`, openedFileToken(link), null);

    /** What `readCourseBundle` makes of `bytes`: the course's name, a library's count, or the problem. */
    const read = async (bytes) => {
        try {
            const got = await readCourseBundle(new Blob([bytes]));
            return got.kind === 'course' ? { course: got.data.project.name } : { library: got.count };
        } catch (e) {
            return { problem: e?.problem ?? String(e) };
        }
    };
    const zip = async (entries, options = {}) => {
        const z = new JSZip();
        for (const [name, content, opts] of entries) z.file(name, content, opts);
        return z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', ...options });
    };
    const manifest = (name) => JSON.stringify({ project: { name }, nodes: [{ title: 'A' }] });

    ok('control: the door served the exported file', openedViaDoor?.status === 200 && openedViaDoor.raw.equals(exportedBundle));
    check('a course the app exported reads as that course', await read(openedViaDoor.raw), { course: 'Nederlands A2 — été' });
    check('…written without compression too', await read(await zip([['manifest.json', manifest('Stored')]], { compression: 'STORE' })), { course: 'Stored' });
    check('…or streamed, its sizes after the data', await read(await zip([['manifest.json', manifest('Streamed')]], { streamFiles: true })), { course: 'Streamed' });
    check('…or with a comment after the directory', await read(await zip([['manifest.json', manifest('Commented')]], { comment: 'x'.repeat(5000) })), { course: 'Commented' });
    check('a manifest wins over a library list, as in the importer',
        await read(await zip([['library.json', '{}'], ['manifest.json', manifest('First')]])), { course: 'First' });

    const library = { kind: 'terramentor-library', projects: [
        { file: 'projects/001-a.studyvault', name: 'A' },
        { file: 'projects/002-b.studyvault', name: 'B' },
        { file: 'projects/002-b.studyvault', name: 'B, listed twice' },
    ] };
    check('a whole library reads as its courses, each once', await read(await zip([['library.json', JSON.stringify(library)]])), { library: 2 });
    check('…and a list that is not one is no course', await read(await zip([['library.json', JSON.stringify({ ...library, kind: 'other' })]])), { problem: 'not-a-course' });

    check('a file that is no archive is damaged', await read(Buffer.from('not a zip at all, just text '.repeat(10))), { problem: 'damaged' });
    check('an archive with neither list is no course', await read(await zip([['notes.txt', 'hi']])), { problem: 'not-a-course' });
    check('a manifest that is not a course is no course', await read(await zip([['manifest.json', '{"project":{},"nodes":[]}']])), { problem: 'not-a-course' });
    check('a manifest that is not JSON is damaged', await read(await zip([['manifest.json', '{"project":']])), { problem: 'damaged' });
    const whole = await zip([['manifest.json', manifest('Cut')], ['media/a.bin', Buffer.alloc(20000, 7)]]);
    check('a file cut short is damaged', await read(whole.subarray(0, whole.length - 30)), { problem: 'damaged' });

    // Offsets in an archive's central directory (one entry per record, signature PK\1\2).
    const directoryAt = (buf, name) => {
        for (let at = buf.lastIndexOf(Buffer.from('PK\x01\x02', 'latin1')); at >= 0; at = buf.lastIndexOf(Buffer.from('PK\x01\x02', 'latin1'), at - 1)) {
            if (buf.toString('utf8', at + 46, at + 46 + buf.readUInt16LE(at + 28)) === name) return at;
        }
        return -1;
    };
    const encrypted = Buffer.from(await zip([['manifest.json', manifest('Locked')]]));
    encrypted.writeUInt16LE(encrypted.readUInt16LE(directoryAt(encrypted, 'manifest.json') + 8) | 1, directoryAt(encrypted, 'manifest.json') + 8);
    check('an encrypted manifest is damaged, never guessed at', await read(encrypted), { problem: 'damaged' });
    // Two entries named manifest.json: the importer reads one of them, and the
    // page must not show the other. Made by renaming a second entry in place.
    const twice = Buffer.from(await zip([['manifest.json', manifest('Shown')], ['manifesX.json', manifest('Imported')]]));
    for (let at = twice.indexOf('manifesX.json'); at >= 0; at = twice.indexOf('manifesX.json', at + 1)) twice.write('manifest.json', at, 'latin1');
    check('an archive naming the manifest twice is refused', await read(twice), { problem: 'damaged' });

    // A small file that inflates past the ceiling: refused by its stated size,
    // and, when the directory lies about the size, while it streams.
    const big = Buffer.from(await zip([['manifest.json', Buffer.alloc(MAX_MANIFEST_BYTES + 1024, 32)]]));
    ok('control: the large manifest is small on disk', big.length < 1024 * 1024, String(big.length));
    check('a manifest larger than the ceiling is refused by its size', await read(big), { problem: 'too-large' });
    big.writeUInt32LE(100, directoryAt(big, 'manifest.json') + 24);
    check('…and, claiming 100 bytes, while it inflates', await read(big), { problem: 'too-large' });
}

console.log(`\n${pass} passed, ${fail} failed`);
// Ended, not killed: process.exit() while the database's handle is still
// closing aborts node on Windows (libuv UV_HANDLE_CLOSING), and a suite whose
// every assertion passed would read as broken.
try { (await import('../server/database.js')).default.close(); } catch { /* already closed */ }
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* Windows may hold the WAL */ }
process.exitCode = fail ? 1 : 0;
