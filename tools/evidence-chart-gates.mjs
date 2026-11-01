// tools/evidence-chart-gates.mjs — the evidence chart says what its sources say.
//
// docs/WHY_IT_WORKS.md and the README show effect sizes from published studies.
// The numbers live once, in docs/evidence/effect-sizes.json, each beside its
// citation, its link and the sentence it was read from; the SVGs and the doc's
// table are generated from that file by tools/evidence-chart.mjs: a wide and a
// medium one that colour themselves, and a narrow one per theme for a phone.
// What can go wrong, and what this suite catches:
//
//   * a number corrected in the data while a drawing or the table still shows
//     the old one (the generated files are compared with a fresh render);
//   * a bar with no source, a source with no link, or a value with no quoted
//     sentence behind it;
//   * a bar or its interval outside the axis, which draws off the image, and an
//     interval in the data that a drawing leaves out;
//   * any text past the image's edge, into other text or onto a bar, in any
//     layout, set 15% wider than the estimate, since the viewer's system font
//     decides the real width;
//   * a window width, from a 360px phone to a 2560px screen, at which the
//     README or the doc shows the chart with labels under 13px, any text under
//     12px, or filling less than 70% of GitHub's column there (the queries read
//     are the ones in the files; the column model is pinned here to what was
//     measured on GitHub);
//   * a group without the scale under it, and a wrapped paragraph that ends on
//     one word or a stub of a line;
//   * text, bars, the zero line, or an interval line over its bar too faint on
//     GitHub's light, dark or dimmed page;
//   * the README or the doc dropping a layout or a theme from its <picture>, or
//     keying one source on width AND theme: GitHub's page script rewrites such
//     a query to the theme alone for a reader with a fixed theme;
//   * the wide or medium chart losing the dark colours it picks itself, or the
//     cards (white, GitHub dark) that keep each palette readable in WebKit,
//     which picks by the OS instead;
//   * a number typed by hand beside the chart (the two alt texts, the README
//     paragraph) that is no longer a number in the data.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    loadData, lf, THEMES, CHARTS, LAYOUTS, LIGHT_CARD, DARK_CARD, fmt, svgPath, DOC_PATH, layout, WIDER_FONT,
    renderSvg, renderTable, docWithTable, PAGES, pictureMedia, withPictureMedia, columnAt, WINDOWS, wrap, textWidth,
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
    // A space or `<` `>` cannot stand in a bare link target; percent-encode them in the data.
    check(`${r.id}: cites a paper with an https link`, typeof s.cite === 'string' && s.cite.trim() !== '' && /^https:\/\/[^\s<>]+$/.test(s.url || ''),
        `${JSON.stringify(s.cite)} ${JSON.stringify(s.url)}`);
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
const GAP = 8;
const meet = (a, b, gap) => a.top < b.bottom && b.top < a.bottom && a.left < b.right + gap && b.left < a.right + gap;
for (const name of Object.keys(LAYOUTS)) {
    const { W, texts, markBoxes, plot } = layout(data, name);
    const outside = texts.filter((t) => t.left < 0 || t.right > W).map((t) => `"${t.s}" ${t.left.toFixed(0)}..${t.right.toFixed(0)}`);
    check(`${name}: every text fits inside the ${W}px image in a 15% wider font`, outside.length === 0, outside.join('; '));
    const overlaps = [];
    for (const [i, a] of texts.entries()) {
        for (const b of texts.slice(i + 1)) if (meet(a, b, GAP)) overlaps.push(`"${a.s}" / "${b.s}"`);
    }
    check(`${name}: no two texts closer than ${GAP}px in a 15% wider font`, overlaps.length === 0, overlaps.join('; '));
    const onMarks = texts.flatMap((t) => markBoxes.filter((m) => meet(t, m, 4)).map((m) => `"${t.s}" on ${m.id}`));
    check(`${name}: no text on a bar, an interval line or a phone chart's zero line`, onMarks.length === 0, onMarks.join('; '));
    const offPlot = markBoxes.filter((m) => m.left < plot.left || m.right > plot.right).map((m) => m.id);
    check(`${name}: every bar and interval inside its plot`, offPlot.length === 0, offPlot.join(', '));
}

