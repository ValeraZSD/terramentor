#!/usr/bin/env node
// tools/accessibility-settings-gates.mjs — Settings → Accessibility, as rules
// the source has to keep.
//
// Run:  node tools/accessibility-settings-gates.mjs
//       ROOT=<another checkout> node tools/accessibility-settings-gates.mjs
//
// The section's rows are presentation, so most of what can go wrong is a
// surface that quietly reads something else:
//
//   1. **Motion is one switch.** Every animation obeys `data-motion` on <html>
//      (the reader's choice, already resolved against the system's). Tailwind's
//      own `motion-safe:`/`motion-reduce:` read only the media query and cannot
//      be redefined, so they are kept out of src/ and `motion-on:`/`motion-off:`
//      are used instead; a script asks `motionReduced()`, never the media query.
//   2. **"Widest" spacing is at least WCAG 1.4.12** (letters 0.12em, words
//      0.16em, lines 1.5, paragraphs 2em); axe-gates scans the section's screen.
//   3. **Read aloud never leaves the machine**: local voices only, no request.
//   4. **No row is sold as a dyslexia aid**: nothing in the interface says so.
//   5. **Every row is a registered client row** of the library scope, and the
//      first paint replays the cached choice (`theme-boot.js`).
//
// No model, no network, no browser.

