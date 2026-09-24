#!/usr/bin/env node
/**
 * settings-vocabulary-gates.mjs — what a SETTING looks like, as a rule.
 *
 * `control-gates.mjs` settled what a CONTROL looks like and the page obeys it.
 * What it cannot see is everything AROUND the control, and that is where the
 * page came apart. Counted on 2026-09-22 from phone screenshots of the app:
 *
 *   * 41 labels in `text-transform: uppercase`, including topic names and a
 *     project's own words. In Russian, capitals strip the ascenders and
 *     descenders that give a word its silhouette, so
 *     «ПОДТВЕРЖДЕНИЕ ТЕМЫ» is a grey brick. It is also, in 2026, the single
 *     loudest tell of machine-written interface copy.
 *   * SEVEN different disclosures, four of them hand-written copies of each
 *     other with one detail different apiece (a tint, a border, a missing
 *     webkit marker reset, the chevron on the other side).
 *   * fourteen of those disclosures called "More", which names nothing: two of
 *     them sat 150px apart on the Search links tab, one inside the other's
 *     section, and the sentence behind each was four lines long.
 *
 * Each rule below is re-run against the exact pre-fix shape it was written for
 * (PRE_FIX at the bottom). A rule that does not fire on the code that caused it
 * is not a rule, it is a comment — and the rules here are cheap string checks,
 * which is exactly the kind that silently stops matching after a refactor.
 *
 *   node tools/settings-vocabulary-gates.mjs
 *   node tools/settings-vocabulary-gates.mjs --json
 */
