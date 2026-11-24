#!/usr/bin/env node
/**
 * tools/assistant-scroll-gates.mjs — the assistant's log holds still while an
 * answer is written into it, measured in a browser.
 *
 *   node tools/assistant-scroll-gates.mjs                 desktop and phone
 *   node tools/assistant-scroll-gates.mjs --browser <p>   a Chromium-based browser (default: Edge or Chrome)
 *   node tools/assistant-scroll-gates.mjs --only phone    one size (desktop or phone)
 *
 * The built app on the invented course from tools/docs-fixture.mjs, talking to
 * a stub model in this process that streams one long answer (nothing billed,
 * nothing leaves the machine). At a desktop and a phone size:
 *
 *  - Send puts the new question at the top of the log, one padding down;
 *  - after that the log does not move while the answer streams, also after
 *    the reader scrolls up to re-read, and does not move when it ends;
 *  - while text runs on below the view, "Still writing below" shows, and
 *    "More below" once the answer is done;
 *  - each press turns one page and skips nothing (the line at the bottom edge
 *    stays in view); pressed until it goes, the answer's last paragraph is in
 *    view; from the keyboard, focus stays on the button while text is below
 *    and lands on the log, not the page, on the last press;
 *  - closed and opened again, the panel shows the newest message with no
 *    room left under the old question;
 *  - a question the model refuses stays at the top with its notice in view
 *    (the path that drops a question and its room, a send the server refuses
 *    before a turn starts, is checked in the source by assistant-gates.mjs).
 *
 * Each "holds still" check also asserts the answer streamed long enough to
 * have moved a log that follows it, so a stream that never arrived passes
 * nothing. The source-level checks of the same code are in assistant-gates.mjs.
 *
 * Without Edge or Chrome it is SKIPPED locally and fails in CI.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};

delete process.env.__COMPAT_LAYER;

const { visit, findBrowser, removeScratch } = await import(pathToFileURL(join(ROOT, 'tools', 'docs-shots.mjs')).href);
const { prepare: prepareFixture } = await import(pathToFileURL(join(ROOT, 'tools', 'docs-fixture.mjs')).href);

let browserPath;
try {
    browserPath = findBrowser(value('--browser'));
} catch {
    if (process.env.CI) { console.log('  FAIL  no Edge or Chrome to run the screens in'); console.log('0 passed, 1 failed'); process.exit(1); }
    console.log('SKIPPED: no Edge or Chrome found (pass --browser <path>)');
    process.exit(0);
}

// dist/, built from the sources being checked (as axe-gates does).
function newest(path) {
    if (!existsSync(path)) return 0;
    const st = statSync(path);
    if (!st.isDirectory()) return st.mtimeMs;
    let most = 0;
    for (const name of readdirSync(path)) most = Math.max(most, newest(join(path, name)));
    return most;
}
const built = existsSync(join(ROOT, 'dist', 'index.html')) ? statSync(join(ROOT, 'dist', 'index.html')).mtimeMs : 0;
const sources = Math.max(...['src', 'public', 'index.html', 'vite.config.ts', 'tailwind.config.js', 'postcss.config.js'].map((p) => newest(join(ROOT, p))));
if (sources > built) {
    console.log(built ? 'dist/ is older than the sources: building it' : 'no dist/: building it');
    const run = spawnSync(process.execPath, [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--logLevel', 'warn'], { cwd: ROOT, stdio: 'inherit' });
    if (run.status !== 0) { console.log('  FAIL  vite build'); console.log('0 passed, 1 failed'); process.exit(1); }
}

// ---------------------------------------------------------------------------
// The stub model: an OpenAI-compatible endpoint that streams a long answer to
// a question containing "long", a short one otherwise.
// ---------------------------------------------------------------------------

const LONG_Q = 'Now the long version, please';
const FAIL_Q = 'This one fails, please';
const para = (i) => `Step ${i}. A wave on a string fixed at both ends reflects at each end, and the reflected wave adds to the incoming one. Where they always cancel the string stays still, a node; where they add the most it swings widest, an antinode.`;
const LONG = Array.from({ length: 16 }, (_, i) => para(i + 1)).join('\n\n');
const SHORT = 'Standing waves form when two equal waves travel in opposite directions.';
const stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
        if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ object: 'list', data: [{ id: 'stub-model', object: 'model' }] }));
        }
        if (req.method !== 'POST' || !req.url.startsWith('/v1/chat/completions')) {
            res.writeHead(404, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ error: { message: 'not in the stub' } }));
        }
        let parsed = {};
        try { parsed = JSON.parse(body); } catch { /* not json */ }
        const last = (parsed.messages || []).filter((m) => m.role === 'user').pop()?.content ?? '';
        const asked = typeof last === 'string' ? last : JSON.stringify(last);
        if (!parsed.stream) {
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'NONE' }, finish_reason: 'stop' }], usage: { completion_tokens: 1 } }));
        }
        if (asked.includes(FAIL_Q)) {
            // Refused outright (not a transient error), so the turn fails, after
            // a pause long enough to see the room made for the question first.
            return setTimeout(() => {
                res.writeHead(400, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'refused by the stub' } }));
            }, 2000);
        }
        const words = (asked.includes(LONG_Q) ? LONG : SHORT).split(/(?<= )/);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        let i = 0;
        const timer = setInterval(() => {
            if (res.destroyed) return clearInterval(timer);
            if (i < words.length) {
                res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: words.slice(i, i + 3).join('') } }] })}\n\n`);
                i += 3;
                return;
            }
            clearInterval(timer);
            res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
            res.end('data: [DONE]\n\n');
        }, 35);
        res.on('close', () => clearInterval(timer));
    });
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
stub.unref();
const stubBase = `http://127.0.0.1:${stub.address().port}/v1`;

