// tools/evidence-chart-gates.mjs — the evidence chart says what its sources say.
//
// docs/WHY_IT_WORKS.md and the README show effect sizes from published studies.
// The numbers live once, in docs/evidence/effect-sizes.json, each beside its
// citation, its link and the sentence it was read from; the two SVGs and the
// doc's table are generated from that file by tools/evidence-chart.mjs. What
// can go wrong, and what this suite catches:
//
//   * a number corrected in the data while the drawing or the table still shows
//     the old one (the generated files are compared with a fresh render);
//   * a bar with no source, a source with no link, or a value with no quoted
//     sentence behind it;
//   * a bar or its interval outside the axis, which draws off the image;
//   * a label long enough to run into the source beside it, or a value label
//     past the right edge (GitHub shrinks the image on a phone, so the layout
//     has no slack to absorb it);
//   * text or bars too faint on GitHub's light or dark page;
//   * the README or the doc dropping one theme's image from its <picture>.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    loadData, expectedOutputs, lf, THEMES, W, SIZE, textWidth, fmt, svgPath, DOC_PATH, shortLabel,
} from './evidence-chart.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
let passed = 0;
const check = (label, ok, detail = '') => {
    if (ok) passed++; else failures++;
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
};

const data = loadData();
const rows = data.groups.flatMap((g) => g.rows);

// --- every bar has a source ------------------------------------------------
check('the chart has rows', rows.length > 0);
const ids = rows.map((r) => r.id);
check('row ids are unique', new Set(ids).size === ids.length, ids.join(','));
for (const r of rows) {
    const s = r.source || {};
    const missing = ['label', 'short', 'metric', 'size', 'compared'].filter((k) => typeof r[k] !== 'string' || !r[k].trim());
    check(`${r.id}: label, short source, metric, size and comparison filled`, missing.length === 0, `missing ${missing.join(', ')}`);
    check(`${r.id}: value is a number`, Number.isFinite(r.value), String(r.value));
    check(`${r.id}: cites a paper with an https link`, typeof s.cite === 'string' && /^https:\/\//.test(s.url || ''), JSON.stringify(s.url));
    check(`${r.id}: carries the sentence the value was read from`, typeof s.quote === 'string' && s.quote.length >= 20);
    check(`${r.id}: says when it was checked`, /^\d{4}-\d{2}-\d{2}$/.test(r.checked || ''), String(r.checked));
    check(`${r.id}: says whether it is peer-reviewed`, typeof r.reviewed === 'boolean', String(r.reviewed));
    if (r.ci !== null) {
        const ok = Array.isArray(r.ci) && r.ci.length === 2 && r.ci[0] <= r.value && r.value <= r.ci[1];
        check(`${r.id}: interval brackets the value`, ok, JSON.stringify(r.ci));
    }
    const lo = Array.isArray(r.ci) ? r.ci[0] : r.value;
    const hi = Array.isArray(r.ci) ? r.ci[1] : r.value;
    check(`${r.id}: inside the axis`, lo >= data.axis.min && hi <= data.axis.max, `${lo}..${hi} vs ${data.axis.min}..${data.axis.max}`);
}

// --- the drawing has room for its text -------------------------------------
const x = (v) => ((v - data.axis.min) / (data.axis.max - data.axis.min)) * W;
// `textWidth` was within 1% of Edge's measured widths (Segoe UI, 1 Nov 2026);
// a viewer whose system sans is wider (DejaVu on Linux) gets 15% of slack.
const WIDER_FONT = 1.15;
for (const r of rows) {
    const room = W - WIDER_FONT * (textWidth(r.label, SIZE.label) + textWidth(shortLabel(r), SIZE.small));
    check(`${r.id}: label and source fit on one line`, room >= 12, `${room.toFixed(0)}px spare`);
    const reach = Array.isArray(r.ci) ? (r.value >= 0 ? x(r.ci[1]) : x(r.ci[0])) : x(r.value);
    const valueW = textWidth(fmt(r.value), SIZE.value, true);
    const fits = r.value >= 0 ? reach + 6 + valueW <= W : reach - 6 - valueW >= 0;
    check(`${r.id}: value label inside the image`, fits);
}
if (rows.some((r) => r.reviewed === false)) {
    check('the asterisk on unreviewed sources is explained in the note', data.note.some((l) => l.startsWith('* ')));
}
for (const line of [...data.title]) check(`title line fits: "${line}"`, textWidth(line, SIZE.title, true) <= W);
for (const line of [...data.subtitle, ...data.note]) check(`note line fits: "${line}"`, textWidth(line, SIZE.small) <= W);

// --- contrast on GitHub's own pages (WCAG 2 relative luminance) --------------
const lum = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const [l1, l2] = [lum(a), lum(b)].sort((p, q) => q - p); return (l1 + 0.05) / (l2 + 0.05); };
// Light: github.com's page. Dark: the default dark theme and the dimmed one.
const PAGES = { light: ['#ffffff'], dark: ['#0d1117', '#212830'] };
for (const [theme, c] of Object.entries(THEMES)) {
    for (const page of PAGES[theme]) {
        for (const role of ['ink', 'quiet']) {
            const k = contrast(c[role], page);
            check(`${theme} ${role} text on ${page} reaches 4.5:1`, k >= 4.5, k.toFixed(2));
        }
        for (const role of ['gain', 'loss']) {
            const k = contrast(c[role], page);
            check(`${theme} ${role} bar on ${page} reaches 3:1`, k >= 3, k.toFixed(2));
        }
    }
}

// --- the generated files match the data ------------------------------------
for (const [path, content] of expectedOutputs(data)) {
    const rel = path.slice(repoRoot.length + 1).replace(/\\/g, '/');
    const current = existsSync(path) ? lf(readFileSync(path, 'utf8')) : null;
    check(`${rel} matches the data (node tools/evidence-chart.mjs)`, current === content, current === null ? 'missing' : 'stale');
}

// --- both themes are offered wherever the chart is shown ---------------------
const pictureOffersBoth = (text, prefix) => {
    const dark = new RegExp(`<source media="\\(prefers-color-scheme: dark\\)" srcset="${prefix}effect-sizes-dark\\.svg">`);
    const light = new RegExp(`<img src="${prefix}effect-sizes-light\\.svg" alt="[^"]{40,}"`);
    return dark.test(text) && light.test(text);
};
check('README shows the chart with a dark source and a described light image',
    pictureOffersBoth(readFileSync(join(repoRoot, 'README.md'), 'utf8'), 'docs/evidence/'));
check('WHY_IT_WORKS.md shows the chart with a dark source and a described light image',
    pictureOffersBoth(readFileSync(DOC_PATH, 'utf8'), 'evidence/'));
// The link must sit in the chart's own section (from the <picture> to the next heading): the
// README's documentation list links the doc too, and would hide a section that lost its link.
const readme = lf(readFileSync(join(repoRoot, 'README.md'), 'utf8'));
const chartAt = readme.indexOf('effect-sizes-light.svg');
const nextHeading = chartAt < 0 ? -1 : readme.indexOf('\n#', chartAt);
const chartSection = chartAt < 0 ? '' : readme.slice(chartAt, nextHeading < 0 ? undefined : nextHeading);
check('README links to the doc beside the chart', /\]\(docs\/WHY_IT_WORKS\.md\)/.test(chartSection));
for (const theme of Object.keys(THEMES)) check(`${theme} SVG exists`, existsSync(svgPath(theme)));

// `tools/run-gates.mjs` reads the assertion count out of this line.
console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
