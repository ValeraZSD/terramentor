#!/usr/bin/env node
// contrast-audit.mjs — local-only WCAG AA/AAA colour-contrast linter (zero deps).
//
// Statically scans the frontend for Tailwind text/background colour usage and
// checks every foreground-on-background pair for WCAG 2.1 contrast, in BOTH
// light and dark modes. No browser, no server, no install — just:
//
// Each failure prints a "→ fix:" line with up to 3 auto-computed replacement
// tokens (nearest shade / tint / text swap that clears the target), ranked by
// how small a change they are. Pick whichever reads best.
//
//     node tools/contrast-audit.mjs                 # human report (AA + AAA)
//     node tools/contrast-audit.mjs --aaa           # only show AAA failures too
//     node tools/contrast-audit.mjs --fail-on aa    # exit 1 if any AA failure
//     node tools/contrast-audit.mjs --json          # machine-readable findings
//     node tools/contrast-audit.mjs --surfaces      # include advisory surface sweep
//     node tools/contrast-audit.mjs --all-sites     # list EVERY file:line per pair (not just the first)
//     node tools/contrast-audit.mjs --max 40        # cap findings printed
//
// It is NOT committed (see .gitignore `tools/`). It's a dev aid: after a frontend
// colour change, run it to catch regressions. Because it's static it can't know
// the exact ancestor a piece of text renders on, so it reports three confidence
// tiers:
//   • PAIR  — text + background on the SAME element (high confidence, exact)
//   • INFER — muted achromatic text with NO bg class, checked against the mode's
//             canonical surface. Shown by DEFAULT: a neutral grey/slate text
//             token that sets no background renders on the page/card by
//             convention, so this reliably catches "unreadable grey label" bugs
//             that PAIR mode can't see — without the sweep's false positives.
//   • SWEEP — any standalone text colour vs ALL canonical surfaces, worst case
//             (advisory / noisy; only shown with --surfaces)
//
// Convention this relies on (see docs/ARCHITECTURE.md): the codebase uses explicit Tailwind
// `dark:` variants, so the resting light/dark colour of an element is statically
// recoverable. Interaction variants (hover/focus/group-*) are intentionally
// ignored — only the resting state is audited.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SRC = join(ROOT, 'src');

