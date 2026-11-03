#!/usr/bin/env node
/**
 * The pictures in the README, kept true to the app.
 *
 *   node tools/docs-shots.mjs                        check every picture against the app as built
 *   node tools/docs-shots.mjs --library <dir>        re-shoot the stills from a copy of the library in <dir>
 *   node tools/docs-shots.mjs --accept [name,...]    record the screens as they are, keeping the pictures
 *
 *   --only plan,atlas    only these pictures (names are the file names without the extension);
 *                        the screens before them in the manifest are still visited, unrecorded
 *   --out <dir>          write re-shot stills here instead of docs/screenshots/, each with a PNG beside it
 *   --browser <path>     a Chromium-based browser (default: Edge or Chrome where it is usually installed)
 *
 * Run `npm run build` first: the server serves `dist/`, and a stale build is a
 * picture of yesterday's app.
 *
 * Every picture under docs/screenshots/ has an entry in manifest.json naming
 * the screen it shows: a state below, reached by clicking through the built
 * app like a learner would. Beside it is that screen's interface text, recorded
 * as the labels the interface owns (strings from src/locales/en.json, so course
 * content, dates and counts are not part of it) and the third of the window
 * each one sits in.
 *
 * The check builds the invented course in tools/docs-fixture.mjs in a scratch
 * library, opens each state in a headless browser and compares its labels with
 * the manifest. A label that appeared, went or moved to another part of the
 * window means the picture shows a screen the app no longer has, and the check
 * fails naming them. No model is called anywhere: the fixture's lessons,
 * questions and cards are written out, its topic vectors come from a stub on
 * 127.0.0.1, and a copied library is served with AI and the update check
 * switched off and without its credentials file. AI settings in the caller's
 * environment are dropped too, since they would win over the library's.
 *
 * Re-shooting needs a library worth showing, which the repository does not
 * ship. `--library <dir>` takes a Terramentor data folder (or its .db file),
 * copies it to a scratch folder and shoots from the copy, so the folder named
 * is never written. The folder holds `docs-shots.json` naming what to show:
 *
 *   { "project": "<course name>",
 *     "study":  { "topic": "<title>", "heading": "<a heading in its lesson>", "uiScale": 100 },
 *     "prove":  { "topic": "<title>", "wrong": "<words from the question to answer wrong, or its number>",
 *                 "seed": <optional whole number, the order the check is asked in> },
 *     "cards":  { "topic": "<title>" },
 *     "prepare": "<optional module, run against the copy before shooting>" }
 *
 * A re-shoot also records the fixture's screens, so the pictures and the
 * manifest change in the same commit. A clip (`"clip": true`) is filmed with
 * other tools; the check still watches the screens it passes through, and
 * `--accept <name>` records them once it is re-filmed.
 */

import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = join(ROOT, 'docs', 'screenshots');
const MANIFEST = join(SHOTS, 'manifest.json');
const FIXTURE = join(ROOT, 'tools', 'docs-fixture.mjs');
const CHILD_FLAG = '--serve-child';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// The scratch server: a child process whose environment names the scratch
// library before any server module is imported.
// ---------------------------------------------------------------------------

async function serveChild({ mode, dir, port }) {
    process.env.DATA_DIR = dir;
    process.env.DB_PATH = join(dir, 'library.db');
    process.env.VAULT_ROOT = join(dir, 'vault');
    process.env.SECRETS_PATH = join(dir, 'library.secrets.json');
    process.env.PORT = String(port);
    process.env.HOST = '127.0.0.1';
    // The AI address and key in the caller's environment win over the library's
    // settings, so a contributor's own model would answer the scratch server.
    for (const key of Object.keys(process.env)) if (/^(AI_|OPENAI_)/.test(key)) delete process.env[key];
    // The server shuffles a check's questions; a seeded random asks them in the
    // same order on every run, so the wrong answer lands on the same row. The
    // seed starts again at each draw: other requests take numbers from the same
    // random, and how many arrive before the draw depends on timing. A
    // library's docs-shots.json may give `prove.seed` to pick the order.
    let drawSeed = 0x9e3779b9;
    let seed = drawSeed;
    Math.random = () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const { Server } = await import('node:net');
    const emit = Server.prototype.emit;
    Server.prototype.emit = function (event, req, ...rest) {
        if (event === 'request' && /\/mastery-check\/draw\b/.test(req?.url ?? '')) seed = drawSeed;
        return emit.call(this, event, req, ...rest);
    };
    mkdirSync(process.env.VAULT_ROOT, { recursive: true });

    const { resolveDataPaths } = await import(pathToFileURL(join(ROOT, 'server', 'paths.js')).href);
    const paths = resolveDataPaths();
    if (!paths.dbPath.startsWith(dir) || !paths.vaultRoot.startsWith(dir)) {
        throw new Error(`refusing: the library resolved outside the scratch folder (${paths.dbPath})`);
    }

    let cast;
    if (mode === 'fixture') {
        const { startFixture } = await import(pathToFileURL(FIXTURE).href);
        cast = await startFixture();
    } else {
        const { default: db } = await import(pathToFileURL(join(ROOT, 'server', 'database.js')).href);
        // A copied library keeps its own switches: no model and no update check from the scratch server.
        const put = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
        put.run('ai_enabled', 'false');
        put.run('update_check', 'off');
        // Answered, or the app asks about it in a strip over every screen.
        put.run('update_check_asked', '1');
        cast = JSON.parse(readFileSync(join(dir, 'docs-shots.json'), 'utf8'));
        cast.ids = resolveCast(db, cast);
        if (cast.prove?.seed !== undefined) {
            if (!Number.isInteger(cast.prove.seed)) throw new Error('docs-shots.json: "prove.seed" must be a whole number');
            drawSeed = cast.prove.seed;
        }
    }
    await import(pathToFileURL(join(ROOT, 'server', 'index.js')).href);
    process.stdout.write(`DOCS-SHOTS-READY ${JSON.stringify({ dbPath: paths.dbPath, cast })}\n`);
}

