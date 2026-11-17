// The word diff behind the course-update preview (src/utils/wordDiff.ts): only
// the words that changed are marked, each side joins back to its text exactly,
// and a language without spaces is split into its words, not marked whole.
//
//   node tools/word-diff-gates.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundleTs } from './lib/bundleTs.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'word-diff-gates-'));
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }));
const mod = await bundleTs('src/utils/wordDiff.ts', scratch, { what: 'word diff', needs: ['diffWords'], platform: 'node' });
if (!mod) process.exit(0);
const { diffWords } = mod;

let passed = 0;
let failed = 0;
function check(name, got, want) {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (ok) passed++;
    else failed++;
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
}

const marked = (parts) => parts.filter(p => p.mark).map(p => p.text);
const joined = (parts) => parts.map(p => p.text).join('');

const pairs = [
    ['When a noun takes de and when het.', 'When a noun takes de and when het, with the five rules that cover most nouns.'],
    ['foo bar', 'foo bar baz'],
    ['', 'new'],
    ['same', 'same'],
    ['今日は天気がいいですね', '今日は天気が悪いですね'],
    ['❤️Hi there 👨‍👩‍👧', '❤️Hi here 👨‍👩‍👧'],
];
for (const [a, b] of pairs) {
    const d = diffWords(a, b);
    check(`joins back exactly: ${JSON.stringify(b).slice(0, 30)}`, [joined(d.before), joined(d.after)], [a, b]);
}

let d = diffWords('foo bar', 'foo bar baz');
check('text appended at the end marks only the new word, not the last old one', [marked(d.before), marked(d.after)], [[], ['baz']]);

d = diffWords('Welk lidwoord hoort bij "huis"?', 'Welk lidwoord hoort bij het woord "huis"?');
check('an inserted phrase is marked without the spaces around it', marked(d.after), ['het woord']);

d = diffWords('de and when het.', 'de, and when het.');
check('punctuation is its own mark: the comma, not the word before it', [marked(d.before), marked(d.after)], [[], [',']]);

d = diffWords('今日は天気がいいですね', '今日は天気が悪いですね');
check('Japanese is split into words: one changed word, not the sentence', [marked(d.before), marked(d.after)], [['いい'], ['悪い']]);

d = diffWords('❤️Hi there 👨‍👩‍👧', '❤️Hi here 👨‍👩‍👧');
check('an emoji stays one glyph and is not marked when unchanged', [marked(d.before), marked(d.after)], [['there'], ['here']]);

d = diffWords('same text', 'same text');
check('identical texts mark nothing', [marked(d.before), marked(d.after)], [[], []]);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
