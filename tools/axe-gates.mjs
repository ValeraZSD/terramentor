#!/usr/bin/env node
/**
 * Accessibility, measured in a real browser on every screen a learner uses.
 *
 *   node tools/axe-gates.mjs                 check every screen against tools/axe-allowlist.json
 *   node tools/axe-gates.mjs --accept        lower the allowlist to what the screens show now
 *   node tools/axe-gates.mjs --accept --bootstrap   write it even where it rises (a new list; say why)
 *   node tools/axe-gates.mjs --only home     only the screens whose name contains "home"
 *   node tools/axe-gates.mjs --browser <p>   a Chromium-based browser (default: Edge or Chrome)
 *
 * The invented course from tools/docs-fixture.mjs is built in a scratch
 * library and served from `dist/` (rebuilt first when any source is newer).
 * Each screen is opened in a headless browser in light and dark, at desktop
 * and phone width, and axe-core checks it against WCAG 2.2 A and AA plus
 * Deque's best practices. No model and no network: the fixture's lessons and
 * cards are written out, and its topic vectors come from a stub on 127.0.0.1.
 *
 * WHY. Contrast, names that do not match their labels, targets too small to
 * press, controls nested in controls, regions with the same name: none of it
 * shows in a code review, and every one of them came back after being fixed
 * by hand. Several need layout and colour, so the check runs in a browser
 * rather than jsdom.
 *
 * The allowlist only goes down. Each screen and rule may have at most the
 * number of failing elements it lists; one more fails the gate, and so does
 * one fewer, so the number is lowered in the same commit as the fix
 * (`--accept` writes the lower numbers and refuses to raise any, an empty
 * list included; `--bootstrap` alone writes a rise). A new screen starts with
 * none allowed.
 *
 * Before anything is trusted, axe is shown one deliberately broken button and
 * must report it: a scan that silently found nothing (axe not injected, a
 * page that never loaded) would otherwise read as a clean screen. And each
 * screen is scanned only once it shows what it draws when loaded
 * (`READY` in tools/lib/axeScreens.mjs) and no error page: a skeleton or an
 * error boundary has few controls and would pass.
 *
 * axe's "incomplete" results (it could not decide, mostly contrast over an
 * image or a gradient) are counted and printed, not gated.
 *
 * Windows only: a CI runner on another system skips the whole suite (the
 * counts are taken with Windows fonts). On Windows it needs Edge or Chrome:
 * without one it is SKIPPED locally and fails in CI.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWLIST = join(ROOT, 'tools', 'axe-allowlist.json');
const FIXTURE = join(ROOT, 'tools', 'docs-fixture.mjs');
const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa', 'best-practice'];

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const accept = flag('--accept');
const bootstrap = flag('--bootstrap');
const only = value('--only');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? `\n${extra}` : ''}`); }
};

// Edge started from some shells carries a compatibility layer and restarts
// itself without it, leaving the launcher to exit while an orphan runs on.
delete process.env.__COMPAT_LAYER;

// Contrast, target size and overlap depend on how the system font lays out a
// line, and the allowlist is counted on Windows, where the README pictures are
// recorded too (tools/docs-shots.mjs). A CI runner on another system skips.
if (process.env.CI && process.platform !== 'win32') {
    console.log(`SKIPPED: the allowlist is counted on Windows; this CI runner is ${process.platform}`);
    process.exit(0);
}

const { visit, findBrowser, removeScratch, STATES, byText } = await import(pathToFileURL(join(ROOT, 'tools', 'docs-shots.mjs')).href);
const { readyFor, BROKEN, acceptAllowlist } = await import(pathToFileURL(join(ROOT, 'tools', 'lib', 'axeScreens.mjs')).href);

let browserPath;
try {
    browserPath = findBrowser(value('--browser'));
} catch {
    if (process.env.CI) { console.log('  FAIL  no Edge or Chrome to run the screens in'); console.log('0 passed, 1 failed'); process.exit(1); }
    console.log('SKIPPED: no Edge or Chrome found (pass --browser <path>)');
    process.exit(0);
}

// ---------------------------------------------------------------------------
// dist/, built from the sources being checked.
// ---------------------------------------------------------------------------

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
// The screens. Each is reached the way a learner would, from the fixture's ids.
// ---------------------------------------------------------------------------

const VARIANTS = [
    { theme: 'light', viewport: 'desktop' }, { theme: 'dark', viewport: 'desktop' },
    { theme: 'light', viewport: 'phone' }, { theme: 'dark', viewport: 'phone' },
];
const SIZES = { desktop: { width: 1280, height: 800, scale: 1 }, phone: { width: 390, height: 844, scale: 1 } };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const go = (path, needle = null, wait = 1200) => async (page, ctx) => {
    await page.go(typeof path === 'function' ? path(ctx.ids) : path, needle);
    await sleep(wait);
};
const thenPress = (first, expr, what, wait = 1200) => async (page, ctx) => {
    await first(page, ctx);
    await page.waitFor(expr, what);
    await page.press(expr, what);
    await sleep(wait);
};
const topic = go((ids) => `/project/${ids.project}/tree/${ids.study}`, 'Details');
// A phone draws each section as its name over a one-line summary, so the
// button's text only STARTS with the name.
const settings = (section) => thenPress(go('/settings', 'Settings'), byText('button', `/^${section.replace(/[&]/g, '\\&')}/`), section);

const SCREENS = {
    home: go('/'),
    projects: go('/projects', 'New'),
    'new-course': STATES['new-course'],
    'new-course-form': STATES['new-course-form'],
    'course-dashboard': go((ids) => `/project/${ids.project}/dashboard`, 'Dashboard', 1800),
    outline: go((ids) => `/project/${ids.project}/tree`),
    topic,
    'topic-quizzes': thenPress(topic, `document.querySelector('[data-tab="quizzes"]')`, 'the Quizzes tab'),
    'topic-cards': thenPress(topic, `document.querySelector('[data-tab="flashcards"]')`, 'the Flashcards tab'),
    lesson: go((ids) => `/project/${ids.project}/study/${ids.study}`, null, 2500),
    vault: go((ids) => `/project/${ids.project}/vault`),
    atlas: go('/atlas', null, 2500),
    'card-front': async (page, ctx) => {
        const study = byText('button', '/^Study [\\d.,\\s]+ cards?$/');
        await page.go(`/project/${ctx.ids.project}/dashboard`, null);
        await page.waitFor(study, 'the cards owed');
        await page.press(study, 'Study the cards owed');
        await page.waitFor(`document.querySelector('[data-owns-keyboard]')`, 'the review session');
        await sleep(800);
    },
    'card-answer': async (page, ctx) => {
        await SCREENS['card-front'](page, ctx);
        // The plate is the fallback for a session drawn with no Reveal answer
        // button (before it had one), so the gate can measure that version too.
        await page.press(`(${byText('button', '/^Reveal answer/')}) || document.querySelector('[aria-label="Flip flashcard"]')`, 'Reveal answer');
        await sleep(800);
    },
    assistant: STATES['topic-assistant'],
    'settings-general': go('/settings', 'Settings'),
    'settings-accessibility': settings('Accessibility'),
    'settings-learning': settings('Learning'),
    'settings-models': settings('AI & Models'),
    'settings-web': settings('Web & research'),
};

const variantName = (screen, v) => `${screen} ${v.theme}-${v.viewport}`;
const wanted = Object.keys(SCREENS).filter((s) => !only || s.includes(only));
if (!wanted.length) {
    console.log(`  FAIL  --only ${only} names no screen (screens: ${Object.keys(SCREENS).join(', ')})\n0 passed, 1 failed`);
    process.exit(1);
}
const unready = Object.keys(SCREENS).filter((s) => !readyFor(s));
check('every screen names what it draws once loaded (READY)', !unready.length, unready.map((s) => `        ${s}`).join('\n'));
const states = {};
for (const screen of wanted) {
    for (const v of VARIANTS) {
        states[variantName(screen, v)] = async (page, ctx) => {
            const { width, height } = SIZES[v.viewport];
            await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
            await page.send('Emulation.setTouchEmulationEnabled', v.viewport === 'phone' ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
            await page.setting('theme', v.theme);
            await SCREENS[screen](page, ctx);
            // Drawn, not a skeleton: a wait here means the data came late, so
            // the screen gets a moment to settle after it.
            const t = Date.now();
            await page.waitFor(readyFor(screen) ?? 'false', `${screen} drawn (READY)`);
            if (Date.now() - t > 300) await sleep(800);
        };
    }
}

// ---------------------------------------------------------------------------
// The scan.
// ---------------------------------------------------------------------------

const RUN_AXE = `(async () => {
    if (!window.axe) { (0, eval)(${JSON.stringify(AXE_SOURCE)}); }
    const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ${JSON.stringify(TAGS)} }, resultTypes: ['violations', 'incomplete'] });
    return {
        violations: r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map((n) => ({ target: n.target.join(' '), html: n.html.slice(0, 600), why: (n.failureSummary || '').split('\\n').slice(1, 3).join(' ').trim() })) })),
        incomplete: r.incomplete.map((v) => ({ id: v.id, targets: v.nodes.map((n) => n.target.join(' ')) })),
    };
})()`;

/** axe must see a button with no name: proof the scan runs at all. */
const SELF_TEST = `(async () => {
    const b = document.createElement('button');
    b.setAttribute('data-axe-self-test', '');
    document.body.appendChild(b);
    try {
        const r = await window.axe.run(b, { runOnly: { type: 'rule', values: ['button-name'] } });
        return r.violations.length === 1 && r.violations[0].nodes.length === 1;
    } finally { b.remove(); }
})()`;