/** Titles in docs-shots.json to the ids the routes take. */
function resolveCast(db, cast) {
    const project = db.prepare('SELECT id FROM projects WHERE name = ?').get(cast.project);
    if (!project) throw new Error(`docs-shots.json: no course named "${cast.project}"`);
    const topic = (title) => {
        if (!title) return null;
        const row = db.prepare('SELECT id FROM nodes WHERE project_id = ? AND title = ?').get(project.id, title);
        if (!row) throw new Error(`docs-shots.json: no topic "${title}" in "${cast.project}"`);
        return row.id;
    };
    return { project: project.id, study: topic(cast.study?.topic), prove: topic(cast.prove?.topic), cards: topic(cast.cards?.topic) };
}

function freePort() {
    return new Promise((ok, bad) => {
        const s = createServer();
        s.once('error', bad);
        s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); });
    });
}

async function startServer(mode, dir) {
    const port = await freePort();
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), CHILD_FLAG, JSON.stringify({ mode, dir, port })], {
        cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    const ready = new Promise((ok, bad) => {
        const read = (chunk) => {
            log += chunk;
            const m = log.match(/DOCS-SHOTS-READY (.+)\n/);
            if (m && /Server running at (https?):/.test(log)) ok({ ...JSON.parse(m[1]), scheme: log.match(/Server running at (https?):/)[1] });
        };
        child.stdout.on('data', read);
        child.stderr.on('data', (c) => { log += c; });
        child.once('exit', (code) => bad(new Error(`the scratch server exited (${code}):\n${log.slice(-3000)}`)));
    });
    const exited = new Promise((r) => child.once('exit', r));
    const stop = () => { child.kill(); return exited; };
    let info;
    let timer;
    try {
        // A timer left running would hold the run open for its full two minutes after the last screen.
        const late = new Promise((_, bad) => { timer = setTimeout(() => bad(new Error(`the scratch server did not start:\n${log.slice(-3000)}`)), 120_000); });
        info = await Promise.race([ready, late]);
    } catch (err) {
        await stop();
        throw err;
    } finally {
        clearTimeout(timer);
    }
    if (!resolve(info.dbPath).startsWith(resolve(dir))) { await stop(); throw new Error(`the server answered for ${info.dbPath}, not the scratch library`); }
    return { ...info, base: `${info.scheme}://127.0.0.1:${port}`, log: () => log, exitCode: () => child.exitCode, stop };
}

// ---------------------------------------------------------------------------
// The browser, over the DevTools protocol.
// ---------------------------------------------------------------------------

function findBrowser(explicit) {
    if (explicit) return explicit;
    if (process.env.BROWSER_PATH) return process.env.BROWSER_PATH;
    const candidates = process.platform === 'win32'
        ? ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
            'C:/Program Files/Google/Chrome/Application/chrome.exe']
        : process.platform === 'darwin'
            ? ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
            : ['/usr/bin/google-chrome', '/usr/bin/microsoft-edge', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
    const found = candidates.find((p) => existsSync(p));
    if (!found) throw new Error('no Chromium-based browser found: pass --browser <path> or set BROWSER_PATH');
    return found;
}