// --- the scale beside every group, and paragraphs without a stub line --------
// On a phone the chart runs past a screen: a scale only under the last group
// leaves the first one without it. A paragraph wrapped so its last line is one
// word, or under a third of the width, reads as left over ("rank them."),
// unless the line above holds four words or fewer and has none to give
// ("Sources and limits:" over a path).
for (const name of Object.keys(LAYOUTS)) {
    const { W, size: S } = LAYOUTS[name];
    const { axes } = layout(data, name);
    check(`${name}: tick labels, 0 among them, under each of the ${data.groups.length} groups`,
        axes.length === data.groups.length && axes.every((a) => a.length >= 2 && a.includes('0')), JSON.stringify(axes));
    const paragraphs = [[data.title.join(' '), S.title, true], ...data.subtitle.map((p) => [p, S.sub, false]), ...data.note.map((p) => [p, S.small, false])];
    const stubs = [];
    for (const [p, px, bold] of paragraphs) {
        const ls = wrap(p, px, W, bold);
        const last = ls[ls.length - 1];
        const stub = !last.includes(' ') || textWidth(last, px, bold) * WIDER_FONT < W / 3;
        if (ls.length > 1 && stub && ls[ls.length - 2].split(' ').length > 4) stubs.push(last);
    }
    check(`${name}: no wrapped paragraph ends on one word or under a third of the width`, stubs.length === 0, stubs.map((s) => `"${s}"`).join('; '));
}
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
// Light: github.com's page, and the card under the wide and medium charts' light
// colours. Dark: the default dark theme (and the card under their dark colours)
// and the dimmed one.
const BACKGROUNDS = { light: [...new Set(['#ffffff', LIGHT_CARD])], dark: [...new Set(['#0d1117', DARK_CARD, '#212830'])] };
for (const [theme, c] of Object.entries(THEMES)) {
    for (const page of BACKGROUNDS[theme]) {
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
// Each interval path names its row, and only interval paths carry the `ci`
// class: one per row that has an interval, none for a row without.
const withCi = rows.filter((r) => Array.isArray(r.ci));
for (const chart of CHARTS) {
    const svg = renderSvg(data, chart);
    const wrong = withCi.map((r) => [r.id, svg.split(`data-row="${r.id}" `).length - 1]).filter(([, n]) => n !== 1);
    const total = svg.split('class="ci"').length - 1;
    check(`${chart.file} draws exactly one interval line for each row that has one`, wrong.length === 0 && total === withCi.length,
        `${wrong.map(([id, n]) => `${id}: ${n}`).join(', ')}; ${total} lines for ${withCi.length} intervals`);
}

// --- each drawing wears the colours of the page it is shown on ---------------
// A phone file holds one theme's colours. The wide and medium files hold both and pick
// with `prefers-color-scheme`, which follows GitHub's theme in Chromium and
// Firefox and the OS in WebKit; each palette sits on a card of its own page
// (white, GitHub dark), so a WebKit reader whose GitHub theme differs from the
// OS still reads it: light ink on white would otherwise be 1.1:1.
const styleOf = (svg) => (svg.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || '';
const hasPalette = (css, c) => Object.values(c).every((hex) => css.includes(hex));
for (const chart of CHARTS) {
    const css = styleOf(renderSvg(data, chart));
    if (chart.theme === 'auto') {
        const [base, dark = ''] = css.split('@media (prefers-color-scheme: dark)');
        check(`${chart.file} carries the light colours outside and the dark ones inside a dark-scheme block`,
            hasPalette(base, THEMES.light) && hasPalette(dark, THEMES.dark));
        check(`${chart.file} paints its light colours on a card the colour of GitHub's light page, and its dark ones on GitHub dark's`,
            base.includes(`.card{fill:${LIGHT_CARD}}`) && LIGHT_CARD.toLowerCase() === '#ffffff'
            && dark.includes(`.card{fill:${DARK_CARD}}`) && DARK_CARD.toLowerCase() === '#0d1117'
            && renderSvg(data, chart).includes('<rect class="card"'));
    } else {
        check(`${chart.file} holds the ${chart.theme} colours and no card`,
            hasPalette(css, THEMES[chart.theme]) && !css.includes('@media') && !renderSvg(data, chart).includes('class="card"'));
    }
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
    source: { cite: 'Name [2020] | x', url: 'https://example.org/a_(b)|c' },
};
const awkwardLines = renderTable({ groups: [{ label: 'a | group', rows: [awkwardRow] }] }).split('\n')
    .filter((l) => l.startsWith('| ') && !l.startsWith('| ---') && !l.startsWith('| Result'));
const wanted = [
    ['**a | group**', '', '', '', '', '', ''],
    ['a|b', '0.10 SD', 'not extracted', 'x[1]', 'y]', 'a\\|b, ends in \\', '[Name [2020] | x](https://example.org/a_\\(b\\)|c)'],
];
const got = awkwardLines.map(cellsOf);
check('table cells holding | [ ] or \\ read back as typed', JSON.stringify(got) === JSON.stringify(wanted), JSON.stringify(got));
// The link target: no bare parenthesis left to end the link, and the escapes undo to the URL in the data.
const target = ((got[1] || [])[6] || '').match(/\]\((.*)\)$/)?.[1] || '';
check('a source URL holding ( ) or | stays one link to that URL',
    !/(^|[^\\])[()]/.test(target) && target.replace(/\\(.)/g, '$1') === awkwardRow.source.url, target);

// --- the generated files match the data ------------------------------------
// The SVGs are compared even when the doc's markers are broken, so one fault
// does not hide another.
const outputs = CHARTS.map((c) => [svgPath(c.file), renderSvg(data, c)]);
let doc = null;
try {
    doc = docWithTable(readFileSync(DOC_PATH, 'utf8'), data);
    check('the doc has its evidence-table markers once each', true);
} catch (e) {
    check('the doc has its evidence-table markers once each', false, e.message);
}
// Each page's width queries are written by the generator too.
for (const [page, { path }] of Object.entries(PAGES)) {
    const text = page === 'doc' ? doc : readFileSync(path, 'utf8');
    if (text === null) continue;
    try {
        outputs.push([path, withPictureMedia(text, page)]);
        check(`${page}: one wide and one medium <source> for the generator to set`, true);
    } catch (e) {
        check(`${page}: one wide and one medium <source> for the generator to set`, false, e.message);
    }
}
for (const [path, content] of outputs) {
    const rel = path.slice(repoRoot.length + 1).replace(/\\/g, '/');
    const current = existsSync(path) ? lf(readFileSync(path, 'utf8')) : null;
    check(`${rel} matches the data (node tools/evidence-chart.mjs)`, current === content, current === null ? 'missing' : 'stale');
}

// --- every layout and both themes wherever the chart is shown ----------------
// GitHub's `themed-picture` script, for a reader who chose a fixed theme, sets
// the media of every <source> naming prefers-color-scheme to "always" or
// "never" by theme, so a query on width and theme together loses its width.
// The wide and medium sources are therefore keyed on width only (they colour
// themselves) and come first; the phone's dark source next; the phone's light
// image last.
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
for (const page of Object.keys(PAGES)) {
    let media = {};
    let bad = [];
    try {
        media = pictureMedia(page);
        bad = Object.entries(media).filter(([, q]) => !/width/.test(q) || /prefers-color-scheme/.test(q)).map(([n, q]) => `${n}: "${q}"`);
    } catch (e) {
        bad = [e.message];
    }
    check(`${page}: the wide and the medium query are each on width alone`, Object.keys(media).length === 2 && bad.length === 0, bad.join('; '));
}
/**
 * The page's chart as a browser reads it: the tags of the <picture> holding
 * exactly the wide, medium and dark sources and then a described light image,
 * in that order, or null. A browser takes the first source that matches and
 * ignores a <source> after the <img> or in another <picture>, so an extra
 * source anywhere in it could take over. A <picture> in an HTML comment is
 * never drawn.
 */
const chartPicture = (text, prefix) => {
    const p = escRe(prefix);
    const want = [
        new RegExp(`^<source media="[^"]+" srcset="${p}effect-sizes-wide\\.svg">$`),
        new RegExp(`^<source media="[^"]+" srcset="${p}effect-sizes-medium\\.svg">$`),
        new RegExp(`^<source media="\\(prefers-color-scheme: dark\\)" srcset="${p}effect-sizes-dark\\.svg">$`),
        new RegExp(`^<img src="${p}effect-sizes-light\\.svg" alt="[^"]{40,}">$`),
    ];
    for (const [pic] of text.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<picture>[\s\S]*?<\/picture>/g)) {
        // Quote-aware: a `>` inside an attribute (an alt text, `width >= 584px`) does not end the tag.
        const tags = [...pic.matchAll(/<(?:source|img)\b(?:[^>"]|"[^"]*")*>/g)].map(([t]) => t);
        if (tags.length === want.length && tags.every((t, i) => want[i].test(t))) return tags;
    }
    return null;
};

// --- the chart at every window width ----------------------------------------
// What a browser does with the page's own <picture>, at each whole window width:
// the first source whose media matches, else the <img>. GitHub then shows that
// file at its own width, or shrunk to the column (`max-width: 100%`), whose
// width at that window is the model in the generator. From a 360px phone (the
// narrowest in common use; at 320 the narrow chart's small text is 11px) up,
// the labels must be shown at 13px or more, every other text at 12px or more,
// and the chart must fill 70% of the column or more; a narrow chart must wear
// the reader's theme.
const LABEL_MIN = 13;
const TEXT_MIN = 12;
const FILL_MIN = 0.7;
// The model is the generator's, so it is held here to the column GitHub drew:
// measured in Edge on 2026-11-01, logged out, at these window widths (the
// content box of article.markdown-body, on the repository page and a file page).
const MEASURED = {
    readme: { 390: 324, 551: 453, 583: 485, 600: 502, 700: 602, 767: 669, 800: 438, 847: 485, 848: 486, 900: 538, 1000: 638, 1100: 658, 1200: 758, 1280: 838, 1440: 838, 1920: 838, 2560: 838 },
    doc: { 390: 324, 551: 485, 583: 517, 600: 534, 700: 634, 767: 701, 800: 702, 847: 749, 848: 750, 900: 802, 1000: 902, 1100: 681, 1200: 781, 1280: 861, 1440: 1012, 1920: 1012, 2560: 1012 },
};
for (const [page, points] of Object.entries(MEASURED)) {
    const off = Object.entries(points).filter(([vw, col]) => columnAt(page, Number(vw)) !== col).map(([vw, col]) => `${vw}px: model ${columnAt(page, Number(vw))}, measured ${col}`);
    check(`${page}: the column model gives the ${Object.keys(points).length} widths measured on GitHub`, off.length === 0, off.join('; '));
}
check('the width queries are worked out from a 360px window or less to 2560px or more', WINDOWS.from <= 360 && WINDOWS.to >= 2560, JSON.stringify(WINDOWS));
const matches = (media, vw, dark) => media.split(',').some((q) => q.trim().split(/\s+and\s+/).every((c) => {
    const m = c.match(/^\((min-width|max-width|prefers-color-scheme):\s*(\d+(?:\.\d+)?px|dark|light)\)$/);
    if (!m) throw new Error(`a media condition this gate cannot read: "${c}"`);
    if (m[1] === 'prefers-color-scheme') return (m[2] === 'dark') === dark;
    return m[1] === 'min-width' ? vw >= parseFloat(m[2]) : vw <= parseFloat(m[2]);
}));
const chartOf = Object.fromEntries(CHARTS.map((c) => [c.file, c]));
for (const [page, { path, prefix }] of Object.entries(PAGES)) {
    const tags = chartPicture(lf(readFileSync(path, 'utf8')), prefix);
    check(`${page}: the chart's <picture> holds the wide, medium and dark sources, then a described light image, and nothing else`, tags !== null);
    if (!tags) continue;
    const sources = tags.map((t) => ({ media: (t.match(/ media="([^"]*)"/) || [])[1] ?? null, file: t.match(/(?:srcset|src)="(?:[^"]*\/)?([^"/]+)"/)[1] }));
    const mixed = sources.slice(0, 2).filter((s) => /prefers-color-scheme/.test(s.media));
    check(`${page}: no width source names the colour scheme`, mixed.length === 0, mixed.map((s) => s.media).join('; '));
    const bad = [];
    try {
        for (let vw = 360; vw <= WINDOWS.to; vw++) {
            for (const dark of [false, true]) {
                const chart = chartOf[sources.find((s) => s.media === null || matches(s.media, vw, dark)).file];
                const { W, size } = LAYOUTS[chart.layout];
                const col = columnAt(page, vw);
                const label = (size.label * Math.min(W, col)) / W;
                const smallest = (Math.min(...Object.values(size)) * Math.min(W, col)) / W;
                const fill = Math.min(W, col) / col;
                const theme = chart.theme === 'auto' || chart.theme === (dark ? 'dark' : 'light');
                if (label < LABEL_MIN || smallest < TEXT_MIN || fill < FILL_MIN || !theme) {
                    bad.push(`${vw}px ${dark ? 'dark' : 'light'}: ${chart.file}, labels ${label.toFixed(1)}px, smallest text ${smallest.toFixed(1)}px, ${Math.round(fill * 100)}% of ${col}px`);
                }
            }
        }
    } catch (e) {
        bad.push(e.message);
    }
    check(`${page}: from a 360px to a ${WINDOWS.to}px window the chart's labels are ${LABEL_MIN}px or more, all its text ${TEXT_MIN}px, and it fills ${FILL_MIN * 100}% of the column`,
        bad.length === 0, `${bad.length} widths, e.g. ${bad.slice(0, 3).join('; ')}`);
}
// The link must sit in the chart's own section (from the <picture> to the next heading): the
// README's documentation list links the doc too, and would hide a section that lost its link.
const readme = lf(readFileSync(join(repoRoot, 'README.md'), 'utf8'));
const chartAt = readme.indexOf('effect-sizes-light.svg');
const nextHeading = chartAt < 0 ? -1 : readme.indexOf('\n#', chartAt);
const chartSection = chartAt < 0 ? '' : readme.slice(chartAt, nextHeading < 0 ? undefined : nextHeading);
check('README links to the doc beside the chart', /\]\(docs\/WHY_IT_WORKS\.md\)/.test(chartSection));
for (const chart of CHARTS) check(`${chart.file} exists`, existsSync(svgPath(chart.file)));

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
