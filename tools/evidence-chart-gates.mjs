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
//   * a bar or its interval outside the axis, which draws off the image, and an
//     interval in the data that the drawing leaves out;
//   * any text past the image's edge or into other text, set 15% wider than the
//     estimate, since the viewer's system font decides the real width (GitHub
//     also shrinks the image on a phone, so the layout has no slack);
//   * text, bars, the zero line, or an interval line over its bar too faint on
//     GitHub's light, dark or dimmed page;
//   * the README or the doc dropping one theme's image from its <picture>;
//   * a number typed by hand beside the chart (the two alt texts, the README
//     paragraph) that is no longer a number in the data.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    loadData, lf, THEMES, W, fmt, svgPath, DOC_PATH, layout, WIDER_FONT, renderSvg, renderTable, docWithTable,
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
        // Number.isFinite first: `null <= 0.3` is true in JavaScript.
        const ok = Array.isArray(r.ci) && r.ci.length === 2 && r.ci.every(Number.isFinite)
            && r.ci[0] <= r.value && r.value <= r.ci[1];
        check(`${r.id}: interval brackets the value`, ok, JSON.stringify(r.ci));
    }
    const lo = Array.isArray(r.ci) ? r.ci[0] : r.value;
    const hi = Array.isArray(r.ci) ? r.ci[1] : r.value;
    check(`${r.id}: inside the axis`, lo >= data.axis.min && hi <= data.axis.max, `${lo}..${hi} vs ${data.axis.min}..${data.axis.max}`);
}

// --- the drawing has room for its text -------------------------------------
// Every piece of text the SVG draws (title, labels, sources, values, ticks,
// notes), at the width `layout` gives it. The margin is pinned here, not only
// read from the generator: lowering WIDER_FONT there would otherwise pass.
check('text is laid out at least 15% wider than the estimate', WIDER_FONT >= 1.15, String(WIDER_FONT));
const { texts } = layout(data, 'light');
const outside = texts.filter((t) => t.left < 0 || t.right > W).map((t) => `"${t.s}" ${t.left.toFixed(0)}..${t.right.toFixed(0)}`);
check(`every text fits inside the ${W}px image in a 15% wider font`, outside.length === 0, outside.join('; '));
const GAP = 8;
const overlaps = [];
for (const [i, a] of texts.entries()) {
    for (const b of texts.slice(i + 1)) {
        const rowsMeet = a.top < b.bottom && b.top < a.bottom;
        const colsMeet = a.left < b.right + GAP && b.left < a.right + GAP;
        if (rowsMeet && colsMeet) overlaps.push(`"${a.s}" / "${b.s}"`);
    }
}
check(`no two texts closer than ${GAP}px in a 15% wider font`, overlaps.length === 0, overlaps.join('; '));
if (rows.some((r) => r.reviewed === false)) {
    check('the asterisk on unreviewed sources is explained in the note', data.note.some((l) => l.startsWith('* ')));
}

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
        for (const role of ['gain', 'loss', 'zero']) {
            const k = contrast(c[role], page);
            check(`${theme} ${role} mark on ${page} reaches 3:1`, k >= 3, k.toFixed(2));
        }
    }
    // The interval line crosses its own bar: it must show on the bar too.
    for (const role of ['gain', 'loss']) {
        const k = contrast(c.ci, c[role]);
        check(`${theme} interval line on a ${role} bar reaches 3:1`, k >= 3, k.toFixed(2));
    }
}

// --- every interval is drawn -------------------------------------------------
// Each interval path names its row, and only interval paths are stroked in the
// `ci` colour: one per row that has an interval, none for a row without.
const withCi = rows.filter((r) => Array.isArray(r.ci));
for (const [theme, c] of Object.entries(THEMES)) {
    const svg = renderSvg(data, theme);
    const wrong = withCi.map((r) => [r.id, svg.split(`data-row="${r.id}" `).length - 1]).filter(([, n]) => n !== 1);
    const total = svg.split(`stroke="${c.ci}"`).length - 1;
    check(`${theme} SVG draws exactly one interval line for each row that has one`, wrong.length === 0 && total === withCi.length,
        `${wrong.map(([id, n]) => `${id}: ${n}`).join(', ')}; ${total} lines for ${withCi.length} intervals`);
}

