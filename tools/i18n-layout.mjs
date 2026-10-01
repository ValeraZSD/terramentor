#!/usr/bin/env node
/**
 * Look at the interface in a language that is not English, and measure whether
 * it still fits.
 *
 *   node tools/i18n-layout.mjs                       de + ru against localhost:3001
 *   node tools/i18n-layout.mjs --base http://localhost:5194 --locales de,ru,ja
 *
 * From Git Bash, prefix `MSYS_NO_PATHCONV=1` when passing `--routes`: it
 * rewrites a leading-slash argument into a Windows path, so `--routes /settings`
 * arrives as `C:/Program Files/Git/settings` and the run dies on "Cannot
 * navigate to invalid URL" — which reads as a browser fault, not an argument one.
 *
 * Why this exists. Every other i18n check reads the FILE: placeholders, plural
 * forms, coverage, register. None of them can see the one failure a translation
 * actually causes on screen — a label that is 13 characters in English and 33
 * in German, sitting in a control sized for 13. "Mark complete" becomes "Als
 * abgeschlossen markieren"; nothing is missing, nothing is misspelt, and the
 * button is clipped or the row scrolls sideways. That is a layout bug that
 * exists in exactly one language, which is why nobody developing in English
 * ever meets it.
 *
 * It drives the installed Edge over CDP because the in-app browser pane gives a
 * hidden page no layout at all — every clientWidth comes back 0 and every
 * measurement silently reads as "fits". A checker that cannot fail is worse
 * than no checker, so this one refuses to run rather than report against a
 * viewport that does not exist.
 *
 * Reports, never fails: which control clipped, on which route, at which width.
 * Whether 3px of clipping matters is a judgement, and the judgement is the
 * reader's.
 */
import { spawn } from 'node:child_process';
import { rmSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const BASE = arg('base', 'http://localhost:3001').replace(/\/$/, '');
const LOCALES = arg('locales', 'de,ru').split(',').map((s) => s.trim()).filter(Boolean);
const ROUTES = arg('routes', '/,/projects,/calendar,/schedule,/atlas,/settings').split(',');
const WIDTHS = [[1400, 900, 'desktop'], [375, 812, 'phone']];
const CDP_PORT = Number(arg('port', '9333'));

/**
 * Every string this app itself can render in that locale: the translations, and
 * the English keys they fall back to. A word on screen that is not in here came
 * from the learner's library, so its clipping is not a translation fault.
 */
const localesDir = resolve(here, '..', 'src', 'locales');
const enJson = JSON.parse(readFileSync(join(localesDir, 'en.json'), 'utf8'));
function uiStrings(locale) {
    const out = new Set(Object.values(enJson).map((v) => String(v).slice(0, 120)));
    const file = join(localesDir, `${locale}.json`);
    if (existsSync(file)) for (const v of Object.values(JSON.parse(readFileSync(file, 'utf8')))) out.add(String(v).slice(0, 120));
    return [...out];
}

const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
// The throwaway browser profile goes to the OS temp directory, never beside the
// tool: Edge holds the directory open past our kill(), so a profile written into
// the repo survives the run that made it and turns up as untracked noise in the
// next commit.
const profile = join(tmpdir(), `terramentor-i18n-edge-${process.pid}`);
try { rmSync(profile, { recursive: true, force: true }); } catch { /* held by a dead run */ }
const edge = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--mute-audio',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });

async function cdpTarget() {
    for (let i = 0; i < 60; i++) {
        try {
            const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
            const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
            if (page) return page.webSocketDebuggerUrl;
        } catch { /* not up yet */ }
        await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('Edge devtools never came up');
}

const ws = new WebSocket(await cdpTarget());
await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });
let msgId = 0;
const pending = new Map();
ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id === undefined) return;
    const p = pending.get(m.id); pending.delete(m.id);
    if (m.error) p.bad(new Error(m.error.message)); else p.ok(m.result);
};
const send = (method, params = {}) => new Promise((ok, bad) => {
    const id = ++msgId; pending.set(id, { ok, bad });
    ws.send(JSON.stringify({ id, method, params }));
});
await send('Page.enable');
await send('Runtime.enable');

async function evaluate(expression) {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
    return r.result.value;
}

/**
 * Two different faults, and the second one is why this file was edited.
 *
 * A control is CLIPPED when its text is wider than the box drawn for it AND the
 * box hides the overflow. An element that scrolls on purpose (the tab rail) or
 * lets its text spill visibly is not a finding.
 *
 * But a control can also be drawn perfectly and simply not fit where it was
 * put: a segmented control is an `inline-flex` whose own content never
 * overflows it — it just grows, and the PANEL cuts it. Measured on the real
 * app in ru at 390px, the thinking-budget control was 371px wide in a 326px
 * panel with "Тщательно" 41px past the edge, and every scrollWidth on the page
 * read as fitting. So the second pass asks a different question: where is this
 * element's box, against the box of the nearest ancestor that clips? An
 * ancestor that SCROLLS (auto/scroll) is not clipping — what is past its edge
 * is still reachable — so the walk stops there and reports nothing.
 */
