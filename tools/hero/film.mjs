#!/usr/bin/env node
/**
 * Films the README hero: an empty library, a new course drafted by the model, its first topic
 * explained with a drawing by the assistant, then one question answered and marked. One
 * continuous take, no camera moves; the model's replies come from recordings (serve.mjs).
 *
 *   node tools/hero/film.mjs --recorder <demo.mjs> --cassettes <dir> [options]
 *
 *   --recorder <file>     the screen recorder module (exports record(opts, script)); env HERO_RECORDER
 *   --cassettes <dir>     recorded model replies (see serve.mjs); env HERO_CASSETTES
 *   --work <dir>          scratch folder for the library, frames and checks (default: a new temp folder)
 *   --out <file>          the clip (default <work>/hero.webp)
 *   --port <n>            the app's port (default 3536)
 *   --stepped             frame-stepped capture: the page and the replayed model run on the film's
 *                         clock, so a busy machine films the same clip, only slower
 *   --until <scene>       stop after a scene: created | opened | end (default end)
 *   --wait-feed           after the course is drafted, cut until every topic's lessons are written
 *   --fallback-log, --order-logs, --no-fallback, --record, --max-usd, --max-real: passed to serve.mjs
 *
 * Env: HERO_NAME, HERO_DESCRIPTION (the course typed in), LAPSE (creation speed-up, default 3),
 * ANSWER_LAPSE (default 4).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const Database = createRequire(join(ROOT, 'package.json'))('better-sqlite3');

const opt = { recorder: process.env.HERO_RECORDER, cassettes: process.env.HERO_CASSETTES, port: 3536, until: 'end', pass: [] };
{
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        const v = () => { const x = argv[++i]; if (x === undefined) throw new Error(`${k} needs a value`); return x; };
        if (k === '--recorder') opt.recorder = v();
        else if (k === '--cassettes') opt.cassettes = v();
        else if (k === '--work') opt.work = v();
        else if (k === '--out') opt.out = v();
        else if (k === '--port') opt.port = Number(v());
        else if (k === '--stepped') opt.stepped = true;
        else if (k === '--until') opt.until = v();
        else if (k === '--wait-feed') opt.waitFeed = true;
        // Paths are resolved here: the server runs from the repository root, not from here.
        else if (k === '--fallback-log') opt.pass.push(k, resolve(v()));
        else if (k === '--order-logs') opt.pass.push(k, v().split(',').filter(Boolean).map((p) => resolve(p)).join(','));
        else if (['--no-fallback', '--max-usd', '--max-real'].includes(k)) opt.pass.push(k, v());
        else if (k === '--record') opt.pass.push(k);
        else throw new Error(`unknown option ${k}`);
    }
}
if (!opt.recorder || !opt.cassettes) throw new Error('usage: film.mjs --recorder <demo.mjs> --cassettes <dir> [options]');
const SCENES = ['created', 'opened', 'end'];
if (!SCENES.includes(opt.until)) throw new Error(`--until is one of ${SCENES.join(', ')}`);
const WORK = resolve(opt.work || mkdtempSync(join(tmpdir(), 'hero-film-')));
const LIB = join(WORK, 'library');
if (existsSync(LIB)) throw new Error(`every take needs a new library: ${LIB} exists`);
mkdirSync(WORK, { recursive: true });
const OUT = resolve(opt.out || join(WORK, 'hero.webp'));
const { record } = await import(pathToFileURL(resolve(opt.recorder)).href);

const NAME = process.env.HERO_NAME || 'Standing Waves';
const DESCRIPTION = process.env.HERO_DESCRIPTION || 'How standing waves form on a string and in a pipe, for a first-year physics exam';
const QUESTION = 'Explain this topic to me visually';
const LAPSE = Number(process.env.LAPSE || 3);
const ANSWER_LAPSE = Number(process.env.ANSWER_LAPSE || 4);
const BASE = `http://127.0.0.1:${opt.port}`;
const ASSIST = 'aside[aria-label="Assistant"]';
// The toasts and the floating update/help chips are not part of the story.
const HIDE_CSS = '.fixed.safe-top-4.z-\\[60\\], .fixed.safe-bottom-3.left-1\\/2.z-40 { display: none !important; }';
const HIDE_JS = `(() => { const s = document.createElement('style'); s.id = 'hero-hide'; s.textContent = ${JSON.stringify(HIDE_CSS)}; (document.head || document.documentElement).appendChild(s); })()`;
// While the film runs n times faster, every endless animation (a spinner, a pulse) runs 1/n as
// fast, so it turns at its real speed on screen.
const SLOW_JS = `(() => { if (window.__demoSlow) return 1; window.__demoSlow = 1; window.__demoRate = window.__demoRate || 1;
    setInterval(() => { for (const a of document.getAnimations()) { const t = a.effect && a.effect.getTiming && a.effect.getTiming(); if (t && t.iterations === Infinity && a.playbackRate !== window.__demoRate) a.playbackRate = window.__demoRate; } }, 50);
    return 1; })()`;
// A headless browser grants pointer lock and would hold the desktop's real mouse.
const NO_POINTER_LOCK = 'Element.prototype.requestPointerLock = function () { return Promise.resolve(); };';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const dbq = (sql, ...a) => { const db = new Database(join(LIB, 'library.db'), { readonly: true }); try { return db.prepare(sql).all(...a); } finally { db.close(); } };

// ---- the app -------------------------------------------------------------------------------
const logPath = join(WORK, 'server.log');
const serverArgs = [join(ROOT, 'tools', 'hero', 'serve.mjs'), '--library', LIB, '--port', String(opt.port), '--cassettes', resolve(opt.cassettes), ...opt.pass, ...(opt.stepped ? ['--film-clock'] : [])];
// Something already answering the port (an earlier run's server) would be driven instead.
if (await fetch(`${BASE}/api/build`).then(() => true, () => false)) throw new Error(`port ${opt.port} is already in use; pass another --port`);
const server = spawn(process.execPath, serverArgs,{ cwd: ROOT, stdio: ['ignore', openSync(logPath, 'a'), openSync(logPath, 'a')] });
let up = false;
for (let i = 0; i < 240 && !up; i++) {
    await sleep(500);
    if (server.exitCode !== null) break;
    up = readFileSync(logPath, 'utf8').includes('HERO-SERVER-READY') && await fetch(`${BASE}/api/build`).then((r) => r.ok, () => false);
}
if (!up) { server.kill(); throw new Error(`the app did not start; see ${logPath}`); }
const ready = JSON.parse(readFileSync(logPath, 'utf8').match(/HERO-SERVER-READY (.*)/)[1]);
if (resolve(ready.dbPath) !== resolve(join(LIB, 'library.db')) || ready.port !== opt.port) { server.kill(); throw new Error(`the server bound ${ready.port} for ${ready.dbPath}, not ${opt.port} for the take's library`); }
stamp('serving', LIB);
// The replayed model follows the film's clock (stepped takes only).
const onClock = opt.stepped ? (t, auto) => fetch(`${BASE}/__film/clock?t=${t}&auto=${auto ? 1 : 0}`).then(() => { }) : undefined;

async function lapse(d, n) {
    await d.evaluate(`(window.__demoRate = ${1 / n}, ${SLOW_JS})`);
    d.speed(n);
}
// Scroll `el`'s own scroller so it sits `offset` px below the viewport top, eased over `ms`.
const glide = (d, elExpr, offset, ms = 1600) => d.evaluate(`(async () => {
    const el = ${elExpr}; if (!el) return 'missing';
    let s = el.parentElement;
    while (s && !(s.scrollHeight > s.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(s).overflowY))) s = s.parentElement;
    if (!s) return 'no scroller';
    const from = s.scrollTop, to = Math.max(0, Math.min(s.scrollHeight - s.clientHeight, from + el.getBoundingClientRect().top - ${offset}));
    const t0 = performance.now();
    await new Promise(done => { const step = now => { const k = Math.min(1, (now - t0) / ${ms}); const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; s.scrollTop = from + (to - from) * e; k < 1 ? requestAnimationFrame(step) : done(); }; requestAnimationFrame(step); });
    return Math.round(el.getBoundingClientRect().top);
})()`);
// A glide runs on the page's clock: in a stepped take the film must step while it runs.
const glideFilmed = async (d, elExpr, offset, ms) => {
    const p = glide(d, elExpr, offset, ms);
    if (!opt.stepped) return p;
    let done = false, val;
    p.then((v) => { done = true; val = v; }, () => { done = true; });
    while (!done) await d.wait(50);
    return val;
};
// The cursor onto what is being shown, a little in from the element's left edge.
async function pointAt(d, expr, ms = 800, at = 0.35) {
    const p = await d.evaluate(`(() => { const e = ${expr}; if (!e) return null; const r = e.getBoundingClientRect(); if (!r.height) return null; return [Math.round(r.left + Math.min(r.width * ${at}, 160)), Math.round(r.top + Math.min(r.height / 2, 14))]; })()`).catch(() => null);
    if (!p || p[1] < 70 || p[1] > 770) return false;
    await d.move({ x: p[0], y: p[1] }, { ms });
    return true;
}
const ANSWER_TAIL = `[...(document.querySelector('${ASSIST}') || document.createElement('i')).querySelectorAll('p, li')].filter(e => { const r = e.getBoundingClientRect(); return r.height && r.top < 740; }).pop()`;
const RICH_VISUAL = `[...(document.querySelector('${ASSIST}') || document).querySelectorAll('.visual-block')].find(v => {
    if (/Couldn't render|Draw it|Rendering|Generating|Drawing/.test(v.innerText)) return false;
    return [...v.querySelectorAll('svg animate, svg animateMotion, svg animateTransform, canvas, iframe')]
        .some(e => (e.closest('svg, canvas, iframe') || e).getBoundingClientRect().height > 140);
})`;
// Wall-clock limits: a stepped take runs slower than the film it makes.
const limit = (ms) => (opt.stepped ? ms * 4 : ms);

// The topic the film opens: nodes and antinodes draw best, else harmonics, else the fifth topic.
function pickTopic() {
    const db = new Database(join(LIB, 'library.db'), { readonly: true });
    try {
        const pid = db.prepare('SELECT id FROM projects ORDER BY id DESC LIMIT 1').get().id;
        const leaves = db.prepare(`WITH RECURSIVE t(id, title, path) AS (
                SELECT id, title, printf('%06d', COALESCE(position, 0)) || printf('%08d', id) FROM nodes WHERE project_id = ? AND parent_id IS NULL AND is_note = 0
                UNION ALL SELECT n.id, n.title, t.path || '/' || printf('%06d', COALESCE(n.position, 0)) || printf('%08d', n.id) FROM nodes n JOIN t ON n.parent_id = t.id WHERE n.is_note = 0)
            SELECT t.id, t.title FROM t WHERE NOT EXISTS (SELECT 1 FROM nodes c WHERE c.parent_id = t.id AND c.is_note = 0) ORDER BY path`).all(pid);
        const pick = leaves.find((l) => /antinode/i.test(l.title)) || leaves.find((l) => /\bnodes?\b/i.test(l.title))
            || leaves.find((l) => /harmonic/i.test(l.title)) || leaves[4] || leaves[0];
        return { projectId: pid, topics: leaves.length, ...pick };
    } finally { db.close(); }
}

const refusedCalls = () => {
    const f = join(LIB, 'replay.jsonl');
    if (!existsSync(f)) return [];
    // The server is still appending: a half-written last line is skipped.
    return readFileSync(f, 'utf8').split('\n').flatMap((l) => { try { return l.trim() ? [JSON.parse(l)] : []; } catch { return []; } }).filter((e) => e.how === 'refused');
};

// Off camera: wait until every top-level topic has a written lesson and nothing runs for 10 s.
async function waitFeed() {
    const t1 = Date.now();
    let idle = 0, last = '';
    for (;;) {
        const list = await fetch(`${BASE}/api/tasks`).then((r) => r.json()).catch(() => []);
        const busy = (Array.isArray(list) ? list : list.tasks || []).filter((t) => t.status === 'running' || t.status === 'queued');
        const NO_LESSON = `FROM nodes n WHERE n.is_note = 0 AND n.parent_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM feed_items f WHERE f.node_id = n.id AND f.kind = 'lesson' AND f.status = 'ready')`;
        const left = dbq(`SELECT COUNT(*) c ${NO_LESSON}`)[0].c;
        const s = `busy ${busy.map((t) => t.kind).join(',') || '-'}, topics without a lesson ${left}`;
        if (s !== last) { stamp('feed', s); last = s; }
        // A call with no recording fails the same way on every retry: stop instead of waiting.
        const refused = refusedCalls();
        if (refused.length) throw new Error(`the feed asked for ${refused.length} call(s) with no recording, e.g. "${refused[0].label}"; the requests are in ${join(LIB, 'refused')} (record them with --record)`);
        idle = busy.length === 0 && left === 0 ? idle + 1 : 0;
        if (idle >= 5) break;
        if (Date.now() - t1 > 40 * 60e3) throw new Error(`feed not written in 40 min: ${s}`);
        if (busy.length === 0 && left > 0 && Date.now() - t1 > 60e3) {
            const n = dbq(`SELECT n.id ${NO_LESSON} ORDER BY n.id LIMIT 1`)[0];
            if (n) await fetch(`${BASE}/api/feed?nodeId=${n.id}&limit=5`).catch(() => { });
        }
        await sleep(2000);
    }
    stamp('feed written in', Math.round((Date.now() - t1) / 1000), 's');
}

let result;
try {
    result = await record({
        url: `${BASE}/projects`, waitFor: 'text=New course', out: OUT,
        viewport: { width: 1280, height: 800, scale: 2 }, fps: 20, theme: 'light', locale: 'en-US',
        keepFrames: true, tail: 600, strictSize: true, start: [880, 560],
        workDir: join(WORK, 'frames'), checkDir: join(WORK, 'check'),
        fade: 0, soften: 0, progressBar: { color: '#0E7490', marks: false },
        stepped: !!opt.stepped, onClock,
        setup: async (d) => {
            await d.send('Page.addScriptToEvaluateOnNewDocument', { source: NO_POINTER_LOCK });
            await d.evaluate(NO_POINTER_LOCK);
            await d.send('Page.addScriptToEvaluateOnNewDocument', { source: `document.addEventListener('DOMContentLoaded', () => ${HIDE_JS})` });
            await d.evaluate(HIDE_JS);
            await d.send('Page.addScriptToEvaluateOnNewDocument', { source: SLOW_JS });
            await d.evaluate(SLOW_JS);
            await d.waitFor('text=No projects yet', 20000).catch(() => { });
            await d.wait(300);
        },
    }, async (d) => {
        await d.dwell(500);                                  // the empty library
        await d.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.innerText.trim() === 'New course'); if (b) b.setAttribute('data-hero-new', '1'); return !!b; })()`);
        await d.click('[data-hero-new="1"]', { after: 250 });
        await d.waitFor('[role=dialog] [data-tile]', 10000);
        await d.dwell(700);                                  // Create | Import
        await d.click('[role=dialog] [data-tile]', { after: 250 });
        await d.waitFor('input[placeholder^="e.g., Machine"]', 10000);
        await d.dwell(900);                                  // the empty form
        await lapse(d, 3);
        await d.type('input[placeholder^="e.g., Machine"]', NAME, { cps: 14 });
        await d.type('[role=dialog] textarea', DESCRIPTION, { cps: 22 });
        await lapse(d, 1);
        await d.dwell(900);                                  // the filled form
        await d.click('text=Create with AI', { after: 300 });
        stamp('create pressed');
        await d.waitFor('text=Stop creating', 20000).catch(() => { });
        // The cursor steps aside, just outside the dialog, level with where Go to Project appears.
        const rest = await d.evaluate(`(() => { const r = document.querySelector('[role=dialog]').getBoundingClientRect(); return [Math.round(r.right + 48), Math.round(r.bottom - 44)]; })()`);
        await d.move({ x: rest[0], y: rest[1] }, { ms: 700 });
        // The whole run as a time-lapse: every stage appears and ticks as it really did.
        const already = await d.evaluate('/Go to Project/.test(document.body.innerText)');
        let lapseCap = { end() { } };
        if (!already) {
            await lapse(d, LAPSE);
            lapseCap = await d.caption(`Drafting the course · ${LAPSE}× speed`, 600000);
        }
        const t0 = Date.now();
        for (;;) {
            const s = await d.evaluate(`/Go to Project/.test(document.body.innerText) ? 'done' : /Open Partial Project|Set up AI/.test(document.body.innerText) ? 'fail' : ''`);
            if (s === 'done') break;
            if (s === 'fail') throw new Error('creation failed: ' + await d.evaluate(`(document.querySelector('[role=dialog]')||document.body).innerText.slice(0, 400)`));
            if (Date.now() - t0 > limit(6 * 60e3)) throw new Error('creation took too long');
            await d.wait(250);
        }
        stamp('course drafted in', Math.round((Date.now() - t0) / 1000), 's (wall)');
        await lapse(d, 1);
        lapseCap.end();
        const pick = pickTopic();
        stamp('course', pick.topics, 'topics; filmed topic', JSON.stringify(pick));
        if (opt.waitFeed) {
            // The finished run is the same picture before and after the cut, so the cut does not show.
            d.pause();
            await waitFeed();
            await d.resume({ ms: 0 });
        } else {
            fetch(`${BASE}/api/feed?nodeId=${pick.id}&limit=5`).catch(() => { });
        }
        await d.dwell(1600);                                  // the finished run
        if (opt.until === 'created') return;
        await d.click('text=Go to Project', { after: 300 });
        await d.dwell(900);                                   // the course page
        const row = await d.evaluate(`(() => {
            const want = ${JSON.stringify(pick.title)};
            const all = [...document.querySelectorAll('body *')].filter(e => e.children.length === 0 && e.textContent.trim() === want)
                .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
            const el = all[0]; if (!el) return 'none';
            el.setAttribute('data-hero-topic', '1');
            return Math.round(el.getBoundingClientRect().top);
        })()`);
        if (row === 'none') throw new Error('topic not in the sidebar');
        // The cursor goes to the sidebar first and the list scrolls under it.
        if (row > 600 || row < 120) {
            const x = await d.evaluate(`Math.round(document.querySelector('[data-hero-topic="1"]').getBoundingClientRect().left + 70)`);
            await d.move({ x, y: 420 }, { ms: 700 });
            await glideFilmed(d, `document.querySelector('[data-hero-topic="1"]')`, 400);
            await d.dwell(400);
        }
        await d.click('[data-hero-topic="1"]', { after: 300 });
        await d.dwell(1200);                                  // the topic opens
        if (opt.until === 'opened') return;
        await d.click('[aria-label="Ask the assistant"]', { after: 300 });
        await d.waitFor(ASSIST, 10000).catch(() => { });
        await d.dwell(700);
        await lapse(d, 2.5);
        await d.type(`${ASSIST} textarea`, QUESTION, { cps: 26 });
        await lapse(d, 1);
        await d.dwell(800);                                   // the question, read
        await d.click(`${ASSIST} [aria-label="Send"]`, { after: 300 });
        stamp('asked');
        await lapse(d, ANSWER_LAPSE);
        const answerCap = await d.caption(`Writing the answer · ${ANSWER_LAPSE}× speed`, 600000);
        const t1 = Date.now();
        let nextTail = 0;
        for (let i = 0; ; i++) {
            if (await d.evaluate(`(() => { const v = ${RICH_VISUAL}; return v ? 'ok' : ''; })()`)) break;
            if (Date.now() - t1 > limit(180e3)) throw new Error('no animation in time');
            // The cursor reads along with the answer as it arrives.
            if (i >= nextTail) { await pointAt(d, ANSWER_TAIL, 700, 0.2); nextTail = i + 10; }
            await d.wait(250);
        }
        await lapse(d, 1);
        answerCap.end();
        await d.evaluate(`(() => { const v = ${RICH_VISUAL}; v.setAttribute('data-hero-visual', '1'); return 1; })()`);
        await glideFilmed(d, `document.querySelector('[data-hero-visual="1"]')`, 150, 1400);
        const VIS_SVG = `(document.querySelector('[data-hero-visual="1"] svg animate, [data-hero-visual="1"] svg animateTransform, [data-hero-visual="1"] canvas, [data-hero-visual="1"] iframe') || {}).closest?.('svg, canvas, iframe')`;
        // One stop just under the drawing, then straight to Study.
        const under = await d.evaluate(`(() => { const s = ${VIS_SVG}; if (!s) return null; const r = s.getBoundingClientRect(); return [Math.round(r.left + r.width * 0.62), Math.round(Math.min(r.bottom + 14, 760))]; })()`);
        if (under) await d.move({ x: under[0], y: under[1] }, { ms: 1000 });
        await d.dwell(3000);                                  // it moves: several cycles
        await d.click('button[title="Study this topic now"]', { after: 300 });
        for (let i = 0; i < 480; i++) {
            if (await d.evaluate(`!!document.querySelector('div.min-w-0.flex-1.text-base.font-medium') || /Got it, continue|End of chapter/.test(document.querySelector('main')?.innerText || '')`)) break;
            await d.wait(250);
        }
        await d.caption('Then prove it: every answer is marked', 3400);
        await pointAt(d, `[...document.querySelectorAll('main h2, main h3, h2, h3')].find(h => h.getBoundingClientRect().left > 300 && h.getBoundingClientRect().left < 800)`, 700);
        await d.dwell(700);                                   // the lesson, from its top
        const STEM = 'div.min-w-0.flex-1.text-base.font-medium';
        if (!await d.evaluate(`!!document.querySelector('${STEM}')`)) {
            // A written lesson holds its question back until "Got it, continue".
            await d.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(b => /Got it, continue/.test(b.innerText)); if (b) b.setAttribute('data-hero-continue', '1'); return !!b; })()`);
            await glideFilmed(d, `document.querySelector('[data-hero-continue="1"]')`, 560, 3200);
            await d.dwell(500);
            await d.click('[data-hero-continue="1"]', { after: 300 });
            await d.waitFor(STEM, 30000).catch(() => { });
            await d.dwell(600);
        }
        const target = await chooseAnswer(d);
        stamp('answer', JSON.stringify(target));
        await d.move('[data-hero-q="1"]', { kind: null }).catch(() => { });
        await glideFilmed(d, `document.querySelector('[data-hero-q="1"]')`, 200, 1800);
        await pointAt(d, `document.querySelector('[data-hero-q="1"] ${STEM}')`, 900, 0.6);
        await d.dwell(500);                                   // the question, read
        if (target.kind === 'button') await d.click('[data-hero-pick="1"]');
        else {
            await d.type('[data-hero-pick="1"]', target.text, { cps: 7 });
            await d.dwell(500);
            await d.click('[data-hero-q="1"] [data-hero-check="1"]');
        }
        const q = await d.locate('[data-hero-q="1"]', false);
        await d.move({ x: Math.min(1240, q.left + q.w + 30), y: q.y }, { ms: 600 });
        for (let i = 0; i < 300; i++) {
            if (await d.evaluate(`(() => { const r = document.querySelector('[data-hero-q="1"]'); return r && /Correct|Not quite|Not marked/.test(r.innerText) ? 'ok' : ''; })()`)) break;
            await d.wait(200);
        }
        const over = await d.evaluate(`(() => { const r = document.querySelector('[data-hero-q="1"]'); const v = [...r.querySelectorAll('p')].find(p => /^(Correct|Not quite|Not marked)/.test(p.innerText.trim())); return v ? Math.round(v.parentElement.getBoundingClientRect().bottom + 60 - innerHeight) : 0; })()`);
        if (over > 0) await glideFilmed(d, `document.querySelector('[data-hero-q="1"]')`, 200 - over, 900);
        await d.dwell(2000);                                  // the verdict
    });
} finally {
    server.kill();
}
console.log(JSON.stringify({ out: OUT, work: WORK, ...result }, null, 1));

// The first question on screen the library's own key can mark (a choice or a number).
async function chooseAnswer(d) {
    const qs = dbq(`SELECT id, node_id, content FROM feed_items WHERE kind = 'question'`).map((r) => ({ id: r.id, ...JSON.parse(r.content) }));
    const norm = (s) => String(s || '').replace(/[​-‍⁠﻿]/g, '').replace(/\$/g, '').replace(/\\displaystyle/g, '').replace(/\\[,;! ]/g, '').replace(/\s+/g, '').toLowerCase();
    const roots = await d.evaluate(`(() => {
        const plain = el => { const c = el.cloneNode(true); c.querySelectorAll('.katex').forEach(k => { const a = k.querySelector('annotation'); k.replaceWith(document.createTextNode(a ? a.textContent : k.textContent)); }); return c.textContent; };
        return [...document.querySelectorAll('div.min-w-0.flex-1.text-base.font-medium')].map((stem, i) => {
            const root = stem.parentElement.parentElement; root.setAttribute('data-hero-root', String(i));
            return { i, stem: plain(stem), options: [...root.querySelectorAll('button[aria-pressed]')].map(plain), numeric: !!root.querySelector('input[inputmode=decimal]') };
        });
    })()`);
    for (const r of roots) {
        const q = qs.find((x) => norm(x.question).slice(0, 50) === norm(r.stem).slice(0, 50));
        if (!q) continue;
        const type = q.type || 'multiple_choice';
        if ((type === 'multiple_choice' || type === 'true_false') && r.options.length) {
            const want = norm(q.correct_answer);
            const idx = r.options.findIndex((o) => norm(o) === want || norm(o).endsWith(want));
            if (idx < 0) continue;
            await d.evaluate(`(() => { const root = document.querySelector('[data-hero-root="${r.i}"]'); root.setAttribute('data-hero-q', '1'); root.querySelectorAll('button[aria-pressed]')[${idx}].setAttribute('data-hero-pick', '1'); return 1; })()`);
            return { kind: 'button', type, answer: r.options[idx] };
        }
        if (type === 'numeric' && r.numeric) {
            await d.evaluate(`(() => { const root = document.querySelector('[data-hero-root="${r.i}"]'); root.setAttribute('data-hero-q', '1'); root.querySelector('input[inputmode=decimal]').setAttribute('data-hero-pick', '1'); const b = [...root.querySelectorAll('button')].find(b => b.textContent.trim() === 'Check answer'); b.setAttribute('data-hero-check', '1'); return 1; })()`);
            return { kind: 'numeric', type, text: String(q.correct_answer) };
        }
    }
    throw new Error('no answerable question on the page');
}