import { readFileSync, existsSync, globSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.ROOT ? path.resolve(process.env.ROOT) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => { const p = path.join(ROOT, rel); return existsSync(p) ? readFileSync(p, 'utf8') : ''; };
const files = (glob) => globSync(glob, { cwd: ROOT, nodir: true }).map(f => f.replace(/\\/g, '/'));
/** Comments blanked, so a rule named in prose is not a use of it. */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const section = (name) => console.log(`\n${name}`);

const SRC = files('src/**/*.{ts,tsx}');
const css = read('src/index.css');
const tw = read('tailwind.config.js');

section('1. motion is one switch');
const mediaVariants = SRC.filter(f => /\bmotion-(safe|reduce):/.test(code(read(f))));
check('no Tailwind motion-safe:/motion-reduce: in src (they ignore the app\'s setting)', mediaVariants.length === 0, mediaVariants.join(', '));
check('motion-on:/motion-off: are defined on data-motion',
    /addVariant\('motion-on',\s*'html:not\(\[data-motion="reduce"\]\) &'\)/.test(tw)
    && /addVariant\('motion-off',\s*'html\[data-motion="reduce"\] &'\)/.test(tw));
const scriptsAsking = SRC.filter(f => f !== 'src/utils/accessibility.ts' && /prefers-reduced-motion/.test(code(read(f))));
check('no script asks the media query itself; motionReduced() does', scriptsAsking.length === 0, scriptsAsking.join(', '));
check('the stylesheet has no reduced-motion media query left: every rule reads data-motion',
    !/@media[^{]*prefers-reduced-motion/.test(code(css)) && /html\[data-motion="reduce"\]/.test(css));
const blanket = /html\[data-motion="reduce"\] \*,[\s\S]*?\{([^}]*)\}/.exec(code(css))?.[1] ?? '';
check('reduce ends every animation and transition at once', /animation-duration:\s*0\.01ms/.test(blanket) && /transition-duration:\s*0\.01ms/.test(blanket) && /animation-iteration-count:\s*1/.test(blanket), blanket.trim().slice(0, 120));
const motionUsers = SRC.filter(f => /\bmotionReduced\(\)/.test(code(read(f))));
check(`scripted motion asks motionReduced() (${motionUsers.length} files)`, motionUsers.length >= 8, motionUsers.join(', '));

section('2. spacing at the widest step is at least WCAG 1.4.12');
const ruleValue = (attr, level, prop) => {
    const m = new RegExp(`html\\[data-${attr}="${level}"\\][^{]*\\{\\s*${prop}:\\s*([0-9.]+)(em)?`).exec(css);
    return m ? Number(m[1]) : NaN;
};
check('letters 0.12em', ruleValue('letter-spacing', 'widest', 'letter-spacing') >= 0.12);
check('words 0.16em', ruleValue('word-spacing', 'widest', 'word-spacing') >= 0.16);
check('lines 1.5', ruleValue('line-spacing', 'widest', 'line-height') >= 1.5);
const para = /html\[data-line-spacing\][^{]*\.prose p\s*\{\s*margin-bottom:\s*([0-9.]+)em/.exec(css);
check('paragraphs 2em', !!para && Number(para[1]) >= 2, para?.[0] ?? 'no paragraph rule');
check('"wider" sits between normal and widest',
    ruleValue('letter-spacing', 'wider', 'letter-spacing') > 0 && ruleValue('letter-spacing', 'wider', 'letter-spacing') < ruleValue('letter-spacing', 'widest', 'letter-spacing')
    && ruleValue('line-spacing', 'wider', 'line-height') < ruleValue('line-spacing', 'widest', 'line-height'));
check('the section is a screen axe-gates scans', /'settings-accessibility':/.test(read('tools/axe-gates.mjs')));

section('3. read aloud never leaves the machine');
const speech = code(read('src/utils/readAloud.ts'));
check('only local voices are used', /localService/.test(speech) && /speechSynthesis/.test(speech));
check('it makes no request', speech !== '' && !/\bfetch\(|XMLHttpRequest|WebSocket|api\./.test(speech));
check('a missing voice is said, not silently skipped', /'no-voice'/.test(speech) && /no \{\{language\}\} voice installed/.test(read('src/components/ui/ReadAloudButton.tsx')));

section('4. no row is sold as a dyslexia aid');
const claims = [...SRC, 'src/locales/en.json'].filter(f => /dyslexi|bionic reading/i.test(f.endsWith('.json') ? read(f) : code(read(f))));
check('no interface string says dyslexia or bionic reading', claims.length === 0, claims.join(', '));
check('no dyslexia font is bundled', files('public/**/*').concat(files('src/**/*')).every(f => !/dyslexi/i.test(f)));

section('5. every row is registered, and the first paint replays it');
const schema = read('server/settingsSchema.js');
const access = read('src/utils/accessibility.ts');
const rows = [...(/A11Y_KEYS = \{([^}]*)\}/.exec(access)?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map(m => m[1]);
check(`the section's rows are named in one table (${rows.length})`, rows.length === 10, rows.join(', '));
const notUi = rows.filter(r => !new RegExp(`\\b${r}: client\\('ui',`).test(schema));
check('each is a client ui row of the registry', notUi.length === 0, notUi.join(', '));
const scope = /library:\s*\[([\s\S]*?)\]/.exec(schema)?.[1] ?? '';
const notLibrary = rows.filter(r => !scope.includes(`'${r}'`));
check('each travels with the library (scope)', notLibrary.length === 0, notLibrary.join(', '));
check('theme takes "system"', /theme: client\('ui', oneOf\('light', 'dark', 'system'\)\)/.test(schema));
const boot = read('public/theme-boot.js');
check('theme-boot replays motion and spacing before the first paint', /terramentor-a11y/.test(boot) && /data-motion/.test(boot) && /data-line-spacing|line-spacing/.test(boot));
check('theme-boot repaints a "system" theme in the mode the system is in', /themeChoice/.test(boot) && /otherVars/.test(boot));

section('6. confirm before grading reaches every surface that grades on a press');
for (const f of ['src/components/GlobalFlashcardReview.tsx', 'src/components/FlashcardView.tsx', 'src/components/feed/FlashcardFeedCard.tsx']) {
    check(`${path.basename(f)} rates through useConfirmPress`, /useConfirmPress</.test(read(f)) && /confirmRate\.press\(/.test(read(f)));
}
check('a choice question that grades on its press asks twice', /confirmAnswers/.test(read('src/components/answer/ChoiceInput.tsx')));
{
    const drill = read('src/components/drills/DrillPlayer.tsx');
    check('a drill option that grades on its press asks twice', /useConfirmPress</.test(drill) && /pick\.press\(/.test(drill));
}
// An armed rating is announced: the state change on the focused button is
// what a screen reader reads, the changed second line alone is not.
check('an armed rating says so to a screen reader', /aria-pressed=\{armed/.test(read('src/components/flashcards/RatingButton.tsx')));

section('7. read aloud and motion follow the reader, not the page around them');
{
    const btn = read('src/components/ui/ReadAloudButton.tsx');
    // The course text's `lang` sits INSIDE the target; up from it is only <html lang>.
    check('read aloud takes the language from inside the text first', /querySelector\('\[lang\]'\)/.test(btn));
    const scroll = read('src/utils/scrollWithin.ts');
    check('a scroll asked to be smooth is instant under reduced motion', /motionReduced\(\)/.test(scroll) && /motionReduced\(\)/.test(read('src/hooks/useStickToBottom.ts')));
    const css = read('src/index.css');
    check('text spacing leaves formulas and drawings alone', /data-line-spacing="widest"\] body \*:not\(\.katex, \.katex \*, svg, svg \*\)/.test(css));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