async function prepare(ctx) {
    const ids = await prepareFixture(ctx);
    const Database = require('better-sqlite3');
    const db = new Database(ctx.dbPath);
    try {
        db.pragma('busy_timeout = 5000');
        const set = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
        for (const [k, v] of Object.entries({
            ai_enabled: 'true', ai_provider: 'openai', ai_openai_base_url: stubBase,
            ai_openai_model: 'stub-model', ai_web_search: 'off',
        })) set.run(k, v);
    } finally {
        db.close();
    }
    return ids;
}

// ---------------------------------------------------------------------------
// In the page.
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** The log, where the long question sits in it, and the "below" button's words. */
const STATE = `(() => {
    const log = document.querySelector('aside[aria-label="Assistant"] [role="log"]');
    if (!log) return null;
    const lr = log.getBoundingClientRect();
    const q = [...log.querySelectorAll('p')].filter((p) => p.textContent.includes(${JSON.stringify(LONG_Q)})).pop();
    const button = [...document.querySelectorAll('aside[aria-label="Assistant"] button')].find((b) => /below$/.test(b.textContent.trim()));
    const content = log.firstElementChild?.lastElementChild;
    return {
        top: log.scrollTop,
        questionAt: q ? q.getBoundingClientRect().top - lr.top : null,
        pad: parseFloat(getComputedStyle(log).paddingTop),
        padBottom: parseFloat(getComputedStyle(log).paddingBottom),
        hidden: content ? content.getBoundingClientRect().bottom - (lr.bottom - parseFloat(getComputedStyle(log).paddingBottom)) : null,
        answer: content ? content.getBoundingClientRect().height : null,
        view: lr.height,
        button: button ? button.textContent.trim() : null,
        busy: !!document.querySelector('[aria-label="Stop generating"]'),
        focusOnLog: document.activeElement === log,
        room: log.firstElementChild?.style.minHeight ?? null,
        // The answer's own last paragraph, found by its words, not by the hook's measure.
        lastStepShown: (() => {
            const p = [...log.querySelectorAll('p')].filter((e) => e.textContent.startsWith('Step 16.')).pop();
            if (!p) return false;
            const r = p.getBoundingClientRect();
            return r.top >= lr.top && r.bottom <= lr.bottom;
        })(),
        text: log.innerText,
    };
})()`;
/** The bar's assistant button: icon-only with a name on a narrow bar, the word itself on a wide one. */
const OPEN = `(document.querySelector('[aria-label^="Open the assistant"]') || [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Assistant'))`;
const BUTTON = `[...document.querySelectorAll('aside[aria-label="Assistant"] button')].find((b) => /below$/.test(b.textContent.trim()))`;