const seen = {};
const undecided = {};
const broken = [];
let selfTested = false;
const scratch = mkdtempSync(join(tmpdir(), 'axe-gates-'));
const t0 = Date.now();
try {
    const { prepare } = await import(pathToFileURL(FIXTURE).href);
    await visit('fixture', scratch, [{ states: Object.keys(states) }], SIZES.desktop, browserPath, async (_entry, state, page) => {
        const variant = state.split(' ')[1];
        const dark = await page.evaluate(`document.documentElement.classList.contains('dark')`);
        if (dark !== variant.startsWith('dark')) throw new Error(`${state}: the page drew ${dark ? 'dark' : 'light'}`);
        if (await page.evaluate(BROKEN)) broken.push(state);
        const result = await page.evaluate(RUN_AXE);
        seen[state] = result.violations;
        undecided[state] = result.incomplete;
        if (!selfTested) { selfTested = true; check('axe reports a button with no name (the scan really runs)', await page.evaluate(SELF_TEST)); }
    }, prepare, states);
} finally {
    removeScratch(scratch);
}
const seconds = ((Date.now() - t0) / 1000).toFixed(0);

// ---------------------------------------------------------------------------
// Against the allowlist.
// ---------------------------------------------------------------------------

const file = existsSync(ALLOWLIST) ? JSON.parse(readFileSync(ALLOWLIST, 'utf8')) : { allowed: {} };
const allowed = file.allowed ?? {};
const counts = {};
for (const [state, violations] of Object.entries(seen)) {
    counts[state] = {};
    for (const v of violations) counts[state][v.id] = v.nodes.length;
}