async function openBrowser(exe, { width, height, scale }) {
    const port = await freePort();
    const profile = mkdtempSync(join(tmpdir(), 'docs-shots-browser-'));
    const args = ['--headless=new', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
        '--mute-audio', '--lang=en-US', '--accept-lang=en-US', '--force-color-profile=srgb', '--ignore-certificate-errors',
        `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'];
    // A Linux CI runner refuses Chromium's user-namespace sandbox.
    if (process.platform === 'linux' && process.env.CI) args.unshift('--no-sandbox');
    const proc = spawn(exe, args, { stdio: 'ignore' });
    let gone = null;
    const exited = new Promise((r) => proc.once('exit', r));
    proc.once('error', (err) => { gone = err; });
    proc.once('exit', (code) => { gone ??= new Error(`the browser exited (${code})`); });
    let wsUrl;
    for (let i = 0; i < 120 && !wsUrl && !gone; i++) {
        try {
            const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
            wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl;
        } catch { /* not listening yet */ }
        if (!wsUrl) await sleep(250);
    }
    if (!wsUrl) { proc.kill(); await Promise.race([exited, sleep(10_000)]); removeScratch(profile); throw new Error(gone ? `${exe}: ${gone.message}` : `${exe} did not open a DevTools port`); }
    const ws = new WebSocket(wsUrl);
    await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = () => bad(new Error('the DevTools socket did not open')); });
    let next = 0;
    const pending = new Map();
    // A browser that crashes mid-state would leave every call waiting for ever.
    const fail = (why) => { for (const p of pending.values()) p.bad(new Error(why)); pending.clear(); };
    ws.onclose = () => fail('the DevTools socket closed');
    proc.once('exit', (code) => fail(`the browser exited (${code})`));
    // Requests the browser gave up on, with its own reason ("net::ERR_…"): "Failed to fetch" says neither.
    const urls = new Map();
    const failed = [];
    // The page's own API calls still unanswered, and when the last answer came. Only
    // those: a frame in its own process, the browser's icon fetch and a request kept
    // alive past its page report their end elsewhere or never. An answer counts when it
    // starts to arrive, so a stream of live updates is not waited on for ever.
    const inflight = new Set();
    let lastEnded = Date.now();
    const answered = (id) => { if (inflight.delete(id)) lastEnded = Date.now(); };
    ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.method === 'Network.requestWillBeSent') {
            urls.set(m.params.requestId, `${m.params.request.method} ${m.params.request.url}`);
            if (/^(Fetch|XHR)$/.test(m.params.type) && new URL(m.params.request.url).pathname.startsWith('/api/')) inflight.add(m.params.requestId);
        }
        if (m.method === 'Network.responseReceived' || m.method === 'Network.loadingFinished' || m.method === 'Network.loadingFailed') answered(m.params.requestId);
        if (m.method === 'Network.loadingFailed') failed.push(`${urls.get(m.params.requestId) ?? m.params.requestId}: ${m.params.errorText}${m.params.canceled ? ' (cancelled)' : ''}`);
        if (m.id === undefined) return;
        const p = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) p.bad(new Error(m.error.message)); else p.ok(m.result);
    };
    const send = (method, params = {}) => new Promise((ok, bad) => {
        if (gone || ws.readyState !== WebSocket.OPEN) return bad(new Error(`the browser is gone (${method})`));
        const id = ++next;
        pending.set(id, { ok, bad });
        ws.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expression) => {
        const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
        return r.result.value;
    };
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');
    await send('Emulation.setLocaleOverride', { locale: 'en-US' }).catch(() => { });
    // The server keeps days in UTC; a page in UTC sees the same day on every machine.
    await send('Emulation.setTimezoneOverride', { timezoneId: 'UTC' }).catch(() => { });
    // A Windows Server runner has the system's animations off, so the browser
    // reports reduced motion and a lesson's animation opens paused ("Play").
    // The pictures show it with motion on, as a desktop has it.
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
    const close = async () => {
        ws.onclose = null;
        try { ws.close(); } catch { /* closed */ }
        proc.kill();
        // The profile is locked until the browser has gone.
        await Promise.race([exited, sleep(10_000)]);
        removeScratch(profile);
    };
    /** The requests that failed since the last call, and forget them. */
    const failures = () => failed.splice(0);
    /**
     * Wait until no request has been on its way for `quiet` ms: a screen whose
     * data arrives late (the course card's pace line) is read after it lands.
     */
    /** Forget the calls a page left behind, so one state does not wait on another's. */
    const forget = () => inflight.clear();
    const settled = async (quiet = 500, most = 15_000) => {
        for (const t0 = Date.now(); Date.now() - t0 < most;) {
            if (!inflight.size && Date.now() - lastEnded >= quiet) return [];
            await sleep(100);
        }
        return [...inflight].map((id) => urls.get(id) ?? id);
    };
    return { send, evaluate, close, failures, settled, forget };
}

/** The page-side helpers every state uses, bound to one browser and one server. */
function pageKit(browser, base) {
    const { send, evaluate } = browser;
    const kit = {
        evaluate,
        go: async (path, needle) => {
            // Mark the page being left: until the navigation commits, its document still answers.
            await evaluate('window.__docsLeaving = true').catch(() => { });
            await send('Page.navigate', { url: base + path });
            const arrived = '!window.__docsLeaving && document.readyState === "complete"';
            await kit.waitFor(needle ? `${arrived} && document.body.innerText.includes(${JSON.stringify(needle)})` : arrived, needle ? `"${needle}" at ${path}` : path);
            await evaluate('document.fonts.ready.then(() => 1)');
        },
        waitFor: async (expr, what, ms = 30_000) => {
            for (const t0 = Date.now(); Date.now() - t0 < ms;) {
                if (await evaluate(`!!(${expr})`).catch(() => false)) return;
                await sleep(250);
            }
            throw new Error(`timed out waiting for ${what}`);
        },
        /** Press an element like a pointer would: move, press, release at its centre. */
        press: async (expr, what) => {
            const p = await evaluate(`(() => { const e = ${expr}; if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
            if (!p) throw new Error(`nothing to press: ${what}`);
            await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
            for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
            await sleep(600);
        },
        /** Park the pointer where it hovers nothing. */
        rest: async () => {
            const { w, h } = await evaluate('({ w: innerWidth, h: innerHeight })');
            await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: w - 1, y: h - 1 });
            await sleep(400);
        },
        setting: (key, value) => evaluate(`fetch('/api/settings/${key}', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: ${JSON.stringify(value)} }) }).then((r) => r.status)`),
        png: async () => Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
    };
    return kit;
}

const byText = (selector, re) => `[...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => ${re}.test((e.textContent || '').trim()))`;
const DIALOG = `document.querySelector('[role="dialog"]')`;

