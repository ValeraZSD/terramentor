#!/usr/bin/env node
/**
 * Interface-language guards.
 *
 * The keys are the English text, so nothing can go wrong at RUNTIME — a
 * missing translation renders the sentence. What can go wrong is silent
 * drift: a reworded English string orphans its translations in every locale,
 * a translator drops a `{{placeholder}}`, a locale file carries a key the app
 * no longer uses, or `en.json` falls behind the source. Each of those is
 * invisible on screen and caught here.
 *
 *   node tools/i18n-gates.mjs            asserts + coverage table
 *
 * Coverage is REPORTED, never asserted: a new key lands in English first and
 * the locales catch up (tools/i18n-translate.mjs); failing the build on an
 * 99% Dutch would only teach people to stop adding keys.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectKeys, englishEntries, pluralCategories } from './lib/i18nKeys.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const srcDir = join(repoRoot, 'src');
const localesDir = join(srcDir, 'locales');

let pass = 0, fail = 0;
const check = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    ok ? pass++ : fail++;
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok ? '' : `  (got ${JSON.stringify(got).slice(0, 300)}, want ${JSON.stringify(want).slice(0, 120)})`}`);
};
const ok = (name, cond, detail = '') => check(name + (detail ? ` — ${detail}` : ''), !!cond, true);

const placeholders = (s) => [...String(s).matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]).sort();
const baseKey = (k) => k.replace(/_(zero|one|two|few|many|other)$/, '');

// --- the source list -------------------------------------------------------------
console.log('--- en.json against the source ---');
const used = collectKeys(srcDir);
ok('the source uses translation keys', used.size > 1000, `${used.size} distinct keys`);
const en = JSON.parse(readFileSync(join(localesDir, 'en.json'), 'utf8'));
const expected = {};
for (const [key, { plural }] of used) Object.assign(expected, englishEntries(key, plural));
const missingFromEn = Object.keys(expected).filter((k) => !(k in en));
check('every key in the source has an en.json entry (run tools/i18n-extract.mjs)', missingFromEn.slice(0, 5), []);
const staleInEn = Object.keys(en).filter((k) => !(k in expected));
check('en.json carries no key the source stopped using', staleInEn.slice(0, 5), []);
ok('en.json values keep their placeholders',
    Object.entries(en).every(([k, v]) => JSON.stringify(placeholders(baseKey(k))) === JSON.stringify(placeholders(v))));
const pluralKeys = [...used].filter(([, v]) => v.plural).map(([k]) => k);
ok('plural keys have both English forms', pluralKeys.every((k) => `${k}_one` in en && `${k}_other` in en), `${pluralKeys.length} plural keys`);
ok('no key is empty or whitespace', Object.keys(en).every((k) => k.trim().length > 0));
ok('no key still carries a raw HTML entity', Object.keys(en).every((k) => !/&[a-z]+;|&#\d+;/.test(k)));

// The locale list the app offers must match the files that exist.
const i18nSrc = readFileSync(join(srcDir, 'i18n', 'index.ts'), 'utf8');
const offered = [...i18nSrc.matchAll(/\{ code: '([a-z]{2,3})', name: '/g)].map((m) => m[1]);
const files = readdirSync(localesDir).filter((f) => f.endsWith('.json')).map((f) => basename(f, '.json'));
check('every offered language has a locale file', offered.filter((c) => c !== 'en' && !files.includes(c)), []);
check('every locale file is offered', files.filter((c) => !offered.includes(c)), []);

// --- each locale -------------------------------------------------------------------
console.log('\n--- locales ---');
const rows = [];
for (const code of files) {
    if (code === 'en') continue;
    const file = join(localesDir, `${code}.json`);
    let data;
    try { data = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { ok(`${code}.json parses`, false, e.message); continue; }
    const cats = pluralCategories(code);
    // A locale may carry any plural form its language has for a plural key.
    //
    // "A plural key" means what EN.JSON says it is, not only what the source
    // scan spotted. Those two disagree — a handful of keys carry `_one`/`_other`
    // in en.json while `used` does not mark them plural — and deriving the
    // allowed set from the scan alone reported a Russian `_few` as a key nobody
    // asked for. Russian has four categories and `i18n-translate` writes all of
    // them, so the gate was failing the tool for doing its job.
    const pluralBases = new Set(pluralKeys);
    for (const k of Object.keys(en)) {
        const m = /^(.*)_other$/.exec(k);
        if (m && `${m[1]}_one` in en) pluralBases.add(m[1]);
    }
    const allowed = new Set(Object.keys(en));
    for (const k of pluralBases) for (const c of cats) allowed.add(`${k}_${c}`);
    const unknown = Object.keys(data).filter((k) => !allowed.has(k));
    check(`${code}: no key outside the source list`, unknown.slice(0, 5), []);
    const badPh = Object.entries(data).filter(([k, v]) => JSON.stringify(placeholders(baseKey(k))) !== JSON.stringify(placeholders(v)));
    check(`${code}: every translation keeps its placeholders`, badPh.slice(0, 3).map(([k]) => k), []);
    const empty = Object.entries(data).filter(([, v]) => typeof v !== 'string' || !v.trim());
    check(`${code}: no empty translation`, empty.slice(0, 3).map(([k]) => k), []);
    // A translation identical to its key is untranslated (unless it is a name).
    const singular = Object.keys(en).filter((k) => !/_(one|other)$/.test(k));
    const translated = singular.filter((k) => k in data && data[k] !== k).length;
    const pluralDone = pluralKeys.filter((k) => cats.every((c) => `${k}_${c}` in data)).length;
    rows.push({ code, coverage: ((translated + pluralDone) / (singular.length + pluralKeys.length) * 100).toFixed(1), missing: singular.length - singular.filter((k) => k in data).length });
}
if (rows.length) {
    console.log('\ncoverage');
    for (const r of rows) console.log(`  ${r.code.padEnd(4)} ${String(r.coverage).padStart(5)}%   ${r.missing} keys missing`);
}

// --- the boot path ------------------------------------------------------------------
console.log('\n--- wiring ---');
ok('main.tsx waits for the language before the first render', /i18nReady\.then/.test(readFileSync(join(srcDir, 'main.tsx'), 'utf8')));
ok('the store applies ui_language from settings', /ui_language/.test(readFileSync(join(srcDir, 'store.ts'), 'utf8')));
ok('no hardcoded en-US date formatting remains in the client',
    !readdirAll(srcDir).some((f) => /'en-(US|GB)'/.test(readFileSync(f, 'utf8'))));
ok('the html lang attribute follows the language', /documentElement\.lang = /.test(i18nSrc));
// `import.meta.glob` is replaced at build time only where it is CALLED; a
// `typeof import.meta.glob` guard survives into the bundle and is false there,
// which shipped every locale as silently English once. Call it inside try/catch.
// Loosened from `/try \{\s*return import\.meta\.glob/`: the intent is "the call
// is made, and it is not hidden behind a typeof guard", and the old pattern also
// pinned the brace style and the fact that the call was the first statement in
// the try — a reformat failed it while the bundle was still correct.
ok('locale discovery calls import.meta.glob directly (no typeof guard)',
    !/typeof import\.meta\.glob/.test(i18nSrc) && /\btry\b[\s\S]{0,200}\breturn import\.meta\.glob\b/.test(i18nSrc));
ok('English needs no locale file (the key is the string)', existsSync(join(localesDir, 'en.json')));

// --- the fallback, exercised rather than reasoned about --------------------------
// "A missing translation renders the English sentence" is the claim the whole
// natural-language-key design rests on, and every other assertion here reads
// FILES. This one runs i18next with the real config against a real locale: the
// case that would betray it is a language with more plural categories than
// English (ru has one/few/many), where falling back can print the raw key with
// its {{count}} showing instead of a sentence.
console.log('\n--- fallback ---');
try {
    const i18next = (await import('i18next')).default;
    const probeCode = readdirSync(localesDir).map((f) => basename(f, '.json')).find((c) => c === 'ru')
        ?? readdirSync(localesDir).map((f) => basename(f, '.json')).find((c) => c !== 'en');
    await i18next.init({
        lng: 'en', fallbackLng: 'en', keySeparator: false, nsSeparator: false,
        returnEmptyString: false, interpolation: { escapeValue: false },
        resources: { en: { translation: {} } }, initAsync: false,
    });
    i18next.addResourceBundle(probeCode, 'translation', JSON.parse(readFileSync(join(localesDir, `${probeCode}.json`), 'utf8')), true, true);
    await i18next.changeLanguage(probeCode);

    const absent = 'This exact sentence is in no locale file, by construction.';
    ok(`${probeCode}: an untranslated key renders its English sentence`, i18next.t(absent) === absent);
    // A plural key whose ONLY placeholder is `count` — most carry others that
    // the call site fills, and leaving those unfilled is the probe's fault, not
    // the fallback's.
    const pluralKey = Object.keys(en)
        .filter((k) => k.endsWith('_other'))
        .map((k) => k.replace(/_other$/, ''))
        .find((k) => JSON.stringify(placeholders(k)) === JSON.stringify(['count']));
    const rendered = pluralKey ? [1, 2, 3, 5, 11].map((count) => i18next.t(pluralKey, { count })) : [];
    ok(`${probeCode}: no plural form leaks a raw {{placeholder}}`,
        rendered.length > 0 && rendered.every((s) => !/\{\{\w+\}\}/.test(s)), rendered.join(' · ').slice(0, 80));
    ok('an unknown plural key still renders as English', !/\{\{\w+\}\}/.test(i18next.t('{{count}} zorbles', { count: 3 })));
} catch (e) {
    ok('the fallback probe runs', false, e.message);
}

function readdirAll(dir, out = []) {
    for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (f === 'locales') continue;
        if (readdirSync(dir, { withFileTypes: true }).find((d) => d.name === f)?.isDirectory()) readdirAll(p, out);
        else if (/\.(tsx?|css)$/.test(f)) out.push(p);
    }
    return out;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
