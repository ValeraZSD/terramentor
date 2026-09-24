#!/usr/bin/env node
// style-lint.mjs — local-only Tailwind/style consistency linter (zero deps).
//
// Companion to contrast-audit.mjs. Where that tool checks *contrast*, this one
// checks *consistency* — the class-level mistakes that make a UI feel patchy:
//
//   1. HARDCODED COLOUR   literal #hex / rgb() / arbitrary `text-[#…]` utilities
//                         instead of Tailwind tokens or the `accent` variable.
//   2. ACCENT MISUSE      violet/purple families used as an accent; the accent
//                         colour comes from the `accent` theme token.
//   3. DARK-MODE GAP      a light resting background (bg-white / bg-slate-50…200)
//                         with no dark: counterpart → unreadable in dark mode.
//   4. CLASS CONFLICT     two competing colours for the same property/variant on
//                         one element, or a duplicated class token (copy-paste).
//   5. CONVENTION         near-black text on a saturated fill (green/blue/red/…) —
//                         passes contrast but reads wrong; those hues want white
//                         labels. Luminous hues (amber/yellow/lime) are exempt —
//                         dark text IS the convention there.
//   6. SCALE-DRIFT        arbitrary spacing/radius values (p-[7px], rounded-[5px])
//                         that sidestep the 4px scale. Font sizes and min-/max-/
//                         w-/h- layout constraints are excluded (usually intentional).
//
//     node tools/style-lint.mjs                 # human report
//     node tools/style-lint.mjs --json          # machine-readable
//     node tools/style-lint.mjs --only conflict # one check (hardcoded|accent|dark|conflict|convention)
//     node tools/style-lint.mjs --fail-on error # exit 1 if any error-level finding
//
// Static & heuristic: it reads resting classes only, and the documented rainbow
// palettes are allow-listed, so a clean run means "no new inconsistencies", not
// "provably perfect".

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blankComments } from './lib/blankComments.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SRC = join(ROOT, 'src');

// Files whose literal colours / non-accent families are intentional (ARCHITECTURE:
// the only sanctioned non-accent palettes). Matched as path suffixes.
const ALLOW = [
  'src/components/ui/ColorField.tsx', // the project + accent swatch palettes
  'src/utils/color.ts',               // hex→triplet helpers
  'src/components/ResourceList.tsx',  // TYPE_CONFIG per-resource-type colours (documented)
];
const isAllowed = (rel) => ALLOW.some((a) => rel === a);

const COLOR_FAMILIES = ['slate', 'gray', 'zinc', 'neutral', 'stone', 'red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal', 'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose'];
const FAM_RE = new RegExp(`^(${COLOR_FAMILIES.join('|')})-(50|100|200|300|400|500|600|700|800|900|950)$`);
// Utility prefixes that carry a colour (for arbitrary-value / conflict checks).
const COLOR_PREFIXES = ['bg', 'text', 'border', 'ring', 'fill', 'stroke', 'from', 'via', 'to', 'divide', 'outline', 'decoration', 'shadow', 'accent', 'caret', 'ring-offset'];

// Scale-drift check: arbitrary length values on spacing/radius utilities that
// sidestep the 4px design scale. Layout constraints (min-/max-/w-/h-) and font
// sizes are excluded — those arbitrary values are usually intentional.
// Internal spacing + radius only. Margins / inset / top-left positioning are
// excluded — those arbitrary values are often justified pixel-alignment (e.g.
// ml-[52px] to clear a 40px icon + 12px gap) with no scale token to snap to.
const SCALE_PROPS = '(?:p|px|py|pt|pb|pl|pr|gap|gap-x|gap-y|space-x|space-y|rounded|rounded-t|rounded-b|rounded-l|rounded-r|rounded-tl|rounded-tr|rounded-bl|rounded-br|rounded-s|rounded-e)';
const SCALE_RE = new RegExp(`^${SCALE_PROPS}-\\[(-?[0-9.]+)(px|rem)\\]$`);
const ROUND_TOKEN = { 2: 'rounded-sm', 4: 'rounded', 6: 'rounded-md', 8: 'rounded-lg', 12: 'rounded-xl', 16: 'rounded-2xl', 24: 'rounded-3xl', 9999: 'rounded-full' };
// Tailwind's default numeric spacing keys (× 4px). Note the gaps: no 13, no 15…
const SPACING_KEYS = new Set([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60, 64, 72, 80, 96]);
function scaleSuggest(prop, px) {
    if (prop.startsWith('rounded')) return ROUND_TOKEN[px] ? `use \`${ROUND_TOKEN[px]}\`` : 'off the radius scale';
    const key = px / 4;
    if (SPACING_KEYS.has(key)) return `use \`${prop}-${key}\``;
    return px % 4 === 0 ? 'divisible by 4 but no scale token — snap to a nearby step' : 'off the 4px spacing grid';
}

