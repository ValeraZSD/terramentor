#!/usr/bin/env node
/**
 * tools/page-scroll-gates.mjs — on a desktop the page never scrolls: the app's
 * frame is exactly the window, and every list scrolls inside itself.
 *
 *   node tools/page-scroll-gates.mjs                 the checks below, in the built app
 *   node tools/page-scroll-gates.mjs --only feed     only the screens whose name contains "feed"
 *   node tools/page-scroll-gates.mjs --browser <p>   a Chromium-based browser (default: Edge or Chrome)
 *
 * WHY. The desktop layout is a frame the size of the window: a header, and
 * under it panes that scroll on their own. When anything on a screen makes the
 * DOCUMENT taller than the window, the page gains a scroll of its own, and the
 * next thing that scrolls "into view" the native way (it moves every scrolling
 * ancestor up to the window) slides the whole frame up: the header leaves the
 * screen and nothing brings it back. Measured once at 1280x800: a hidden text
 * twin (`sr-only`, which is `position: absolute`) placed against a box OUTSIDE
 * the pane that clipped it sat at the foot of the assistant's list, the page
 * was 907px tall, and the feed's "Got it, continue" scrolled the window 107px.
 *
 * Three halves, at 1280x800 and 1024x700, in the desktop Layout frame:
 *
 *  1. Every screen: `document.scrollingElement.scrollHeight <= innerHeight`.
 *     A failure names the elements past the window's foot that no box clips.
 *  2. Every screen: no `position: absolute` element has a SCROLLER between it
 *     and the box it is placed against. Such an element neither scrolls with
 *     the list nor is clipped by it: it lands at its static position, which in
 *     a long list is below the window, and that is how the twin grew the page.
 *  3. In-app jumps (feed "Got it, continue", a deck section picked on the strip,
 *     arrow keys in the outline, arrow keys in search results, switching tabs):
 *     `window.scrollY` stays 0. Each is pressed twice: on the screen as it is,
 *     and with the document made taller than the window on purpose (a spacer
 *     under the app), so a jump that WOULD move the page fails even while no
 *     screen leaks. The model picker's list is not here: it is a `fixed`
 *     popover, and nothing inside a fixed box scrolls the window.
 *
 * The data is the invented course from tools/docs-fixture.mjs in a scratch
 * library (the scratch server sets its library paths in its own process), plus
 * rows written straight into that library: an assistant conversation of twelve
 * exchanges whose last reply holds a graph, a model connection, and a card deck
 * of sixty sections. No model and no network.
 *
 * Without Edge or Chrome it is SKIPPED locally and fails in CI. A CI runner
 * that is not Windows skips it, as axe-gates does: the frame is measured with
 * the fonts the app ships to on Windows.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const only = value('--only');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? `\n${extra}` : ''}`); }
};

delete process.env.__COMPAT_LAYER;

if (process.env.CI && process.platform !== 'win32') {
    console.log(`SKIPPED: the frame is measured on Windows; this CI runner is ${process.platform}`);
    process.exit(0);
}

const { visit, findBrowser, removeScratch, byText } = await import(pathToFileURL(join(ROOT, 'tools', 'docs-shots.mjs')).href);
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
// The library: the fixture course, a conversation with a graph, a deck.
// ---------------------------------------------------------------------------

/** A reply as the assistant writes one: prose, then a graph in its fence. */
const REPLY = [
    'The brightness falls off with the square of the distance, so twice as far is a quarter as bright:',
    '',
    '```plot',
    '{"title":"Brightness against distance","data":[{"fn":"1/x^2"}],"xAxis":{"domain":[0.5,4],"label":"distance"},"yAxis":{"domain":[0,4],"label":"brightness"}}',
    '```',
    '',
    'That is why a nearby dim star can look brighter than a distant giant.',
].join('\n');
// Sizes a library reaches in real use: a conversation longer than the panel,
// a deck whose outline is longer than the window.
const EXCHANGES = 12;
const DECK_SECTIONS = 60;

