#!/usr/bin/env node
/**
 * Desktop build guards: where the data goes, how the launcher decides, when the
 * server stops itself, and that the packaging pieces are all there.
 *
 * Every decision the launcher makes is a function in desktop/lib.js or
 * server/paths.js with its inputs injectable, so this suite walks each one
 * across all three platforms from whichever machine runs it. The lifecycle
 * router is mounted on a real Express app on an ephemeral port and driven with
 * fetch — no model, no database, no window.
 *
 *   node tools/desktop-gates.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { resolveDataPaths, userDataDir, DATA_FOLDER_NAME } from '../server/paths.js';
import { createDesktop, shouldShutDown, openFolderCommand, IDLE_MS, BYE_GRACE_MS, NOT_DESKTOP } from '../server/desktop.js';
import {
    chooseDataDir, readLibraryPointer, libraryPointerFile, LIBRARY_POINTER,
    browserCandidates, findBrowser, browserArgs, defaultBrowserCommand,
    isOurInstance, findRunningInstance, portRange, prepareLogFile, startMenuShortcutScript, LOG_MAX_BYTES, whichOnPath,
    autostartPlan, WINDOW_MODES, WINDOW_SIZE, launchCommand, shouldOpenWindow, AUTOSTART_WINDOW_MODES,
} from '../desktop/lib.js';
import { buildIco, buildIcns, readIcoTable, ICO_SIZES } from './lib/icons.mjs';
import { deployment, readBuildInfo, updateCommand } from '../server/version.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

let pass = 0, fail = 0;
const check = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    ok ? pass++ : fail++;
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};
const ok = (name, cond, detail = '') => check(name + (detail ? ` — ${detail}` : ''), !!cond, true);

// ---------------------------------------------------------------------------
console.log('--- where the data goes (server/paths.js) ---');
{
    const root = '/app/server';
    const legacy = resolveDataPaths({ env: {}, root });
    check('no env: the historical layout under server/', legacy.source, 'legacy');
    ok('legacy db lives in server/', legacy.dbPath.endsWith('terramentor.db') && legacy.dbPath.includes('server'));
    ok('legacy vault lives in server/', legacy.vaultRoot.replace(/\\/g, '/').endsWith('/app/server/vault'));

    const data = resolveDataPaths({ env: { DATA_DIR: '/home/u/.local/share/Terramentor' }, root });
    check('DATA_DIR decides both halves', data.source, 'data-dir');
    ok('db under DATA_DIR', data.dbPath.replace(/\\/g, '/').endsWith('Terramentor/terramentor.db'));
    ok('vault under DATA_DIR', data.vaultRoot.replace(/\\/g, '/').endsWith('Terramentor/vault'));

    const both = resolveDataPaths({ env: { DATA_DIR: '/d', DB_PATH: '/x/lib.db', VAULT_ROOT: '/y/vault' }, root });
    check('DB_PATH and VAULT_ROOT beat DATA_DIR', both.source, 'env');
    ok('explicit db path wins', both.dbPath.replace(/\\/g, '/').endsWith('/x/lib.db'));
    ok('explicit vault root wins', both.vaultRoot.replace(/\\/g, '/').endsWith('/y/vault'));

    const dbOnly = resolveDataPaths({ env: { DB_PATH: '/scratch/t.db' }, root });
    ok('DB_PATH alone leaves the vault on the legacy path (Docker-era behaviour, unchanged)',
        dbOnly.vaultRoot.replace(/\\/g, '/').endsWith('/app/server/vault'));
    ok('dataDir for a DB_PATH-only run is the database directory', dbOnly.dataDir.replace(/\\/g, '/').endsWith('/scratch'));
}
{
    const home = '/home/u';
    check('Linux: XDG_DATA_HOME when set',
        userDataDir({ platform: 'linux', env: { XDG_DATA_HOME: '/xdg' }, home }).replace(/\\/g, '/'), `/xdg/${DATA_FOLDER_NAME}`);
    check('Linux: ~/.local/share otherwise',
        userDataDir({ platform: 'linux', env: {}, home }).replace(/\\/g, '/'), `/home/u/.local/share/${DATA_FOLDER_NAME}`);
    check('macOS: Application Support',
        userDataDir({ platform: 'darwin', env: {}, home }).replace(/\\/g, '/'), `/home/u/Library/Application Support/${DATA_FOLDER_NAME}`);
    check('Windows: LOCALAPPDATA (not Roaming — a multi-GB library must not sync)',
        userDataDir({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, home: 'C:\\Users\\u' }).replace(/\//g, '\\'),
        `C:\\Users\\u\\AppData\\Local\\${DATA_FOLDER_NAME}`);
    ok('Windows without LOCALAPPDATA still lands under the profile',
        /AppData[\\/]Local[\\/]Terramentor$/.test(userDataDir({ platform: 'win32', env: {}, home: 'C:\\Users\\u' })));
}

// ---------------------------------------------------------------------------
console.log('\n--- the launcher\'s data-directory choice ---');
{
    const base = { appRoot: '/opt/mn', platform: 'linux', env: {}, home: '/home/u', exists: () => false };
    check('--data-dir wins', chooseDataDir({ ...base, argDataDir: '/a', envDataDir: '/e', packaged: true }).why, 'argument');
    check('DATA_DIR next', chooseDataDir({ ...base, envDataDir: '/e', packaged: true }).why, 'environment');
    const portable = chooseDataDir({ ...base, packaged: true, exists: (p) => p.replace(/\\/g, '/') === '/opt/mn/data' });
    check('a data/ folder beside the app makes it portable', portable.why, 'portable');
    ok('portable dir is that folder', portable.dir.replace(/\\/g, '/').endsWith('/opt/mn/data'));
    const user = chooseDataDir({ ...base, packaged: true });
    check('a packaged copy uses the per-user folder', user.why, 'user');
    ok('…which is the platform app-data path', user.dir.replace(/\\/g, '/').endsWith('/.local/share/Terramentor'));
    const checkout = chooseDataDir({ ...base, packaged: false });
    check('a checkout keeps the historical layout', checkout.why, 'checkout');

    // A library on the big disk. The per-user folder is on the system drive,
    // which is the drive most likely to be full, and a library with a few
    // imported decks runs to gigabytes.
    const noteAt = '/home/u/.local/share/Terramentor/' + LIBRARY_POINTER;
    const withPointer = (text, dirExists = true) => chooseDataDir({
        ...base, packaged: true,
        exists: (p) => {
            const q = p.replace(/\\/g, '/');
            if (q === noteAt) return true;
            if (q === '/opt/mn/data') return false;
            return dirExists;
        },
        readFile: () => text,
    });
    const pointed = withPointer(libraryPointerFile('/mnt/big/Library'));
    check('a pointer file moves the library', pointed.why, 'pointer');
    // `endsWith`, because `resolve` on Windows prefixes the current drive letter
    // to a POSIX-looking absolute path, as every other path check here does.
    ok('…to the path it names', pointed.dir.replace(/\\/g, '/').endsWith('/mnt/big/Library'));
    ok('…and nothing is missing when it is there', !pointed.missing);
    ok('the file the app writes is one the reader can act on: a comment, and how to undo it',
        libraryPointerFile('/x').includes('#') && /Delete this file/.test(libraryPointerFile('/x')));

    // The failure this must NOT have. A pointer at somewhere unreachable used
    // to be the shape that opens an empty library beside the real one and reads
    // as lost work; it has to be reported, not fallen back from.
    const gone = withPointer(libraryPointerFile('/mnt/unplugged/Library'), false);
    check('a pointer at a folder that is not there still names it', gone.why, 'pointer');
    ok('…and says so, rather than silently opening the default', gone.missing === true);
    ok('…and names the file to delete to undo it', String(gone.pointer).endsWith(LIBRARY_POINTER));

    ok('an empty or comment-only pointer is no pointer at all',
        chooseDataDir({
            ...base, packaged: true,
            exists: (p) => p.replace(/\\/g, '/') === noteAt,
            readFile: () => '# nothing but a comment\n\n',
        }).why === 'user');
    ok('an unreadable pointer falls back rather than crashing the app',
        chooseDataDir({
            ...base, packaged: true,
            exists: (p) => p.replace(/\\/g, '/') === noteAt,
            readFile: () => { throw new Error('EACCES'); },
        }).why === 'user');
    check('comments and blank lines are skipped', readLibraryPointer('# a\n\n  /d/lib  \n/other'), '/d/lib');
    check('nothing in it reads as nothing', readLibraryPointer('\n\n# only comments\n'), null);
    ok('an explicit --data-dir still beats a pointer, so a shortcut can always override it',
        chooseDataDir({
            ...base, packaged: true, argDataDir: '/said/so',
            exists: (p) => p.replace(/\\/g, '/') === noteAt, readFile: () => '/mnt/big/Library',
        }).why === 'argument');
    check('…by choosing no directory at all', checkout.dir, null);
}

// ---------------------------------------------------------------------------
console.log('\n--- which browser opens the window ---');
{
    const winEnv = { ProgramFiles: 'C:\\PF', 'ProgramFiles(x86)': 'C:\\PF86', LOCALAPPDATA: 'C:\\U\\Local' };
    const cands = browserCandidates('win32', winEnv);
    ok('Windows: Edge before Chrome', cands[0].includes('msedge.exe') && cands.findIndex((c) => c.includes('chrome.exe')) > 0);
    ok('Windows: every candidate is checked in Program Files, x86 and the user profile',
        cands.filter((c) => c.includes('msedge.exe')).length === 3);
    ok('macOS: Chrome first', browserCandidates('darwin')[0].includes('Google Chrome'));
    ok('Linux: bare names, resolved on PATH', browserCandidates('linux').every((c) => !c.includes('/')));
    ok('Firefox is never a candidate (no --app mode)', !browserCandidates('win32', winEnv).concat(browserCandidates('darwin'), browserCandidates('linux')).some((c) => /firefox/i.test(c)));

    const onlyChrome = (p) => p.replace(/\\/g, '/') === 'C:/PF/Google/Chrome/Application/chrome.exe';
    ok('finds the one that exists', /chrome\.exe$/.test(findBrowser({ platform: 'win32', env: winEnv, exists: onlyChrome }) || ''));
    check('none installed → null', findBrowser({ platform: 'win32', env: winEnv, exists: () => false }), null);
    check('Linux: PATH lookup', (whichOnPath('chromium', { PATH: ['/nope', '/usr/bin'].join(delimiter) }, (p) => p.replace(/\\/g, '/') === '/usr/bin/chromium') || '').replace(/\\/g, '/'), '/usr/bin/chromium');

    const args = browserArgs('http://127.0.0.1:3001', '/data/browser-profile');
    check('app mode', args[0], '--app=http://127.0.0.1:3001');
    ok('a dedicated profile, so the window is its own instance', args.some((a) => a.startsWith('--user-data-dir=')));
    ok('no first-run prompts', args.includes('--no-first-run') && args.includes('--no-default-browser-check'));

    check('default browser, Windows', defaultBrowserCommand('http://x', 'win32'), { cmd: 'cmd.exe', args: ['/c', 'start', '', 'http://x'] });
    check('default browser, macOS', defaultBrowserCommand('http://x', 'darwin'), { cmd: 'open', args: ['http://x'] });
    check('default browser, Linux', defaultBrowserCommand('http://x', 'linux'), { cmd: 'xdg-open', args: ['http://x'] });
    check('open folder, Windows', openFolderCommand('C:\\d', 'win32').cmd, 'explorer.exe');
    check('open folder, macOS', openFolderCommand('/d', 'darwin').cmd, 'open');
}

// ---------------------------------------------------------------------------
console.log('\n--- is that server ours? ---');
{
    const mine = { desktop: true, app: 'terramentor', dataDir: 'C:\\Users\\u\\AppData\\Local\\Terramentor' };
    ok('same app, same directory', isOurInstance(mine, 'C:\\Users\\u\\AppData\\Local\\Terramentor', 'win32'));
    ok('Windows compares paths case-insensitively', isOurInstance(mine, 'c:\\users\\U\\appdata\\local\\terramentor', 'win32'));
    ok('a different directory is a different library', !isOurInstance(mine, 'D:\\portable\\data', 'win32'));
    ok('a non-desktop server is never claimed', !isOurInstance({ desktop: false }, 'C:\\x', 'win32'));
    ok('something else answering JSON is not ours', !isOurInstance({ app: 'other', desktop: true, dataDir: 'C:\\x' }, 'C:\\x', 'win32'));
    ok('a checkout (no data dir) claims any desktop Terramentor', isOurInstance(mine, null, 'win32'));

    check('port range', portRange(3001, 3), [3001, 3002, 3003]);
    const calls = [];
    const fakeFetch = async (url) => {
        calls.push(url);
        if (url.includes(':3001/')) return { ok: true, json: async () => ({ desktop: false }) };                 // some other server on 3001
        if (url.includes(':3002/')) throw new Error('ECONNREFUSED');
        if (url.startsWith('http://') && url.includes(':3003/')) return { ok: true, json: async () => ({ ...mine }) };
        return { ok: false };
    };
    const found = await findRunningInstance({ ports: [3001, 3002, 3003, 3004], dataDir: mine.dataDir, fetchImpl: fakeFetch, platform: 'win32' });
    check('walks the ports and finds ours on 3003', found?.port, 3003);
    check('reports the scheme it answered on', found?.url, 'http://127.0.0.1:3003');
    ok('a port that is not ours is asked on both schemes before moving on', calls.filter((u) => u.includes(':3001/')).length === 2);
    ok('stops looking once found', !calls.some((u) => u.includes(':3004/')));
    const none = await findRunningInstance({ ports: [3001], dataDir: mine.dataDir, fetchImpl: async () => { throw new Error('x'); }, platform: 'win32' });
    check('nothing running → null', none, null);
}

// ---------------------------------------------------------------------------
console.log('\n--- when the server stops itself ---');
{
    const t0 = 1_000_000;
    const base = { startedAt: t0, lastPing: 0, everConnected: false, lastBye: 0, keepRunning: false };
    ok('just started, no window yet: keep waiting', !shouldShutDown({ ...base, now: t0 + IDLE_MS }));
    ok('no window ever came: give up after 4 idle periods', shouldShutDown({ ...base, now: t0 + 4 * IDLE_MS + 1 }));
    const live = { ...base, everConnected: true, lastPing: t0 + 60_000 };
    ok('pinging: stay', !shouldShutDown({ ...live, now: t0 + 60_000 + IDLE_MS - 1 }));
    ok('silent past IDLE_MS: stop', shouldShutDown({ ...live, now: t0 + 60_000 + IDLE_MS + 1 }));
    const bye = { ...live, lastBye: t0 + 61_000 };
    ok('goodbye, then silence: stop after the short grace', shouldShutDown({ ...bye, now: t0 + 61_000 + BYE_GRACE_MS + 1 }));
    ok('goodbye inside the grace: not yet (a reload sends one)', !shouldShutDown({ ...bye, now: t0 + 61_000 + BYE_GRACE_MS - 1 }));
    ok('a ping after the goodbye cancels it', !shouldShutDown({ ...bye, lastPing: t0 + 62_000, now: t0 + 62_000 + BYE_GRACE_MS + 1 }));
    ok('keep-running: never', !shouldShutDown({ ...live, keepRunning: true, now: t0 + 10 * IDLE_MS }));
    ok('keep-running even when no window ever came', !shouldShutDown({ ...base, keepRunning: true, now: t0 + 100 * IDLE_MS }));
}

// The lifecycle router, on a real Express app.
{
    const settings = new Map();
    let stopped = null;
    let clock = 5_000_000;
    const app = express();
    app.use(express.json());
    const d = createDesktop({
        dataDir: '/data', dbPath: '/data/terramentor.db', version: '9.9.9', port: () => 0,
        getSetting: (k, f) => settings.get(k) ?? f,
        setSetting: (k, v) => settings.set(k, v),
        onShutdown: (reason) => { stopped = reason; },
        now: () => clock,
    });
    app.use(d.publicRouter);
    app.use(d.protectedRouter);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${srv.address().port}`;
    const j = async (path, body) => (await fetch(`${base}${path}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})).json();

    const st = await j('/api/desktop/status');
    check('status names the app', st.app, 'terramentor');
    check('status carries the data directory', st.dataDir, '/data');
    check('status says no client yet', st.clients, 0);
    check('keep-running is off by default', st.keepRunning, false);
    await j('/api/desktop/ping', { clientId: 'w1' });
    check('a ping registers a client', (await j('/api/desktop/status')).clients, 1);
    check('…and marks the server as having been connected to', d.state.everConnected, true);
    await j('/api/desktop/ping', { clientId: 'w1', bye: true });
    check('a goodbye from the only client removes it', (await j('/api/desktop/status')).clients, 0);
    ok('…and stamps lastBye', d.state.lastBye === clock);
    await j('/api/desktop/ping', { clientId: 'w2' });
    await j('/api/desktop/ping', { clientId: 'w1', bye: true });
    check('a goodbye while another window is open is not a goodbye', d.state.clients.size, 1);
    check('keep-running can be turned on', (await j('/api/desktop/keep-running', { enabled: true })).keepRunning, true);
    check('…and it is stored as a setting', settings.get('desktop_keep_running'), 'true');
    check('…and read back on status', (await j('/api/desktop/status')).keepRunning, true);
    check('the window opens as a plain window until asked otherwise', st.windowMode, 'window');
    check('a window mode is stored', (await j('/api/desktop/window-mode', { mode: 'fullscreen' })).windowMode, 'fullscreen');
    check('…and read back on the status the launcher probes', (await j('/api/desktop/status')).windowMode, 'fullscreen');
    // The launcher reads this row before it opens anything, so a junk value
    // must not reach a Chromium command line.
    const bad = await fetch(`${base}/api/desktop/window-mode`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: '--kiosk' }),
    });
    check('an unknown mode is refused', bad.status, 400);
    check('…and the stored one is untouched', (await j('/api/desktop/status')).windowMode, 'fullscreen');
    settings.set('desktop_window_mode', 'something else entirely');
    check('a hand-edited row reads as a plain window', (await j('/api/desktop/status')).windowMode, 'window');

    // This gate runs the router directly, without the launcher, so the app
    // genuinely cannot start itself at login here — and saying so is the point:
    // a toggle that cannot work must not be drawn as if it could.
    check('start-at-login is reported as unavailable when the launcher said nothing', st.canStartAtLogin, false);
    check('…and is therefore off', st.startAtLogin, false);
    const refused = await fetch(`${base}/api/desktop/start-at-login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }),
    });
    check('…and turning it on is refused rather than silently doing nothing', refused.status, 400);

    check('quit answers before stopping', (await j('/api/desktop/quit', {})).ok, true);
    await new Promise((r) => setTimeout(r, 300));
    check('quit reaches the shutdown hook', stopped, 'quit requested');
    d.stop('again');
    check('a second stop is ignored', stopped, 'quit requested');
    check('a sign-in start stays in the background until asked otherwise', st.autostartWindow, 'hidden');
    check('…and the other answer is storable', (await j('/api/desktop/autostart-window', { mode: 'show' })).autostartWindow, 'show');
    check('…and read back on the status the launcher probes', (await j('/api/desktop/status')).autostartWindow, 'show');
    const badAuto = await fetch(`${base}/api/desktop/autostart-window`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'minimised' }),
    });
    check('an unknown answer is refused', badAuto.status, 400);
    settings.set('desktop_autostart_window', 'whatever');
    check('a hand-edited row reads as the quiet default', (await j('/api/desktop/status')).autostartWindow, 'hidden');
    check('no tray icon here, and the status says so', st.trayHosted, false);

    srv.close();
    check('a non-desktop server has one fixed answer', NOT_DESKTOP, { desktop: false });
}

// A tray icon changes the LIFETIME: it is the app's presence on screen, so the
// window closing must not take the server with it — that is what makes the icon
// mean anything, and it is what keeps a phone on the tailnet served while the
// desktop window is shut. Asserted by building a second lifecycle with the
// environment the tray host sets, against a stored preference that says off.
{
    const before = process.env.TERRAMENTOR_TRAY;
    process.env.TERRAMENTOR_TRAY = '1';
    const settings = new Map([['desktop_keep_running', 'false']]);
    const d = createDesktop({
        dataDir: '/data', dbPath: '/data/terramentor.db', version: '9.9.9', port: () => 0,
        getSetting: (k, f) => settings.get(k) ?? f,
        setSetting: (k, v) => settings.set(k, v),
        onShutdown: () => {},
        now: () => 1_000_000,
    });
    const st = d.status();
    check('the status reports the tray icon', st.trayHosted, true);
    check('…and keep-running reads as on despite the stored "false"', st.keepRunning, true);
    ok('the stored preference is untouched, so unpacking the same library without a tray hands the answer back',
        settings.get('desktop_keep_running') === 'false');
    if (before === undefined) delete process.env.TERRAMENTOR_TRAY; else process.env.TERRAMENTOR_TRAY = before;

    const plain = createDesktop({
        dataDir: '/data', dbPath: '/d.db', version: '1', port: () => 0,
        getSetting: (k, f) => settings.get(k) ?? f, setSetting: () => {}, onShutdown: () => {}, now: () => 1,
    });
    check('…and without the environment it is off again', plain.status().keepRunning, false);
}

// ---------------------------------------------------------------------------
console.log('\n--- the log file and the shortcut ---');
{
    const calls = [];
    const file = prepareLogFile('/data', {
        mkdir: (d) => calls.push(['mkdir', d]),
        exists: () => true,
        stat: () => ({ size: LOG_MAX_BYTES + 1 }),
        rename: (a, b) => calls.push(['rename', a, b]),
    });
    ok('log lives under <data>/logs/app.log', file.replace(/\\/g, '/').endsWith('/data/logs/app.log'));
    ok('an oversized log is rotated once', calls.some((c) => c[0] === 'rename' && c[2].endsWith('.1')));
    const calls2 = [];
    prepareLogFile('/data', { mkdir: () => {}, exists: () => true, stat: () => ({ size: 10 }), rename: (a, b) => calls2.push(b) });
    check('a small log is left alone', calls2, []);

    const ps = startMenuShortcutScript({ target: "C:\\Apps\\Terramentor's\\Terramentor.exe", workingDir: 'C:\\Apps', icon: 'C:\\Apps\\Terramentor.ico' });
    ok('single quotes in a path are doubled for PowerShell', ps.includes("Terramentor''s"));
    ok('the shortcut goes in the user Start Menu', ps.includes('Start Menu\\Programs'));
    ok('the icon is set', ps.includes('IconLocation'));
}

// ---------------------------------------------------------------------------
// How the window opens, and whether the app opens itself.
//
// Both are decided before there is a window to ask: Chromium takes the window
// state as a launch flag and cannot be told afterwards from inside the page,
// and a login item is a command line written to disk. So both are pure
// functions of their inputs here, and every platform's answer is read from this
// one — the Linux and macOS paths are otherwise only exercised by somebody on
// that OS noticing it did not work.
console.log('\n--- how the window opens, and starting at login ---');
{
    check('three modes, and no fourth that means anything', WINDOW_MODES, ['window', 'maximized', 'fullscreen']);
    const plain = browserArgs('http://x', '/p');
    const flags = (args) => args.filter((a) => a === '--start-maximized' || a === '--start-fullscreen');
    check('a plain window asks for neither flag', flags(plain), []);
    check('maximized asks for exactly one', flags(browserArgs('http://x', '/p', 'maximized')), ['--start-maximized']);
    check('fullscreen asks for exactly one', flags(browserArgs('http://x', '/p', 'fullscreen')), ['--start-fullscreen']);
    ok('an unknown mode is a plain window, not a crash', flags(browserArgs('http://x', '/p', 'kiosk-ish')).length === 0);
    ok('the app flag and the dedicated profile survive either', browserArgs('http://x', '/p', 'fullscreen').includes('--app=http://x'));

    // The size and the state are EXCLUSIVE. Sending both let the size win, in
    // Edge, measured — so `maximized` opened a 1280x860 window on a 2560x1440
    // screen and the setting had never done anything since it shipped.
    const sized = (args) => args.filter((a) => a.startsWith('--window-size'));
    check('a plain window asks for a size', sized(plain), [`--window-size=${WINDOW_SIZE}`]);
    check('maximized asks for NO size', sized(browserArgs('http://x', '/p', 'maximized')), []);
    check('fullscreen asks for NO size', sized(browserArgs('http://x', '/p', 'fullscreen')), []);
    ok('an unknown mode still gets a size, because it is a plain window',
        sized(browserArgs('http://x', '/p', 'kiosk-ish')).length === 1);
    for (const mode of WINDOW_MODES) {
        ok(`${mode}: exactly one of size-or-state reaches the command line`,
            sized(browserArgs('http://x', '/p', mode)).length + flags(browserArgs('http://x', '/p', mode)).length === 1);
    }

    const win = autostartPlan({
        platform: 'win32', target: 'C:\\Program Files\\Terramentor\\Terramentor.exe', args: [],
        workingDir: 'C:\\Program Files\\Terramentor', icon: 'C:\\Program Files\\Terramentor\\Terramentor.ico',
        env: { APPDATA: 'C:\\Users\\x\\AppData\\Roaming' },
    });
    ok('Windows: a shortcut in the Startup folder, not a registry write', win.supported && win.kind === 'shortcut'
        && win.path.replace(/\\/g, '/').endsWith('Start Menu/Programs/Startup/Terramentor.lnk'));
    ok('…written by a script that names the exe', win.script.includes('Terramentor.exe'));
    ok('…and opens minimized, so a checkout\'s console is not the first thing on screen at sign-in',
        win.script.includes('$s.WindowStyle = 7'));

    const winArgs = autostartPlan({
        platform: 'win32', target: 'C:\\node.exe', args: ['C:\\My Apps\\launcher.js'],
        env: { APPDATA: 'C:\\Users\\x\\AppData\\Roaming' },
    });
    ok('…and quotes an argument containing a space, which a bare path loses at it',
        winArgs.script.includes('"C:\\My Apps\\launcher.js"'));

    // What the login item is asked to RUN. A command line inherits nothing from
    // the run that wrote it — no `.env` a package script passed to node, no
    // exported DATA_DIR — so the library has to be named in it. Without that the
    // copy that opens at sign-in resolves the data directory afresh, lands on the
    // historical layout, and shows an empty library beside the real one.
    // …and it must not open a CONSOLE while it does. node.exe is a console
    // program: a login item naming it puts a console window on screen at every
    // sign-in, and that window is not a log viewer to be closed — it IS the
    // server, so tidying it away stops the app.
    const SHIM = 'D:\\app\\desktop\\wrappers\\launch-hidden.vbs';
    const WSCRIPT = 'C:\\Windows\\System32\\wscript.exe';
    const fromCheckout = launchCommand({
        platform: 'win32', packaged: false, appRoot: 'D:\\app',
        execPath: 'C:\\Program Files\\nodejs\\node.exe', scriptPath: 'D:\\app\\desktop\\launcher.js',
        dataDir: 'D:\\Terramentor-data',
        env: { SystemRoot: 'C:\\Windows' }, exists: (p) => p === SHIM || p === WSCRIPT,
    });
    check('a checkout goes through the windowless shim, and still names node, the script and the library',
        [fromCheckout.target, ...fromCheckout.args],
        [WSCRIPT, SHIM, 'C:\\Program Files\\nodejs\\node.exe', 'D:\\app\\desktop\\launcher.js', '--data-dir', 'D:\\Terramentor-data']);
    ok('…and says it opens no console', fromCheckout.console === false);
    ok('the shim the checkout path names is really in the tree',
        existsSync(join(repoRoot, 'desktop', 'wrappers', 'launch-hidden.vbs')));

    const noShim = launchCommand({
        platform: 'win32', packaged: false, appRoot: 'D:\\app',
        execPath: 'C:\\node.exe', scriptPath: 'D:\\app\\desktop\\launcher.js', dataDir: 'D:\\lib',
        env: { SystemRoot: 'C:\\Windows' }, exists: () => false,
    });
    check('with no shim to reach, it falls back to node itself',
        [noShim.target, ...noShim.args], ['C:\\node.exe', 'D:\\app\\desktop\\launcher.js', '--data-dir', 'D:\\lib']);
    ok('…and SAYS that one opens a console, rather than quietly being the old bug', noShim.console === true);

    const fromPackaged = launchCommand({
        platform: 'win32', packaged: true, appRoot: 'C:\\Apps\\Terramentor',
        execPath: 'C:\\node.exe', scriptPath: 'C:\\Apps\\Terramentor\\desktop\\launcher.js',
        dataDir: 'C:\\Users\\x\\AppData\\Local\\Terramentor',
        exists: (p) => p === 'C:\\Apps\\Terramentor\\Terramentor.exe',
    });
    check('a packaged copy names its own exe, and the library just the same',
        [fromPackaged.target, ...fromPackaged.args],
        ['C:\\Apps\\Terramentor\\Terramentor.exe', '--data-dir', 'C:\\Users\\x\\AppData\\Local\\Terramentor']);
    ok('…which is the windowless one with the tray icon', fromPackaged.console === false);
    const cmdOnly = launchCommand({
        platform: 'win32', packaged: true, appRoot: 'C:\\Apps\\T', execPath: 'C:\\node.exe',
        scriptPath: 'C:\\Apps\\T\\desktop\\launcher.js', dataDir: null,
        exists: (p) => p === 'C:\\Apps\\T\\Terramentor.cmd',
    });
    check('a build whose C# compiler was unavailable falls back to the .cmd', cmdOnly.target, 'C:\\Apps\\T\\Terramentor.cmd');
    ok('…and that one is declared a console launch, because it is', cmdOnly.console === true);

    const legacy = launchCommand({
        platform: 'linux', packaged: false, appRoot: '/app',
        execPath: '/usr/bin/node', scriptPath: '/app/desktop/launcher.js', dataDir: null,
    });
    check('…and a run with no data directory of its own pins nothing, so the historical layout still resolves',
        [legacy.target, ...legacy.args], ['/usr/bin/node', '/app/desktop/launcher.js']);
    ok('the pinned path survives into the shortcut, quoted against its spaces',
        autostartPlan({
            platform: 'win32', target: 'C:\\node.exe',
            args: ['D:\\app\\launcher.js', '--data-dir', 'D:\\3 - work\\Terramentor-data'],
            env: { APPDATA: 'C:\\Users\\x\\AppData\\Roaming' },
        }).script.includes('--data-dir "D:\\3 - work\\Terramentor-data"'));

    const mac = autostartPlan({
        platform: 'darwin', target: '/usr/local/bin/node', args: ['/Apps/launcher.js'], home: '/Users/x',
    });
    ok('macOS: a LaunchAgent plist in the user library', mac.supported && mac.kind === 'plist'
        && mac.path === '/Users/x/Library/LaunchAgents/com.terramentor.app.plist');
    ok('…that runs at load and names both parts of the command',
        mac.contents.includes('<key>RunAtLoad</key>') && mac.contents.includes('<string>/Apps/launcher.js</string>'));

    const linux = autostartPlan({
        platform: 'linux', target: '/usr/bin/node', args: ['/apps/launcher.js'], home: '/home/x', env: {},
    });
    ok('Linux: an XDG autostart entry', linux.supported && linux.kind === 'desktop-entry'
        && linux.path === '/home/x/.config/autostart/terramentor.desktop');
    ok('…honouring XDG_CONFIG_HOME when it is set',
        autostartPlan({ platform: 'linux', target: '/usr/bin/node', home: '/home/x', env: { XDG_CONFIG_HOME: '/cfg' } })
            .path === '/cfg/autostart/terramentor.desktop');
    ok('…and not opening a terminal', linux.contents.includes('Terminal=false'));

    // The refusals. Each of these would otherwise write a login item that fails
    // every morning with nothing on screen to say why.
    ok('no launch target: not supported, and it says why', autostartPlan({ platform: 'win32', env: {} }).supported === false);
    ok('Windows with no APPDATA: not supported', autostartPlan({ platform: 'win32', target: 'x.exe', env: {} }).supported === false);
    ok('a home-less unix account: not supported', autostartPlan({ platform: 'linux', target: '/x', env: {}, home: '' }).supported === false);

    // Every login item says it IS one, on all three platforms. The run it starts
    // has a decision no other run has — whether to put a window on screen — and
    // it can only know to make it from the command line it was given.
    ok('Windows: the login item marks itself as one', win.script.includes('--autostart'));
    ok('macOS: the login item marks itself as one', mac.contents.includes('<string>--autostart</string>'));
    ok('Linux: the login item marks itself as one', /Exec=.*--autostart/.test(linux.contents));
    ok('…and it is added to whatever the launcher already pins, not instead of it',
        autostartPlan({
            platform: 'linux', target: '/usr/bin/node', args: ['/apps/launcher.js', '--data-dir', '/lib'], home: '/home/x', env: {},
        }).contents.includes('Exec=/usr/bin/node /apps/launcher.js --data-dir /lib --autostart'));
}

// ---------------------------------------------------------------------------
// Whether a sign-in start puts a window on screen.
//
// The trap this guards is a setting that makes the app VANISH. Coming up with
// no window is only safe where something else is on screen to open one — the
// tray icon, which exists on packaged Windows and nowhere else. On a checkout,
// on macOS and on Linux the same preference has to be ignored, or turning it on
// leaves a running server with no way back to it short of typing the address.
console.log('\n--- does a sign-in start open a window? ---');
{
    check('two answers, and the quiet one is the default', AUTOSTART_WINDOW_MODES, ['show', 'hidden']);
    const w = (o) => shouldOpenWindow({ wantWindow: true, ...o });
    ok('an ordinary launch opens a window', w({}));
    ok('…even where the preference says hidden, because it is not a sign-in run',
        w({ autostartWindow: 'hidden', trayHosted: true }));
    ok('a sign-in run behind a tray icon honours "hidden"',
        !w({ autostart: true, autostartWindow: 'hidden', trayHosted: true }));
    ok('…and honours "show" just as much',
        w({ autostart: true, autostartWindow: 'show', trayHosted: true }));
    ok('a sign-in run with NO tray icon opens a window whatever the preference says',
        w({ autostart: true, autostartWindow: 'hidden', trayHosted: false }));
    ok('--no-window still beats everything: the build check must open nothing',
        !shouldOpenWindow({ wantWindow: false, autostart: false, autostartWindow: 'show', trayHosted: true }));
    ok('an unreadable preference is treated as hidden only where hiding is safe',
        !w({ autostart: true, autostartWindow: undefined, trayHosted: true })
        && w({ autostart: true, autostartWindow: undefined, trayHosted: false }));
}

// ---------------------------------------------------------------------------
console.log('\n--- icons ---');
{
    const png = readFileSync(join(repoRoot, 'public', 'icons', 'icon-512.png'));
    const ico = await buildIco(png);
    check('ICO magic', [ico.readUInt16LE(0), ico.readUInt16LE(2)], [0, 1]);
    const table = readIcoTable(ico);
    check('one entry per standard size', table.map((e) => e.size), ICO_SIZES);
    ok('every entry is 32-bit', table.every((e) => e.bpp === 32));
    ok('entries are DIBs sized for XOR + AND masks', table.every((e) => e.bytes === 40 + e.size * e.size * 4 + Math.ceil(e.size / 32) * 4 * e.size));
    ok('offsets are contiguous and end at the file end', table.at(-1).offset + table.at(-1).bytes === ico.length);
    const icns = await buildIcns(png, [16, 512]);
    check('ICNS magic', icns.subarray(0, 4).toString('ascii'), 'icns');
    check('ICNS declares its own length', icns.readUInt32BE(4), icns.length);
    check('first entry is the 16px PNG', icns.subarray(8, 12).toString('ascii'), 'icp4');
    ok('entry data is a PNG', icns.subarray(16, 24).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
}

// ---------------------------------------------------------------------------
console.log('\n--- identity of a packaged copy ---');
{
    const saved = process.env.TERRAMENTOR_DESKTOP;
    process.env.TERRAMENTOR_DESKTOP = '1';
    check('the launcher env marks a desktop install', deployment(), 'desktop');
    if (saved === undefined) delete process.env.TERRAMENTOR_DESKTOP; else process.env.TERRAMENTOR_DESKTOP = saved;
    check('a desktop install has no update command (it is replaced by the next download)', updateCommand('desktop'), null);
    check('no build.json in a checkout', readBuildInfo(repoRoot), null);
    check('a build stamp elsewhere is read', typeof readBuildInfo(join(repoRoot, 'nope')), 'object');
}

// ---------------------------------------------------------------------------
console.log('\n--- packaging pieces are present ---');
{
    for (const f of ['desktop/launcher.js', 'desktop/lib.js', 'desktop/README.txt', 'tools/build-desktop.mjs',
        'desktop/wrappers/Terramentor.cmd', 'desktop/wrappers/Terramentor.command', 'desktop/wrappers/terramentor.sh',
        'desktop/wrappers/install-desktop-entry.sh', 'desktop/wrappers/Launcher.cs', 'desktop/wrappers/Info.plist',
        'desktop/wrappers/app-bundle-main.sh']) {
        ok(`${f} exists`, existsSync(join(repoRoot, f)));
    }
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    ok('npm run desktop starts the launcher', /desktop\/launcher\.js/.test(pkg.scripts.desktop || ''));
    ok('npm run build:desktop packages it', /build-desktop\.mjs/.test(pkg.scripts['build:desktop'] || ''));
    const launcher = readFileSync(join(repoRoot, 'desktop', 'launcher.js'), 'utf8');
    ok('the launcher sets DATA_DIR in-process, before importing the server',
        launcher.indexOf("process.env.DATA_DIR = chosen.dir") < launcher.indexOf("import(pathToFileURL"));
    ok('the launcher asks for port fallback', launcher.includes("process.env.PORT_FALLBACK = '1'"));
    const index = readFileSync(join(repoRoot, 'server', 'index.js'), 'utf8');
    ok('the server exports serverReady for the launcher', /export const serverReady/.test(index));
    ok('port fallback is opt-in (a developer wants EADDRINUSE)', /PORT_FALLBACK === '1' \? 10 : 1/.test(index));
    ok('the desktop probe is mounted BEFORE the auth gate', index.indexOf('desktop.publicRouter') < index.indexOf("app.use('/api', requireAuth)"));
    ok('…and the controls after it', index.indexOf('desktop.protectedRouter') > index.indexOf("app.use('/api', requireAuth)"));
    const readme = readFileSync(join(repoRoot, 'desktop', 'README.txt'), 'utf8');
    ok('the zip README names the data folder on every platform', ['%LOCALAPPDATA%', 'Application Support', '.local/share'].every((s) => readme.includes(s)));
    const wf = readFileSync(join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8');
    ok('the release workflow builds the desktop packages on all three OSes', ['windows-latest', 'macos-latest', 'ubuntu-latest'].every((s) => wf.includes(s)) && wf.includes('build-desktop'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