// ---------------------------------------------------------------------------
// The states. Each one reaches a screen the way a learner would; `cast` says
// which course and topics, `ids` their ids in the library being served.
// ---------------------------------------------------------------------------

const STATES = {
    async 'calendar-month'(page, { ids }) {
        await page.go(`/project/${ids.project}/calendar`, 'Today');
        await page.press(byText('button', '/^Month$/'), 'the Month view');
        await sleep(1500);
    },

    async 'study-lesson'(page, { ids, cast }) {
        if (cast.study.uiScale) await page.setting('ui_scale', cast.study.uiScale);
        await page.go(`/project/${ids.project}/study/${ids.study}`, cast.study.heading);
        const heading = byText('h1, h2, h3, h4', `/^${escapeRe(cast.study.heading)}/`);
        await page.evaluate(`(async () => {
            const el = ${heading};
            let s = el.parentElement;
            while (s && !(s.scrollHeight > s.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(s).overflowY))) s = s.parentElement;
            if (s) s.scrollTop += el.getBoundingClientRect().top - s.getBoundingClientRect().top - 8;
            await new Promise((r) => setTimeout(r, 2500));
            // An animation is shown at one fixed moment, the same in every run.
            for (const svg of document.querySelectorAll('svg')) if (svg.pauseAnimations && svg.querySelector('animate, animateMotion, animateTransform')) { svg.pauseAnimations(); svg.setCurrentTime(2.3); }
            return 1;
        })()`);
        await sleep(600);
    },

    async 'mastery-result'(page, { ids, cast }) {
        await page.go(`/project/${ids.project}/tree/${ids.prove}`, 'Details');
        await page.press(`document.querySelector('button[title="Completed"]')`, 'the Completed status');
        await page.waitFor(`${DIALOG} && /Question \\d+ of \\d+/.test(${DIALOG}.innerText)`, 'the mastery check');
        const keys = await page.evaluate(`fetch('/api/ai/quizzes/${ids.prove}').then((r) => r.json())`);
        await answerCheck(page, keys, cast.prove.wrong ?? 0);
        await page.waitFor(`${DIALOG} && /Review Answers/i.test(${DIALOG}.innerText)`, 'the result');
        await sleep(1500);
        await fitScroll(page);
    },

    async 'card-review'(page, { ids, cast }) {
        const study = byText('button', '/^Study [\\d.,\\s]+ cards?$/');
        await page.go(`/project/${ids.project}/dashboard`, null);
        await page.waitFor(study, 'the cards owed');
        await page.press(study, 'Study the cards owed');
        const flip = `document.querySelector('[aria-label="Flip flashcard"]')`;
        await page.waitFor(flip, 'a card');
        // The session's own Skip rates nothing: pass cards until one from the named topic.
        const from = `(() => { const e = [...document.querySelectorAll('*')].find((x) => x.children.length > 1 && /^From:/.test((x.innerText || '').trim())); return e ? e.innerText.replace(/\\s+/g, ' ') : ''; })()`;
        for (let i = 0; cast.cards?.topic && !(await page.evaluate(from)).includes(cast.cards.topic); i++) {
            if (i === 80) throw new Error(`no card from "${cast.cards.topic}" in the first 80 of the session`);
            await page.press(byText('button', '/^Skip$/'), 'Skip');
        }
        await page.press(flip, 'the card');
        await sleep(1500);
    },

    async 'atlas-terra'(page) {
        await page.setting('atlas_color_mode', 'mastery');
        const terra = byText('button', '/^Terra$/');
        await page.go('/atlas', null);
        await page.waitFor(terra, 'the Terra switch');
        await page.press(terra, 'Terra');
        await sleep(1500);
        const stop = `document.querySelector('[aria-label="Stop turning"]')`;
        if (await page.evaluate(`!!${stop}`)) await page.press(stop, 'Stop turning');
        await sleep(3000);
    },

    async projects(page) {
        await page.go('/projects', 'New');
    },

    async 'new-course'(page) {
        await page.go('/projects', 'New');
        await page.press(byText('button', '/^New (course|project)$/i'), 'New course');
        await page.waitFor(DIALOG, 'the new course dialog');
        await sleep(800);
    },

    async 'course-dashboard'(page, { ids }) {
        await page.go(`/project/${ids.project}/dashboard`, 'Dashboard');
        await sleep(1500);
    },

    async 'topic-assistant'(page, { ids }) {
        await page.go(`/project/${ids.project}/tree/${ids.study}`, 'Details');
        await page.press(`document.querySelector('[aria-label="Ask the assistant"]')`, 'the assistant');
        await page.waitFor(`document.querySelector('aside[aria-label="Assistant"]')`, 'the assistant drawer');
        await sleep(1000);
    },

    async 'study-question'(page, { ids }) {
        await page.go(`/project/${ids.project}/study/${ids.study}`, 'Check your understanding');
        const q = byText('h1, h2, h3, h4, p, div', '/^Check your understanding/');
        await page.evaluate(`(${q}).scrollIntoView({ block: 'start' }), 1`);
        await sleep(1500);
    },
};

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/**
 * Answer every question of the open check with its key, except one: the
 * question whose wording contains `wrong` when it is text, the `wrong`-th
 * question (1-based) when it is a number. It gets its first option that is
 * not the key.
 */
