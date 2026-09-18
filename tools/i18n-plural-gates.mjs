#!/usr/bin/env node
/**
 * How a COUNT reaches the reader, in every language the app offers.
 *
 * The faults this exists for, in one rendered sentence:
 *
 *     2 287 темаs из проекта «18»s, сгруппировано в 117 регионs по смыслу.
 *
 * Three faults in one sentence, none of which any existing gate could see:
 * a bare Latin "s" appended in JSX to a Russian word; a count rendered as if it
 * were a project's NAME, because the key is worded in the singular and a
 * translator reads `{{projects}}` as one; and, underneath both, English
 * loading no resources at all, so a count-based key could never fire its
 * `_one` form and the codebase could make up the difference only by appending
 * the JSX "s".
 *
 * `i18n-gates.mjs` checks that the FILES agree. This one checks what a reader
 * would actually see, which is a different question:
 *
 *  1. the source appends no plural letter beside a `t(…)` call;
 *  2. `src/i18n/enPlurals.ts` still matches en.json (English's only resources);
 *  3. every locale carries every plural CATEGORY its language selects — a
 *     missing `_few` is not a missing translation, it is a key rendered raw;
 *  4. the form a reader reaches for "3" is not the form they reach for "1",
 *     in the languages that distinguish them. French had this back to front in
 *     14 keys: the plural wording sat in `_many`, which French reaches only for
 *     a few compact large-number formats, and `_other` — everything from 2 up —
 *     held the singular. "3 carte", "7 jour", in the shipped file;
 *  5. a real i18next, initialised exactly as the app initialises it, renders a
 *     sample of keys at 1, 3 and 5 in every language with no placeholder left
 *     behind and no empty string.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import i18next from 'i18next';
import { buildEnPlurals } from './i18n-en-plurals.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const srcDir = join(root, 'src');
const localesDir = join(srcDir, 'locales');

let passed = 0; let failed = 0;
const ok = (name) => { passed++; process.stdout.write(`  ok   ${name}\n`); };
const bad = (name, detail) => {
    failed++;
    process.stdout.write(` FAIL  ${name}\n`);
    for (const line of [].concat(detail).slice(0, 8)) process.stdout.write(`         ${line}\n`);
};
const assert = (cond, name, detail) => (cond ? ok(name) : bad(name, detail));

const SUF = /_(zero|one|two|few|many|other)$/;
const en = JSON.parse(readFileSync(join(localesDir, 'en.json'), 'utf8'));
const locales = readdirSync(localesDir)
    .filter((f) => f.endsWith('.json') && f !== 'en.json')
    .map((f) => f.slice(0, -5));

// --- 1. the source appends nothing to a translated string -------------------------------
process.stdout.write('\n--- the source ---\n');
const files = [];
(function walk(d) {
    for (const e of readdirSync(d)) {
        const p = join(d, e);
        if (statSync(p).isDirectory()) { if (e !== 'locales') walk(p); }
        else if (/\.tsx?$/.test(e) && !/\.d\.ts$/.test(e)) files.push(p);
    }
})(srcDir);

// `{n === 1 ? '' : 's'}` and its spellings, and `${…}card${…}` in a template.
const SUFFIX_IDIOMS = [
    /[?:]\s*'s'\s*[:}]/,
    /[?:]\s*"s"\s*[:}]/,
    /\?\s*'(s|es|zes)'\s*:\s*''/,
    /\?\s*''\s*:\s*'(s|es|zes)'/,
    /\$\{[^}]*\}\s*(?:card|day|item|char|topic|result|review|flashcard|question|region|section|deck|link|page|answer)s?\$\{[^}]*\?\s*''\s*:\s*'s'/,
];
const offenders = [];
for (const f of files) {
    const text = readFileSync(f, 'utf8');
    text.split(/\r?\n/).forEach((line, i) => {
        if (SUFFIX_IDIOMS.some((re) => re.test(line))) {
            offenders.push(`${relative(root, f)}:${i + 1}  ${line.trim().slice(0, 110)}`);
        }
    });
}
assert(
    offenders.length === 0,
    'no surface builds a plural by appending a letter — that letter reaches every language',
    offenders,
);

// --- 2. English's own plural resources --------------------------------------------------
// Compared with line endings normalised, because this is a check on CONTENT and
// `.gitattributes` is `* text=auto`: a clone on Windows checks the file out with
// CRLF while the generator emits LF (157 CR bytes measured on a Windows
// checkout, 2026-09-17), so a byte comparison fails on a file that is perfectly
// correct. Normalising here, and CI carrying a windows-latest leg, keeps a
// correct file green on every contributor's machine.
const lf = (s) => (s === null ? null : s.replace(/\r\n/g, '\n'));
const generated = lf(buildEnPlurals(en));
const onDisk = lf((() => { try { return readFileSync(join(srcDir, 'i18n', 'enPlurals.ts'), 'utf8'); } catch { return null; } })());
assert(
    onDisk === generated,
    'src/i18n/enPlurals.ts matches en.json (run: node tools/i18n-en-plurals.mjs)',
    onDisk === null ? ['the file is missing'] : ['it is out of date'],
);
const enPluralKeys = Object.keys(en).filter((k) => SUF.test(k));
assert(
    enPluralKeys.length > 0 && enPluralKeys.every((k) => k in JSON.parse(`{${(generated.match(/^ {4}".*",$/gm) || []).map((l) => l.trim().replace(/,$/, '')).join(',')}}`)),
    `English ships every plural form it has — ${enPluralKeys.length} entries`,
);

// --- 3 & 4. every locale's plural shape -------------------------------------------------
process.stdout.write('\n--- plural forms per locale ---\n');

/** Bases whose singular and plural are genuinely the same words in that language.
 *  The list is per language, read against that language's own grammar, never global. */