// --- what the generator prints -----------------------------------------------
check('a value that rounds to zero prints without a minus', fmt(-0.001) === '0.00' && fmt(-0.29) === '−0.29', `${fmt(-0.001)} ${fmt(-0.29)}`);
// Text holding `|`, `[`, `]` or `\` must come back out of the table as typed:
// split on the pipes a markdown reader splits on (a backslash escapes the next
// character), then undo the escapes.
const cellsOf = (line) => {
    const out = [];
    let cur = '';
    for (let i = 0; i < line.length; i++) {
        if (line[i] === '\\' && i + 1 < line.length) cur += line[i] + line[++i];
        else if (line[i] === '|') { out.push(cur); cur = ''; } else cur += line[i];
    }
    out.push(cur);
    return out.slice(1, -1).map((c) => c.trim().replace(/\\([\\|[\]])/g, '$1'));
};
const awkwardRow = {
    label: 'a|b', metric: 'SD', value: 0.1, ci: null, size: 'x[1]', compared: 'y]', note: 'a\\|b, ends in \\',
    source: { cite: 'Name [2020] | x', url: 'https://example.org' },
};
const awkwardLines = renderTable({ groups: [{ label: 'a | group', rows: [awkwardRow] }] }).split('\n')
    .filter((l) => l.startsWith('| ') && !l.startsWith('| ---') && !l.startsWith('| Result'));
const wanted = [
    ['**a | group**', '', '', '', '', '', ''],
    ['a|b', '0.10 SD', 'not extracted', 'x[1]', 'y]', 'a\\|b, ends in \\', '[Name [2020] | x](https://example.org)'],
];
const got = awkwardLines.map(cellsOf);
check('table cells holding | [ ] or \\ read back as typed', JSON.stringify(got) === JSON.stringify(wanted), JSON.stringify(got));

// --- the generated files match the data ------------------------------------
// The SVGs are compared even when the doc's markers are broken, so one fault
// does not hide another.
const outputs = Object.keys(THEMES).map((t) => [svgPath(t), renderSvg(data, t)]);
try {
    outputs.push([DOC_PATH, docWithTable(readFileSync(DOC_PATH, 'utf8'), data)]);
    check('the doc has its evidence-table markers once each', true);
} catch (e) {
    check('the doc has its evidence-table markers once each', false, e.message);
}
for (const [path, content] of outputs) {
    const rel = path.slice(repoRoot.length + 1).replace(/\\/g, '/');
    const current = existsSync(path) ? lf(readFileSync(path, 'utf8')) : null;
    check(`${rel} matches the data (node tools/evidence-chart.mjs)`, current === content, current === null ? 'missing' : 'stale');
}

// --- both themes are offered wherever the chart is shown ---------------------
const pictureOffersBoth = (text, prefix) => {
    const dark = new RegExp(`<source media="\\(prefers-color-scheme: dark\\)" srcset="${prefix}effect-sizes-dark\\.svg">`);
    const light = new RegExp(`<img src="${prefix}effect-sizes-light\\.svg" alt="[^"]{40,}"`);
    // Both inside ONE <picture>, the source first: a browser ignores a <source>
    // in another <picture> or after the <img>.
    return [...text.matchAll(/<picture>[\s\S]*?<\/picture>/g)].some(([p]) => {
        const darkAt = p.search(dark);
        const lightAt = p.search(light);
        return darkAt >= 0 && lightAt > darkAt;
    });
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

// --- numbers typed by hand beside the chart --------------------------------
// The alt texts and the README's paragraph repeat values from the data in
// prose. They are not generated, so a value corrected in the data must fail
// here until the prose is corrected too.
const altOf = (text) => (text.match(/<img src="[^"]*effect-sizes-light\.svg" alt="([^"]*)"/) || [])[1] || '';
const readmeAlt = altOf(readme);
const docAlt = altOf(lf(readFileSync(DOC_PATH, 'utf8')));
check('the README and the doc describe the chart with the same alt text', readmeAlt !== '' && readmeAlt === docAlt);
const spoken = (v) => (v < 0 ? `minus ${fmt(-v)}` : fmt(v));
// In the chart's order, so two values swapped between studies fail too.
// Whole numbers only (`\d+`, no third decimal), so a mistyped 10.50 is not read as 0.50.
const NUMBER = /(?:minus )?\d+\.\d\d(?!\d)/g;
const said = [...readmeAlt.matchAll(NUMBER)].map((m) => m[0]);
const shown = rows.map((r) => spoken(r.value));
check("the alt text gives every value in the chart, in the chart's order", said.join(' / ') === shown.join(' / '),
    `alt: ${said.join(', ')}; chart: ${shown.join(', ')}`);
const values = new Set(rows.map((r) => fmt(Math.abs(r.value))));
const sectionAt = readme.indexOf('\n## Why not a chatbot');
const sectionEnd = readme.indexOf('\n## ', sectionAt + 1);
const prose = sectionAt < 0 ? '' : readme.slice(sectionAt, sectionEnd < 0 ? undefined : sectionEnd).replace(/<picture>[\s\S]*?<\/picture>/g, '');
check('the README has its "Why not a chatbot" section', prose !== '');
const UNSIGNED = /\d+\.\d\d(?!\d)/g;
const strays = [...readmeAlt.matchAll(UNSIGNED), ...prose.matchAll(UNSIGNED)].map((m) => m[0]).filter((n) => !values.has(n));
check('every two-decimal number beside the chart is a value in the data', strays.length === 0, `not in the data: ${strays.join(', ')}`);

// `tools/run-gates.mjs` reads the assertion count out of this line.
console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