// Convention check: near-black text tokens that look wrong on a saturated fill.
const DARK_TEXT = new Set(['text-black', 'text-slate-800', 'text-slate-900', 'text-gray-800', 'text-gray-900', 'text-zinc-800', 'text-zinc-900', 'text-neutral-800', 'text-neutral-900', 'text-stone-800', 'text-stone-900']);
const NEUTRAL_FAM = new Set(['slate', 'gray', 'zinc', 'neutral', 'stone']);        // dark text on grey is fine
const LUMINOUS_FAM = new Set(['yellow', 'amber', 'lime']);                          // bright hues — dark text IS the convention

// A token value that names a colour (not a size/layout keyword).
function isColorValue(v) {
  if (['white', 'black', 'transparent', 'current', 'inherit', 'accent', 'accent-fg'].includes(v)) return true;
  const base = v.split('/')[0];
  return FAM_RE.test(base) || ['accent', 'accent-fg'].includes(base);
}
// text- utilities that are NOT colours (sizes, alignment, wrapping, transforms).
const TEXT_NONCOLOR = /^(xs|sm|base|lg|xl|\d?xl|left|right|center|justify|start|end|ellipsis|clip|wrap|nowrap|balance|pretty|opacity-|\[)/;

// ---------------------------------------------------------------------------
// Walk + className-scope extraction (resting classes only; ${…} noise dropped).
// ---------------------------------------------------------------------------
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) { if (name !== 'node_modules' && name !== 'dist') walk(p, out); }
    else if (/\.(tsx|jsx|ts|css)$/.test(name)) out.push(p);
  }
  return out;
}
function lineAt(text, idx) { return text.slice(0, idx).split('\n').length; }

