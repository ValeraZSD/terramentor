#!/usr/bin/env node
/**
 * tools/panel-fit-gates.mjs — a course's columns fit the room they have: the
 * sidebar, the view in the middle and a topic's panel never run past the box
 * that holds them, whatever the window, the stored widths and the assistant.
 *
 *   node tools/panel-fit-gates.mjs                 every case below, in the built app
 *   node tools/panel-fit-gates.mjs --only 1280     only the cases whose name contains "1280"
 *   node tools/panel-fit-gates.mjs --browser <p>   a Chromium-based browser (default: Edge or Chrome)
 *   node tools/panel-fit-gates.mjs --shots <dir>   also a screenshot of every case
 *
 * WHY. The topic panel was drawn at its stored width (300-600px) inside a row
 * that clips, beside the course sidebar and the view in the middle. With the
 * assistant docked, that row is the window less the assistant: at 1280 with the
 * assistant at its default 520px it is 760px, the sidebar takes 256, and a panel
 * stored at 600 had 504px to stand in. The middle view went to nothing and the
 * panel's last ~96px (its Close button, the ends of its lines, its cards) were
 * cut off. The width was capped against the WINDOW, never against the room.
 *
 * Each case sets the stored widths and the language, opens a topic on the
 * course Dashboard (or none), docks the assistant or not, and then, at
 * 1024/1100/1280/1440 x 800:
 *
 *  1. No visible control and no line of text in the app column (everything but
 *     the assistant) runs past the side of a box that clips it. A box that
 *     scrolls sideways on purpose (a tab rail) does not count, and neither does
 *     a line cut with an ellipsis on purpose (`truncate`).
 *  2. With a topic open, its Close button is inside the window and is what a
 *     pointer at its centre would press.
 *  3. With a topic open, the middle view is either at least 20rem wide or not
 *     drawn at all: never a strip.
 *
 * The data is the invented course from tools/docs-fixture.mjs in a scratch
 * library (the scratch server sets its library paths in its own process). No
 * model and no network. Without Edge or Chrome it is SKIPPED locally and fails
 * in CI; a CI runner that is not Windows skips it, as page-scroll-gates does.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const only = value('--only');
const shots = value('--shots');
if (shots) mkdirSync(shots, { recursive: true });

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? `\n${extra}` : ''}`); }
};

delete process.env.__COMPAT_LAYER;

if (process.env.CI && process.platform !== 'win32') {
    console.log(`SKIPPED: the columns are measured on Windows; this CI runner is ${process.platform}`);
    process.exit(0);
}

const { visit, findBrowser, removeScratch } = await import(pathToFileURL(join(ROOT, 'tools', 'docs-shots.mjs')).href);
const { prepare } = await import(pathToFileURL(join(ROOT, 'tools', 'docs-fixture.mjs')).href);

let browserPath;
try {
    browserPath = findBrowser(value('--browser'));
} catch {
    if (process.env.CI) { console.log('  FAIL  no Edge or Chrome to run the screens in'); console.log('0 passed, 1 failed'); process.exit(1); }
    console.log('SKIPPED: no Edge or Chrome found (pass --browser <path>)');
    process.exit(0);
}

// dist/, built from the sources being checked (as page-scroll-gates does).
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
// What is measured in the page.
// ---------------------------------------------------------------------------

/**
 * Everything in the app column that is drawn and runs past the inline side of
 * a box that clips it. Controls by their box, text by its line boxes (a Range),
 * so a word cut in half inside a wide paragraph is caught as well as a button.
 *
 * A clipping box is one whose `overflow-x` is not `visible`. One that scrolls
 * sideways ON PURPOSE (a tab rail: its class says `overflow-x-auto` or
 * `overflow-x-scroll`) is skipped: what is past its edge is a scroll away. A
 * box that scrolls DOWN (`overflow-y-auto`) also computes `overflow-x: auto`,
 * and content past its side is just as cut for a reader, so it counts.
 */