import { readFileSync, globSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const rel = (abs) => path.relative(ROOT, abs).replace(/\\/g, '/');

/** Every surface held to the setting vocabulary. */
const SETTINGS_SCOPE = [
    'src/components/Settings.tsx',
    'src/components/settings/*.tsx',
    'src/components/SearchProvidersPanel.tsx',
    'src/components/SecuritySettings.tsx',
    'src/components/ui/SettingRow.tsx',
];

/** The whole interface, for the casing rule — a shouted label is shouted
 *  wherever it is drawn, and the worst of them were on feed cards. */
const UI_SCOPE = ['src/**/*.tsx', 'src/**/*.ts'];

const files = (globs) => globs
    .flatMap((g) => globSync(g, { cwd: ROOT }))
    .map((f) => rel(path.join(ROOT, f)))
    .filter((f, i, all) => all.indexOf(f) === i)
    .sort();

const findings = [];
let checked = 0;
const fail = (rule, file, line, detail, fix) => findings.push({ rule, file, line, detail, fix });
const lineOf = (src, index) => src.slice(0, index).split('\n').length;

/** Comments, blanked character for character so line numbers do not move. */
const blindComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
    .replace(/^[ \t]*\/\/.*$/gm, (c) => ' '.repeat(c.length));

/** Lines that are only talking ABOUT the rule. */
const isComment = (line) => /^\s*(\*|\/\/|\/\*)/.test(line);

/* ── 1. nothing shouts ──────────────────────────────────────────────────── */
//
// The class, not the rendered text: a translated string is capitalised by the
// language, and `text-transform` is the app overruling it.
function noShouting(src, file) {
    src.split('\n').forEach((line, i) => {
        if (isComment(line)) return;
        if (/\buppercase\b/.test(line)) {
            fail('caps', file, i + 1, 'text-transform: uppercase',
                'sentence case — see GROUP_CAPTION in ui/SettingRow.tsx');
        }
        // The same thing done in JS, which no class scan would ever see. A file
        // extension or a currency code is not prose and is allowed by name.
        const up = /(\w[\w.]*)\.toUpperCase\(\)/.exec(line);
        if (up && !/file_type|extension|\bext\b|charAt|hex|code/i.test(line)) {
            fail('caps', file, i + 1, `${up[1]}.toUpperCase() on displayed text`,
                'draw the string as it was written');
        }
    });
}

/* ── 1b. and taking the shouting out left no stumps ─────────────────────── */
//
// The pass that removed `uppercase tracking-wider` did it by pattern and cut
// through the neighbouring class: `font-semibold uppercase tracking-wider`
// became `font-semiboldr`, `text-xs uppercase tracking-wider` became
// `text-xsr`, and `text-[10px] uppercase tracking-widest` became
// `text-[11px]st` — seventeen labels that silently lost their weight or their
// size, because Tailwind drops a class it does not know without a word and tsc
// cannot see inside a string. A size or weight fused to trailing letters is
// never a real class.
const FUSED_TYPE = /(?:^|[\s"'`:{])((?:text-(?:xs|sm|base|lg|[2-9]?xl|\[[\d.]+(?:px|rem|em)\])|font-(?:thin|extralight|light|normal|medium|semibold|bold|extrabold|black))[a-z]+)(?![\w-])/g;
// Only on a line that is building classes, so prose ("any text-based file")
// is not read as one.
const CLASS_LINE = /(?:^|[\s"'`])(?:bg|border|rounded|flex|grid|gap|items|justify|[pm][xytblr]?|[wh]|text-(?:slate|gray|accent|red|amber|white))-/;
function noClassStumps(src, file) {
    src.split('\n').forEach((line, i) => {
        if (isComment(line) || !CLASS_LINE.test(line)) return;
        for (const m of line.matchAll(FUSED_TYPE)) {
            fail('stump', file, i + 1, `\`${m[1]}\` is not a class — a size or weight with letters fused on`,
                'restore the class it was cut from (font-semibold, text-xs, …)');
        }
    });
}

/* ── 2. one disclosure vocabulary ───────────────────────────────────────── */
//
// A `<details>` in the settings scope means someone has hand-written an eighth
// shape. `Explain` is prose behind a name, `ExpandableSection` is controls
// behind a name, and there is deliberately no third.
function oneDisclosure(raw, file) {
    // Blind the comments: the note left where each hand-written copy was
    // removed names the tag it replaced, and so does this file's own
    // explanation of the rule. Blanking them keeps every line number intact.
    const src = blindComments(raw);
    for (const m of src.matchAll(/<details\b/g)) {
        fail('shape', file, lineOf(src, m.index), 'hand-written <details>',
            'use <Explain> (prose) or <ExpandableSection> (controls) from ui/Disclosure');
    }
    for (const m of src.matchAll(/<summary\b/g)) {
        fail('shape', file, lineOf(src, m.index), 'hand-written <summary>',
            'use <Explain> or <ExpandableSection> from ui/Disclosure');
    }
}

/* ── 3. no disclosure is called "More" ──────────────────────────────────── */
//
// A door with no sign on it. The rule is enforced on the KEY rather than on the
// component, because the next unnamed one will be spelt "Details" or "Show" —
// so it also fails a summary that is one of the generic words.
const EMPTY_NAMES = /^(more|details?|show|info|learn more|read more)$/i;
function namedDisclosures(src, file) {
    for (const m of src.matchAll(/<Explain\b[\s\S]{0,200}?summary=\{(?:tr|t|k)\("([^"]*)"\)\}/g)) {
        if (EMPTY_NAMES.test(m[1].trim())) {
            fail('unnamed', file, lineOf(src, m.index), `summary is "${m[1]}"`,
                'name what is inside it — "Where your data goes", not "More"');
        }
    }
}

/* ── 4. the control is on the right, on one line ────────────────────────── */
//
// A switch that wraps onto its own line lands at the LEFT edge — the one corner
// of a phone a thumb cannot reach, which is why every phone OS puts a switch on
// the right. This checks the one row every setting is built from.
function rowNeverWraps(src, file) {
    if (!file.endsWith('ui/SettingRow.tsx')) return;
    // The row itself: a flex line whose first child is the name column.
    const row = /<div [^>]*className=\{`flex[^`]*`\}>\s*\n\s*<div className="min-w-0 flex-1">/.exec(src);
    if (!row) {
        fail('row', file, 1, 'the setting row is no longer a flex line with a `min-w-0 flex-1` name column',
            'name left, control right — see the comment above it');
        return;
    }
    if (/flex-wrap/.test(row[0])) {
        fail('row', file, lineOf(src, row.index), 'the setting row wraps',
            'a wrapped control lands at the LEFT edge; let the name wrap, or stack deliberately');
    }
    // The only other place a control may go is UNDER the whole name, which is
    // what `block` and the measured stack share. If that branch disappears, a
    // three-line name beside a wide control is back.
    if (!/\{under && control/.test(src)) {
        fail('row', file, lineOf(src, row.index), 'there is no stacked branch for a control that cannot fit',
            'a control that cannot sit beside its name goes UNDER it, never half-way');
    }
}

/* ── run ────────────────────────────────────────────────────────────────── */
for (const file of files(UI_SCOPE)) {
    checked++;
    const src = read(file);
    noShouting(src, file);
    noClassStumps(src, file);
}
for (const file of files(SETTINGS_SCOPE)) {
    const src = read(file);
    checked++;
    oneDisclosure(src, file);
    namedDisclosures(src, file);
    rowNeverWraps(src, file);
}

/* ── the rules are re-run against the shapes that caused them ───────────── */
//
// Every one of these is a verbatim line from the tree before this pass.
const PRE_FIX = [
    {
        why: 'the group caption that started it',
        run: noShouting,
        src: '            <h2 className="mb-2 px-1 text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">',
    },
    {
        why: 'a topic name shouted on a feed card',
        run: noShouting,
        src: '                        <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500 truncate">',
    },
    {
        why: 'the poster, which does it in JS where no class scan would see it',
        run: noShouting,
        src: '    centred(ctx, content.eyebrow.toUpperCase(), layout.width / 2, layout.eyebrowY);',
    },
    {
        why: 'the weight the caps removal cut into `font-semiboldr`',
        run: noClassStumps,
        src: '                                <h3 className="text-xs font-semiboldr text-slate-500 dark:text-slate-400">',
    },
    {
        why: 'the size it cut into `text-[11px]st`',
        run: noClassStumps,
        src: '        <span className={`text-[11px]st font-semibold px-2 py-1 rounded-md ${CHIP_TONE[tone]}`}>',
    },
    {
        why: 'the eighth disclosure shape, hand-written in the AI tab',
        run: oneDisclosure,
        src: '<details className="group rounded-lg border border-slate-200 bg-slate-50">\n<summary className="flex items-center gap-2 px-3 h-10">',
    },
    {
        why: 'the unnamed "More" this pass removed fourteen of',
        run: namedDisclosures,
        src: '<Explain summary={tr("More")}>x</Explain>',
    },
    {
        why: 'the wrapping row that put a switch under the reader’s left thumb',
        run: rowNeverWraps,
        file: 'src/components/ui/SettingRow.tsx',
        src: '            <div ref={row} className={`flex flex-wrap items-center justify-between gap-x-6`}>\n                <div className="min-w-0 flex-1">\n{under && control}',
    },
];

const blind = [];
for (const c of PRE_FIX) {
    const before = findings.length;
    c.run(c.src, c.file || 'PRE_FIX');
    const fired = findings.splice(before).length;
    if (!fired) blind.push(c.why);
}

const C = { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', c: '\x1b[36m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };
if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ checked, findings, blind }, null, 2));
} else {
    console.log(`\n${C.b}Setting vocabulary${C.x} ${C.d}(${checked} files scanned)${C.x}\n`);
    for (const why of blind) {
        console.log(`  ${C.y}blind${C.x} a rule no longer fires on ${why}`);
    }
    for (const f of findings) {
        console.log(`  ${C.r}${f.rule}${C.x} ${f.detail}`);
        console.log(`        ${C.d}${f.file}:${f.line}${C.x}`);
        console.log(`        ${C.d}→ ${f.fix}${C.x}`);
    }
    // run-gates.mjs reads this line: a suite that prints no count is a suite
    // that might be asserting nothing.
    const asserts = checked + PRE_FIX.length;
    if (!findings.length && !blind.length) {
        console.log(`  ${C.g}${asserts} passed, 0 failed${C.x} ${C.d}· nothing shouts, one disclosure shape, every disclosure named, the control on the right${C.x}`);
        console.log(`  ${C.d}· ${PRE_FIX.length} pre-fix shapes still caught${C.x}`);
    } else {
        console.log(`  ${asserts - findings.length - blind.length} passed, ${findings.length + blind.length} failed`);
    }
    console.log('');
}

process.exit(findings.length || blind.length ? 1 : 0);