function extractScopes(text) {
  const scopes = [];
  const re = /className\s*=\s*(\{|")/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const start = m.index + m[0].length;
    let end;
    if (m[1] === '"') { end = text.indexOf('"', start); if (end === -1) continue; }
    else {
      let depth = 1, i = start;
      for (; i < text.length && depth > 0; i++) { if (text[i] === '{') depth++; else if (text[i] === '}') depth--; }
      end = i - 1;
    }
    const blob = text.slice(start, end);
    const tokens = blob.replace(/\$\{[^}]*\}/g, ' ').match(/[a-zA-Z][\w:/.\-\[\]#]*/g) || [];
    scopes.push({ line: lineAt(text, m.index), tokens, raw: blob, brace: m[1] === '{' });
    re.lastIndex = end;
  }
  return scopes;
}

// A scope may hold several mutually-exclusive class strings (ternary branches).
// Conflict/dup checks must run *per string literal*, else `a ? 'text-x' : 'text-y'`
// looks like two competing colours when only one ever applies.
function literalSegments(scope) {
  if (!scope.brace) return [scope.raw.replace(/\$\{[^}]*\}/g, ' ')];
  const segs = [];
  const q = /'([^']*)'|"([^"]*)"|`([^`]*)`/g;
  let m;
  while ((m = q.exec(scope.raw)) !== null) segs.push((m[1] ?? m[2] ?? m[3]).replace(/\$\{[^}]*\}/g, ' '));
  return segs.length ? segs : [scope.raw.replace(/\$\{[^}]*\}/g, ' ')];
}
const tokenize = (s) => s.match(/[a-zA-Z][\w:/.\-\[\]#]*/g) || [];

// Split a class token into { variantKey, base } — variantKey groups responsive/
// state/dark prefixes so `bg-white` and `dark:bg-slate-900` are distinct scopes.
function splitVariants(token) {
  const parts = token.split(':');
  const base = parts.pop();
  return { variantKey: parts.slice().sort().join(':'), prefixes: parts, base };
}

// ---------------------------------------------------------------------------
// Analyse.
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const opt = {
  json: args.includes('--json'),
  only: (() => { const i = args.indexOf('--only'); return i !== -1 ? args[i + 1] : null; })(),
  failOn: (() => { const i = args.indexOf('--fail-on'); return i !== -1 ? args[i + 1] : null; })(),
};

const findings = [];
const push = (f) => { if (!opt.only || opt.only === f.check) findings.push(f); };

const HEX_RE = /#[0-9a-fA-F]{3,8}\b/;
const files = walk(SRC);

for (const file of files) {
  // Comments are blanked first, not removed, so every index still lines up.
  // Without it an apostrophe in a `//` comment inside a className made the
  // prose between two apostrophes read as a class string, and an ordinary
  // English "a" was reported as a duplicate class.
  const text = blankComments(readFileSync(file, 'utf8'));
  const rel = relative(ROOT, file).split(sep).join('/');
  const allowed = isAllowed(rel);

  for (const scope of extractScopes(text)) {
    const { line, tokens, raw } = scope;

    // --- 1 & 2: hardcoded colour + accent misuse (per token) ---
    if (!allowed) {
      // arbitrary colour utility e.g. bg-[#1e293b], text-[#fff]
      for (const t of tokens) {
        const arb = t.match(/^(?:[a-z-]+:)*([a-z-]+)-\[#([0-9a-fA-F]{3,8})\]$/);
        if (arb && COLOR_PREFIXES.includes(arb[1].split(':').pop())) {
          push({ check: 'hardcoded', level: 'error', file: rel, line, token: t, msg: `arbitrary hex "${t}" — use a Tailwind token or the accent variable` });
        }
      }
      // literal hex sitting in the className string (rare, but a smell)
      const hex = raw.replace(/\$\{[^}]*\}/g, ' ').match(HEX_RE);
      if (hex) push({ check: 'hardcoded', level: 'warn', file: rel, line, token: hex[0], msg: `literal ${hex[0]} inside className` });
      // violet / purple used as an accent
      for (const t of tokens) {
        const { base } = splitVariants(t);
        // family can follow a utility prefix: text-violet-600, dark:bg-purple-500…
        const fam = base.match(/(?:^|-)(violet|purple)-\d/);
        if (fam) {
          push({ check: 'accent', level: 'warn', file: rel, line, token: t, msg: `${fam[1]}-* looks like a hardcoded accent — use \`accent\`/\`accent-fg\`` });
        }
      }
    }

    // --- 3: dark-mode gap — light resting bg on a real surface with no dark: bg ---
    // Only flag actual surfaces (padding / resting text colour / border) — bare
    // white indicator dots & toggle knobs legitimately stay white in both modes.
    const LIGHT_BG = new Set(['bg-white', 'bg-slate-50', 'bg-slate-100', 'bg-slate-200', 'bg-gray-50', 'bg-gray-100', 'bg-gray-200']);
    const restingLightBg = tokens.find((t) => LIGHT_BG.has(t)); // resting = no prefix
    const hasDarkBg = tokens.some((t) => t.startsWith('dark:bg-'));
    const isSurface = tokens.some((t) => /^(p[xytblr]?-|border(-|$)|text-(slate|gray|zinc|red|amber|green|blue|accent))/.test(t));
    if (restingLightBg && !hasDarkBg && isSurface) {
      push({ check: 'dark', level: 'warn', file: rel, line, token: restingLightBg, msg: `${restingLightBg} surface has no dark: background — check dark mode` });
    }

    // --- scale drift: arbitrary spacing/radius values off the design scale ---
    for (const t of tokens) {
      const { base } = splitVariants(t);
      const m = base.match(SCALE_RE);
      if (!m) continue;
      const px = m[2] === 'rem' ? parseFloat(m[1]) * 16 : parseFloat(m[1]);
      const prop = base.slice(0, base.indexOf('-['));
      push({ check: 'scale', level: 'warn', file: rel, line, token: base, msg: `arbitrary ${base} breaks the spacing/radius scale — ${scaleSuggest(prop, px)}` });
    }

    // --- 4: class conflicts + dups, per string-literal segment (ternary-safe) ---
    for (const seg of literalSegments(scope)) {
      const segTokens = tokenize(seg);
      const byKey = new Map(); // `${variantKey}|${prop}` -> Set(values)
      const seenTok = new Set();
      const dups = new Set();
      for (const t of segTokens) {
        if (seenTok.has(t)) dups.add(t); else seenTok.add(t);
        const { variantKey, base } = splitVariants(t);
        let prop = null, val = null;
        if (base.startsWith('bg-')) { const v = base.slice(3); if (isColorValue(v) && !/^\[/.test(v) && !['gradient', 'none', 'clip'].includes(v.split('-')[0])) { prop = 'bg'; val = v; } }
        else if (base.startsWith('text-')) { const v = base.slice(5); if (isColorValue(v) && !TEXT_NONCOLOR.test(v)) { prop = 'text'; val = v; } }
        if (prop) {
          const k = `${variantKey}|${prop}`;
          if (!byKey.has(k)) byKey.set(k, new Set());
          byKey.get(k).add(val);
        }
      }
      for (const [k, vals] of byKey) {
        if (vals.size > 1) {
          const [variantKey, prop] = k.split('|');
          const at = variantKey ? `${variantKey}:` : 'resting';
          push({ check: 'conflict', level: 'error', file: rel, line, token: [...vals].map((v) => `${prop}-${v}`).join(' + '), msg: `competing ${prop} colours on one element (${at})` });
        }
      }
      for (const d of dups) push({ check: 'conflict', level: 'warn', file: rel, line, token: d, msg: `duplicate class "${d}"` });

      // --- 5: convention — near-black text on a saturated (non-grey, non-luminous)
      // fill. Passes contrast but reads wrong: saturated colours want white labels.
      const darkTextAt = {}; const satBgAt = {};
      for (const t of segTokens) {
        const { variantKey, base } = splitVariants(t);
        if (DARK_TEXT.has(base)) darkTextAt[variantKey] = base;
        const bm = base.match(/^bg-([a-z]+)-(500|600|700|800|900)$/);
        if (bm && !NEUTRAL_FAM.has(bm[1]) && !LUMINOUS_FAM.has(bm[1])) satBgAt[variantKey] = base;
      }
      for (const vk of Object.keys(satBgAt)) {
        if (darkTextAt[vk]) {
          push({ check: 'convention', level: 'warn', file: rel, line, token: `${darkTextAt[vk]} + ${satBgAt[vk]}`, msg: `near-black text on saturated ${satBgAt[vk].slice(3)} — white text reads better on this fill` });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------
const CHECK_LABEL = { hardcoded: 'HARDCODED', accent: 'ACCENT', dark: 'DARK-GAP', conflict: 'CONFLICT', convention: 'CONVENTION', scale: 'SCALE-DRIFT' };
const byCheck = (c) => findings.filter((f) => f.check === c);
const summary = {
  files: files.length,
  total: findings.length,
  errors: findings.filter((f) => f.level === 'error').length,
  warns: findings.filter((f) => f.level === 'warn').length,
  hardcoded: byCheck('hardcoded').length, accent: byCheck('accent').length, dark: byCheck('dark').length, conflict: byCheck('conflict').length, convention: byCheck('convention').length, scale: byCheck('scale').length,
};

if (opt.json) {
  console.log(JSON.stringify({ summary, findings }, null, 2));
} else {
  const C = { r: '\x1b[31m', y: '\x1b[33m', g: '\x1b[32m', c: '\x1b[36m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };
  console.log(`\n${C.b}Style consistency lint${C.x} ${C.d}(${summary.files} files scanned)${C.x}\n`);
  console.log(`${C.b}Summary${C.x}`);
  console.log(`  ${summary.errors ? C.r : C.g}${summary.errors} error${C.x}   ${summary.warns ? C.y : C.g}${summary.warns} warn${C.x}   ${C.d}·${C.x}   hardcoded ${summary.hardcoded}  accent ${summary.accent}  dark-gap ${summary.dark}  conflict ${summary.conflict}  convention ${summary.convention}  scale ${summary.scale}\n`);
  if (!findings.length) {
    console.log(`${C.g}✓ No style inconsistencies found.${C.x}\n`);
  } else {
    const order = { error: 0, warn: 1 };
    findings.sort((a, b) => order[a.level] - order[b.level] || a.check.localeCompare(b.check) || a.file.localeCompare(b.file));
    for (const f of findings) {
      const sev = f.level === 'error' ? `${C.r}error${C.x}` : `${C.y}warn ${C.x}`;
      const tag = `${C.c}${(CHECK_LABEL[f.check] || f.check).padEnd(9)}${C.x}`;
      console.log(`  ${sev} ${tag} ${f.msg}`);
      console.log(`        ${C.d}${f.file}:${f.line}${C.x}  ${C.d}${f.token}${C.x}`);
    }
    console.log('');
  }
}

if (opt.failOn === 'error' && summary.errors) process.exit(1);
if (opt.failOn === 'warn' && (summary.errors || summary.warns)) process.exit(1);