async function answerCheck(page, quizzes, wrong) {
    const keys = (Array.isArray(quizzes) ? quizzes : quizzes?.quizzes ?? [])
        .flatMap((q) => (typeof q.questions === 'string' ? JSON.parse(q.questions) : q.questions ?? []))
        .map((q) => ({ stem: q.question, key: String(q.correct_answer ?? ''), options: q.options ?? [] }));
    let missed = 0;
    for (let n = 1; n <= 20; n++) {
        const open = await page.evaluate(`!!${DIALOG} && /Question \\d+ of \\d+/.test(${DIALOG}.innerText)`);
        if (!open) {
            if (wrong && !missed) throw new Error(`docs-shots.json: no question of the check matches "wrong": ${JSON.stringify(wrong)}`);
            return;
        }
        const picked = await page.evaluate(`(() => {
            const keys = ${JSON.stringify(keys)};
            const flat = (s) => (s || '').replace(/\\$/g, '').replace(/\\\\displaystyle/g, '').replace(/\\s+/g, '');
            const plain = (el) => { const c = el.cloneNode(true); c.querySelectorAll('.katex').forEach((k) => { const a = k.querySelector('annotation'); k.replaceWith(document.createTextNode(a ? a.textContent : k.textContent)); }); return flat(c.textContent); };
            const d = ${DIALOG};
            const text = plain(d);
            const k = keys.find((k) => text.includes(flat(k.stem).slice(0, 40)));
            if (!k) return 'no key for this question';
            const wrong = ${JSON.stringify(wrong)};
            const miss = typeof wrong === 'string' ? flat(k.stem).includes(flat(wrong)) : ${n} === wrong;
            const want = miss ? flat(k.options.find((o) => flat(o) !== flat(k.key)) || '') : flat(k.key);
            const buttons = [...d.querySelectorAll('button')];
            const b = buttons.find((b) => want && plain(b).endsWith(want)) || buttons.find((b) => plain(b) === want);
            if (!b) return 'no option reading ' + want;
            b.setAttribute('data-docs-pick', '');
            return miss ? 'missed' : 'ok';
        })()`);
        if (picked === 'missed') missed++;
        else if (picked !== 'ok') throw new Error(`question ${n}: ${picked}`);
        await page.press(`document.querySelector('[data-docs-pick]')`, `the answer to question ${n}`);
        await page.evaluate(`document.querySelector('[data-docs-pick]')?.removeAttribute('data-docs-pick'), 1`);
        const next = byText('[role="dialog"] button', '/^(Next|Submit|Finish)/');
        if (await page.evaluate(`!!(${next})`)) await page.press(next, 'Next');
        await sleep(700);
    }
}

/** Scroll the result so neither edge of its scroll area cuts through a line or an icon. */
async function fitScroll(page) {
    await page.evaluate(`(() => {
        const d = ${DIALOG};
        const s = [...d.querySelectorAll('*')].find((e) => e.scrollHeight > e.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(e).overflowY));
        if (!s) return 0;
        s.scrollTop = 0;
        const box = s.getBoundingClientRect();
        const spans = [];
        const walker = document.createTreeWalker(s, NodeFilter.SHOW_TEXT);
        for (let n; (n = walker.nextNode());) {
            if (!n.textContent.trim()) continue;
            const r = document.createRange();
            r.selectNodeContents(n);
            for (const q of r.getClientRects()) spans.push([q.top - box.top, q.bottom - box.top]);
        }
        for (const e of s.querySelectorAll('*')) { const q = e.getBoundingClientRect(); if (q.height > 0 && q.height < 120) spans.push([q.top - box.top, q.bottom - box.top]); }
        // The least scroll that cuts no line at either edge, so the top of the result (the score) stays in view.
        let best = null;
        for (let y = 0; y <= Math.min(240, s.scrollHeight - s.clientHeight); y++) {
            let margin = Infinity;
            for (const [a, b] of spans) {
                for (const edge of [y, y + s.clientHeight]) {
                    if (edge === 0) continue;
                    if (edge > a - 2 && edge < b + 2) { margin = -1; break; }
                    margin = Math.min(margin, Math.abs(edge - a), Math.abs(edge - b));
                }
                if (margin < 0) break;
            }
            if (margin >= 2) { best = { y, margin }; break; }
        }
        if (best) s.scrollTop = best.y;
        return best ? best.y : 0;
    })()`);
    await sleep(600);
}

// ---------------------------------------------------------------------------
// A screen's interface text: what the check compares.
// ---------------------------------------------------------------------------

/**
 * Every visible piece of text and every visible label attribute: its centre as
 * a fraction of the window, and `cut`, how far it is from the nearest edge
 * that could cut it off (the window's bottom, or an edge of a box that
 * scrolls), in the same units.
 */