async function ask(page, text) {
    await page.evaluate(`(() => {
        const ta = document.querySelector('textarea[placeholder="Ask anything…"]');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, ${JSON.stringify(text)});
        ta.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(200);
    await page.press(`document.querySelector('[aria-label="Send"]')`, 'Send');
}

/** Wait until `text` is in the log and nothing is being written. */
async function answered(page, text) {
    await page.waitFor(`(() => { const s = ${STATE}; return s && !s.busy && s.text.includes(${JSON.stringify(text)}); })()`, `the answer containing "${text}"`, 60_000);
}

const run = (form) => async (page) => {
    console.log(`\n${form}:`);
    await page.go('/projects', null);
    await page.waitFor(OPEN, 'the assistant button');
    await page.press(OPEN, 'Open the assistant');
    await page.waitFor(`document.querySelector('textarea[placeholder="Ask anything…"]')`, 'the composer');

    await ask(page, 'What is a standing wave?');
    await answered(page, 'opposite directions');

    await ask(page, LONG_Q);
    // The one move a question makes (a smooth scroll): first the question
    // reaches the top, then the position holds for a moment.
    await page.waitFor(`(() => { const s = ${STATE}; return s && s.questionAt != null && Math.abs(s.questionAt - s.pad) <= 4; })()`, 'the question at the top', 10_000).catch(() => { });
    let settled = await page.evaluate(STATE);
    for (let i = 0; i < 30; i++) {
        await sleep(150);
        const now = await page.evaluate(STATE);
        if (Math.abs(now.top - settled.top) < 1) { settled = now; break; }
        settled = now;
    }
    check('Send puts the question at the top of the log', settled.questionAt != null && Math.abs(settled.questionAt - settled.pad) <= 4,
        `question at ${settled.questionAt?.toFixed(1)} px, padding ${settled.pad}`);
    check('...while the answer is still being written', settled.busy);

    // Sampled while it is written. Part way through, the reader scrolls up
    // to re-read and later comes back: the log must stay wherever they put it.
    const samples = [];
    let expected = settled.top;
    let scrolledUp = null;
    for (let i = 0; i < 400; i++) {
        if (i === 12 || i === 24) {
            expected = i === 12 ? Math.max(0, settled.top - 150) : settled.top;
            await page.evaluate(`document.querySelector('aside[aria-label="Assistant"] [role="log"]').scrollTop = ${expected}`);
        }
        const s = await page.evaluate(STATE);
        samples.push({ ...s, expected });
        if (i > 12 && i < 24 && s.busy) scrolledUp = (scrolledUp ?? true) && Math.abs(s.top - expected) < 1;
        if (!s.busy) break;
        await sleep(100);
    }
    const streaming = samples.filter((s) => s.busy);
    const moved = streaming.filter((s) => Math.abs(s.top - s.expected) >= 1);
    // Taller than the view, measured on the answer itself, not on the scroll:
    // a log that follows the stream hides nothing, yet the answer is as long.
    const tallest = Math.max(...streaming.map((s) => s.answer ?? 0));
    const view = streaming[0]?.view ?? 0;
    check('the answer streamed for a while and grew taller than the view (so a following log would have moved)',
        streaming.length >= 30 && tallest > view + 100,
        `${streaming.length} samples while writing, answer ${tallest.toFixed(0)} px, view ${view.toFixed(0)} px`);
    check('the log did not move while the answer was written', moved.length === 0,
        `${moved.length} of ${streaming.length} samples off where the reader left it: ${moved.slice(0, 5).map((s) => `${s.top.toFixed(0)} (want ${s.expected.toFixed(0)})`).join(', ')}`);
    check('...including after the reader scrolled up to re-read', scrolledUp === true, String(scrolledUp));
    check('"Still writing below" showed while it was written', streaming.some((s) => s.button === 'Still writing below'),
        [...new Set(streaming.map((s) => s.button))].join(' / '));

    await answered(page, 'Step 16.');
    await sleep(800);
    const done = await page.evaluate(STATE);
    check('the log did not move when the answer ended', Math.abs(done.top - settled.top) < 1, `${settled.top.toFixed(0)} -> ${done.top.toFixed(0)}`);
    check('"More below" shows once it is done', done.button === 'More below', String(done.button));
    check('...and the end of the answer is out of sight', !done.lastStepShown);

    // Each press turns one page. Nothing may be skipped: the line at the
    // bottom edge before a press must still be in view after it, so the log
    // moves on by at most the height of its text area, and by something.
    /** Press (or Enter), wait for the smooth scroll to stop, return the new state. */
    const turn = async (press) => {
        const before = await page.evaluate(STATE);
        await press();
        let s = before;
        for (let i = 0, still = 0; i < 40 && still < 3; i++) {
            await sleep(100);
            const n = await page.evaluate(STATE);
            still = Math.abs(n.top - s.top) < 1 ? still + 1 : 0;
            s = n;
        }
        return { before, after: s, moved: s.top - before.top, text: before.view - before.pad - before.padBottom };
    };
    const presses = [];
    for (let i = 0; i < 30; i++) {
        if (!(await page.evaluate(`!!(${BUTTON})`))) break;
        presses.push(await turn(() => page.press(BUTTON, 'More below')));
    }
    const fmt = (ps) => ps.map((p) => `${p.moved.toFixed(0)}/${p.text.toFixed(0)}`).join(', ');
    check('one press turns one page, not straight to the end (it took more than one)', presses.length > 1, `${presses.length} press(es): ${fmt(presses)}`);
    check('...each moving on, and never past the line that was at the bottom edge',
        presses.length > 0 && presses.every((p) => p.moved > 0 && p.moved <= p.text + 1), fmt(presses));
    const after = presses.at(-1)?.after ?? done;
    check('pressing until it goes brings the answer\'s last paragraph into view', after.lastStepShown && after.button === null,
        `last paragraph in view: ${after.lastStepShown}, button ${after.button}`);

    // From the keyboard: back up, focus the button, Enter until it goes. A press
    // that leaves text below keeps focus on the button, so Enter can go on.
    await page.evaluate(`document.querySelector('aside[aria-label="Assistant"] [role="log"]').scrollTop = ${settled.top}`);
    await page.waitFor(`!!(${BUTTON})`, 'the button back after scrolling up', 5000);
    await page.evaluate(`(${BUTTON}).focus()`);
    const enter = async () => {
        for (const type of ['keyDown', 'keyUp']) {
            await page.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) });
        }
    };
    const first = await turn(enter);
    const focusOnButton = await page.evaluate(`document.activeElement === (${BUTTON})`);
    check('pressed with Enter it turns a page and keeps focus on the button while text is below',
        first.moved > 0 && first.moved <= first.text + 1 && focusOnButton, `moved ${first.moved.toFixed(0)}/${first.text.toFixed(0)}, focus on the button: ${focusOnButton}`);
    let keyed = first.after;
    for (let i = 0; i < 30 && keyed.button; i++) keyed = (await turn(enter)).after;
    check('...and the last Enter leaves focus on the log, the end in view', keyed.lastStepShown && keyed.button === null && keyed.focusOnLog,
        `last paragraph in view ${keyed.lastStepShown}, button ${keyed.button}, focus on the log: ${keyed.focusOnLog}`);

    // Closed and opened again: the newest message, and no room left over.
    await page.evaluate(`document.querySelector('aside[aria-label="Assistant"] [role="log"]').scrollTop = ${settled.top}`);
    await page.press(`document.querySelector('[aria-label="Close assistant"]')`, 'Close assistant');
    await page.waitFor(`!document.querySelector('aside[aria-label="Assistant"]')`, 'the assistant closed', 5000);
    await page.press(OPEN, 'Open the assistant');
    await page.waitFor(`(() => { const s = ${STATE}; return s && s.text.includes('Step 16.'); })()`, 'the conversation again', 10_000);
    await sleep(800);
    const reopened = await page.evaluate(STATE);
    check('opened again, it shows the newest message', reopened.lastStepShown && reopened.button === null,
        `last paragraph in view ${reopened.lastStepShown}, button ${reopened.button}`);
    check('...with no room left under the old question', !reopened.room, `min-height ${reopened.room}`);

    // A turn the model refuses: the question is kept in the chat (the server
    // dropped it; the panel puts it back) with a "didn't send" notice under
    // it. The reader sees both without scrolling: the question at the top
    // again, the notice in view.
    await ask(page, FAIL_Q);
    const NOTICE = `[...document.querySelectorAll('aside[aria-label="Assistant"] [role="log"] button')].find((b) => b.textContent.trim() === 'Try again')`;
    try {
        await page.waitFor(`!!(${NOTICE}) && !document.querySelector('[aria-label="Stop generating"]')`, 'the failed turn\'s notice', 30_000);
    } catch (err) {
        const s = await page.evaluate(STATE);
        console.log(`        (log ends: ${JSON.stringify(s?.text.slice(-300))}, busy ${s?.busy})`);
        throw err;
    }
    await sleep(1200);
    const failed = await page.evaluate(`(() => {
        const log = document.querySelector('aside[aria-label="Assistant"] [role="log"]');
        const l = log.getBoundingClientRect();
        const q = [...log.querySelectorAll('p')].filter((p) => p.textContent.includes(${JSON.stringify(FAIL_Q)})).pop();
        const r = (${NOTICE}).getBoundingClientRect();
        return { questionAt: q ? q.getBoundingClientRect().top - l.top : null, pad: parseFloat(getComputedStyle(log).paddingTop), noticeShown: r.top >= l.top && r.bottom <= l.bottom };
    })()`);
    check('a refused question stays at the top of the log', failed.questionAt != null && Math.abs(failed.questionAt - failed.pad) <= 4,
        `question at ${failed.questionAt?.toFixed(1)} px`);
    check('...with its notice in view under it', failed.noticeShown);
};

const only = value('--only');
for (const [form, viewport] of [['desktop', { width: 1280, height: 800, scale: 1 }], ['phone', { width: 390, height: 844, scale: 1 }]]) {
    if (only && form !== only) continue;
    const scratch = mkdtempSync(join(tmpdir(), 'assistant-scroll-gates-'));
    try {
        const states = { [form]: run(form) };
        await visit('fixture', scratch, [{ states: Object.keys(states) }], viewport, browserPath, async () => { }, prepare, states);
    } catch (err) {
        fail++;
        console.log(`  FAIL  ${form}: ${err.message.split('\n')[0]}`);
    } finally {
        removeScratch(scratch);
    }
}

stub.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