const unique = new Set();
const byImpact = {};
for (const violations of Object.values(seen)) for (const v of violations) for (const n of v.nodes) {
    const key = `${v.id} ${n.target}`;
    if (!unique.has(key)) byImpact[v.impact] = (byImpact[v.impact] ?? 0) + 1;
    unique.add(key);
}
const raw = Object.values(seen).flat().reduce((a, v) => a + v.nodes.length, 0);
console.log(`\n${Object.keys(seen).length} scans in ${seconds} s: ${unique.size} unique rule+element failures (${Object.entries(byImpact).map(([k, n]) => `${n} ${k}`).join(', ') || 'none'}), ${raw} in all`);

// What axe could not decide (needs a person): counted, not gated.
const undecidedByRule = {};
for (const results of Object.values(undecided)) for (const r of results) for (const t of r.targets) {
    (undecidedByRule[r.id] ??= new Set()).add(t);
}
const undecidedTotal = Object.values(undecidedByRule).reduce((a, s) => a + s.size, 0);
console.log(`axe could not decide ${undecidedTotal} unique rule+element pair(s)${undecidedTotal ? `: ${Object.entries(undecidedByRule).sort(([, a], [, b]) => b.size - a.size).map(([id, s]) => `${id} ${s.size}`).join(', ')}` : ''}`);

if (accept) {
    if (broken.length) {
        console.log(`\nnot writing the allowlist: ${broken.length} screen(s) drew an error page:\n  ${broken.join('\n  ')}`);
        process.exit(1);
    }
    const result = acceptAllowlist(allowed, counts, { bootstrap });
    if (result.refused) {
        console.log(`\nrefusing to raise the allowlist:\n  ${result.refused.join('\n  ')}\nfix these, or run with --bootstrap and say why in the commit`);
        process.exit(1);
    }
    const sorted = result.allowed;
    writeFileSync(ALLOWLIST, `${JSON.stringify({ about: file.about ?? 'Failing elements allowed per screen and axe rule. Numbers only go down: see tools/axe-gates.mjs.', allowed: sorted }, null, 2)}\n`);
    console.log(`wrote ${Object.values(sorted).reduce((a, r) => a + Object.values(r).reduce((x, y) => x + y, 0), 0)} allowed element(s) on ${Object.keys(sorted).length} screen(s)`);
    process.exit(0);
}

console.log('');
for (const state of Object.keys(seen).sort()) {
    const now = counts[state];
    const limit = allowed[state] ?? {};
    const worse = Object.entries(now).filter(([rule, n]) => n > (limit[rule] ?? 0));
    const better = Object.entries(limit).filter(([rule, n]) => (now[rule] ?? 0) < n);
    const detail = worse.map(([rule]) => {
        const v = seen[state].find((x) => x.id === rule);
        return `        ${rule} (${v.impact}): ${v.nodes.length} > ${limit[rule] ?? 0} allowed\n${v.nodes.slice(0, 4).map((n) => `          ${n.target}\n            ${n.html}${n.why ? `\n            why: ${n.why}` : ''}`).join('\n')}`;
    }).join('\n');
    check(`${state}: no failure beyond the allowlist`, !worse.length, detail);
    check(`${state}: the allowlist is no higher than the screen`, !better.length,
        better.map(([rule, n]) => `        ${rule}: ${now[rule] ?? 0} now, ${n} allowed; lower it (node tools/axe-gates.mjs --accept)`).join('\n'));
}
check('no screen drew an error page in place of itself', !broken.length, broken.map((s) => `        ${s}`).join('\n'));
if (!only) {
    const stale = Object.keys(allowed).filter((s) => !(s in seen));
    check('every allowlisted screen is still scanned', !stale.length, stale.map((s) => `        ${s}`).join('\n'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