const SAME_BY_DESIGN = {
    // German: "Quiz" and "Zeichen" do not change in the plural (Duden: das Quiz, die Quiz).
    de: ['{{count}} of them.', '{{name}} —', '{{value}} chars', 'Show them now anyway',
        '{{count}} quizzes in this project', 'quizzes'],
    es: ['{{count}} of them.', '{{name}} —'],
    fr: ['{{count}} of them.', '{{name}} —', '{{count}} quizzes in this project', 'quizzes'],
    it: ['{{count}} of them.', '{{name}} —', '{{count}} AI tasks', 'Attaching', '{{count}} quizzes in this project', 'quizzes'],
    nl: ['{{count}} of them.', '{{name}} —', '{{count}} occurrences', 'Show them now anyway'],
    pl: ['{{count}} of them.', '{{name}} —', '{{count}} quick questions', 'from {{count}} decks', 'Show them now anyway', 'and keep their'],
    pt: ['{{count}} of them.', '{{name}} —', '{{count}} quick questions', 'Show them now anyway'],
    ru: ['{{count}} of them.', '{{name}} —', 'Show them now anyway', 'and keep their'],
    // Ukrainian neuters in -ання (завдання, читання, посилання, питання) are the same
    // word after 1 and after 3, so a flat pair there is the language, not a lapse.
    uk: ['{{count}} of them.', '{{name}} —', '{{count}} AI tasks', '{{count}} links resolved',
        '{{count}} links found', '{{label}}: {{count}} links found', 'Show them now anyway',
        'and keep their', '{{count}} questions answered.', 'Added {{added}} readings', 'Describe {{pending}} pictures',
        'Plus {{ghostCorrect}}', 'reviews due in the next', 'Added {{count}} readings', 'Show {{count}} more AI tasks'],
    // English: neither sentence ties a noun to the count — "1 of them" is as
    // right as "5 of them", and the other reads its numbers out of two
    // placeholders that are formatted before they get here.
    en: ['{{count}} of them.', '{{name}} —'],
};

// English's own singular is written by hand, so it gets the same check as every
// locale: a hand-written `_one` is exactly where "1 sections" appears.
for (const loc of [...locales, 'en']) {
    const d = JSON.parse(readFileSync(join(localesDir, `${loc}.json`), 'utf8'));
    const rules = new Intl.PluralRules(loc);
    const cats = rules.resolvedOptions().pluralCategories;
    const bases = [...new Set(Object.keys(d).filter((k) => SUF.test(k)).map((k) => k.replace(SUF, '')))];

    const missing = [];
    for (const b of bases) for (const c of cats) if (d[`${b}_${c}`] === undefined) missing.push(`${b}_${c}`);
    assert(missing.length === 0, `${loc}: every plural key carries all of [${cats.join(', ')}]`, missing);

    if (cats.length > 1) {
        const exempt = SAME_BY_DESIGN[loc] || [];
        const flat = bases.filter((b) => {
            if (exempt.some((p) => b.startsWith(p))) return false;
            const one = d[`${b}_${rules.select(1)}`];
            return one !== undefined && one === d[`${b}_${rules.select(3)}`];
        });
        assert(
            flat.length === 0,
            `${loc}: what a reader sees for 3 is not what they see for 1`,
            flat.map((b) => `${b} → "${d[`${b}_${rules.select(3)}`]}"`),
        );
    }
}

// --- 5. rendered, through a real i18next ------------------------------------------------
process.stdout.write('\n--- rendered ---\n');
const SAMPLE = [
    ['{{count}} topics', { count: 0 }],
    ['{{count}} cards', { count: 0 }],
    ['{{count}} days', { count: 0 }],
    ['{{totalResults}} results', { count: 0, totalResults: 0 }],
    ['{{fmt}} cards', { count: 0, fmt: '0' }],
    ['quizzes', { count: 0 }],
];

const inst = i18next.createInstance();
await inst.init({
    lng: 'en',
    fallbackLng: 'en',
    keySeparator: false,
    nsSeparator: false,
    returnEmptyString: false,
    interpolation: { escapeValue: false },
    resources: { en: { translation: Object.fromEntries(Object.entries(en).filter(([k]) => SUF.test(k))) } },
    initAsync: false,
});
for (const loc of locales) {
    inst.addResourceBundle(loc, 'translation', JSON.parse(readFileSync(join(localesDir, `${loc}.json`), 'utf8')), true, true);
}

for (const loc of ['en', ...locales]) {
    await inst.changeLanguage(loc);
    const faults = [];
    const shown = [];
    for (const [key, params] of SAMPLE) {
        if (!(`${key}_other` in en)) continue;
        for (const n of [1, 3, 5]) {
            const out = inst.t(key, { ...params, count: n, totalResults: n, fmt: String(n) });
            if (!out || /\{\{|_(one|few|many|other)$/.test(out)) faults.push(`${loc} ${key} n=${n} → ${JSON.stringify(out)}`);
            if (key === '{{count}} topics') shown.push(out);
        }
    }
    assert(faults.length === 0, `${loc}: every sampled count renders — ${shown.join(' · ')}`, faults);
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