const CUT = `(() => {
    const assistant = document.querySelector('aside[aria-label="Assistant"]');
    const skip = (el) => !el || (assistant && assistant.contains(el));
    const rail = (a) => typeof a.className === 'string' && /(^|\\s)(overflow-x-(auto|scroll)|overflow-auto)(\\s|$)/.test(a.className) && a.scrollWidth > a.clientWidth + 1;
    const hiddenTwin = (el) => {
        for (let a = el; a && a !== document.body; a = a.parentElement) {
            const s = getComputedStyle(a);
            if (s.visibility === 'hidden' || s.display === 'none' || s.opacity === '0' || s.position === 'fixed') return true;
            if (s.position === 'absolute' && a.offsetWidth <= 1 && a.offsetHeight <= 1) return true;
            if (s.clip && s.clip !== 'auto') return true;
        }
        return false;
    };
    const name = (el) => {
        const cls = typeof el.className === 'string' ? el.className.trim().split(/\\s+/).slice(0, 4).join('.') : '';
        const text = (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40);
        return el.tagName.toLowerCase() + (cls ? '.' + cls : '') + (text ? ' "' + text + '"' : '');
    };
    /** The first box between el and the page that clips el sideways, and by how much. */
    const cutBy = (el, rect) => {
        if (rect.width < 1 || rect.height < 1) return null;
        for (let a = el.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
            const s = getComputedStyle(a);
            if (s.overflowX === 'visible') continue;
            if (s.textOverflow === 'ellipsis') return null;
            if (rail(a)) return null;
            const b = a.getBoundingClientRect();
            const bl = b.left + a.clientLeft, br = bl + a.clientWidth;
            const over = Math.max(bl - rect.left, rect.right - br);
            if (over > 1.5) return { box: a, over: Math.round(over) };
        }
        return null;
    };
    const out = [];
    const seen = new Set();
    const note = (el, what, c) => {
        const key = c.box;
        if (seen.has(el)) return;
        seen.add(el);
        out.push(what + ' cut by ' + c.over + 'px at the side of ' + name(key).slice(0, 70));
    };
    const CONTROLS = 'button, a[href], input, select, textarea, [role="button"], [role="tab"], [role="checkbox"], [role="switch"]';
    for (const el of document.querySelectorAll(CONTROLS)) {
        if (skip(el) || !el.getClientRects().length || hiddenTwin(el)) continue;
        const c = cutBy(el, el.getBoundingClientRect());
        if (c) note(el, name(el), c);
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const el = n.parentElement;
        if (!n.data.trim() || skip(el) || !el.getClientRects().length || el.closest('svg, math, .katex-mathml, script, style') || hiddenTwin(el)) continue;
        range.selectNodeContents(n);
        for (const r of range.getClientRects()) {
            const c = cutBy(el, r);
            if (c) { note(el, 'text "' + n.data.trim().replace(/\\s+/g, ' ').slice(0, 40) + '"', c); break; }
        }
    }
    return out;
})()`;

/** The topic's Close: in the window, and what a pointer at its centre presses. */
const CLOSE = `(() => {
    const b = [...document.querySelectorAll('[data-close]')].find((e) => e.getClientRects().length);
    if (!b) return { found: false };
    const r = b.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { found: true, inside: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight, pressable: !!hit && b.contains(hit), x: Math.round(x), right: Math.round(r.right), w: innerWidth };
})()`;

/** The middle view's width, the panel's and the sidebar's (0 when not drawn). */
const COLUMNS = `(() => {
    const w = (el) => el && el.getClientRects().length ? Math.round(el.getBoundingClientRect().width) : 0;
    const panel = document.querySelector('[data-close]')?.closest('aside');
    const sidebar = document.querySelector('[data-course-sidebar]');
    const middle = document.querySelector('[data-workspace-center]') ?? (panel ? panel.previousElementSibling : null);
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    return { panel: w(panel), sidebar: w(sidebar), middle: w(middle), rem };
})()`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// The cases.
// ---------------------------------------------------------------------------

const ASSISTANT_BUTTON = `document.querySelector('button[title^="Ask the assistant"]')`;
const ASSISTANT = `document.querySelector('aside[aria-label="Assistant"]')`;

/**
 * One case: the stored widths and language, a course screen, the assistant.
 * `assistantWidth` is what a drag would have left in the browser's storage.
 */
function reachCase({ panel = 420, sidebar = 256, assistant = false, assistantWidth = null, topic = true, lang = 'en' }) {
    return async (page, ctx) => {
        await page.setting('detailPanelWidth', String(panel));
        await page.setting('sidebarWidth', String(sidebar));
        await page.setting('ui_language', lang);
        await page.evaluate(`(() => { ${assistantWidth == null ? "localStorage.removeItem('assistant.width')" : `localStorage.setItem('assistant.width', '${assistantWidth}')`}; return 1; })()`);
        const path = `/project/${ctx.ids.project}/dashboard${topic ? `/${ctx.ids.study}` : ''}`;
        await page.go(path, null);
        await page.waitFor(topic ? `document.querySelector('[data-close]')` : `document.querySelector('[data-course-sidebar]')`, topic ? 'the topic panel' : 'the course sidebar');
        if (assistant) {
            await page.waitFor(ASSISTANT_BUTTON, 'the assistant button');
            await page.evaluate(`(${ASSISTANT_BUTTON}).click(), 1`);
            await page.waitFor(ASSISTANT, 'the assistant');
        }
        await sleep(1500);
    };
}

