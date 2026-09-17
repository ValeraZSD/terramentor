#!/usr/bin/env node
// a11y-lint.mjs — local-only keyboard / screen-reader accessibility linter (zero-dep).
//
// Third companion to contrast-audit.mjs (contrast) and style-lint.mjs (consistency).
// This one asks: *can you use the app with only a keyboard + a screen reader?* It
// statically parses JSX opening tags and flags the classic traps:
//
//   1. CLICK-NO-KEY    onClick on a non-interactive tag (div/span/li/…) with no
//                      keyboard handler (onKeyDown/Up/Press) → Enter/Space do
//                      nothing; keyboard users can't trigger it.
//   2. NO-LABEL        an icon-only <button> (no text child) with no aria-label /
//                      aria-labelledby / title → a screen reader announces nothing.
//   3. TABINDEX>0      tabIndex={2}+ → hijacks the natural focus order (anti-pattern).
//   4. IMG-NO-ALT      <img> without an alt attribute.
//   5. A-NO-HREF       <a> with onClick but no href → not focusable/activatable;
//                      should be a <button>.
//   6. TOUCH-TARGET    a button/link/role=button whose estimated tap box is below
//                      the WCAG 2.5.5 min (default 44px, --min N) in BOTH dims.
//
//     node tools/a11y-lint.mjs                 # human report
//     node tools/a11y-lint.mjs --json          # machine-readable
//     node tools/a11y-lint.mjs --only no-label # one check (click-no-key|no-label|tabindex|img-no-alt|a-no-href)
//     node tools/a11y-lint.mjs --fail-on warn  # exit 1 if any finding
//
// Not committed (see .gitignore `tools/`). Heuristic & conservative (opening-tag
// analysis; dynamic `{children}` buttons are assumed labelled to avoid noise), so
// a clean run means "no obvious keyboard traps", not a full audit.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SRC = join(ROOT, 'src');

// Natively focusable / keyboard-activatable elements — onClick on these is fine.
const INTERACTIVE = new Set(['button', 'a', 'input', 'select', 'textarea', 'option', 'summary', 'details', 'label']);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) { if (name !== 'node_modules' && name !== 'dist') walk(p, out); }
    else if (/\.(tsx|jsx)$/.test(name)) out.push(p);
  }
  return out;
}
const lineAt = (text, idx) => text.slice(0, idx).split('\n').length;

// Iterate JSX elements, yielding { tag, attrs, line, contentStart, selfClose }.
// Scans from after the tag name to the tag-closing `>` at brace-depth 0 (strings
// and `${…}`/`{…}` expressions skipped) so `>` inside className={`a>b`} is ignored.
function* jsxTags(text) {
  const re = /<([A-Za-z][A-Za-z0-9]*)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    let i = re.lastIndex, depth = 0, q = null, selfClose = false;
    for (; i < text.length; i++) {
      const ch = text[i];
      if (q) { if (ch === q) q = null; continue; }
      if (ch === '"' || ch === "'" || ch === '`') { q = ch; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      else if (ch === '>' && depth === 0) { selfClose = text[i - 1] === '/'; break; }
    }
    yield { tag: m[1], attrs: text.slice(re.lastIndex, i), line: lineAt(text, m.index), contentStart: i + 1, selfClose };
    re.lastIndex = i;
  }
}

