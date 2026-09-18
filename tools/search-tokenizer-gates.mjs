// tools/search-tokenizer-gates.mjs — search must find content in the script it
// is written in.
//
// `extractWords` allowlisted `a-z0-9`, Latin-1 Supplement/Extended-A and CJK
// ideographs. Everything else was replaced with a space BEFORE the length
// filter, so a query in any other script tokenised to nothing and `searchAll`
// returned an empty result for every table. The two that matter here are the
// two the library actually holds:
//
//   * **Cyrillic** — a Russian course ("Нидерландский язык: с нуля до C1") could
//     not be found by any word in its own language.
//   * **Kana** — hiragana (぀-ゟ) and katakana (゠-ヿ) are NOT
//     inside 一-鿿, so a Japanese deck was searchable by kanji and not
//     by the reading, which is how most of it is written.
//
// Neither failed loudly: search returned "nothing found", which is what it also
// says when there is genuinely nothing.
import { extractWords } from '../server/search.js';

let failures = 0;
let passed = 0;
const check = (label, actual, expected) => {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    const ok = a === e;
    if (ok) passed++; else failures++;
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${ok ? '' : ` — got ${a}, want ${e}`}`);
};

// --- the scripts the library contains --------------------------------------
check('Cyrillic survives', extractWords('предлог'), ['предлог']);
check('Cyrillic, mixed case', extractWords('Теория и примеры'),
    ['теория', 'примеры']);          // "и" is one letter, below MIN_QUERY_LENGTH
check('Cyrillic beside Latin', extractWords('предлог artikel'),
    ['предлог', 'artikel']);
check('hiragana survives', extractWords('ひらがな'), ['ひらがな']);
check('katakana survives', extractWords('カタカナ'), ['カタカナ']);
check('kanji still survives', extractWords('日本語'), ['日本語']);
check('Greek survives', extractWords('γλώσσα'), ['γλώσσα']);

// --- what must NOT change ---------------------------------------------------
check('plain Latin unchanged', extractWords('the article'), ['the', 'article']);
check('Dutch diacritics unchanged', extractWords('één café'), ['één', 'café']);
check('digits kept', extractWords('lesson 12'), ['lesson', '12']);
check('punctuation still splits', extractWords('de/het, man!'), ['de', 'het', 'man']);
check('single letters still dropped', extractWords('a b cd'), ['cd']);
check('empty query stays empty', extractWords('   '), []);
check('punctuation-only stays empty', extractWords('!!! ???'), []);

// `tools/run-gates.mjs` reads the assertion count out of this line with
// /(\d+)\s+(?:passed|\w*\s?assertions)/i — without it the suite is reported
// with "?" assertions and counted as a failure however it exited.
console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
