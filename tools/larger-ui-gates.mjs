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
    // The form behind "Create a course": name field, material list, the foot.
    'new-course-form': STATES['new-course-form'],
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
    // A phone at the largest text: the detail header cannot fit one line
    // even with Close as the X, so Close keeps its word on the second line.
    'phone-160%': { width: 390, height: 844, scale: 1, uiScale: 160, screens: ['topic'] },
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
    // A box clips what it holds only on its containing-block chain: a fixed
    // box (the phone's detail sheet) escapes every ancestor but a transformed
    // one, an absolute box every ancestor below its positioned one. Walks
    // that chain up from \`from\`, calling \`each(ancestor, style, box)\` for
    // every one that clips on some axis; \`each\` returns true to stop.
    const clippers = (from, each) => {
        let pos = getComputedStyle(from).position;
        for (let a = from.parentElement; a && a !== document.documentElement; a = a.parentElement) {
            const s = getComputedStyle(a);
            const holds = s.transform !== 'none' || s.filter !== 'none';
            if (pos === 'fixed' && !holds) continue;
            if (pos === 'absolute' && s.position === 'static' && !holds) continue;
            pos = s.position;
            if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
            // The client box in viewport pixels: the rect is drawn (it carries
            // every transform), clientWidth and the borders are not, so they are
            // scaled by how much the box is drawn larger or smaller than laid out.
            const k = a.getBoundingClientRect();
            const sx = a.offsetWidth ? k.width / a.offsetWidth : 1, sy = a.offsetHeight ? k.height / a.offsetHeight : 1;
            const box = { l: k.left + a.clientLeft * sx, t: k.top + a.clientTop * sy, r: k.left + (a.clientLeft + a.clientWidth) * sx, b: k.top + (a.clientTop + a.clientHeight) * sy };
            if (each(a, s, box)) return;
        }
    };
    const scrolls = (s, axis) => /auto|scroll/.test(axis === 'x' ? s.overflowX : s.overflowY);
    const cutTo = (q, s, box, axis) => {
        if (axis === 'x' && s.overflowX !== 'visible') { q.l = Math.max(q.l, box.l); q.r = Math.min(q.r, box.r); }
        if (axis === 'y' && s.overflowY !== 'visible') { q.t = Math.max(q.t, box.t); q.b = Math.min(q.b, box.b); }
    };
    // The pressable area: the control, and what it holds that takes the
    // pointer, as far as it shows. A part spilling past a box that clips it,
    // inside the control or round it, is cut back to that box. Round the
    // control, a box that scrolls cuts only to its scrollport's size.
    const area = (el) => {
        const r = el.getBoundingClientRect();
        const q = { l: r.left, t: r.top, r: r.right, b: r.bottom };
        const grow = (x) => {
            const p = x.getBoundingClientRect();
            const c = { l: p.left, t: p.top, r: p.right, b: p.bottom };
            // Inside the control every clipping box counts; the boxes round it come once, below.
            clippers(x, (a, s, box) => {
                if (a !== el && !el.contains(a)) return true;
                cutTo(c, s, box, 'x'); cutTo(c, s, box, 'y');
                return a === el;
            });
            if (c.r - c.l < 1 || c.b - c.t < 1) return;
            q.l = Math.min(q.l, c.l); q.t = Math.min(q.t, c.t); q.r = Math.max(q.r, c.r); q.b = Math.max(q.b, c.b);
        };
        for (const c of el.querySelectorAll('*')) if (getComputedStyle(c).pointerEvents !== 'none') grow(c);
        if (el.matches('input[type="checkbox"], input[type="radio"]')) for (const label of el.labels || []) grow(label);
        // Round the control, along the axis a box scrolls, the control slides
        // as far as that box can scroll, and what shows is its best overlap
        // with the scrollport once the boxes round the scroller have cut it.
        // Per axis: the part [lo, hi], the shift range [tmin, tmax] and the
        // window [vl, vr] it slides under. The overlap is a trapezoid in the
        // shift, so the best shift is the centred one, clamped to the range.
        const best = (k) => {
            const t = Math.min(k.tmax, Math.max(k.tmin, (k.vl + k.vr) / 2 - (k.lo + k.hi) / 2));
            return [Math.max(k.lo + t, k.vl), Math.min(k.hi + t, k.vr)];
        };
        const ax = {
            x: { lo: q.l, hi: q.r, slides: false, edge: ['l', 'r'], size: 'clientWidth', scroll: 'scrollWidth', at: 'scrollLeft' },
            y: { lo: q.t, hi: q.b, slides: false, edge: ['t', 'b'], size: 'clientHeight', scroll: 'scrollHeight', at: 'scrollTop' },
        };
        clippers(el, (a, s, box) => {
            for (const [name, k] of Object.entries(ax)) {
                const [b0, b1] = [box[k.edge[0]], box[k.edge[1]]];
                if (!scrolls(s, name)) {
                    if ((name === 'x' ? s.overflowX : s.overflowY) === 'visible') continue;
                    if (k.slides) { k.vl = Math.max(k.vl, b0); k.vr = Math.min(k.vr, b1); }
                    else { k.lo = Math.max(k.lo, b0); k.hi = Math.min(k.hi, b1); }
                    continue;
                }
                // A scroller inside a scroller: settle the inner one first.
                if (k.slides) [k.lo, k.hi] = best(k);
                const scale = a[k.size] ? (b1 - b0) / a[k.size] : 1;
                const max = Math.max(0, a[k.scroll] - a[k.size]), now = a[k.at];
                const [s0, s1] = name === 'x' && s.direction === 'rtl' ? [-max, 0] : [0, max];
                Object.assign(k, { slides: true, tmin: (now - s1) * scale, tmax: (now - s0) * scale, vl: b0, vr: b1 });
            }
        });
        for (const k of Object.values(ax)) if (k.slides) [k.lo, k.hi] = best(k);
        return { w: Math.max(0, ax.x.hi - ax.x.lo), h: Math.max(0, ax.y.hi - ax.y.lo) };
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
        if (el.closest('[data-gate-probe]')) { probe[el.dataset.probe] = { small: a.w < minTarget || a.h < minTarget, w: Math.round(a.w), h: Math.round(a.h), minH: px(getComputedStyle(el).minHeight) }; continue; }
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
    // What a field shows (its value, else its placeholder; a select's chosen
    // option) is painted text but no text node, so the walk above never sees
    // it: a 44px field could show its value at 10px.
    for (const el of document.querySelectorAll('input:not([type="hidden"], [type="checkbox"], [type="radio"], [type="range"], [type="color"], [type="file"]), textarea, select')) {
        const value = el.matches('select') ? (el.selectedOptions[0]?.textContent ?? '') : (el.value || el.placeholder || '');
        if (!value.trim() || !shown(el, true)) continue;
        const size = parseFloat(getComputedStyle(el).fontSize);
        if (el.closest('[data-gate-probe]')) { if (el.dataset.probe === 'valueText') probe.valueFont = { small: size < minText }; continue; }
        textRuns++;
        if (size < minText) text.push({ text: 'field: ' + value.trim().slice(0, 33), size: (size / rem).toFixed(3) + 'rem', where: where(el) });
    }
    // In forced colours every control wears a frame (its outline). An
    // ancestor that clips its overflow and does not scroll must leave that
    // frame whole: a title button 4px wider than its truncating heading kept
    // only its right edge, a stray "]" beside the title.
    const cut = [];
    if (matchMedia('(forced-colors: active)').matches) {
        for (const el of document.querySelectorAll(CONTROLS)) {
            // Of the probes only the framed tabs (PROBE says what each is).
            const isProbe = !!el.closest('[data-gate-probe]');
            if (!shown(el) || (isProbe && !['rail', 'hidden', 'outer', 'scaledFrame', 'scaledFrameOver'].includes(el.dataset.probe))) continue;
            if (isProbe) probe[el.dataset.probe + 'Cut'] = '';
            const cs = getComputedStyle(el);
            const w = parseFloat(cs.outlineWidth) || 0;
            if (cs.outlineStyle === 'none' || w === 0) continue;
            const out = w + (parseFloat(cs.outlineOffset) || 0);
            if (out <= 0) continue;
            const r = el.getBoundingClientRect();
            // The frame as far as it can show. A box that scrolls along an
            // axis cuts what is scrolled out of view: not a defect, so along
            // that axis the frame is narrowed to what shows inside it, and the
            // boxes round it are checked against that part. Every other
            // clipping axis (hidden, clip; a scroller's other axis: a tab
            // rail that scrolls sideways) must leave the frame whole.
            // The outline is laid out in the control's own pixels; the rect is drawn.
            const ox = el.offsetWidth ? out * r.width / el.offsetWidth : out, oy = el.offsetHeight ? out * r.height / el.offsetHeight : out;
            const f = { l: r.left - ox, t: r.top - oy, r: r.right + ox, b: r.bottom + oy };
            clippers(el, (a, s, box) => {
                const sides = [];
                const past = (side, px) => { if (px > 0.5) sides.push(side + ' ' + px.toFixed(1) + 'px'); };
                const moving = { x: scrolls(s, 'x') && a.scrollWidth > a.clientWidth + 1, y: scrolls(s, 'y') && a.scrollHeight > a.clientHeight + 1 };
                if (s.overflowX !== 'visible' && !moving.x) { past('left', box.l - f.l); past('right', f.r - box.r); }
                if (s.overflowY !== 'visible' && !moving.y) { past('top', box.t - f.t); past('bottom', f.b - box.b); }
                if (sides.length) {
                    if (isProbe) probe[el.dataset.probe + 'Cut'] = sides.join(', ');
                    else cut.push({ name: name(el), sides: sides.join(', '), where: where(el), by: where(a) });
                    return true;
                }
                if (moving.x) cutTo(f, s, box, 'x');
                if (moving.y) cutTo(f, s, box, 'y');
                return f.r - f.l < 1 || f.b - f.t < 1;   // scrolled out of view
            });
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
    // Contrast of an element's text against what is really painted under it:
    // every background from the root down, alpha composited (a tick's track
    // is a translucent slate over a tinted row over the card).
    const rgba = (c) => { const m = /^rgba?\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)(?:,\\s*([\\d.]+))?\\)$/.exec(c); return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]] : null; };
    const over = (top, under) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3]));
    const lum = (c) => { const v = c.map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
    const contrast = (el) => {
        const chain = [];
        for (let e = el; e; e = e.parentElement) chain.unshift(e);
        let bg = [255, 255, 255];
        for (const e of chain) {
            const c = rgba(getComputedStyle(e).backgroundColor);
            if (!c) return null;
            bg = over(c, bg);
        }
        const fg = rgba(getComputedStyle(el).color);
        if (!fg) return null;
        const [a, b] = [lum(over(fg, bg)), lum(bg)];
        return Math.round((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) * 100) / 100;
    };
    // The phase blocks (dashboard/PhaseProgress.tsx): each topic's block,
    // its width, and the name drawn inside it if any.
    const ticks = [...document.querySelectorAll('[data-tick-bar] > [role="button"]')].filter((t) => !t.closest('[data-gate-probe]') && shown(t)).map((t) => {
        const n = t.querySelector('[data-tick-name]');
        const on = !!n && shown(n, true);
        const r = t.getBoundingClientRect();
        const cs = on ? getComputedStyle(n) : null;
        return {
            w: r.width, h: r.height, label: t.getAttribute('aria-label') || '', title: t.getAttribute('title') || '',
            name: on ? n.textContent : null,
            hidden: on ? !!n.closest('[aria-hidden="true"]') : null,
            // A name longer than its block ends in an ellipsis inside it; it never runs past the block.
            fits: on ? (n.scrollWidth <= n.clientWidth + 0.5 || (cs.textOverflow === 'ellipsis' && cs.overflowX === 'hidden'))
                && n.getBoundingClientRect().right <= r.right + 0.5 && n.getBoundingClientRect().height <= r.height + 0.5 : null,
            ratio: on ? contrast(n) : null,
            // Longer than its block: only the ellipsis keeps it inside.
            cut: on ? n.scrollWidth > n.clientWidth + 0.5 : null,
        };
    });
    // The detail header's one row of controls: title, Study, icon buttons, Close.
    const headerOf = () => {
        const title = [...document.querySelectorAll('button[data-row="title"]')].find((b) => shown(b) && b.parentElement?.classList.contains('flex-wrap'));
        const row = title?.parentElement;
        const close = row && [...row.children].find((c) => c.getAttribute('aria-label') === 'Close detail panel');
        if (!close) return null;
        const kids = [...row.children].filter((c) => shown(c));
        const tops = kids.map((c) => c.getBoundingClientRect().top);
        const gap = parseFloat(getComputedStyle(row).columnGap) || 0;
        const rest = kids.filter((c) => c !== title && c !== close).reduce((s, c) => s + c.getBoundingClientRect().width, 0);
        // The row with Close as the X: title at its least width, the other buttons, the X at the floor.
        const withX = 8 * rem + rest + gap * (kids.length - 1) + Math.max(2.75 * rem, 44);
        return {
            oneLine: Math.max(...tops) - Math.min(...tops) < 4,
            word: close.textContent.trim(), tooltip: close.getAttribute('title') || '',
            close: [close.getBoundingClientRect().width, close.getBoundingClientRect().height].map(Math.round),
            row: Math.round(row.clientWidth), withX: Math.round(withX), xFits: withX <= row.clientWidth + 0.5,
        };
    };
    const header = headerOf();
    // The page between the course tree and the details pane.
    const side = document.querySelector('[data-course-sidebar]');
    const main = side && [...side.parentElement.children].find((c) => c !== side && c.tagName === 'DIV');
    const centre = main ? { w: Math.round(main.getBoundingClientRect().width), row: side.parentElement.clientWidth } : null;
    return { attr: document.documentElement.hasAttribute('data-larger-ui'), rem, targets, text, mins, probe, cut, titles, centre, ticks, header, examined: { controls, text: textRuns } };
})()`;

// Three known controls put on every page, so the counts cannot pass by
// measuring nothing: a 20px button and a label in the smallest size (the
// measurement must see both with the setting off, and the setting must grow
// both), and a button that asks for 64px (the floor must not take it away).
// Off-screen, so no screenshot shows them; removed before the shot anyway.
const PROBE = `(() => {
    const box = document.createElement('div');
    box.setAttribute('data-gate-probe', '');
    box.style.cssText = 'position:fixed;left:-400px;top:0;width:300px;--f:max(2.75rem,44px)';
    box.innerHTML = '<button type="button" data-probe="small" class="w-5 h-5 p-0">x</button>'
        + '<span data-probe="text" class="text-3xs">probe</span>'
        // A full-size field whose value is drawn at 10px (set inline, so the
        // setting does not raise it): only the text count can catch it.
        + '<input data-probe="valueText" value="probe" style="display:block;width:100%;height:max(3rem, 48px);font-size:0.625rem">'
        + '<button type="button" data-probe="tall" class="min-h-16 w-full">tall</button>'
        // A drill's answer: 3rem asked, and never under 44px at 80%.
        + '<button type="button" data-probe="answer" class="min-h-12 w-full border-2">answer</button>'
        // A switch's 24px track whose target spills round it (ui/Switch.tsx),
        // and the same one inside a track that clips it: only what shows counts.
        + '<button type="button" role="switch" data-probe="spill" class="relative block w-11 h-6 my-4 p-0"><span data-switch-spill class="absolute -inset-x-1.5 -inset-y-2.5"></span></button>'
        + '<button type="button" role="switch" data-probe="clipped" class="relative block w-11 h-6 my-4 p-0 overflow-hidden"><span data-switch-spill class="absolute -inset-x-1.5 -inset-y-2.5"></span></button>'
        // The same switch inside a 24px box that hides what spills out of it.
        + '<div style="overflow:hidden;height:1.5rem;margin:1rem 0"><button type="button" role="switch" data-probe="wrapped" class="relative block w-11 h-6 p-0"><span data-switch-spill class="absolute -inset-x-1.5 -inset-y-2.5"></span></button></div>'
        // A tab in a rail that scrolls sideways and is no taller than the tab.
        + '<div style="overflow-x:auto;width:60px;white-space:nowrap"><button type="button" data-probe="rail" class="outline-none" style="width:200px">tab</button></div>'
        // A tab wider than a box that hides its overflow: that cannot scroll.
        + '<div style="overflow:hidden;width:60px;padding:4px 0;white-space:nowrap"><button type="button" data-probe="hidden" class="outline-none" style="width:200px">tab</button></div>'
        // A tab in full view inside its rail, the rail in a box narrower than it.
        + '<div style="overflow:hidden;width:40px"><div style="overflow-x:auto;width:120px;padding:4px;white-space:nowrap"><button type="button" data-probe="outer" class="outline-none" style="width:60px">tab</button><span style="display:inline-block;width:200px"></span></div></div>'
        // Sizes in --f, the floor (44px at 100% text). A button twice the floor
        // in a box that hides overflow, drawn at half size: 1.4 floors wide
        // shows 0.7 of a floor, 2.6 wide shows the whole drawn floor.
        + '<div style="transform:scale(0.5);transform-origin:0 0;overflow:hidden;width:calc(var(--f) * 1.4);height:calc(var(--f) * 2)"><button type="button" data-probe="scaled" class="p-0" style="width:calc(var(--f) * 2);height:calc(var(--f) * 2)">s</button></div>'
        + '<div style="transform:scale(0.5);transform-origin:0 0;overflow:hidden;width:calc(var(--f) * 2.6);height:calc(var(--f) * 2)"><button type="button" data-probe="scaledFits" class="p-0" style="width:calc(var(--f) * 2);height:calc(var(--f) * 2)">s</button></div>'
        // A button 1.4 floors wide in a sideways scroller 0.7 wide shows 0.7
        // of a floor at any scroll position; in one 3 floors wide, all of it.
        + '<div style="overflow-x:auto;width:calc(var(--f) * 0.7)"><button type="button" data-probe="narrowRail" class="p-0" style="width:calc(var(--f) * 1.4);height:calc(var(--f) * 1.1)">n</button></div>'
        + '<div style="overflow-x:auto;width:calc(var(--f) * 3)"><button type="button" data-probe="wideRail" class="p-0" style="width:calc(var(--f) * 1.4);height:calc(var(--f) * 1.1)">w</button></div>'
        // A rail 3 floors wide that scrolls only 0.1 of a floor, holding a
        // button that starts 1.5 floors in, inside a box showing the rail's
        // first 1.2 floors: no scroll position brings the button into view.
        + '<div style="overflow:hidden;width:calc(var(--f) * 1.2)"><div style="overflow-x:auto;width:calc(var(--f) * 3);white-space:nowrap"><span style="display:inline-block;width:calc(var(--f) * 1.5)"></span><button type="button" data-probe="limitedRail" class="p-0" style="width:calc(var(--f) * 1.6);height:calc(var(--f) * 1.1)">l</button></div></div>'
        // A tab's 2px frame, 2px out, in a box drawn at half size that hides
        // overflow: 4px of padding round the tab holds the frame exactly, 2px
        // does not (it shows 1px of the 2 the frame needs).
        // (Set inline: at rest the forced-colours CSS makes an outline-none frame 1px and flush.)
        + '<div style="display:inline-block;transform:scale(0.5);transform-origin:0 0;overflow:hidden;padding:4px"><button type="button" data-probe="scaledFrame" class="p-0 block" style="width:40px;height:20px;outline:2px solid transparent;outline-offset:2px">t</button></div>'
        + '<div style="display:inline-block;transform:scale(0.5);transform-origin:0 0;overflow:hidden;padding:2px"><button type="button" data-probe="scaledFrameOver" class="p-0 block" style="width:40px;height:20px;outline:2px solid transparent;outline-offset:2px">t</button></div>'
        // A 100-topic phase: dashboard/PhaseProgress.tsx's tick bar, its
        // classes copied. Its last topic must be pressable at the floor.
        + '<div data-tick-bar class="flex h-3 w-full overflow-hidden gap-0">'
        + Array.from({ length: 100 }, (_, i) => '<div role="button" tabindex="0" data-probe="' + (i === 99 ? 'lastTick' : 'tick') + '" class="h-full min-w-0 flex-1 rounded-sm"></div>').join('')
        + '</div>';
    document.body.appendChild(box);
})()`;
const UNPROBE = `document.querySelector('[data-gate-probe]')?.remove()`;

// The rows of the course tree and the outline: where each title's first
// letter starts, per depth, and what stands first in the row.
const ROWS = `(() => {
    const firstLetter = (el) => {
        const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (n) => n.textContent.trim() ? 1 : 3 });
        const t = w.nextNode();
        if (!t) return null;
        const i = t.textContent.search(/\\S/);
        const r = document.createRange();
        r.setStart(t, i); r.setEnd(t, i + 1);
        return r.getClientRects()[0]?.left ?? null;
    };
    const rows = [];
    for (const [list, sel] of [['tree', '[data-sidebar-row]'], ['outline', '[data-tree-item-id]']]) {
        for (const row of document.querySelectorAll(sel)) {
            const b = row.getBoundingClientRect();
            const title = row.querySelector('[data-row="title"]');
            if (b.width < 1 || !title || row.dataset.depth == null) continue;
            const first = row.firstElementChild;
            const col = row.querySelector(':scope > [data-row-fold], :scope > [data-fold-spacer]');
            rows.push({ list, depth: +row.dataset.depth, x: Math.round((firstLetter(title) ?? NaN) - b.left),
                col: col ? Math.round(col.getBoundingClientRect().left - b.left) : NaN,
                box: Math.round(title.getBoundingClientRect().left - b.left),
                grip: Math.round(row.querySelector('[data-drag-handle]')?.getBoundingClientRect().width ?? 0),
                // How far the row's content runs past its box, and the room
                // its title keeps: a deep row must not push either out.
                over: Math.round(row.scrollWidth - row.clientWidth),
                titleW: Math.round(title.getBoundingClientRect().width),
                pad: parseFloat(getComputedStyle(row).paddingLeft),
                rowW: Math.round(b.width),
                rem: parseFloat(getComputedStyle(document.documentElement).fontSize),
                text: title.textContent.trim().slice(0, 30),
                first: first?.hasAttribute('data-row-fold') || first?.hasAttribute('data-fold-spacer') ? 'column' : first?.hasAttribute('data-drag-handle') ? 'grip' : (first?.tagName ?? 'none').toLowerCase() });
        }
    }
    return rows;
})()`;

// The grip is the keyboard's way to drag a row: hidden until focused, it must
// then show, after the title (whose start stays put). No pointer ever sees it,
// so the 44px floor (a pointer target's) is not asked of it. `step` 'title'
// focuses the first shown row's title; 'grip' focuses its grip (after a key
// press, so the focus is a keyboard one) and measures. A list out of view (the
// phone's closed tree drawer) is 'none'.
// 'title' focuses the row's title and records where the title starts BEFORE
// any key is pressed; 'where' says where Tab put the focus ('grip', 'row' for
// another control of the row, 'out'); 'grip' measures what Tab reached and
// never moves the focus itself, so a grip Tab cannot reach fails.
const GRIP = (sel, step) => `(() => {
    if (${JSON.stringify(step)} === 'title') {
        const row = [...document.querySelectorAll(${JSON.stringify(sel)})].find((r) => {
            const b = r.getBoundingClientRect();
            return b.width > 1 && b.right > 0 && b.left < innerWidth && !r.closest('[inert], [aria-hidden="true"]') && r.querySelector('[data-drag-handle]');
        });
        if (!row) return 'none';
        const title = row.querySelector('[data-row="title"]');
        title.focus();
        // In the row's own frame: focusing the grip may scroll a narrow board
        // sideways, which moves the whole row, not the title within it.
        window.__grip = { row, title, before: Math.round(title.getBoundingClientRect().left - row.getBoundingClientRect().left) };
        return true;
    }
    const { row, title, before } = window.__grip;
    const at = document.activeElement;
    const grip = at?.matches('[data-drag-handle]') && row.contains(at) ? at : null;
    if (${JSON.stringify(step)} === 'where') return grip ? 'grip' : row.contains(at) ? 'row' : 'out';
    const out = grip
        ? { reached: true, w: Math.round(grip.getBoundingClientRect().width), h: Math.round(grip.getBoundingClientRect().height),
            visible: grip.matches(':focus-visible'), moved: Math.round(title.getBoundingClientRect().left - row.getBoundingClientRect().left) - before }
        : { reached: false, at: at ? (at.getAttribute('aria-label') || at.textContent || at.tagName).trim().slice(0, 40) : 'nothing' };
    at?.blur();
    delete window.__grip;
    return out;
})()`;
// In High Contrast a row's fold chevron takes the text colour, in either app
// theme: dark's own grey (a two-class utility) outweighed a one-attribute rule.
const CHEVRON = `(() => {
    const chev = [...document.querySelectorAll('[data-row-chevron]')].find((c) => c.getBoundingClientRect().width > 1);
    if (!chev) return null;
    const ref = document.createElement('span');
    ref.style.color = 'CanvasText';
    document.body.append(ref);
    const root = document.documentElement, was = root.classList.contains('dark');
    const out = { want: getComputedStyle(ref).color };
    for (const dark of [false, true]) { root.classList.toggle('dark', dark); out[dark ? 'dark' : 'light'] = getComputedStyle(chev).color; }
    root.classList.toggle('dark', was);
    ref.remove();
    return out;
})()`;

const AXE_TARGETS = `(async () => {
    if (!window.axe) { (0, eval)(${JSON.stringify(AXE_SOURCE)}); }
    const r = await window.axe.run(document, { runOnly: { type: 'rule', values: ['target-size'] }, resultTypes: ['violations'] });
    return r.violations.flatMap((v) => v.nodes.map((n) => n.target.join(' ')));
})()`;

const DEEPEST = 9;
const MIN_TITLE = 5;
// ROWS_DUMP=<file>: write every state's measured rows there, for per-depth numbers.
if (process.env.ROWS_DUMP) process.on('exit', () => writeFileSync(process.env.ROWS_DUMP, JSON.stringify(Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, v.rows])))));
const seen = {};
const scratch = mkdtempSync(join(tmpdir(), 'larger-ui-gates-'));
if (shots) mkdirSync(shots, { recursive: true });
const t0 = Date.now();
try {
    const { prepare: course } = await import(pathToFileURL(FIXTURE).href);
    // A topic with a topic under it, beside topics without: a row with a fold
    // chevron and a row with a status mark at one depth, in the tree and in a
    // card. Added at the end of the first chapter: the topics the screens
    // study from stay leaves.
    const prepare = async (ctx) => {
        const ids = await course(ctx);
        const nodes = (await ctx.api.get(`/api/projects/${ids.project}/nodes`)).json ?? [];
        const chapter = nodes.find((n) => n.parent_id == null);
        if (!chapter) throw new Error('larger-ui-gates: the course has no chapter');
        const add = async (parent_id, title) => {
            const r = await ctx.api.post('/api/nodes', { project_id: ids.project, parent_id, title });
            if (r.status >= 300) throw new Error(`larger-ui-gates: add ${title}: ${r.status} ${JSON.stringify(r.json)}`);
            return r.json.id;
        };
        let deep = await add(await add(chapter.id, 'Kinds of telescope mount'), 'Equatorial mounts');
        // A chain down to depth 9, past where the indent would push a row
        // out of a narrow tree.
        for (let depth = 3; depth <= DEEPEST; depth++) deep = await add(deep, `Level ${depth} worked example`);
        return ids;
    };
    await visit('fixture', scratch, [{ states: Object.keys(states) }], SIZES.desktop, browserPath, async (_entry, state, page) => {
        await page.evaluate(PROBE);
        const m = await page.evaluate(MEASURE);
        m.rows = /^(outline|topic) /.test(state) ? await page.evaluate(ROWS) : null;
        m.axe = state.endsWith(' on') ? await page.evaluate(AXE_TARGETS) : [];
        await page.evaluate(UNPROBE);
        if (state.startsWith('topic ')) {
            m.grips = {};
            for (const [list, sel] of [['tree', '[data-sidebar-row]'], ['outline', '[data-tree-item-id]']]) {
                if (await page.evaluate(GRIP(sel, 'title')) === 'none') { m.grips[list] = 'none'; continue; }
                // Tab on from the title, past any other control of the row,
                // until the focus reaches the grip or leaves the row.
                for (let i = 0; i < 6; i++) {
                    for (const type of ['keyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
                    if (await page.evaluate(GRIP(sel, 'where')) !== 'row') break;
                }
                m.grips[list] = await page.evaluate(GRIP(sel, 'grip'));
            }
        }
        if (state.includes(' contrast ')) m.chevron = await page.evaluate(CHEVRON);
        seen[state] = m;
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
    if (m.rows) {
        // A title starts at one x per depth, whatever stands before it (a fold
        // chevron or a status mark): with the switch on, a topic's 20px spacer
        // beside a 44px chevron put two titles of one level 28px apart.
        const lists = [...new Set(m.rows.map((r) => r.list))];
        const spread = [];
        for (const name of lists) for (const depth of new Set(m.rows.filter((r) => r.list === name).map((r) => r.depth))) {
            const at = m.rows.filter((r) => r.list === name && r.depth === depth);
            const xs = at.map((r) => r.x);
            if (Math.max(...xs) - Math.min(...xs) > 1 || xs.some(Number.isNaN)) spread.push(`${name} depth ${depth}: ${at.map((r) => `${r.x}px "${r.text}"`).join(', ')}`);
        }
        const nested = m.rows.filter((r) => r.list === 'outline' && r.depth > 0).length;
        check(`${state}: the outline shows a nested topic and the course tree is measured (${m.rows.length} rows)`,
            nested > 0 && (state.includes(' phone ') || m.rows.some((r) => r.list === 'tree')));
        check(`${state}: titles at one depth start at one x`, spread.length === 0, list(spread, (x) => x));
        // Each level steps in by the column and its gap, so a sub-topic's
        // chevron or mark stands under its parent's title. A chapter's title
        // follows its badge, so the tree starts this at depth 2. With the
        // switch on the step stays the same and the 44px column overhangs it.
        if (!on) {
            const misplaced = [];
            for (const r of m.rows) {
                if (r.depth < (r.list === 'tree' ? 2 : 1)) continue;
                const parent = m.rows.find((p) => p.list === r.list && p.depth === r.depth - 1);
                // Short of the step only at the list's cap column, and only if
                // a row there holds a title within one step of MIN_TITLE: one
                // more step would have squeezed it (the cap below).
                const cap = Math.max(...m.rows.filter((p) => p.list === r.list).map((p) => p.col));
                if (parent && r.col < parent.box - 1 && Math.abs(r.col - cap) <= 1
                    && m.rows.some((p) => p.list === r.list && Math.abs(p.col - cap) <= 1 && p.titleW < MIN_TITLE * p.rem + (parent.box - parent.col) + 1)) continue;
                if (parent &&!(Math.abs(r.col - parent.box) <= 1)) misplaced.push(`${r.list} "${r.text}" column at ${r.col}px, parent's title at ${parent.box}px`);
            }
            check(`${state}: a sub-topic's column stands under its parent's title`, misplaced.length === 0, list(misplaced, (x) => x));
        }
        // The row itself is what a mouse or a finger drags. A grip in every
        // row was a blank slot before the title (touch) or after it (mouse,
        // hidden but still holding 44px with the switch on); it shows only
        // while a keyboard has it.
        // A deep row keeps its title readable inside the row: each level
        // steps in until the title would get narrower than MIN_TITLE, then
        // the indent stops growing. Without the cap a level 8 row ran out of
        // a 280px tree with the switch on.
        const deepest = Math.max(...m.rows.filter((r) => r.list === 'tree').map((r) => r.depth));
        check(`${state}: the tree shows the chain down to depth ${DEEPEST}`, state.includes(' phone ') || deepest === DEEPEST, `deepest ${deepest}`);
        // A title under MIN_TITLE is the indent's fault only where the row is
        // indented: an unindented row in a narrow tree at 160% has no more to
        // give (the tree's width answers for that, and `over` still counts).
        const basePad = Object.fromEntries(['tree', 'outline'].map((l) => [l, Math.min(...m.rows.filter((r) => r.list === l).map((r) => r.pad))]));
        const squeezed = m.rows.filter((r) => r.over > 1 || (r.titleW < MIN_TITLE * r.rem - 1 && r.pad > basePad[r.list] + 1));
        check(`${state}: every title keeps ${MIN_TITLE}rem inside its row, at every depth`, squeezed.length === 0,
            list(squeezed, (r) => `${r.list} depth ${r.depth} "${r.text}": title ${r.titleW}px in a ${r.rowW}px row, ${r.over}px past it`));
        const wrong = m.rows.filter((r) => r.first !== 'column');
        check(`${state}: every row starts with its fold chevron or status mark`, wrong.length === 0,
            list(wrong, (r) => `${r.list} "${r.text}" starts with ${r.first}`));
        const shown = m.rows.filter((r) => r.grip > 1);
        check(`${state}: no row holds room for a grip until it is focused`, shown.length === 0,
            list(shown, (r) => `${r.list} "${r.text}" grip ${r.grip}px wide`));
    }
    if (m.grips) {
        const measured = ['tree', 'outline'].filter((l) => m.grips[l] !== 'none');
        check(`${state}: a grip is measured in a list in view (${measured.join(', ') || 'none'})`, measured.length > 0);
        for (const list of measured) {
            const g = m.grips[list];
            check(`${state}: Tab from a ${list} row's title reaches its grip, which shows, and the title stays put`,
                g.reached && g.visible && g.w > 1 && g.h > 1 && g.moved === 0,
                g.reached ? `${g.w}x${g.h}px, focus-visible ${g.visible}, title moved ${g.moved}px` : `Tab reached "${g.at}", not the grip`);
        }
    }
    if (m.chevron) check(`${state}: a fold chevron takes the text colour in both app themes`,
        m.chevron.light === m.chevron.want && m.chevron.dark === m.chevron.want,
        `light ${m.chevron.light}, dark ${m.chevron.dark}, text ${m.chevron.want}`);
    const p = m.probe;
    check(`${state}: a 20px button and a 10px label are ${on ? 'grown past the floors' : 'seen as too small'}`,
        !!(p.small && p.text) && p.small.small === !on && p.text.small === !on, JSON.stringify(p));
    check(`${state}: a 44px field showing its value at 10px is seen as small text`, p.valueFont?.small === true && p.valueText?.small === false, JSON.stringify([p.valueFont, p.valueText]));
    // Clipping counts: the clipped spill is 24px tall whatever the setting.
    check(`${state}: a switch whose spill is clipped, by itself or by a box round it, is seen as too small`,
        p.clipped?.small === true && p.wrapped?.small === true, JSON.stringify([p.clipped, p.wrapped]));
    check(`${state}: a box drawn at half size cuts at its drawn size`,
        p.scaled?.small === true && p.scaledFits?.small === false, JSON.stringify([p.scaled, p.scaledFits]));
    check(`${state}: a target wider than its scroller counts at the scrollport's width`,
        p.narrowRail?.small === true && p.wideRail?.small === false, JSON.stringify([p.narrowRail, p.wideRail]));
    check(`${state}: a target a rail cannot scroll into the part that shows is seen as too small`,
        p.limitedRail?.small === true, JSON.stringify(p.limitedRail));
    if (state.includes(' contrast ')) {
        check(`${state}: a sideways rail that cuts its tab's top and bottom frame is caught`, /top .*bottom/.test(p.railCut ?? ''), JSON.stringify(p.railCut));
        check(`${state}: a box that hides overflow sideways and cuts a tab's frame is caught`, /right/.test(p.hiddenCut ?? ''), JSON.stringify(p.hiddenCut));
        check(`${state}: a box round a rail that cuts a tab showing in the rail is caught`, /right/.test(p.outerCut ?? ''), JSON.stringify(p.outerCut));
        check(`${state}: a frame drawn at half size is measured at that size: whole when it fits, caught when it spills`,
            p.scaledFrameCut === '' && /left|right|top|bottom/.test(p.scaledFrameOverCut ?? ''), JSON.stringify([p.scaledFrameCut, p.scaledFrameOverCut]));
    }
    const scale = SIZES[state.split(' ')[1]].uiScale ?? 100;
    check(`${state}: the page runs at ${scale}% text`, Math.abs(m.rem - 16 * scale / 100) < 0.1, `${m.rem}px`);
    // The phase blocks carry their topics' names only with the setting on,
    // only in a block at least 6rem wide, and only as a picture of the label.
    if (state.startsWith('course-dashboard ')) {
        const named = m.ticks.filter((x) => x.name !== null);
        const fmt = (x) => `${Math.round(x.w)}px  "${x.title}"  name ${JSON.stringify(x.name)}  ${x.ratio}:1`;
        check(`${state}: the phase bars were measured (${m.ticks.length} topic blocks)`, m.ticks.length >= 8);
        if (!on) {
            check(`${state}: no topic block shows a name, and the bar is the thin one`, named.length === 0 && m.ticks.every((x) => x.h < m.rem), list(named, fmt));
        } else {
            const wide = m.ticks.filter((x) => x.w >= 6 * m.rem + 1), narrow = m.ticks.filter((x) => x.w < 6 * m.rem - 1);
            if (state.includes(' desktop ')) check(`${state}: a 4-topic phase on a desktop has blocks wide enough for a name (${wide.length})`, wide.length >= 4);
            // "Constellations and star maps" is longer than a desktop block, so the ellipsis is really exercised.
            if (state.includes(' desktop ')) check(`${state}: at least one name is longer than its block and is cut (${named.filter((x) => x.cut).length})`, named.some((x) => x.cut));
            check(`${state}: every block at least 6rem wide shows its topic's name (${wide.length})`, wide.every((x) => x.name === x.title && x.title), list(wide.filter((x) => x.name !== x.title || !x.title), fmt));
            check(`${state}: no block under 6rem shows a name (${narrow.length})`, narrow.every((x) => x.name === null), list(narrow.filter((x) => x.name !== null), fmt));
            check(`${state}: each name is cut with an ellipsis inside its block, on one line`, named.every((x) => x.fits), list(named.filter((x) => !x.fits), fmt));
            check(`${state}: each name is hidden from screen readers, the block's label still says the title once`,
                named.every((x) => x.hidden && x.label.startsWith(`${x.title}, `) && x.label.split(x.title).length === 2), list(named.filter((x) => !x.hidden || !x.label.startsWith(`${x.title}, `)), (x) => `${fmt(x)}  label "${x.label}"`));
            check(`${state}: each name reads at 4.5:1 or more on its block`, named.every((x) => x.ratio !== null && x.ratio >= 4.5), list(named.filter((x) => !(x.ratio >= 4.5)), fmt));
        }
    }
    // The phone's detail header: Close is the X exactly when the word does
    // not fit the title's row and the X does.
    if (state.startsWith('topic ') && state.includes(' phone')) {
        const h = m.header;
        check(`${state}: the detail header was measured`, !!h, JSON.stringify(h));
        if (h && !on) check(`${state}: Close keeps its word`, h.word !== '', JSON.stringify(h));
        if (h && on) {
            check(`${state}: ${h.word ? `Close keeps its word only where even the X would not fit one line (${h.withX} of ${h.row}px)` : 'Close as the X fits the header on one line'}`,
                h.word ? h.oneLine || !h.xFits : h.oneLine, JSON.stringify(h));
            if (!h.word) check(`${state}: the X Close is named Close and has its tooltip`, /Close/.test(h.tooltip), JSON.stringify(h));
        }
    }
    if (!on) continue;
    // The tree may grow for its buttons, never at the page's cost: the page
    // keeps what it had with the setting off, or a quarter of the row.
    const offState = seen[state.replace(/ on$/, ' off')];
    // The narrow state exists for this check, so there it must measure.
    if (state.includes(' narrow-160% ')) check(`${state}: the tree and the page beside it were measured, both modes`, !!(m.centre && offState?.centre));
    if (m.centre && offState?.centre) check(`${state}: the page beside the tree keeps its width (${offState.centre.w} -> ${m.centre.w}px of ${m.centre.row})`,
        m.centre.w >= Math.min(offState.centre.w, 0.25 * m.centre.row) - 1);
    check(`${state}: a button that asks for 4rem keeps it`, p.tall?.minH >= 4 * m.rem - 0.5, JSON.stringify(p.tall));
    check(`${state}: a 3rem answer keeps 3rem and the 44px floor`, p.answer && !p.answer.small && p.answer.minH >= 3 * m.rem - 0.5, JSON.stringify(p.answer));
    check(`${state}: a switch's spill reaches the floor`, p.spill?.small === false, JSON.stringify(p.spill));
    check(`${state}: the last topic of a 100-topic phase bar is pressable at the floor`, p.lastTick?.small === false, JSON.stringify(p.lastTick));
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