const has = (attrs, re) => re.test(attrs);
const HAS_ONCLICK = /\bonClick\s*=/;
const HAS_ONKEY = /\bonKey(Down|Up|Press)\s*=/;
const HAS_LABEL = /\b(aria-label|aria-labelledby|title)\s*=/;
const HAS_HREF = /\bhref\s*=/;
const HAS_ALT = /\balt\s*=/;
const HAS_ARIA_HIDDEN = /\baria-hidden\s*=\s*\{?\s*(true|["']true)/;
const IS_OVERLAY = /className\s*=\s*\{?\s*["'`][^"'`]*\binset-0\b/;              // full-cover backdrop (string or {`…`})
const IS_PRESENTATION = /\brole\s*=\s*["'](presentation|none)["']/;             // explicit passthrough
const TABINDEX = /\btabIndex\s*=\s*\{?\s*(-?\d+)/;

const args = process.argv.slice(2);
const opt = {
  json: args.includes('--json'),
  only: (() => { const i = args.indexOf('--only'); return i !== -1 ? args[i + 1] : null; })(),
  failOn: (() => { const i = args.indexOf('--fail-on'); return i !== -1 ? args[i + 1] : null; })(),
  min: (() => { const i = args.indexOf('--min'); return i !== -1 ? parseInt(args[i + 1], 10) : 44; })(), // WCAG 2.5.5 target px
};

// Tailwind spacing token → px (n × 4px; `px` = 1px). Null if not a number.
const SP = (v) => (v === 'px' ? 1 : (Number.isNaN(parseFloat(v)) ? null : parseFloat(v) * 4));
// Estimate an interactive element's tap box from its own w/h/size/padding classes.
// Content size is unknown, so a nominal 20px (icon/line) is added to padding.
function touchDims(attrs) {
  const cm = attrs.match(/className\s*=\s*\{?\s*["'`]([^"'`]*)/);
  if (!cm) return { W: null, H: null };
  let w = null, h = null, pt = null, pb = null, pl = null, pr = null;
  for (const raw of cm[1].split(/\s+/)) {
    const t = raw.split(':').pop();
    let m;
    if ((m = t.match(/^size-(\S+)$/))) { const v = SP(m[1]); if (v != null) { w = v; h = v; } }
    else if ((m = t.match(/^w-(\S+)$/))) { const v = SP(m[1]); if (v != null) w = v; }
    else if ((m = t.match(/^h-(\S+)$/))) { const v = SP(m[1]); if (v != null) h = v; }
    else if ((m = t.match(/^p-(\S+)$/))) { const v = SP(m[1]); if (v != null) pt = pb = pl = pr = v; }
    else if ((m = t.match(/^px-(\S+)$/))) { const v = SP(m[1]); if (v != null) pl = pr = v; }
    else if ((m = t.match(/^py-(\S+)$/))) { const v = SP(m[1]); if (v != null) pt = pb = v; }
    else if ((m = t.match(/^pt-(\S+)$/))) { const v = SP(m[1]); if (v != null) pt = v; }
    else if ((m = t.match(/^pb-(\S+)$/))) { const v = SP(m[1]); if (v != null) pb = v; }
    else if ((m = t.match(/^pl-(\S+)$/))) { const v = SP(m[1]); if (v != null) pl = v; }
    else if ((m = t.match(/^pr-(\S+)$/))) { const v = SP(m[1]); if (v != null) pr = v; }
  }
  const NOMINAL = 20;
  let W = w, H = h;
  if (W == null && (pl != null || pr != null)) W = (pl || 0) + (pr || 0) + NOMINAL;
  if (H == null && (pt != null || pb != null)) H = (pt || 0) + (pb || 0) + NOMINAL;
  return { W, H };
}

const findings = [];
const push = (f) => { if (!opt.only || opt.only === f.check) findings.push(f); };
const files = walk(SRC);

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const rel = relative(ROOT, file).split(sep).join('/');

  for (const el of jsxTags(text)) {
    const { tag, attrs, line, contentStart, selfClose } = el;

    // 1. onClick on a non-interactive DOM element with no keyboard handler.
    // Only lowercase = real DOM tags; a custom <Component onClick> forwards the
    // prop and may render its own <button>, so we can't judge it here.
    // `aria-hidden` overlays (modal backdrops) are exempt — they're not exposed to
    // AT and the keyboard path is Escape/close-button on the dialog, not the div.
    const isDomTag = tag[0] === tag[0].toLowerCase();
    const isOverlay = has(attrs, HAS_ARIA_HIDDEN) || has(attrs, IS_OVERLAY) || has(attrs, IS_PRESENTATION);
    // onClick that only stops propagation / prevents default is defensive, not an
    // interactive action → not a keyboard concern.
    const clickBody = (attrs.match(/onClick\s*=\s*\{([\s\S]*?)\}\s*(?=\w+\s*=|\/?>|$)/) || [])[1] || '';
    const defensiveOnly = /stopPropagation|preventDefault/.test(clickBody) && !/\w\s*\(/.test(clickBody.replace(/\.\s*(stopPropagation|preventDefault)\s*\(\s*\)/g, ''));
    // A role whose keyboard is owned by its CONTAINER, not by the element: an
    // ARIA listbox/menu/tablist moves an "active descendant" with the arrow keys
    // while focus stays on the input, so the option itself is never focusable
    // and a key handler on it would be dead code. The container is what must
    // carry the handler, and it is checked on its own line.
    const OWNED_ROLE = /\brole\s*=\s*["'{]?\s*(option|menuitem|menuitemradio|menuitemcheckbox|treeitem)\b/;
    if (isDomTag && !INTERACTIVE.has(tag) && has(attrs, HAS_ONCLICK) && !has(attrs, HAS_ONKEY) && !isOverlay && !defensiveOnly && !OWNED_ROLE.test(attrs)) {
      push({ check: 'click-no-key', level: 'warn', file: rel, line, token: `<${tag} onClick>`, msg: `onClick on <${tag}> with no onKeyDown/Up/Press — not keyboard-operable (use a <button>, or add role+tabIndex+key handler)` });
    }

    // 3. positive tabIndex hijacks focus order.
    const ti = attrs.match(TABINDEX);
    if (ti && parseInt(ti[1], 10) > 0) {
      push({ check: 'tabindex', level: 'warn', file: rel, line, token: `tabIndex={${ti[1]}}`, msg: `positive tabIndex disrupts the natural focus order — prefer 0 or -1` });
    }

    // 4. <img> without alt (decorative imgs should use alt="" explicitly).
    if (tag === 'img' && !has(attrs, HAS_ALT)) {
      push({ check: 'img-no-alt', level: 'warn', file: rel, line, token: '<img>', msg: `<img> has no alt attribute (use alt="" if purely decorative)` });
    }

    // 5. <a onClick> with no href — not focusable/activatable; should be a button.
    if (tag === 'a' && has(attrs, HAS_ONCLICK) && !has(attrs, HAS_HREF)) {
      push({ check: 'a-no-href', level: 'warn', file: rel, line, token: '<a onClick> (no href)', msg: `<a> with onClick but no href isn't keyboard-focusable — use a <button>` });
    }

    // 6. touch-target smaller than the WCAG 2.5.5 minimum (both dims < min).
    // Only compact/icon-ish targets (both dimensions small); wide text buttons —
    // fine to tap — aren't flagged. Skips full-width/auto elements (dims unknown).
    // AAA-level (2.5.5) advisory — opt in via --min or --only touch-target so it
    // doesn't drown the AA-critical checks (the app already clears the 24px AA min).
    const touchOptIn = args.includes('--min') || opt.only === 'touch-target';
    const isBtnLike = tag === 'button' || (tag === 'a' && has(attrs, HAS_HREF)) || /\brole\s*=\s*["']button["']/.test(attrs);
    if (touchOptIn && isBtnLike) {
      const { W, H } = touchDims(attrs);
      if (W != null && H != null && W < opt.min && H < opt.min) {
        push({ check: 'touch-target', level: 'warn', file: rel, line, token: `~${Math.round(W)}×${Math.round(H)}px`, msg: `tap target ~${Math.round(W)}×${Math.round(H)}px is below the ${opt.min}px WCAG 2.5.5 target — add padding or min-w/min-h` });
      }
    }

    // 2. icon-only <button> with no accessible name.
    if (tag === 'button' && !selfClose && !has(attrs, HAS_LABEL)) {
      const close = text.indexOf('</button', contentStart);
      const content = close > -1 ? text.slice(contentStart, close) : '';
      // Dynamic children ({label}) are assumed to carry text → skip to avoid noise.
      // Flag only static content with no words and no un-hidden textual node.
      const hasDynamic = content.includes('{');
      const words = content.replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;/g, ' ').match(/[A-Za-z]{2,}/);
      if (!hasDynamic && !words) {
        push({ check: 'no-label', level: 'warn', file: rel, line, token: '<button> (icon only)', msg: `icon-only <button> with no aria-label/title — screen readers announce nothing` });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------
const CHECK_LABEL = { 'click-no-key': 'CLICK-NO-KEY', 'no-label': 'NO-LABEL', tabindex: 'TABINDEX>0', 'img-no-alt': 'IMG-NO-ALT', 'a-no-href': 'A-NO-HREF', 'touch-target': 'TOUCH-TARGET' };
const byCheck = (c) => findings.filter((f) => f.check === c).length;
const summary = {
  files: files.length, total: findings.length,
  clickNoKey: byCheck('click-no-key'), noLabel: byCheck('no-label'), tabindex: byCheck('tabindex'), imgNoAlt: byCheck('img-no-alt'), aNoHref: byCheck('a-no-href'), touchTarget: byCheck('touch-target'),
};

if (opt.json) {
  console.log(JSON.stringify({ summary, findings }, null, 2));
} else {
  const C = { r: '\x1b[31m', y: '\x1b[33m', g: '\x1b[32m', c: '\x1b[36m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };
  console.log(`\n${C.b}Keyboard / a11y lint${C.x} ${C.d}(${summary.files} JSX files scanned)${C.x}\n`);
  console.log(`${C.b}Summary${C.x}`);
  console.log(`  ${summary.total ? C.y : C.g}${summary.total} finding${summary.total === 1 ? '' : 's'}${C.x}   ${C.d}·${C.x}   click-no-key ${summary.clickNoKey}  no-label ${summary.noLabel}  tabIndex>0 ${summary.tabindex}  img-no-alt ${summary.imgNoAlt}  a-no-href ${summary.aNoHref}  touch-target ${summary.touchTarget}\n`);
  if (!findings.length) {
    console.log(`${C.g}✓ No obvious keyboard/a11y traps found.${C.x}\n`);
  } else {
    findings.sort((a, b) => a.check.localeCompare(b.check) || a.file.localeCompare(b.file) || a.line - b.line);
    for (const f of findings) {
      console.log(`  ${C.y}warn${C.x} ${C.c}${(CHECK_LABEL[f.check] || f.check).padEnd(12)}${C.x} ${f.msg}`);
      console.log(`        ${C.d}${f.file}:${f.line}${C.x}  ${C.d}${f.token}${C.x}`);
    }
    console.log('');
  }
}

if (opt.failOn && (opt.failOn === 'warn' || opt.failOn === 'error') && summary.total) process.exit(1);