/** The scratch library of the size being run, so a jump can put its lesson back. */
let libraryPath = null;
/** The lesson unread again: "Got it, continue" marks it read, and each run presses it. */
function rearmLesson(nodeId) {
    const Database = require('better-sqlite3');
    const db = new Database(libraryPath);
    try {
        db.pragma('busy_timeout = 5000');
        db.prepare("UPDATE feed_items SET status = 'ready', consumed_at = NULL, result = NULL WHERE node_id = ? AND kind = 'lesson'").run(nodeId);
    } finally {
        db.close();
    }
}

async function prepare(ctx) {
    libraryPath = ctx.dbPath;
    const ids = await prepareFixture(ctx);
    const Database = require('better-sqlite3');
    const db = new Database(ctx.dbPath);
    try {
        db.pragma('busy_timeout = 5000');
        const now = new Date().toISOString();
        // The conversation the assistant opens first: the newest one.
        const conv = db.prepare('INSERT INTO chat_conversations (title, node_id, created_at, updated_at) VALUES (?, ?, ?, ?)')
            .run('Brightness and distance', ids.study, now, now).lastInsertRowid;
        const say = db.prepare('INSERT INTO chat_messages (conversation_id, node_id, project_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)');
        for (let i = 1; i < EXCHANGES; i++) {
            say.run(conv, ids.study, ids.project, 'user', `Question ${i}: what does line ${i} of the spectrum show?`, now);
            say.run(conv, ids.study, ids.project, 'assistant', `Line ${i} is one element absorbing one colour.

The same line appears in a lamp on Earth, so the two can be matched.`, now);
        }
        say.run(conv, ids.study, ids.project, 'user', 'Why does a star look dimmer the further away it is?', now);
        say.run(conv, ids.study, ids.project, 'assistant', REPLY, now);

        // A model connection, so AI & Models draws its full page (the pickers,
        // the jobs). The address is the fixture's own stub on 127.0.0.1, so
        // nothing leaves the machine.
        const stub = db.prepare("SELECT value FROM settings WHERE key = 'ai_ollama_url'").get()?.value;
        const connection = db.prepare("INSERT INTO ai_connections (kind, base_url, model, created_at, used_at) VALUES ('ollama', ?, 'stub-model-01:7b', ?, ?)")
            .run(stub, now, now).lastInsertRowid;
        const set = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
        set.run('ai_active_connection', String(connection));
        set.run('ai_provider', 'ollama');
        set.run('ai_model', 'stub-model-01:7b');

        // A deck: sections of cards, more than one page of them (DeckStages PAGE = 12).
        const deck = db.prepare(`INSERT INTO projects (name, color, icon, kind, position) VALUES ('Star names', '#0369a1', 'Layers', 'deck', 1)`).run().lastInsertRowid;
        const node = db.prepare('INSERT INTO nodes (project_id, title, position) VALUES (?, ?, ?)');
        const card = db.prepare('INSERT INTO flashcards (node_id, front, back) VALUES (?, ?, ?)');
        for (let s = 1; s <= DECK_SECTIONS; s++) {
            const stage = node.run(deck, `Section ${s}`, s).lastInsertRowid;
            for (let c = 1; c <= 3; c++) card.run(stage, `Star ${s}.${c}`, `Constellation ${s}.${c}`);
        }
        ids.deck = Number(deck);
    } finally {
        db.close();
    }
    return ids;
}

// ---------------------------------------------------------------------------
// What is measured in the page.
// ---------------------------------------------------------------------------

/**
 * The box an element is placed against, as the CSS containing block rules
 * give it for `position: absolute` (the nearest ancestor that is positioned
 * or that transforms, filters or contains its descendants), or the parent for
 * an element in flow. Null for `fixed` (the window holds it) and at the root.
 */