const COLLECT = `(() => {
    const W = innerWidth, H = innerHeight, out = [];
    // Shown, and not scrolled out of a box that clips it: the point must be inside every such box.
    const place = (el, x, y) => {
        let cut = H - y;
        for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
            const s = getComputedStyle(e);
            if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return null;
            if (e !== el && (s.overflowX !== 'visible' || s.overflowY !== 'visible')) {
                const c = e.getBoundingClientRect();
                if (x < c.left || x > c.right || y < c.top || y > c.bottom) return null;
                if (e.scrollHeight > e.clientHeight + 1) cut = Math.min(cut, c.bottom - y);
                // A box scrolled down can also lose a line over its top edge.
                if (e.scrollTop > 0) cut = Math.min(cut, y - c.top);
            }
        }
        return cut;
    };
    const add = (text, rect, el) => {
        text = (text || '').replace(/\\s+/g, ' ').trim();
        if (!text || text.length > 160 || rect.width < 1 || rect.height < 1) return;
        const x = (rect.left + rect.right) / 2, y = (rect.top + rect.bottom) / 2;
        if (x < 0 || y < 0 || x > W || y > H) return;
        const cut = place(el, x, y);
        if (cut === null) return;
        out.push({ text, x: x / W, y: y / H, cut: cut / H });
    };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n; (n = walker.nextNode());) {
        if (!n.textContent.trim() || !n.parentElement) continue;
        const r = document.createRange();
        r.selectNodeContents(n);
        add(n.textContent, r.getBoundingClientRect(), n.parentElement);
    }
    for (const el of document.querySelectorAll('[aria-label], [title], [placeholder]')) {
        const r = el.getBoundingClientRect();
        for (const a of ['aria-label', 'title', 'placeholder']) if (el.hasAttribute(a)) add(el.getAttribute(a), r, el);
    }
    return out;
})()`;

/** The interface's own strings: exact ones, and patterns for those with a `{{value}}`. */
function catalogue() {
    const en = JSON.parse(readFileSync(join(ROOT, 'src', 'locales', 'en.json'), 'utf8'));
    const exact = new Set();
    const patterns = [];
    for (const value of new Set(Object.values(en))) {
        if (typeof value !== 'string') continue;
        if (!value.includes('{{')) {
            if (value.trim().length > 1) exact.add(value.trim());
            continue;
        }
        const parts = value.split(/(\{\{[^}]+\}\})/);
        const literal = parts.filter((_, i) => i % 2 === 0);
        // A string that is mostly its values ("{{a}} · {{b}}") would match course text.
        if (literal.join('').replace(/[^\p{L}]/gu, '').length < 3) continue;
        // A count is a number, so "{{count}} days" is not read into a quiz answer such as "About 29.5 days".
        const source = parts.map((p, i) => (i % 2 === 0 ? p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : p === '{{count}}' ? '\\d[\\d.,\\s]*?' : '.+?')).join('');
        patterns.push({ value, re: new RegExp(`^${source}$`, 'su') });
    }
    return { exact, patterns };
}

const ZONES_X = ['left', 'centre', 'right'];
const ZONES_Y = ['top', 'middle', 'bottom'];
/**
 * How far text may sit from where it was and still count as the same place,
 * as a share of the window. The app draws in the system's own font, so the
 * same screen wraps a little differently from one machine to the next; a label
 * that moved further than this moved on purpose.
 */
const SLACK = 0.04;

const zoneOf = (x, y) => `${ZONES_Y[Math.min(2, Math.max(0, Math.floor(y * 3)))]}-${ZONES_X[Math.min(2, Math.max(0, Math.floor(x * 3)))]}`;
/** Every part of the window a point could be read as being in, allowing for SLACK. */
const zonesNear = (x, y) => new Set([-SLACK, SLACK].flatMap((dx) => [-SLACK, SLACK].map((dy) => zoneOf(x + dx, y + dy))));

/**
 * The interface's labels on a screen. `edge` marks text close enough to an
 * edge that another machine's wrapping could push it out of sight: it is
 * never recorded and never counted as new, but it does count as still there.
 */
function screenItems(items, { exact, patterns }) {
    const out = [];
    for (const { text, x, y, cut } of items) {
        const value = exact.has(text) ? text : patterns.find((p) => p.re.test(text))?.value;
        // Twice the slack: a label just inside the band when recorded may sit just outside it on another machine.
        if (value) out.push({ value, text, x, y, edge: cut < 2 * SLACK });
    }
    return out;
}

/** What the manifest records: each label once per part of the window it is in. */
const recordOf = (items) => [...new Set(items.filter((i) => !i.edge).map(({ value, x, y }) => `${value} · ${zoneOf(x, y)}`))].sort();

/** Labels on the screen that the record does not have, and recorded labels the screen no longer shows. */
function compareScreen(recorded, items) {
    const was = new Set(recorded ?? []);
    const added = new Set();
    for (const { value, text, x, y, edge } of items) {
        if (edge) continue;
        // A label with a value in it says what it read, so the line can be found on the screen.
        if (![...zonesNear(x, y)].some((z) => was.has(`${value} · ${z}`))) added.add(`${value} · ${zoneOf(x, y)}${value === text ? '' : `  ("${text}")`}`);
    }
    const gone = [...was].filter((label) => {
        const [, value, zone] = label.match(/^(.*) · (\w+-\w+)$/s);
        return !items.some((i) => i.value === value && zonesNear(i.x, i.y).has(zone));
    });
    return { added: [...added].sort(), gone };
}

// ---------------------------------------------------------------------------
// Pictures.
// ---------------------------------------------------------------------------

async function writeWebp(png, file, quality) {
    const { loadImage, createCanvas } = await import('@napi-rs/canvas');
    const img = await loadImage(png);
    const canvas = createCanvas(img.width, img.height);
    canvas.getContext('2d').drawImage(img, 0, 0);
    writeFileSync(file, await canvas.encode('webp', quality));
}

// ---------------------------------------------------------------------------
// The run.
// ---------------------------------------------------------------------------

