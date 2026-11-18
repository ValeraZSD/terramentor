#!/usr/bin/env node
/**
 * Settings → Accessibility → "Larger text and buttons", measured in a browser.
 *
 *   node tools/larger-ui-gates.mjs                 every screen, setting off and on
 *   node tools/larger-ui-gates.mjs --only card     only the screens whose name contains "card"
 *   node tools/larger-ui-gates.mjs --shots <dir>   also save a picture of every state
 *   node tools/larger-ui-gates.mjs --looks         add dark and Windows High Contrast states
 *   node tools/larger-ui-gates.mjs --browser <p>   a Chromium-based browser (default: Edge or Chrome)
 *
 * The invented course from tools/docs-fixture.mjs, built and served the way
 * tools/axe-gates.mjs does it. Each screen is opened at desktop and phone width
 * with the setting off and then on, and two things are counted on it:
 *
 *   small targets  every control (button, link, field, select, tab, option,
 *                  tickbox...) whose pressable area is under 2.75rem (44px at
 *                  100%) in either direction. The area is the control and
 *                  whatever it holds that takes the pointer, so a switch whose
 *                  target spills round its track counts at its real size, and
 *                  a tickbox counts with its label. A link inside running text
 *                  is exempt (WCAG 2.5.5).
 *   small text     every element showing text under 0.875rem (14px at 100%).
 *                  Formulas, drawings (SVG) and super/subscripts are exempt:
 *                  their size is part of what they say.
 *
 * With the setting on, both must be zero, and axe's own target-size rule must
 * find nothing. With it off the counts are printed: they are what the setting
 * changes, and a count of zero there means the measurement saw nothing, which
 * fails the run.
 *
 * Without Edge or Chrome it is SKIPPED locally and fails in CI. Like axe-gates,
 * it counts on Windows: another system's fonts lay lines out differently.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(ROOT, 'tools', 'docs-fixture.mjs');
const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

const args = process.argv.slice(2);
const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const only = value('--only');
const shots = value('--shots');
const looks = args.includes('--looks');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? `\n${extra}` : ''}`); }
};

delete process.env.__COMPAT_LAYER;

if (process.env.CI && process.platform !== 'win32') {
    console.log(`SKIPPED: the sizes are counted on Windows; this CI runner is ${process.platform}`);
    process.exit(0);
}

const { visit, findBrowser, removeScratch, STATES, byText } = await import(pathToFileURL(join(ROOT, 'tools', 'docs-shots.mjs')).href);

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
// The screens: settings, a review session, the feed, the course, a dialog.
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const go = (path, needle = null, wait = 1200) => async (page, ctx) => {
    await page.go(typeof path === 'function' ? path(ctx.ids) : path, needle);
    await sleep(wait);
};
const cardFront = async (page, ctx) => {
    const study = byText('button', '/^Study [\\d.,\\s]+ cards?$/');
    await page.go(`/project/${ctx.ids.project}/dashboard`, null);
    await page.waitFor(study, 'the cards owed');
    await page.press(study, 'Study the cards owed');
    await page.waitFor(`document.querySelector('[data-owns-keyboard]')`, 'the review session');
    await sleep(800);
};
const SCREENS = {
    'settings-accessibility': async (page) => {
        await page.go('/settings', 'Settings');
        const tab = byText('button', '/^Accessibility/');
        await page.waitFor(tab, 'Accessibility');
        await page.press(tab, 'Accessibility');
        await sleep(1000);
    },
    'card-front': cardFront,
    'card-answer': async (page, ctx) => {
        await cardFront(page, ctx);
        await page.press(byText('button', '/^Reveal answer/'), 'Reveal answer');
        await sleep(800);
    },
    // Each screen waits for something of its own: the header alone (on every
    // screen) and the probes would pass the render check with the page missing.
    home: async (page, ctx) => {
        await go('/', null, 2000)(page, ctx);
        await page.waitFor(`document.querySelector('[style*="--feed-top"]')`, 'the home feed');
    },
    'course-dashboard': go((ids) => `/project/${ids.project}/dashboard`, 'Dashboard', 1800),
    outline: async (page, ctx) => {
        await go((ids) => `/project/${ids.project}/tree`)(page, ctx);
        await page.waitFor(`document.querySelector('[data-card-grid] [data-row="title"]')`, 'the outline cards');
    },
    topic: go((ids) => `/project/${ids.project}/tree/${ids.study}`, 'Details'),
    'new-course': STATES['new-course'],
};

// Two sizes at the ends of the interface-size range, on the screens they can
// break: at 80% 2.75rem is 35px, so anything sized in rem alone falls under
// 44px (a switch's spill, a tickbox's input); at 160% on an 800px window the
// tree's 17.5rem is 448px, and beside the details pane the page had no width.
const SIZES = {
    desktop: { width: 1280, height: 800, scale: 1 },
    phone: { width: 390, height: 844, scale: 1 },
    'desktop-80%': { width: 1280, height: 800, scale: 1, uiScale: 80, screens: ['settings-accessibility', 'topic'] },
    'narrow-160%': { width: 800, height: 800, scale: 1, uiScale: 160, screens: ['topic'] },
};
const LOOKS = ['light', 'dark', 'contrast'];
// Without --looks: light everywhere, plus one dense screen in high contrast,
// where a control's frame is drawn and an ancestor can cut it.
const ALWAYS = new Set(['topic desktop contrast']);
const runs = (screen, viewport, look) => (!SIZES[viewport].screens || SIZES[viewport].screens.includes(screen))
    && (looks ? !SIZES[viewport].uiScale || look === 'light' : look === 'light' || ALWAYS.has(`${screen} ${viewport} ${look}`));
const wanted = Object.keys(SCREENS).filter((s) => !only || s.includes(only));
if (!wanted.length) {
    console.log(`  FAIL  --only ${only} names no screen (screens: ${Object.keys(SCREENS).join(', ')})\n0 passed, 1 failed`);
    process.exit(1);
}

const states = {};
for (const screen of wanted) for (const viewport of Object.keys(SIZES)) for (const look of LOOKS) for (const mode of ['off', 'on']) {
    if (!runs(screen, viewport, look)) continue;
    states[`${screen} ${viewport} ${look} ${mode}`] = async (page, ctx) => {
        const { width, height } = SIZES[viewport];
        await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
        await page.send('Emulation.setTouchEmulationEnabled', viewport === 'phone' ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
        await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: look === 'contrast' ? 'active' : 'none' }] });
        await page.setting('theme', look === 'dark' ? 'dark' : 'light');
        await page.setting('larger_ui', mode === 'on' ? 'true' : 'false');
        await page.setting('ui_scale', SIZES[viewport].uiScale ?? 100);
        await SCREENS[screen](page, ctx);
    };
}

// ---------------------------------------------------------------------------
// The measurement, in the page.
// ---------------------------------------------------------------------------

const MEASURE = `(() => {
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const minTarget = Math.max(2.75 * rem, 44) - 0.5;   // half a pixel for subpixel layout
    const minText = 0.875 * rem - 0.05;
    const name = (el) => (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || el.tagName).trim().replace(/\\s+/g, ' ').slice(0, 40);
    const where = (el) => {
        const parts = [];
        for (let e = el; e && e !== document.body && parts.length < 3; e = e.parentElement) {
            parts.unshift(e.tagName.toLowerCase() + (e.getAttribute('role') ? '[role=' + e.getAttribute('role') + ']' : '') + (typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\\s+/).slice(0, 3).join('.') : ''));
        }
        return parts.join(' > ');
    };
    // aria-hidden text is still painted, so the text count keeps it.
    const shown = (el, painted = false) => {
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return false;
        if (el.closest(painted ? '.sr-only' : '[inert], [aria-hidden="true"], .sr-only')) return false;
        const cs = getComputedStyle(el);
        return cs.visibility !== 'hidden' && cs.display !== 'none';
    };
    // The pressable area: the control, and what it holds that takes the
    // pointer, as far as it shows: a part spilling past a box that clips its
    // overflow (the control itself included) is cut back to that box.
    const area = (el) => {
        let r = el.getBoundingClientRect();
        let [l, t, rt, b] = [r.left, r.top, r.right, r.bottom];
        const grow = (x) => {
            const q = x.getBoundingClientRect();
            let [ql, qt, qr, qb] = [q.left, q.top, q.right, q.bottom];
            for (let a = x.parentElement; a; a = a.parentElement) {
                const s = getComputedStyle(a);
                const k = a.getBoundingClientRect();
                if (s.overflowX !== 'visible') { ql = Math.max(ql, k.left + a.clientLeft); qr = Math.min(qr, k.left + a.clientLeft + a.clientWidth); }
                if (s.overflowY !== 'visible') { qt = Math.max(qt, k.top + a.clientTop); qb = Math.min(qb, k.top + a.clientTop + a.clientHeight); }
                if (a === el) break;
            }
            if (qr - ql < 1 || qb - qt < 1) return;
            l = Math.min(l, ql); t = Math.min(t, qt); rt = Math.max(rt, qr); b = Math.max(b, qb);
        };
        for (const c of el.querySelectorAll('*')) if (getComputedStyle(c).pointerEvents !== 'none') grow(c);
        if (el.matches('input[type="checkbox"], input[type="radio"]')) for (const label of el.labels || []) grow(label);
        return { w: rt - l, h: b - t };
    };
    const CONTROLS = 'button, select, summary, a[href], input:not([type="hidden"]), textarea, [role="button"], [role="tab"], [role="switch"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"], [role="radio"], [role="checkbox"], [role="slider"]';
    const targets = [];
    const probe = {};
    // Each control's own minimum, by place and name: the floor replaces it,
    // so a control that asked for more than the floor must keep asking.
    // (Its rendered height is no use here: a stretched flex item follows its
    // neighbours, and they change as text grows.)
    const px = (v) => v.endsWith('px') ? parseFloat(v) : 0;
    const mins = {};
    let controls = 0;
    for (const el of document.querySelectorAll(CONTROLS)) {
        // A link in running text, as the CSS rule spares it; a chip drawn in
        // an answer sits under .not-prose and is measured like any control.
        if (el.matches(':is(p, blockquote, .prose) a') && !el.closest('.not-prose')) continue;
        // A control inside another control is pressed through its parent.
        if (el.parentElement && el.parentElement.closest(CONTROLS) && !el.matches('input[type="checkbox"], input[type="radio"]')) continue;
        if (!shown(el) && !el.matches('input[type="checkbox"], input[type="radio"]')) continue;
        if (el.matches('input[type="checkbox"], input[type="radio"]') && (el.closest('[inert], [aria-hidden="true"]') || !el.getClientRects().length)) continue;
        const a = area(el);
        if (el.closest('[data-gate-probe]')) { probe[el.dataset.probe] = { small: a.w < minTarget || a.h < minTarget, h: Math.round(a.h), minH: px(getComputedStyle(el).minHeight) }; continue; }
        controls++;
        const key = where(el) + ' | ' + name(el);
        const cs = getComputedStyle(el);
        mins[key] = key in mins ? null : [px(cs.minHeight), px(cs.minWidth)];
        if (a.w < minTarget || a.h < minTarget) targets.push({ name: name(el), size: Math.round(a.w) + 'x' + Math.round(a.h), where: where(el) });
    }
    const text = [];
    const seen = new Set();
    let textRuns = 0;
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        if (!n.nodeValue.trim()) continue;
        const el = n.parentElement;
        if (!el || seen.has(el)) continue;
        seen.add(el);
        if (el.closest('svg, .katex, sup, sub, script, style, noscript, template')) continue;
        if (!shown(el, true)) continue;
        const size = parseFloat(getComputedStyle(el).fontSize);
        if (el.closest('[data-gate-probe]')) { if (el.dataset.probe === 'text') probe.text = { small: size < minText }; continue; }
        textRuns++;
        if (size < minText) text.push({ text: n.nodeValue.trim().slice(0, 40), size: (size / rem).toFixed(3) + 'rem', where: where(el) });
    }
    // In forced colours every control wears a frame (its outline). An
    // ancestor that clips its overflow and does not scroll must leave that
    // frame whole: a title button 4px wider than its truncating heading kept
    // only its right edge, a stray "]" beside the title.
    const cut = [];
    if (matchMedia('(forced-colors: active)').matches) {
        for (const el of document.querySelectorAll(CONTROLS)) {
            // Of the probes only the rail's tab: a sideways rail as tall as it.
            const isProbe = !!el.closest('[data-gate-probe]');
            if (!shown(el) || (isProbe && el.dataset.probe !== 'rail')) continue;
            if (isProbe) probe.railCut = '';
            const cs = getComputedStyle(el);
            const w = parseFloat(cs.outlineWidth) || 0;
            if (cs.outlineStyle === 'none' || w === 0) continue;
            const out = w + (parseFloat(cs.outlineOffset) || 0);
            if (out <= 0) continue;
            const r = el.getBoundingClientRect();
            // Only boxes on the containing-block chain clip: a fixed box (the
            // phone's detail sheet) escapes every ancestor but a transformed
            // one, an absolute box every ancestor below its positioned one.
            let pos = cs.position;
            // A scroller cuts what is scrolled out of view along the axis it
            // scrolls, and so does every box round it; that is not a defect.
            // The other axis still counts: a tab rail that scrolls sideways
            // must not cut its tabs' top and bottom.
            let freeX = false, freeY = false;
            for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
                const as = getComputedStyle(a);
                const holds = as.transform !== 'none' || as.filter !== 'none';
                if (pos === 'fixed' && !holds) continue;
                if (pos === 'absolute' && as.position === 'static' && !holds) continue;
                pos = as.position;
                if (as.overflowX === 'visible' && as.overflowY === 'visible') continue;
                if (a.scrollWidth > a.clientWidth + 1) freeX = true;
                if (a.scrollHeight > a.clientHeight + 1) freeY = true;
                if (freeX && freeY) break;
                const b = a.getBoundingClientRect();
                const box = { l: b.left + a.clientLeft, t: b.top + a.clientTop, r: b.left + a.clientLeft + a.clientWidth, b: b.top + a.clientTop + a.clientHeight };
                const sides = [];
                const past = (side, px) => { if (px > 0.5) sides.push(side + ' ' + px.toFixed(1) + 'px'); };
                if (as.overflowX !== 'visible' && !freeX) { past('left', box.l - (r.left - out)); past('right', r.right + out - box.r); }
                if (as.overflowY !== 'visible' && !freeY) { past('top', box.t - (r.top - out)); past('bottom', r.bottom + out - box.b); }
                if (sides.length && isProbe) { probe.railCut = sides.join(', '); break; }
                if (sides.length) { cut.push({ name: name(el), sides: sides.join(', '), where: where(el), by: where(a) }); break; }
            }
        }
    }
    // A row's or card's title button is framed only when it is the open one
    // (or focused): framed at rest, every title read as a box in its card.
    const titles = { all: 0, framed: [] };
    if (matchMedia('(forced-colors: active)').matches) {
        for (const el of document.querySelectorAll('button[data-row="title"]')) {
            if (!shown(el)) continue;
            titles.all++;
            if (el.hasAttribute('aria-current') || el === document.activeElement) continue;
            const cs = getComputedStyle(el);
            if (cs.outlineStyle !== 'none' && (parseFloat(cs.outlineWidth) || 0) > 0) titles.framed.push(name(el));
        }
    }
    // The page between the course tree and the details pane.
    const side = document.querySelector('[data-course-sidebar]');
    const main = side && [...side.parentElement.children].find((c) => c !== side && c.tagName === 'DIV');
    const centre = main ? { w: Math.round(main.getBoundingClientRect().width), row: side.parentElement.clientWidth } : null;
    return { attr: document.documentElement.hasAttribute('data-larger-ui'), rem, targets, text, mins, probe, cut, titles, centre, examined: { controls, text: textRuns } };
})()`;

// Three known controls put on every page, so the counts cannot pass by
// measuring nothing: a 20px button and a label in the smallest size (the
// measurement must see both with the setting off, and the setting must grow
// both), and a button that asks for 64px (the floor must not take it away).
// Off-screen, so no screenshot shows them; removed before the shot anyway.
const PROBE = `(() => {
    const box = document.createElement('div');
    box.setAttribute('data-gate-probe', '');
    box.style.cssText = 'position:fixed;left:-400px;top:0;width:300px';
    box.innerHTML = '<button type="button" data-probe="small" class="w-5 h-5 p-0">x</button>'
        + '<span data-probe="text" class="text-3xs">probe</span>'
        + '<button type="button" data-probe="tall" class="min-h-16 w-full">tall</button>'
        // A drill's answer: 3rem asked, and never under 44px at 80%.
        + '<button type="button" data-probe="answer" class="min-h-12 w-full border-2">answer</button>'
        // A switch's 24px track whose target spills round it (ui/Switch.tsx),
        // and the same one inside a track that clips it: only what shows counts.
        + '<button type="button" role="switch" data-probe="spill" class="relative block w-11 h-6 my-4 p-0"><span data-switch-spill class="absolute -inset-x-1.5 -inset-y-2.5"></span></button>'
        + '<button type="button" role="switch" data-probe="clipped" class="relative block w-11 h-6 my-4 p-0 overflow-hidden"><span data-switch-spill class="absolute -inset-x-1.5 -inset-y-2.5"></span></button>'
        // A tab in a rail that scrolls sideways and is no taller than the tab.
        + '<div style="overflow-x:auto;width:60px;white-space:nowrap"><button type="button" data-probe="rail" class="outline-none" style="width:200px">tab</button></div>';
    document.body.appendChild(box);
})()`;
const UNPROBE = `document.querySelector('[data-gate-probe]')?.remove()`;

const AXE_TARGETS = `(async () => {
    if (!window.axe) { (0, eval)(${JSON.stringify(AXE_SOURCE)}); }
    const r = await window.axe.run(document, { runOnly: { type: 'rule', values: ['target-size'] }, resultTypes: ['violations'] });
    return r.violations.flatMap((v) => v.nodes.map((n) => n.target.join(' ')));
})()`;

const seen = {};
const scratch = mkdtempSync(join(tmpdir(), 'larger-ui-gates-'));
if (shots) mkdirSync(shots, { recursive: true });
const t0 = Date.now();
try {
    const { prepare } = await import(pathToFileURL(FIXTURE).href);
    await visit('fixture', scratch, [{ states: Object.keys(states) }], SIZES.desktop, browserPath, async (_entry, state, page) => {
        await page.evaluate(PROBE);
        const m = await page.evaluate(MEASURE);
        m.axe = state.endsWith(' on') ? await page.evaluate(AXE_TARGETS) : [];
        seen[state] = m;
        await page.evaluate(UNPROBE);
        if (shots) writeFileSync(join(shots, `${state.replace(/ /g, '_')}.png`), await page.png());
    }, prepare, states);
} finally {
    removeScratch(scratch);
}
console.log(`\n${Object.keys(seen).length} states in ${((Date.now() - t0) / 1000).toFixed(0)} s\n`);

// ---------------------------------------------------------------------------
// The counts, off -> on, and the checks.
// ---------------------------------------------------------------------------

const rows = [];
let offTargets = 0, offText = 0, onTargets = 0, onText = 0;
for (const screen of wanted) for (const viewport of Object.keys(SIZES)) for (const look of LOOKS) {
    const off = seen[`${screen} ${viewport} ${look} off`], on = seen[`${screen} ${viewport} ${look} on`];
    if (!off || !on) continue;
    rows.push(`  ${`${screen} ${viewport}${look === 'light' ? '' : ` ${look}`}`.padEnd(36)} targets ${String(off.targets.length).padStart(3)} -> ${String(on.targets.length).padEnd(3)}  text ${String(off.text.length).padStart(3)} -> ${on.text.length}`);
    if (look === 'light') { offTargets += off.targets.length; offText += off.text.length; onTargets += on.targets.length; onText += on.text.length; }
}
console.log(`small targets and small text, setting off -> on:\n${rows.join('\n')}\n  ${'all screens (light)'.padEnd(36)} targets ${String(offTargets).padStart(3)} -> ${String(onTargets).padEnd(3)}  text ${String(offText).padStart(3)} -> ${onText}\n`);

const list = (items, fmt) => items.slice(0, 6).map((x) => `        ${fmt(x)}`).join('\n') + (items.length > 6 ? `\n        ...and ${items.length - 6} more` : '');
for (const [state, m] of Object.entries(seen)) {
    const on = state.endsWith(' on');
    check(`${state}: the page ${on ? 'carries' : 'does not carry'} data-larger-ui`, m.attr === on);
    // A screen that never rendered would pass every count below with nothing in it.
    if (state.includes(' contrast ')) check(`${state}: every control's high-contrast frame is whole`, m.cut.length === 0, list(m.cut, (x) => `${x.sides} cut  "${x.name}"  ${x.where}  (by ${x.by})`));
    // The topic screen holds tree, outline and card titles, so it cannot pass with none.
    if (state.includes(' contrast ')) check(`${state}: only the open title wears a high-contrast frame (${m.titles.all} titles)`,
        m.titles.framed.length === 0 && (!state.startsWith('topic ') || m.titles.all >= 5), list(m.titles.framed, (x) => `framed at rest  "${x}"`));
    check(`${state}: the screen rendered (${m.examined.controls} controls, ${m.examined.text} text runs)`, m.examined.controls >= 5 && m.examined.text >= 5);
    const p = m.probe;
    check(`${state}: a 20px button and a 10px label are ${on ? 'grown past the floors' : 'seen as too small'}`,
        !!(p.small && p.text) && p.small.small === !on && p.text.small === !on, JSON.stringify(p));
    // Clipping counts: the clipped spill is 24px tall whatever the setting.
    check(`${state}: a switch whose spill is clipped is seen as too small`, p.clipped?.small === true, JSON.stringify(p.clipped));
    if (state.includes(' contrast ')) check(`${state}: a sideways rail that cuts its tab's top and bottom frame is caught`,
        /top .*bottom/.test(p.railCut ?? ''), JSON.stringify(p.railCut));
    const scale = SIZES[state.split(' ')[1]].uiScale ?? 100;
    check(`${state}: the page runs at ${scale}% text`, Math.abs(m.rem - 16 * scale / 100) < 0.1, `${m.rem}px`);
    if (!on) continue;
    // The tree may grow for its buttons, never at the page's cost: the page
    // keeps what it had with the setting off, or a quarter of the row.
    const offState = seen[state.replace(/ on$/, ' off')];
    if (m.centre && offState?.centre) check(`${state}: the page beside the tree keeps its width (${offState.centre.w} -> ${m.centre.w}px of ${m.centre.row})`,
        m.centre.w >= Math.min(offState.centre.w, 0.25 * m.centre.row) - 1);
    check(`${state}: a button that asks for 4rem keeps it`, p.tall?.minH >= 4 * m.rem - 0.5, JSON.stringify(p.tall));
    check(`${state}: a 3rem answer keeps 3rem and the 44px floor`, p.answer && !p.answer.small && p.answer.minH >= 3 * m.rem - 0.5, JSON.stringify(p.answer));
    check(`${state}: a switch's spill reaches the floor`, p.spill?.small === false, JSON.stringify(p.spill));
    const off = seen[state.replace(/ on$/, ' off')];
    const shrunk = off ? Object.entries(m.mins).filter(([k, v]) => v && off.mins[k] && (off.mins[k][0] - v[0] > 0.5 || off.mins[k][1] - v[1] > 0.5))
        .map(([k, v]) => `min ${off.mins[k].map(Math.round).join('x')} -> ${v.map(Math.round).join('x')}  ${k}`) : [];
    check(`${state}: no control asks for less than it did with the setting off`, shrunk.length === 0, list(shrunk, (x) => x));
    check(`${state}: no control under 44px`, m.targets.length === 0, list(m.targets, (x) => `${x.size}  "${x.name}"  ${x.where}`));
    check(`${state}: no text under 14px`, m.text.length === 0, list(m.text, (x) => `${x.size}  "${x.text}"  ${x.where}`));
    check(`${state}: axe target-size finds nothing`, m.axe.length === 0, list(m.axe, (x) => x));
}
check('with the setting off the measurement sees small controls and text (it really measures)', offTargets > 0 && offText > 0, `targets ${offTargets}, text ${offText}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