const HELPERS = `
const __cb = (el) => {
    const s = getComputedStyle(el);
    if (s.position === 'fixed') return null;
    if (s.position !== 'absolute') return el.parentElement;
    for (let a = el.parentElement; a; a = a.parentElement) {
        if (a === document.body || a === document.documentElement) return a;
        const t = getComputedStyle(a);
        if (t.position !== 'static' || t.transform !== 'none' || t.filter !== 'none' || t.perspective !== 'none'
            || /paint|layout|strict|content/.test(t.contain) || /transform|filter/.test(t.willChange)) return a;
    }
    return null;
};
const __clips = (el) => {
    if (el === document.body || el === document.documentElement) return false;
    const s = getComputedStyle(el);
    return s.overflowX !== 'visible' || s.overflowY !== 'visible';
};
const __name = (el) => {
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\\s+/).slice(0, 5).join('.') : '';
    const text = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 50);
    return el.tagName.toLowerCase() + (cls ? '.' + cls : '') + (text ? ' "' + text + '"' : '');
};
`;

/** The document's height, and what sticks out past the window unclipped. */
const MEASURE = `(() => {
    ${HELPERS}
    const se = document.scrollingElement;
    const H = innerHeight;
    const out = { height: se.scrollHeight, window: H, scrollY, below: [] };
    if (se.scrollHeight <= H) return out;
    for (const el of document.body.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        if (r.bottom + scrollY <= H + 0.5 || (!r.width && !r.height && !el.getClientRects().length)) continue;
        // Clipped when a box on its containing-block chain clips.
        let clipped = false, fixed = false;
        for (let cur = el; ;) {
            if (getComputedStyle(cur).position === 'fixed') { fixed = true; break; }
            const cb = __cb(cur);
            if (!cb || cb === document.body || cb === document.documentElement) break;
            if (__clips(cb)) { clipped = true; break; }
            cur = cb;
        }
        if (clipped || fixed) continue;
        // Only the deepest: an ancestor that sticks out because a child does is not news.
        out.below = out.below.filter((b) => !b.el.contains(el));
        if (!out.below.some((b) => el.contains(b.el))) out.below.push({ el, bottom: Math.round(r.bottom + scrollY) });
    }
    out.below = out.below.slice(0, 6).map((b) => __name(b.el) + ' ends at ' + b.bottom + 'px');
    return out;
})()`;

/**
 * Absolute elements with a SCROLLER between them and the box they are placed
 * against. Such an element neither scrolls with the list nor is clipped by it:
 * it sits at its place in a list that may be far longer than the window, and
 * that place grows whatever does contain it, up to the page. A box that only
 * clips (`overflow: hidden` for a `truncate` line) is left out: it holds no
 * long content, so what escapes it lands within a line of where it belongs.
 */
const ESCAPES = `(() => {
    ${HELPERS}
    const scrolls = (a) => { const s = getComputedStyle(a); return /(auto|scroll)/.test(s.overflowY + ' ' + s.overflowX); };
    const out = [];
    for (const el of document.body.querySelectorAll('*')) {
        if (getComputedStyle(el).position !== 'absolute') continue;
        const cb = __cb(el);
        for (let a = el.parentElement; a && a !== cb; a = a.parentElement) {
            if (__clips(a) && scrolls(a)) { out.push(__name(el) + ' escapes ' + __name(a).slice(0, 70)); break; }
        }
    }
    return out;
})()`;

const SPACER_ON = `(() => { const d = document.createElement('div'); d.id = '__page-spacer'; d.style.height = '400px'; document.body.appendChild(d); return document.scrollingElement.scrollHeight - innerHeight; })()`;
const SPACER_OFF = `(() => { document.getElementById('__page-spacer')?.remove(); scrollTo(0, 0); return 1; })()`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Press an element where it already is. The shared `page.press` first scrolls
 * the element into view the native way, which would itself move the page and
 * hide what is being measured, so this one refuses an element off the screen.
 */