function parseArgs(argv) {
    const opts = { only: null, library: null, accept: null, out: null, browser: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const value = () => argv[++i];
        if (a === '--only') opts.only = value().split(',');
        else if (a === '--library') opts.library = value();
        else if (a === '--out') opts.out = value();
        else if (a === '--browser') opts.browser = value();
        else if (a === '--fixture-shots') opts.debug = resolve(value());
        else if (a === '--accept') opts.accept = argv[i + 1] && !argv[i + 1].startsWith('--') ? value().split(',') : [];
        else throw new Error(`unknown argument: ${a}`);
    }
    return opts;
}

/** Copy a data folder (or one .db file) into a fresh scratch folder, without its credentials. */
function copyLibrary(from) {
    const src = resolve(from);
    const dir = statSync(src).isDirectory() ? src : dirname(src);
    const db = statSync(src).isDirectory()
        ? readdirSync(dir).filter((f) => f.endsWith('.db')).map((f) => join(dir, f))
        : [src];
    if (db.length !== 1) throw new Error(`expected one .db file in ${dir}, found ${db.length}`);
    if (!existsSync(join(dir, 'docs-shots.json'))) throw new Error(`no docs-shots.json in ${dir}: it names the course and topics to shoot`);
    const scratch = mkdtempSync(join(tmpdir(), 'docs-shots-library-'));
    try {
        cpSync(join(dir, 'docs-shots.json'), join(scratch, 'docs-shots.json'));
        cpSync(db[0], join(scratch, 'library.db'));
        if (existsSync(`${db[0]}-wal`)) cpSync(`${db[0]}-wal`, join(scratch, 'library.db-wal'));
        if (existsSync(join(dir, 'vault'))) cpSync(join(dir, 'vault'), join(scratch, 'vault'), { recursive: true });
    } catch (err) {
        removeScratch(scratch);
        throw err;
    }
    return { scratch, dir };
}

async function visit(mode, dir, entries, viewport, browserPath, onState, prepare) {
    const server = await startServer(mode, dir);
    let browser;
    try {
        browser = await openBrowser(browserPath, viewport);
    } catch (err) {
        await server.stop();
        throw err;
    }
    const page = pageKit(browser, server.base);
    try {
        await page.go('/settings', 'Settings');
        await page.setting('theme', 'light');
        await page.setting('ui_language', 'en');
        if (prepare) {
            const call = (method) => (path, body) => page.evaluate(`fetch(${JSON.stringify(path)}, { method: '${method}', headers: { 'content-type': 'application/json' }${body === undefined ? '' : `, body: ${JSON.stringify(JSON.stringify(body))}`} }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }))`);
            const ids = await prepare({ dbPath: server.dbPath, ids: server.cast.ids, cast: server.cast, api: { get: call('GET'), post: call('POST'), put: call('PUT'), delete: call('DELETE') } });
            if (ids) server.cast.ids = ids;
        }
        for (const entry of entries) {
            for (const state of entry.states) {
                // Each state starts from a fresh page, and one that runs no study clock: the home
                // stream credits its top card with the seconds spent on it, and that time would
                // then show on whichever screen comes later. A request the browser drops between
                // two pages is the transport's doing, not the screen's: start that page again,
                // once, and say so, so a cause that keeps coming back is seen.
                for (let attempt = 1; ; attempt++) {
                    browser.failures();
                    browser.forget();
                    try {
                        await page.go('/projects', null);
                        await page.setting('ui_scale', 100);
                        break;
                    } catch (err) {
                        if (attempt === 2 || !/Failed to fetch/.test(err.message)) throw err;
                        console.error(`docs-shots: ${state}: a request failed on the way in, starting the page again:\n  ${browser.failures().slice(-6).join('\n  ') || '(the browser named none)'}`);
                    }
                }
                await STATES[state](page, { ids: server.cast.ids, cast: server.cast });
                await page.rest();
                const open = await browser.settled();
                // Said, so a request that never ends (and costs every state its wait) is seen.
                if (open.length) console.error(`docs-shots: ${state}: still waiting on ${open.join(', ')}`);
                await sleep(200);
                await onState(entry, state, page, server);
            }
        }
    } catch (err) {
        // Where the state stopped: a picture and the buttons it could have pressed.
        const stopped = join(tmpdir(), 'docs-shots-stopped.png');
        try {
            writeFileSync(stopped, await page.png());
            const buttons = await page.evaluate(`[...document.querySelectorAll('button, a, [role="button"], [role="tab"]')].filter((b) => b.getClientRects().length).map((b) => (b.getAttribute('aria-label') || b.getAttribute('title') || b.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40)).filter(Boolean).slice(0, 40).join(' | ')`);
            err.message += `\n--- the screen it stopped on: ${stopped}\n--- its buttons: ${buttons}`;
        } catch { /* the browser went with the error */ }
        const answers = await fetch(`${server.base}/api/build`).then((r) => r.status, (e) => e.cause?.code ?? e.message);
        err.message += `\n--- server: exit code ${server.exitCode()}, /api/build answers ${answers}`;
        err.message += `\n--- requests the browser dropped: ${browser.failures().slice(-10).join(' | ') || 'none'}`;
        err.message += `\n--- server log ---\n${server.log().slice(-2000)}`;
        throw err;
    } finally {
        await browser.close();
        await server.stop();
    }
}

