#!/usr/bin/env node
/**
 * tools/feed-card-text-gates.mjs — what a lesson and a card in the feed say,
 * in any language.
 *
 * Run:  node tools/feed-card-text-gates.mjs
 *
 *   - A lesson part's leading heading is dropped only when it restates the
 *     part title. The comparison kept ASCII letters and digits alone, so any
 *     two Cyrillic, Greek or Arabic titles reduced to '' and compared equal:
 *     "## Введение" under the part title "Заключение" was dropped as a repeat.
 *   - A feed card with no topic title falls back to "Flashcard" through the
 *     translator, not as English text.
 *
 * Deterministic: `splitLessonHeading` is bundled from the real LessonCard with
 * every import stubbed (it uses none of them); no DOM, no model, no network.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};

// Inside the project: `node_modules/.cache` is ignored by git.
const scratch = mkdtempSync(join(root, 'node_modules', '.cache', 'feed-card-text-'));
const lessonCard = join(root, 'src', 'components', 'feed', 'LessonCard.tsx');
try {
    const outfile = join(scratch, 'lesson-card.mjs');
    await esbuild.build({
        entryPoints: [lessonCard],
        bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent', jsx: 'automatic',
        plugins: [{
            name: 'stub-imports',
            setup(build) {
                // Every import of the component becomes an inert stub: the
                // function under test is pure and must not need the app.
                build.onResolve({ filter: /.*/ }, (args) => args.importer === lessonCard
                    ? { path: args.path, namespace: 'stub' } : undefined);
                build.onResolve({ filter: /.*/, namespace: 'stub' }, (args) => ({ path: args.path, namespace: 'stub' }));
                build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
                    contents: 'module.exports = new Proxy(function () { }, { get: (_, key) => key === "__esModule" ? false : function () { } });',
                    loader: 'js',
                }));
            },
        }],
    });
    const { splitLessonHeading } = await import(pathToFileURL(outfile).href);

    console.log('\nA lesson part\'s own heading, in any script');
    {
        const kept = splitLessonHeading('## Введение\n\nТекст части.', 'Заключение');
        check('a different Cyrillic heading is kept in the body', kept.heading === 'Заключение' && kept.body.startsWith('## Введение'),
            JSON.stringify(kept));
        const greek = splitLessonHeading('## Εισαγωγή\n\nκείμενο', 'Συμπέρασμα');
        check('…and a different Greek one', greek.body.startsWith('## Εισαγωγή'), JSON.stringify(greek));
        const same = splitLessonHeading('## Введение\n\nТекст части.', 'Введение');
        check('the same Cyrillic title is still dropped as a repeat', same.heading === 'Введение' && same.body.trim() === 'Текст части.',
            JSON.stringify(same));
        const cased = splitLessonHeading('# ВВЕДЕНИЕ: часть 1\n\nТекст', 'Введение — часть 1');
        check('…across case and punctuation', cased.body.trim() === 'Текст', JSON.stringify(cased));
        const latin = splitLessonHeading('## Frequency and Period Explained\n\nBody', 'Frequency and period, explained');
        check('a Latin restatement is still dropped (control)', latin.body.trim() === 'Body', JSON.stringify(latin));
        const latinOther = splitLessonHeading('## Worked example\n\nBody', 'Frequency');
        check('a different Latin heading is still kept (control)', latinOther.body.startsWith('## Worked example'));
    }
} finally {
    rmSync(scratch, { recursive: true, force: true });
}

console.log('\nA feed card with no topic title');
{
    const src = readFileSync(join(root, 'src', 'components', 'feed', 'FlashcardFeedCard.tsx'), 'utf8');
    const fallback = /nodeTitle=\{fc\.node_title \|\| ([^}]+)\}/.exec(src)?.[1] ?? '';
    check('the "Flashcard" fallback goes through the translator', fallback.trim() === 't("Flashcard")', fallback);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