async function pressInPlace(page, expr, what) {
    await intoOwnView(page, expr);
    const p = await page.evaluate(`(() => { const e = ${expr}; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, inside: r.top >= 0 && r.bottom <= innerHeight }; })()`);
    if (!p) throw new Error(`nothing to press: ${what}`);
    if (!p.inside) throw new Error(`${what} is off the screen at y=${Math.round(p.y)}`);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
    for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await sleep(600);
}
/** Into view inside its own scroller only, by hand: never the window. */
async function intoOwnView(page, expr) {
    await page.evaluate(`(() => { const e = ${expr}; if (!e) return 0;
        for (let s = e.parentElement; s && s !== document.body; s = s.parentElement) {
            const o = getComputedStyle(s).overflowY;
            if (/(auto|scroll)/.test(o) && s.scrollHeight > s.clientHeight + 1) {
                const r = e.getBoundingClientRect(), f = s.getBoundingClientRect();
                if (r.top < f.top || r.bottom > f.bottom) s.scrollTop += r.top - f.top - (f.height - r.height) / 2;
                break;
            }
        }
        return 1; })()`);
    await sleep(300);
}
const key = async (page, k, code = k, modifiers = 0) => {
    for (const type of ['keyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, key: k, code, modifiers, windowsVirtualKeyCode: { ArrowDown: 40, ArrowUp: 38, k: 75, End: 35, Enter: 13 }[k] ?? 0 });
    await sleep(120);
};

// ---------------------------------------------------------------------------
// The screens.
// ---------------------------------------------------------------------------

const go = (path, needle = null, wait = 1500) => async (page, ctx) => {
    await page.go(typeof path === 'function' ? path(ctx.ids) : path, needle);
    await sleep(wait);
};
const thenPress = (first, expr, what, wait = 1200) => async (page, ctx) => {
    await first(page, ctx);
    await page.waitFor(expr, what);
    await pressInPlace(page, expr, what);
    await sleep(wait);
};
const ASSISTANT_BUTTON = `document.querySelector('button[title^="Ask the assistant"]')`;
const ASSISTANT = `document.querySelector('aside[aria-label="Assistant"]')`;
const TWIN_DRAWN = `document.querySelector('aside[aria-label="Assistant"] [data-text-twin]')`;
const openAssistant = (first) => async (page, ctx) => {
    await first(page, ctx);
    await page.waitFor(ASSISTANT_BUTTON, 'the assistant button');
    await pressInPlace(page, ASSISTANT_BUTTON, 'the assistant button');
    await page.waitFor(ASSISTANT, 'the assistant');
    await page.waitFor(TWIN_DRAWN, 'the reply\'s graph and its text twin');
    await sleep(1200);
};
const topic = go((ids) => `/project/${ids.project}/tree/${ids.study}`, 'Details');
const lesson = async (page, ctx) => {
    rearmLesson(ctx.ids.study);
    await go((ids) => `/project/${ids.project}/study/${ids.study}`, 'Got it, continue', 2500)(page, ctx);
};
const settings = (section) => thenPress(go('/settings', 'Settings'), byText('button', `/^${section.replace(/[&]/g, '\\&')}/`), section);
const deck = go((ids) => `/project/${ids.deck}/dashboard`, 'Section 1', 2000);

const SCREENS = {
    today: go('/'),
    projects: go('/projects', 'New'),
    'course dashboard': go((ids) => `/project/${ids.project}/dashboard`, 'Dashboard', 2000),
    outline: go((ids) => `/project/${ids.project}/tree`),
    'topic details': topic,
    'topic questions and cards': thenPress(topic, `document.querySelector('[data-tab="questions"]')`, 'the Questions and cards tab'),
    'topic with the assistant': openAssistant(topic),
    vault: go((ids) => `/project/${ids.project}/vault`),
    'feed, assistant closed': lesson,
    'feed, assistant open on a reply with a graph': openAssistant(lesson),
    'deck sections': deck,
    'review session': async (page, ctx) => {
        const study = byText('button', '/^Study [\\d.,\\s]+ cards?$/');
        await page.go(`/project/${ctx.ids.project}/dashboard`, null);
        await page.waitFor(study, 'the cards owed');
        await pressInPlace(page, study, 'Study the cards owed');
        await page.waitFor(`document.querySelector('[data-owns-keyboard]')`, 'the review session');
        await sleep(1000);
    },
    'settings general': go('/settings', 'Settings'),
    'settings accessibility': settings('Accessibility'),
    'settings learning': settings('Learning'),
    'settings AI and models': settings('AI & Models'),
    'settings web': settings('Web & research'),
    atlas: go('/atlas', null, 3000),
};

/** A jump: reach the screen, then the press that moves a list. */
const JUMPS = {
    'feed "Got it, continue" with the assistant open on a graph': {
        reach: openAssistant(lesson),
        jump: async (page) => {
            await pressInPlace(page, byText('button', '/^Got it, continue$/'), 'Got it, continue');
            await sleep(1500);
        },
    },
    'feed "Got it, continue"': {
        reach: lesson,
        jump: async (page) => {
            await pressInPlace(page, byText('button', '/^Got it, continue$/'), 'Got it, continue');
            await sleep(1500);
        },
    },
    'a deck section picked on the strip': {
        reach: deck,
        jump: async (page) => {
            // The strip's last block: a section on the second page of the list.
            const target = `[...document.querySelectorAll('button[data-row="stage-segment"]')].pop()`;
            await page.waitFor(target, 'the last section on the strip');
            await pressInPlace(page, target, 'the last section on the strip');
            await sleep(1200);
        },
    },
    'arrow keys down the outline': {
        reach: go((ids) => `/project/${ids.project}/tree`),
        jump: async (page) => {
            const first = `document.querySelector('[data-node-id] [data-row-title]')`;
            await page.waitFor(first, 'an outline row');
            await page.evaluate(`(${first}).focus({ preventScroll: true }), 1`);
            for (let i = 0; i < 20; i++) await key(page, 'ArrowDown');
            await sleep(600);
        },
    },
    'arrow keys down the search results': {
        reach: go('/projects', 'New'),
        jump: async (page) => {
            await key(page, 'k', 'KeyK', 2 /* Ctrl */);
            const input = `document.querySelector('input[placeholder^="Search projects"]')`;
            await page.waitFor(input, 'the search field');
            await page.evaluate(`(() => { const i = ${input}; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'star'); i.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
            await page.waitFor(`document.querySelectorAll('[data-selected]').length > 3`, 'search results');
            for (let i = 0; i < 12; i++) await key(page, 'ArrowDown');
            await sleep(600);
        },
    },
    'a deck section far down opened from search (the sidebar reveals it)': {
        reach: deck,
        jump: async (page) => {
            await key(page, 'k', 'KeyK', 2 /* Ctrl */);
            const input = `document.querySelector('input[placeholder^="Search projects"]')`;
            await page.waitFor(input, 'the search field');
            await page.evaluate(`(() => { const i = ${input}; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'Section 58'); i.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
            await page.waitFor(`document.querySelector('[data-selected="true"]')?.textContent.includes('Section 58')`, 'Section 58 in the results');
            await key(page, 'Enter');
            await page.waitFor(`[...document.querySelectorAll('[data-sidebar-node-list] *')].some((e) => e.children.length === 0 && e.textContent.trim() === 'Section 58' && e.getBoundingClientRect().bottom <= innerHeight)`, 'Section 58 revealed in the sidebar');
            await sleep(600);
        },
    },
    'switching the course\'s tabs and the top bar\'s': {
        reach: go((ids) => `/project/${ids.project}/dashboard`, 'Dashboard'),
        jump: async (page) => {
            for (const tab of ['tree', 'vault', 'dashboard']) {
                await pressInPlace(page, `document.querySelector('nav[aria-label="Project views"] [data-tab="${tab}"]')`, `the ${tab} tab`);
                await sleep(500);
            }
            // The top bar's rail is drawn on the app-wide screens, not inside a course.
            await page.go('/projects', 'New');
            for (const tab of ['atlas', 'today', 'projects']) {
                await pressInPlace(page, `document.querySelector('[data-tab="${tab}"]')`, `the ${tab} tab`);
                await sleep(800);
            }
        },
    },
};

const states = {};
const report = [];
const SIZES = [{ width: 1280, height: 800, scale: 1 }, { width: 1024, height: 700, scale: 1 }];
for (const size of SIZES) {
    const tag = `${size.width}x${size.height}`;
    for (const [name, reach] of Object.entries(SCREENS)) {
        if (only && !name.includes(only)) continue;
        states[`${tag} ${name}`] = { size, kind: 'screen', name, reach };
    }
    for (const [name, j] of Object.entries(JUMPS)) {
        if (only && !name.includes(only)) continue;
        states[`${tag} jump: ${name}`] = { size, kind: 'jump', name, ...j };
    }
}
if (!Object.keys(states).length) {
    console.log(`  FAIL  --only ${only} names nothing\n0 passed, 1 failed`);
    process.exit(1);
}

async function runScreen(page, ctx, s, label) {
    await s.reach(page, ctx);
    await page.evaluate('scrollTo(0, 0), 1');
    const m = await page.evaluate(MEASURE);
    report.push(`${label}: document ${m.height}px in a ${m.window}px window`);
    check(`${label}: the page is no taller than the window (${m.height} <= ${m.window})`, m.height <= m.window,
        m.below.map((b) => `        ${b}`).join('\n'));
    const esc = await page.evaluate(ESCAPES);
    check(`${label}: no absolute element escapes the box that clips it`, !esc.length, esc.slice(0, 8).map((e) => `        ${e}`).join('\n'));
}

async function runJump(page, ctx, s, label) {
    for (const spacer of [false, true]) {
        await s.reach(page, ctx);
        await page.evaluate('scrollTo(0, 0), 1');
        const room = spacer ? await page.evaluate(SPACER_ON) : 0;
        try {
            await s.jump(page, ctx);
            const y = await page.evaluate('Math.round(scrollY)');
            check(`${label}${spacer ? ` (page made ${room}px taller than the window)` : ''}: the window does not scroll (scrollY ${y})`, y === 0);
        } finally {
            await page.evaluate(SPACER_OFF).catch(() => { });
        }
    }
}

const t0 = Date.now();
for (const size of SIZES) {
    const tag = `${size.width}x${size.height}`;
    const mine = Object.fromEntries(Object.entries(states).filter(([, s]) => s.size === size));
    if (!Object.keys(mine).length) continue;
    console.log(`\n${tag}:`);
    const run = {};
    for (const [label, s] of Object.entries(mine)) {
        run[label] = async (page, ctx) => {
            // The window as a desktop has it: no touch, the frame exactly this size.
            await page.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: false });
            try {
                if (s.kind === 'screen') await runScreen(page, ctx, s, label);
                else await runJump(page, ctx, s, label);
            } catch (err) {
                check(`${label}: reached and measured`, false, `        ${err.message.split('\n')[0]}`);
            }
        };
    }
    const scratch = mkdtempSync(join(tmpdir(), 'page-scroll-gates-'));
    try {
        await visit('fixture', scratch, [{ states: Object.keys(run) }], size, browserPath, async () => { }, prepare, run);
    } finally {
        removeScratch(scratch);
    }
}

console.log(`\n${Math.round((Date.now() - t0) / 1000)} s`);
console.log(`\npage-scroll gates: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