const CASES = {};
const SIZES = [1024, 1100, 1280, 1440].map((width) => ({ width, height: 800, scale: 1 }));
for (const size of SIZES) {
    const at = (name, c) => { CASES[`${size.width} ${name}`] = { size, c }; };
    for (const assistant of [false, true]) {
        const a = assistant ? 'assistant docked' : 'assistant closed';
        for (const panel of [300, 420, 600]) at(`${a}, panel ${panel}`, { assistant, panel });
        at(`${a}, no topic`, { assistant, topic: false });
    }
    at('assistant docked, panel 420, sidebar 600', { assistant: true, panel: 420, sidebar: 600 });
    at('assistant dragged to 800, panel 420', { assistant: true, panel: 420, assistantWidth: 800 });
}
// Right to left: the panel docks at the other side; the same room rules hold.
CASES['1280 right to left, assistant docked, panel 600'] = { size: SIZES[2], c: { assistant: true, panel: 600, lang: 'ar' } };
CASES['1440 right to left, assistant closed, panel 600'] = { size: SIZES[3], c: { panel: 600, lang: 'ar' } };
// The handles. With the assistant docked at 1440 the row is 920px: the panel's
// far edge is the assistant's, not the window's, so a drag to 320 is 320; the
// sidebar stops where the middle view (20rem) and the panel (300) still fit.
CASES['1440 drag the panel to 320, assistant docked'] = { size: SIZES[3], c: { assistant: true, panel: 420 }, drag: { handle: 'panel', to: 320, expect: 320 } };
CASES['1440 drag the sidebar to 500, assistant docked'] = { size: SIZES[3], c: { assistant: true, panel: 420 }, drag: { handle: 'sidebar', to: 500, expect: 300 } };
CASES['1440 right to left, drag the panel to 500'] = { size: SIZES[3], c: { panel: 420, lang: 'ar' }, drag: { handle: 'panel', to: 500, expect: 500 } };

/** The column a handle sizes, and the handle on its edge. */
const COLUMN = {
    panel: `document.querySelector('[data-close]')?.closest('aside')`,
    sidebar: `document.querySelector('[data-course-sidebar]')`,
};
/** Drag a column's handle so that the column would be `to` px wide, as a mouse does. */
async function drag(page, { handle, to }) {
    const at = await page.evaluate(`(() => {
        const col = ${COLUMN[handle]};
        const grip = col && [...col.children].find((c) => getComputedStyle(c).cursor === 'col-resize');
        if (!grip) return null;
        const g = grip.getBoundingClientRect(), r = col.getBoundingClientRect();
        const rtl = getComputedStyle(document.documentElement).direction === 'rtl';
        // The panel grows away from its far (inline-end) edge, the sidebar away from its near one.
        const target = ${JSON.stringify(handle)} === 'panel' ? (rtl ? r.left + ${to} : r.right - ${to}) : (rtl ? r.right - ${to} : r.left + ${to});
        return { x: g.left + g.width / 2, y: g.top + g.height / 2, target };
    })()`);
    if (!at) throw new Error(`no resize handle on the ${handle}`);
    const mouse = (type, x, extra = {}) => page.send('Input.dispatchMouseEvent', { type, x, y: at.y, button: 'left', ...extra });
    await mouse('mouseMoved', at.x, { button: 'none' });
    await mouse('mousePressed', at.x, { clickCount: 1 });
    for (let i = 1; i <= 8; i++) { await mouse('mouseMoved', at.x + (at.target - at.x) * i / 8, { buttons: 1 }); await sleep(40); }
    await mouse('mouseReleased', at.target, { clickCount: 1 });
    await sleep(800);
}

const t0 = Date.now();
for (const size of SIZES) {
    const mine = Object.entries(CASES).filter(([label, s]) => s.size === size && (!only || label.includes(only)));
    if (!mine.length) continue;
    console.log(`\n${size.width}x${size.height}:`);
    const run = {};
    for (const [label, s] of mine) {
        run[label] = async (page, ctx) => {
            await page.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: false });
            try {
                await reachCase(s.c)(page, ctx);
                if (s.drag) {
                    await drag(page, s.drag);
                    const got = await page.evaluate(`Math.round((${COLUMN[s.drag.handle]})?.getBoundingClientRect().width ?? -1)`);
                    check(`${label}: the ${s.drag.handle} is drawn ${s.drag.expect}px wide (${got})`, Math.abs(got - s.drag.expect) <= 2);
                }
                if (shots) writeFileSync(join(shots, `${label.replace(/[^\w]+/g, '-')}.png`), await page.png());
                const cut = await page.evaluate(CUT);
                check(`${label}: nothing in the app column is cut at the side of a box`, !cut.length,
                    cut.slice(0, 8).map((x) => `        ${x}`).join('\n') + (cut.length > 8 ? `\n        ... and ${cut.length - 8} more` : ''));
                if (s.c.topic !== false) {
                    const close = await page.evaluate(CLOSE);
                    check(`${label}: the topic's Close is in the window and pressable`, close.found && close.inside && close.pressable,
                        `        ${JSON.stringify(close)}`);
                    const col = await page.evaluate(COLUMNS);
                    check(`${label}: the middle view is 20rem or more, or not drawn (${col.middle}px; panel ${col.panel}, sidebar ${col.sidebar})`,
                        col.middle === 0 || col.middle >= 20 * col.rem - 1);
                }
            } catch (err) {
                check(`${label}: reached and measured`, false, `        ${err.message.split('\n')[0]}`);
            } finally {
                await page.setting('ui_language', 'en').catch(() => { });
            }
        };
    }
    const scratch = mkdtempSync(join(tmpdir(), 'panel-fit-gates-'));
    try {
        await visit('fixture', scratch, [{ states: Object.keys(run) }], size, browserPath, async () => { }, prepare, run);
    } finally {
        removeScratch(scratch);
    }
}

console.log(`\n${Math.round((Date.now() - t0) / 1000)} s`);
console.log(`\npanel-fit gates: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