const MEASURE = `(() => {
  const sel = 'button, a, label, h1, h2, h3, [role="tab"], option';
  const hits = [];
  const outside = [];
  for (const el of document.querySelectorAll(sel + ', [role="radiogroup"], input, select')) {
    if (!el.offsetParent) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    let p = el.parentElement, box = null, scrolls = false;
    while (p) {
      const ox = getComputedStyle(p).overflowX;
      if (ox === 'auto' || ox === 'scroll') { scrolls = true; break; }
      if (ox === 'hidden' || ox === 'clip') { box = p.getBoundingClientRect(); break; }
      p = p.parentElement;
    }
    if (scrolls) continue;
    if (!box) { const de = document.documentElement; box = { left: 0, right: de.clientWidth }; }
    const past = Math.round(Math.max(r.right - box.right, box.left - r.left));
    if (past <= 1) continue;
    const text = el.textContent.trim();
    if (!window.__i18nStrings || ![...text.split('\\n'), text].some(t => window.__i18nStrings.has(t.trim().slice(0, 120)))) continue;
    outside.push({ text: text.replace(/\\s+/g, ' ').slice(0, 44), past, w: Math.round(r.width) });
  }
  for (const el of document.querySelectorAll(sel)) {
    if (!el.offsetParent && el.tagName !== 'OPTION') continue;
    const cs = getComputedStyle(el);
    if (cs.overflowX === 'visible' || cs.overflowX === 'auto' || cs.overflowX === 'scroll') continue;
    if (el.clientWidth < 8) continue;
    const over = el.scrollWidth - el.clientWidth;
    if (over <= 1) continue;
    const text = el.textContent.trim();
    // Only text this app WROTE can be a translation fault. A clipped project
    // title is the learner's own words in a header that truncates on purpose,
    // and reporting it buries the findings that are actually ours.
    if (!window.__i18nStrings || !window.__i18nStrings.has(text.slice(0, 120))) continue;
    hits.push({ text: text.slice(0, 44), w: el.clientWidth, need: el.scrollWidth });
  }
  const de = document.documentElement;
  return JSON.stringify({ pageScrollX: de.scrollWidth - de.clientWidth, w: de.clientWidth, hits: hits.slice(0, 8), outside: outside.slice(0, 8) });
})()`;

const findings = [];
for (const locale of LOCALES) {
    // The stored setting wins over the browser's language, so it is what the
    // run has to change; anything else measures whatever the library was left on.
    const put = await fetch(`${BASE}/api/settings/ui_language`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: locale }),
    }).catch((e) => ({ ok: false, status: e.message }));
    if (!put.ok) { console.log(`! ${locale}: could not set ui_language (${put.status}) — is ${BASE} serving?`); continue; }

    for (const [width, height, label] of WIDTHS) {
        await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 768 });
        for (const route of ROUTES) {
            await send('Page.navigate', { url: BASE + route });
            let ready = false;
            for (let i = 0; i < 80 && !ready; i++) {
                await new Promise((r) => setTimeout(r, 250));
                try { ready = await evaluate('document.readyState === "complete" && !!document.querySelector("header, main")'); } catch { /* navigating */ }
            }
            await new Promise((r) => setTimeout(r, 900));   // the app fetches after mount
            await evaluate(`window.__i18nStrings = new Set(${JSON.stringify(uiStrings(locale))}); 1`);
            let res;
            try { res = JSON.parse(await evaluate(MEASURE)); } catch (e) { console.log(`  ${locale} ${label} ${route}: ${e.message}`); continue; }
            if (res.w === 0) throw new Error('viewport measured 0 wide — the page never laid out, so nothing here is real');
            if (res.pageScrollX > 1 || res.hits.length || res.outside.length) findings.push({ locale, label, route, ...res });
        }
    }
    console.log(`${locale}: measured ${ROUTES.length * WIDTHS.length} screens`);
}

console.log('');
if (!findings.length) console.log('No clipped control, nothing drawn past its panel, and no sideways page scroll on any screen measured.');
for (const f of findings) {
    console.log(`${f.locale} · ${f.label} · ${f.route}${f.pageScrollX > 1 ? `  PAGE SCROLLS X by ${f.pageScrollX}px` : ''}`);
    for (const h of f.hits) console.log(`    ${JSON.stringify(h.text)}  ${h.w}px box, needs ${h.need}px`);
    for (const o of f.outside) console.log(`    ${JSON.stringify(o.text)}  ${o.w}px wide, ${o.past}px past the edge of what clips it`);
}

ws.close();
edge.kill();
try { rmSync(profile, { recursive: true, force: true }); } catch { /* the process is still letting go */ }
process.exit(0);