// ---------------------------------------------------------------------------
// Tailwind v3 default palette (families actually resolvable to a colour).
// ---------------------------------------------------------------------------
const PALETTE = {
  slate: ['#f8fafc', '#f1f5f9', '#e2e8f0', '#cbd5e1', '#94a3b8', '#64748b', '#475569', '#334155', '#1e293b', '#0f172a', '#020617'],
  gray: ['#f9fafb', '#f3f4f6', '#e5e7eb', '#d1d5db', '#9ca3af', '#6b7280', '#4b5563', '#374151', '#1f2937', '#111827', '#030712'],
  zinc: ['#fafafa', '#f4f4f5', '#e4e4e7', '#d4d4d8', '#a1a1aa', '#71717a', '#52525b', '#3f3f46', '#27272a', '#18181b', '#09090b'],
  neutral: ['#fafafa', '#f5f5f5', '#e5e5e5', '#d4d4d4', '#a3a3a3', '#737373', '#525252', '#404040', '#262626', '#171717', '#0a0a0a'],
  stone: ['#fafaf9', '#f5f5f4', '#e7e5e4', '#d6d3d1', '#a8a29e', '#78716c', '#57534e', '#44403c', '#292524', '#1c1917', '#0c0a09'],
  red: ['#fef2f2', '#fee2e2', '#fecaca', '#fca5a5', '#f87171', '#ef4444', '#dc2626', '#b91c1c', '#991b1b', '#7f1d1d', '#450a0a'],
  orange: ['#fff7ed', '#ffedd5', '#fed7aa', '#fdba74', '#fb923c', '#f97316', '#ea580c', '#c2410c', '#9a3412', '#7c2d12', '#431407'],
  amber: ['#fffbeb', '#fef3c7', '#fde68a', '#fcd34d', '#fbbf24', '#f59e0b', '#d97706', '#b45309', '#92400e', '#78350f', '#451a03'],
  yellow: ['#fefce8', '#fef9c3', '#fef08a', '#fde047', '#facc15', '#eab308', '#ca8a04', '#a16207', '#854d0e', '#713f12', '#422006'],
  lime: ['#f7fee7', '#ecfccb', '#d9f99d', '#bef264', '#a3e635', '#84cc16', '#65a30d', '#4d7c0f', '#3f6212', '#365314', '#1a2e05'],
  green: ['#f0fdf4', '#dcfce7', '#bbf7d0', '#86efac', '#4ade80', '#22c55e', '#16a34a', '#15803d', '#166534', '#14532d', '#052e16'],
  emerald: ['#ecfdf5', '#d1fae5', '#a7f3d0', '#6ee7b7', '#34d399', '#10b981', '#059669', '#047857', '#065f46', '#064e3b', '#022c22'],
  teal: ['#f0fdfa', '#ccfbf1', '#99f6e4', '#5eead4', '#2dd4bf', '#14b8a6', '#0d9488', '#0f766e', '#115e59', '#134e4a', '#042f2e'],
  cyan: ['#ecfeff', '#cffafe', '#a5f3fc', '#67e8f9', '#22d3ee', '#06b6d4', '#0891b2', '#0e7490', '#155e75', '#164e63', '#083344'],
  sky: ['#f0f9ff', '#e0f2fe', '#bae6fd', '#7dd3fc', '#38bdf8', '#0ea5e9', '#0284c7', '#0369a1', '#075985', '#0c4a6e', '#082f49'],
  blue: ['#eff6ff', '#dbeafe', '#bfdbfe', '#93c5fd', '#60a5fa', '#3b82f6', '#2563eb', '#1d4ed8', '#1e40af', '#1e3a8a', '#172554'],
  indigo: ['#eef2ff', '#e0e7ff', '#c7d2fe', '#a5b4fc', '#818cf8', '#6366f1', '#4f46e5', '#4338ca', '#3730a3', '#312e81', '#1e1b4b'],
  violet: ['#f5f3ff', '#ede9fe', '#ddd6fe', '#c4b5fd', '#a78bfa', '#8b5cf6', '#7c3aed', '#6d28d9', '#5b21b6', '#4c1d95', '#2e1065'],
  purple: ['#faf5ff', '#f3e8ff', '#e9d5ff', '#d8b4fe', '#c084fc', '#a855f7', '#9333ea', '#7e22ce', '#6b21a8', '#581c87', '#3b0764'],
  fuchsia: ['#fdf4ff', '#fae8ff', '#f5d0fe', '#f0abfc', '#e879f9', '#d946ef', '#c026d3', '#a21caf', '#86198f', '#701a75', '#4a044e'],
  pink: ['#fdf2f8', '#fce7f3', '#fbcfe8', '#f9a8d4', '#f472b6', '#ec4899', '#db2777', '#be185d', '#9d174d', '#831843', '#500724'],
  rose: ['#fff1f2', '#ffe4e6', '#fecdd3', '#fda4af', '#fb7185', '#f43f5e', '#e11d48', '#be123c', '#9f1239', '#881337', '#4c0514'],
};
const SHADES = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900', '950'];

// Accent CSS variables (index.css). Per-project accents OVERRIDE these at runtime,
// so accent findings are flagged "default accent (varies per project)".
const ACCENT = {
  // solid accent stays dark in both modes (white text sits on it)
  accent: { light: '#0e7490', dark: '#0e7490' },
  // accent-fg is brightened in dark mode for AA
  'accent-fg': { light: '#0e7490', dark: '#22d3ee' },
};

// Canonical surfaces text is expected to render on (by frequency in the code).
const SURFACES = {
  light: [['white', '#ffffff'], ['slate-50', '#f8fafc'], ['slate-100', '#f1f5f9']],
  dark: [['slate-900', '#0f172a'], ['slate-800', '#1e293b'], ['slate-700', '#334155']],
};

// Achromatic families used for body/muted text. A neutral text token with no
// bg class is (by overwhelming convention) meant to sit on the page/card
// surface — never on a contrasting colour — so we can check it at high
// confidence against the canonical surface WITHOUT the false positives the full
// --surfaces sweep produces for white/brand text (which clearly sits elsewhere).
const ACHROMATIC = new Set(['slate', 'gray', 'zinc', 'neutral', 'stone']);
// Is this a bare text token whose resting colour is *intended to be read on the
// mode's default surface*? Light mode → dark-ish shades (400+); dark mode →
// light shades (≤500). This excludes light tints in light mode (they're for
// dark chips) and dark shades in dark mode (for light chips), which are exactly
// the ambiguous cases that made the sweep noisy.
function isReadableIntentText(fgToken, mode) {
  const m = fgToken.match(/^([a-z]+)-(\d{2,3})(?:\/\d+)?$/);
  if (!m || !ACHROMATIC.has(m[1])) return false;
  const idx = SHADES.indexOf(m[2]);
  if (idx === -1) return false;
  return mode === 'light' ? idx >= 4 : idx <= 5;
}
// Page-default text colour when an element sets none (Tailwind body has none, but
// the app root sets these — used only to composite alpha text sanely).
const DEFAULT_TEXT = { light: '#0f172a', dark: '#f8fafc' };