/**
 * Remove a scratch folder; the server's and the browser's file handles can
 * outlive their exit by a moment on Windows. A folder that stays locked is
 * named, not thrown: it would hide the run's own result or error.
 */
function removeScratch(dir) {
    try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    } catch (err) {
        console.error(`docs-shots: could not remove ${dir} (${err.code ?? err.message}); delete it by hand`);
    }
}
async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (!existsSync(join(ROOT, 'dist', 'index.html'))) throw new Error('no dist/: run `npm run build` first');
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
    const name = (s) => basename(s.file).replace(/\.[^.]+$/, '');
    const picked = manifest.shots.filter((s) => !opts.only || opts.only.includes(name(s)));
    if (opts.only && picked.length !== opts.only.length) throw new Error(`--only: no picture named ${opts.only.filter((n) => !picked.some((s) => name(s) === n)).join(', ')}`);
    const statesOf = (s) => ({ shot: s, states: s.clip ? Object.keys(s.scenes) : [s.state] });
    const entries = picked.map(statesOf);
    // A screen can carry what earlier screens did to the library (a finished check,
    // time on the clock), so the fixture is walked in the manifest's order from the
    // first picture up to the last one named: a screen is recorded and checked
    // after the same screens, whichever pictures a run names.
    const walk = manifest.shots.slice(0, Math.max(...picked.map((s) => manifest.shots.indexOf(s))) + 1).map(statesOf);
    const browserPath = findBrowser(opts.browser);
    const cat = catalogue();

    if (opts.library) {
        if (!entries.some((e) => !e.shot.clip)) throw new Error('--library re-shoots stills, and no still was named: a clip is filmed, then `--accept <clip>`');
        const { scratch, dir } = copyLibrary(opts.library);
        const out = opts.out ? resolve(opts.out) : SHOTS;
        mkdirSync(out, { recursive: true });
        try {
            const stills = entries.filter((e) => !e.shot.clip);
            const t0 = Date.now();
            const named = JSON.parse(readFileSync(join(dir, 'docs-shots.json'), 'utf8')).prepare;
            const prepare = named ? (await import(pathToFileURL(resolve(dir, named)).href)).default : null;
            await visit('library', scratch, stills, manifest.viewport, browserPath, async (entry, _state, page) => {
                const png = await page.png();
                // A folder of one's own also gets the lossless picture, to look at; the repository keeps the webp.
                if (opts.out) writeFileSync(join(out, `${name(entry.shot)}.png`), png);
                await writeWebp(png, join(out, basename(entry.shot.file)), manifest.webpQuality);
                console.log(`shot ${entry.shot.file}`);
            }, prepare);
            console.log(`re-shot ${stills.length} still(s) in ${((Date.now() - t0) / 1000).toFixed(1)} s from a copy of ${dir}`);
        } finally {
            removeScratch(scratch);
        }
        opts.accept = picked.filter((s) => !s.clip).map(name);
    }

    const fixture = mkdtempSync(join(tmpdir(), 'docs-shots-fixture-'));
    const seen = new Map();
    const t0 = Date.now();
    try {
        const { prepare } = await import(pathToFileURL(FIXTURE).href);
        await visit('fixture', fixture, walk, manifest.viewport, browserPath, async (entry, state, page) => {
            seen.set(`${name(entry.shot)}/${state}`, screenItems(await page.evaluate(COLLECT), cat));
            if (opts.debug) writeFileSync(join(opts.debug, `${name(entry.shot)}-${state}.png`), await page.png());
        }, prepare);
    } finally {
        removeScratch(fixture);
    }
    const seconds = ((Date.now() - t0) / 1000).toFixed(1);

    if (opts.accept) {
        for (const s of picked) {
            if (opts.accept.length && !opts.accept.includes(name(s))) continue;
            if (s.clip) for (const scene of Object.keys(s.scenes)) s.scenes[scene] = recordOf(seen.get(`${name(s)}/${scene}`));
            else s.screen = recordOf(seen.get(`${name(s)}/${s.state}`));
        }
        writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
        console.log(`recorded the screens of ${opts.accept.length ? opts.accept.join(', ') : 'every picture'} in ${seconds} s`);
        return;
    }

    let stale = 0;
    for (const s of picked) {
        const states = s.clip ? Object.entries(s.scenes) : [[s.state, s.screen]];
        for (const [state, recorded] of states) {
            const { added, gone } = compareScreen(recorded, seen.get(`${name(s)}/${state}`));
            if (!added.length && !gone.length) continue;
            stale++;
            console.log(`\ndocs/screenshots/${s.file}${s.clip ? ` (scene "${state}")` : ''} shows a screen that changed:`);
            for (const l of gone) console.log(`  - ${l}`);
            for (const l of added) console.log(`  + ${l}`);
        }
    }
    if (stale) {
        console.log(`\n${stale} screen(s) changed (checked in ${seconds} s). Re-shoot the stills with --library <dir>, re-film a clip,`);
        console.log('or, when the picture still tells the truth, record the screen as it is with --accept <name>.');
        process.exitCode = 1;
    } else {
        console.log(`every picture matches its screen (${picked.length} picture(s), checked in ${seconds} s)`);
    }
}

if (process.argv[2] === CHILD_FLAG) await serveChild(JSON.parse(process.argv[3]));
else await main();