// ---------------------------------------------------------------------------
// Colour maths (WCAG 2.1).
// ---------------------------------------------------------------------------
function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const s = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}
// Composite a possibly-translucent colour over an opaque backdrop → opaque rgb.
function over(fg, alpha, bg) {
  if (alpha >= 1) return fg;
  return fg.map((c, i) => Math.round(c * alpha + bg[i] * (1 - alpha)));
}
function relLum([r, g, b]) {
  const f = (c) => {
    const x = c / 255;
    // 0.04045, not the 0.03928 of WCAG 2.0: 2.1 corrected the constant so the
    // two branches meet. src/utils/color.ts uses the same value.
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(a, b) {
  const l1 = relLum(a);
  const l2 = relLum(b);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

// ---------------------------------------------------------------------------
// Resolve a Tailwind colour token → { hex, alpha } or null if not a colour.
// token examples: white, black, slate-500, slate-500/60, accent, accent-fg/40
// ---------------------------------------------------------------------------
function resolveColor(token, mode) {
  let alpha = 1;
  const slash = token.indexOf('/');
  if (slash !== -1) {
    const a = parseInt(token.slice(slash + 1), 10);
    if (!Number.isNaN(a)) alpha = a / 100;
    token = token.slice(0, slash);
  }
  if (token === 'white') return { hex: '#ffffff', alpha, accent: false };
  if (token === 'black') return { hex: '#000000', alpha, accent: false };
  if (token === 'transparent' || token === 'current' || token === 'inherit') return null;
  if (ACCENT[token]) return { hex: ACCENT[token][mode], alpha, accent: true };
  const m = token.match(/^([a-z]+)-(\d{2,3})$/);
  if (!m) return null;
  const fam = PALETTE[m[1]];
  if (!fam) return null;
  const idx = SHADES.indexOf(m[2]);
  if (idx === -1) return null;
  return { hex: fam[idx], alpha, accent: false };
}

// ---------------------------------------------------------------------------
// Suggested-fix engine: given a failing fg-on-bg pair, search nearby Tailwind
// tokens (same hue, shifted shade; achromatic text swap; lighter tint) for the
// minimal change that clears the AA target. Returns up to 3 ranked candidates.
// ---------------------------------------------------------------------------
function tokenParts(token) {
  let alpha = 1;
  const slash = token.indexOf('/');
  if (slash !== -1) {
    const a = parseInt(token.slice(slash + 1), 10);
    if (!Number.isNaN(a)) alpha = a / 100;
    token = token.slice(0, slash);
  }
  if (token === 'white') return { kind: 'white', alpha };
  if (token === 'black') return { kind: 'black', alpha };
  if (ACCENT[token]) return { kind: 'accent', name: token, alpha };
  const m = token.match(/^([a-z]+)-(\d{2,3})$/);
  if (m && PALETTE[m[1]]) {
    const idx = SHADES.indexOf(m[2]);
    if (idx !== -1) return { kind: 'family', family: m[1], idx, alpha };
  }
  return { kind: 'other', alpha };
}
// contrast of a candidate (fgTok on bgTok) composited over `surface` (rgb).
function ratioFor(fgTok, bgTok, mode, surface) {
  const fg = resolveColor(fgTok, mode);
  const bg = bgTok ? resolveColor(bgTok, mode) : { hex: null, alpha: 1 };
  if (!fg) return 0;
  const bgRgb = bg.hex ? over(hexToRgb(bg.hex), bg.alpha, surface) : surface;
  const fgRgb = over(hexToRgb(fg.hex), fg.alpha, bgRgb);
  return contrast(fgRgb, bgRgb);
}
const withAlpha = (base, alpha) => (alpha < 1 ? `${base}/${Math.round(alpha * 100)}` : base);
function suggestFixes(fgTok, bgTok, mode, surface, target) {
  const fg = tokenParts(fgTok);
  const bg = bgTok ? tokenParts(bgTok) : { kind: 'none', alpha: 1 };
  const cands = [];
  const add = (newFg, newBg, cost, desc) => {
    const r = ratioFor(newFg, newBg, mode, surface);
    if (r >= target) cands.push({ cost, ratio: +r.toFixed(2), desc });
  };
  // A) keep bg, re-shade family text (nearest passing shade wins on cost)
  if (fg.kind === 'family') {
    for (let i = 0; i < SHADES.length; i++) {
      if (i === fg.idx) continue;
      add(withAlpha(`${fg.family}-${SHADES[i]}`, fg.alpha), bgTok, Math.abs(i - fg.idx), `text-${withAlpha(`${fg.family}-${SHADES[i]}`, fg.alpha)}`);
    }
  }
  // A') achromatic text swap (white↔dark) — bigger visual change, cost 3
  if (fg.kind === 'white' || fg.kind === 'black') {
    const swaps = mode === 'light' ? ['slate-900', 'slate-800', 'black'] : ['slate-50', 'slate-100', 'white'];
    for (const nf of swaps) if (nf !== fgTok) add(nf, bgTok, 3, `text-${nf}`);
  }
  // B) keep text, re-shade solid family background
  if (bg.kind === 'family') {
    for (let i = 0; i < SHADES.length; i++) {
      if (i === bg.idx) continue;
      add(fgTok, withAlpha(`${bg.family}-${SHADES[i]}`, bg.alpha), Math.abs(i - bg.idx) + 0.1, `bg-${withAlpha(`${bg.family}-${SHADES[i]}`, bg.alpha)}`);
    }
  }
  // B') lighten a translucent tint (accent or family) — more surface bleeds through
  if ((bg.kind === 'accent' || bg.kind === 'family') && bg.alpha < 1) {
    const base = bg.kind === 'accent' ? bg.name : `${bg.family}-${SHADES[bg.idx]}`;
    for (const a of [10, 5]) if (a < bg.alpha * 100) add(fgTok, `${base}/${a}`, (bg.alpha * 100 - a) / 10, `bg-${base}/${a}`);
  }
  const best = new Map();
  for (const c of cands) if (!best.has(c.desc) || best.get(c.desc).cost > c.cost) best.set(c.desc, c);
  return [...best.values()].sort((a, b) => a.cost - b.cost).slice(0, 3);
}

// ---------------------------------------------------------------------------
// Extract per-element class scopes from a source file.
// A "scope" ≈ one className attribute value. We grab everything Tailwind-ish
// inside each className=... (string literal, template literal, or cn(...)-style
// expression) and treat it as one element for fg/bg pairing.
// ---------------------------------------------------------------------------
function extractScopes(text) {
  const scopes = [];
  const re = /className\s*=\s*(\{|")/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const start = m.index + m[0].length;
    let end;
    if (m[1] === '"') {
      end = text.indexOf('"', start);
      if (end === -1) continue;
    } else {
      // balanced braces
      let depth = 1;
      let i = start;
      for (; i < text.length && depth > 0; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}') depth--;
      }
      end = i - 1;
    }
    const blob = text.slice(start, end);
    const line = text.slice(0, m.index).split('\n').length;
    // pull class-like tokens (letters/digits/-/ /: and %), drop ${...} noise
    const tokens = blob.replace(/\$\{[^}]*\}/g, ' ').match(/[a-zA-Z][\w:/.\-\[\]]*/g) || [];
    scopes.push({ line, tokens });
    re.lastIndex = end;
  }
  // Also handle CSS @apply in .css files (index.css prose etc.)
  return scopes;
}

// classify a single class token → { kind, variant, value }
// kind: text | bg | size | weight | null ; variant: '' | 'dark'
function classify(token) {
  let variant = '';
  // strip leading responsive/state variants; keep only whether 'dark' is present
  const parts = token.split(':');
  const base = parts.pop();
  const prefixes = parts;
  // Ignore interaction/pseudo states — only resting styles are audited.
  const IGNORE = /^(hover|focus|focus-visible|focus-within|active|group-hover|group-focus|peer-hover|peer-focus|disabled|visited|checked|aria-|data-|before|after|placeholder|first|last|odd|even|open)/;
  if (prefixes.some((p) => IGNORE.test(p))) return null;
  if (prefixes.includes('dark')) variant = 'dark';

  if (base.startsWith('text-')) {
    const v = base.slice(5);
    // size keywords
    if (/^(xs|sm|base|lg|xl|\dxl|\d?xl)$/.test(v) || /^(xs|sm|base|lg|xl|2xl|3xl|4xl|5xl|6xl|7xl|8xl|9xl)$/.test(v)) {
      return { kind: 'size', variant, value: v };
    }
    return { kind: 'text', variant, value: v };
  }
  if (base.startsWith('bg-')) return { kind: 'bg', variant, value: base.slice(3) };
  if (base.startsWith('font-')) {
    const w = base.slice(5);
    if (['bold', 'semibold', 'extrabold', 'black', 'medium', 'normal', 'light', 'thin'].includes(w)) {
      return { kind: 'weight', variant, value: w };
    }
  }
  return null;
}

const SIZE_PX = { xs: 12, sm: 14, base: 16, lg: 18, xl: 20, '2xl': 24, '3xl': 30, '4xl': 36, '5xl': 48, '6xl': 60, '7xl': 72, '8xl': 96, '9xl': 128 };
const BOLDISH = new Set(['bold', 'semibold', 'extrabold', 'black']);

// Is this text "large" per WCAG (≥24px, or ≥18.66px and bold)?
function isLarge(px, bold) {
  if (px == null) return false;
  return px >= 24 || (px >= 18.66 && bold);
}

// ---------------------------------------------------------------------------
// Walk source tree.
// ---------------------------------------------------------------------------
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'dist') continue;
      walk(p, out);
    } else if (/\.(tsx|jsx|ts|css)$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Analyse.
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const opt = {
  json: args.includes('--json'),
  aaa: args.includes('--aaa'),
  surfaces: args.includes('--surfaces'),
  allSites: args.includes('--all-sites'),
  max: (() => { const i = args.indexOf('--max'); return i !== -1 ? parseInt(args[i + 1], 10) : 60; })(),
  failOn: (() => { const i = args.indexOf('--fail-on'); return i !== -1 ? args[i + 1] : null; })(),
};

function thresholds(large) {
  return large ? { aa: 3.0, aaa: 4.5 } : { aa: 4.5, aaa: 7.0 };
}

const findings = [];
const files = walk(SRC);

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const rel = relative(ROOT, file).split(sep).join('/');
  for (const scope of extractScopes(text)) {
    const cls = scope.tokens.map(classify).filter(Boolean);
    // resting size/weight (largest wins for "large text" leniency uses base size)
    let px = null;
    let bold = false;
    for (const c of cls) {
      if (c.kind === 'size' && SIZE_PX[c.value] != null) px = px == null ? SIZE_PX[c.value] : Math.max(px, SIZE_PX[c.value]);
      if (c.kind === 'weight' && BOLDISH.has(c.value)) bold = true;
    }
    const large = isLarge(px, bold);

    // Icon heuristic: a scope with explicit square-ish sizing (w-N + h-N) and no
    // text-size/font utility is almost certainly a lucide/SVG icon, not reading
    // text. Decorative icons are exempt from WCAG text-contrast rules, so we keep
    // them out of the default INFER tier (they'd otherwise flood it as noise).
    const hasW = scope.tokens.some((tk) => /^w-(\d|\[)/.test(tk));
    const hasH = scope.tokens.some((tk) => /^h-(\d|\[)/.test(tk));
    const hasTextMeta = cls.some((c) => c.kind === 'size' || c.kind === 'weight');
    const looksLikeIcon = hasW && hasH && !hasTextMeta;

    for (const mode of ['light', 'dark']) {
      // pick resting text colour for this mode: dark variant wins in dark mode,
      // else base. In light mode, dark: variants don't apply.
      const texts = cls.filter((c) => c.kind === 'text');
      const bgs = cls.filter((c) => c.kind === 'bg');
      const pickToken = (arr) => {
        if (mode === 'dark') {
          const d = arr.find((c) => c.variant === 'dark');
          if (d) return d.value;
        }
        const b = arr.find((c) => c.variant === '');
        return b ? b.value : null;
      };
      const fgToken = pickToken(texts);
      const bgToken = pickToken(bgs);
      if (!fgToken) continue;
      const fg = resolveColor(fgToken, mode);
      if (!fg) continue;

      const t = thresholds(large);

      if (bgToken) {
        const bgc = resolveColor(bgToken, mode);
        if (!bgc) continue;
        // composite: bg over canonical surface, fg over resolved bg
        const surface = hexToRgb(SURFACES[mode][0][1]);
        const bgRgb = over(hexToRgb(bgc.hex), bgc.alpha, surface);
        const fgRgb = over(hexToRgb(fg.hex), fg.alpha, bgRgb);
        const ratio = contrast(fgRgb, bgRgb);
        const failAA = ratio < t.aa;
        const failAAA = ratio < t.aaa;
        if (failAA || failAAA) {
          findings.push({
            tier: 'PAIR', file: rel, line: scope.line, mode, large,
            fg: fgToken, bg: bgToken, fgHex: fg.hex, bgHex: bgc.hex,
            ratio: +ratio.toFixed(2), failAA, failAAA,
            accent: fg.accent || bgc.accent,
            need: { aa: t.aa, aaa: t.aaa },
            suggest: suggestFixes(fgToken, bgToken, mode, surface, failAA ? t.aa : t.aaa),
          });
        }
      } else if (isReadableIntentText(fgToken, mode) && !looksLikeIcon) {
        // DEFAULT high-confidence check: muted achromatic text with no bg class
        // renders on the mode's canonical surface. Catches the "unreadable grey
        // label" bugs that PAIR mode structurally can't see (no bg on the same
        // element), without the sweep's white-on-colour false positives.
        const [sName, sHex] = SURFACES[mode][0];
        const surface = hexToRgb(sHex);
        const fgRgb = over(hexToRgb(fg.hex), fg.alpha, surface);
        const ratio = contrast(fgRgb, surface);
        const failAA = ratio < t.aa;
        const failAAA = ratio < t.aaa;
        if (failAA || failAAA) {
          findings.push({
            tier: 'INFER', file: rel, line: scope.line, mode, large,
            fg: fgToken, bg: sName, fgHex: fg.hex, bgHex: sHex,
            ratio: +ratio.toFixed(2), failAA, failAAA,
            accent: false,
            need: { aa: t.aa, aaa: t.aaa },
            suggest: suggestFixes(fgToken, null, mode, surface, failAA ? t.aa : t.aaa),
          });
        }
      } else if (opt.surfaces) {
        // advisory: sweep standalone fg vs canonical surfaces; report worst.
        let worst = null;
        for (const [sName, sHex] of SURFACES[mode]) {
          const bgRgb = hexToRgb(sHex);
          const fgRgb = over(hexToRgb(fg.hex), fg.alpha, bgRgb);
          const ratio = contrast(fgRgb, bgRgb);
          if (!worst || ratio < worst.ratio) worst = { sName, sHex, ratio };
        }
        const failAA = worst.ratio < t.aa;
        const failAAA = worst.ratio < t.aaa;
        if (failAA || failAAA) {
          findings.push({
            tier: 'SWEEP', file: rel, line: scope.line, mode, large,
            fg: fgToken, bg: worst.sName, fgHex: fg.hex, bgHex: worst.sHex,
            ratio: +worst.ratio.toFixed(2), failAA, failAAA,
            accent: fg.accent,
            need: { aa: t.aa, aaa: t.aaa },
          });
        }
      }
    }
  }
}

// De-duplicate identical (mode,fg,bg,tier,large) pairs — keep first occurrence,
// tally how many sites share it.
const seen = new Map();
for (const f of findings) {
  const key = `${f.tier}|${f.mode}|${f.fg}|${f.bg}|${f.large}`;
  if (seen.has(key)) { const u = seen.get(key); u.count++; u.sites.push(`${f.file}:${f.line}`); continue; }
  f.count = 1;
  f.sites = [`${f.file}:${f.line}`];
  seen.set(key, f);
}
let unique = [...seen.values()];
// severity: AA failures first, then by lowest ratio
unique.sort((a, b) => (Number(b.failAA) - Number(a.failAA)) || (a.ratio - b.ratio));

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------
const summary = {
  files: files.length,
  totalSites: findings.length,
  uniqueIssues: unique.length,
  aaFailLight: unique.filter((f) => f.failAA && f.mode === 'light').length,
  aaFailDark: unique.filter((f) => f.failAA && f.mode === 'dark').length,
  aaaFailLight: unique.filter((f) => f.failAAA && f.mode === 'light').length,
  aaaFailDark: unique.filter((f) => f.failAAA && f.mode === 'dark').length,
};

if (opt.json) {
  console.log(JSON.stringify({ summary, findings: unique }, null, 2));
} else {
  const C = { r: '\x1b[31m', y: '\x1b[33m', g: '\x1b[32m', c: '\x1b[36m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`\n${C.b}WCAG contrast audit${C.x} ${C.d}(${summary.files} files scanned, static Tailwind analysis)${C.x}\n`);
  console.log(`${C.b}Summary${C.x}`);
  console.log(`  AA  failures  light ${summary.aaFailLight ? C.r : C.g}${summary.aaFailLight}${C.x}   dark ${summary.aaFailDark ? C.r : C.g}${summary.aaFailDark}${C.x}   ${C.d}(4.5:1 normal / 3:1 large text)${C.x}`);
  console.log(`  AAA failures  light ${summary.aaaFailLight ? C.y : C.g}${summary.aaaFailLight}${C.x}   dark ${summary.aaaFailDark ? C.y : C.g}${summary.aaaFailDark}${C.x}   ${C.d}(7:1 normal / 4.5:1 large text)${C.x}`);
  console.log(`  ${C.d}${summary.uniqueIssues} unique colour pairs, ${summary.totalSites} total sites${C.x}\n`);

  const show = unique.filter((f) => opt.aaa || f.failAA);
  if (!show.length) {
    console.log(`${C.g}✓ No ${opt.aaa ? 'AA/AAA' : 'AA'} contrast failures found.${C.x}`);
    if (!opt.aaa) console.log(`${C.d}  (run with --aaa to also list AAA-only failures, --surfaces for the advisory sweep)${C.x}`);
  } else {
    console.log(`${C.b}Findings${C.x} ${C.d}(worst first; AAA-only in yellow. ×N = shared sites)${C.x}`);
    for (const f of show.slice(0, opt.max)) {
      const sev = f.failAA ? `${C.r}AA✗${C.x}` : `${C.y}AAA✗${C.x}`;
      const col = f.failAA ? C.r : C.y;
      const mode = f.mode === 'dark' ? `${C.c}dark ${C.x}` : `${C.c}light${C.x}`;
      const size = f.large ? 'lg' : 'nm';
      const acc = f.accent ? ` ${C.d}[default accent — varies per project]${C.x}` : '';
      const times = f.count > 1 ? ` ${C.d}×${f.count}${C.x}` : '';
      console.log(
        `  ${sev} ${mode} ${C.d}${pad(f.tier, 5)}${C.x} ${col}${pad(f.ratio + ':1', 8)}${C.x}` +
        ` ${pad('text-' + f.fg, 22)} on ${pad('bg-' + f.bg, 20)} ${C.d}(${f.fgHex}/${f.bgHex}, ${size})${C.x}${times}`,
      );
      if (opt.allSites && f.sites.length > 1) {
        f.sites.forEach((s, i) => console.log(`       ${C.d}${s}${i === 0 ? acc : ''}${C.x}`));
      } else {
        console.log(`       ${C.d}${f.file}:${f.line}${f.count > 1 ? ` ${C.d}(+${f.count - 1} more; --all-sites)` : ''}${acc}${C.x}`);
      }
      if (f.suggest && f.suggest.length) {
        const fixes = f.suggest.map((s) => `${C.g}${s.desc}${C.x} ${C.d}(${s.ratio}:1)${C.x}`).join(`  ${C.d}·${C.x}  `);
        console.log(`       ${C.d}→ fix:${C.x} ${fixes}`);
      } else {
        console.log(`       ${C.d}→ no single-token fix reaches AA — rethink this pairing${C.x}`);
      }
    }
    if (show.length > opt.max) console.log(`  ${C.d}… ${show.length - opt.max} more (raise --max)${C.x}`);
  }
  console.log('');
  if (!opt.surfaces) console.log(`${C.d}Tip: --surfaces adds advisory checks of standalone text colours vs canonical app surfaces.${C.x}\n`);
}

// ---------------------------------------------------------------------------
// Exit code (for CI / gating).
// ---------------------------------------------------------------------------
if (opt.failOn === 'aa' && (summary.aaFailLight || summary.aaFailDark)) process.exit(1);
if (opt.failOn === 'aaa' && (summary.aaaFailLight || summary.aaaFailDark || summary.aaFailLight || summary.aaFailDark)) process.exit(1);
