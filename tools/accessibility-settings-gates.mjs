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
check(`the section's rows are named in one table (${rows.length})`, rows.length === 11, rows.join(', '));
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
// A shaky click that lands twice is one press: the second, within
// DOUBLE_PRESS_MS of the first, neither grades nor re-arms.
check('a double click does not select and grade at once',
    /Date\.now\(\) - armedAt\.current < DOUBLE_PRESS_MS\) return/.test(read('src/hooks/useConfirmPress.ts'))
    && /Date\.now\(\) - chosenAt\.current < DOUBLE_PRESS_MS\) return/.test(read('src/components/answer/ChoiceInput.tsx')));
// An armed rating is announced: the state change on the focused button is
// what a screen reader reads, the changed second line alone is not.
// It is a toggle from the start (false, not absent, while confirm is on):
// absent -> "true" changes the role, which screen readers do not announce.
check('an armed rating says so to a screen reader', /aria-pressed=\{armed\}/.test(read('src/components/flashcards/RatingButton.tsx')));
for (const f of ['src/components/GlobalFlashcardReview.tsx', 'src/components/FlashcardView.tsx', 'src/components/feed/FlashcardFeedCard.tsx']) {
    check(`${path.basename(f)} passes armed as a stable toggle while confirm is on`,
        /armed=\{confirmRate\.confirm \? confirmRate\.armed === rating : undefined\}/.test(read(f)));
}
{
    // The drill's "press again" line stays (invisible) through the verdict;
    // removed, it took a grid row with it and the feedback jumped up.
    const drill = read('src/components/drills/DrillPlayer.tsx');
    check('the drill\'s confirm line stays mounted through the verdict',
        /\{pick\.confirm && \(\s*<p data-confirm-line[^>]*feedback \? 'invisible'/.test(drill) && !/pick\.confirm && !feedback && \(/.test(drill));
}

section('6b. high contrast fills only the chosen segment and the armed rating');
{
    // Every forced-colors block, each up to its closing brace at column 0.
    const block = css.split('@media (forced-colors: active)').slice(1)
        .map(rest => rest.slice(0, rest.search(/\r?\n\}\r?\n/) + 3)).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
    // Every rule that takes over the colours (forced-color-adjust: none)
    // names its control by its own marker. A bare [aria-pressed] also hits a
    // flipped flashcard, where the inherited none kept the white plate under
    // HighlightText: white on white.
    const takeovers = [...block.matchAll(/([^{}]+)\{[^}]*forced-color-adjust:\s*none[^}]*\}/g)].map(m => m[1].trim());
    const loose = takeovers.flatMap(sel => sel.split(',').map(s => s.trim()))
        .filter(s => !/^button\[data-segment\]|^button\[data-rating\]\[data-armed\]|^\[role="switch"\]/.test(s));
    check('no colour takeover on a bare aria-pressed or radio', takeovers.length > 0 && loose.length === 0, loose.join(' | '));
    // Tailwind's outline-none is a transparent outline 2px out; forced colours
    // paint it, so at rest every control wore a second frame and neighbouring
    // segments drew overlapping ones. Hidden at rest, before the state rules.
    const rest = block.indexOf('.outline-none:where(:not(:focus-visible))');
    check('at rest the focus outline is flush and thin, and off on segments',
        rest !== -1 && /\.outline-none:where\(:not\(:focus-visible\)\) \{\s*outline-width: 1px;\s*outline-offset: 0;/.test(block)
        && /button\[data-segment\]:where\(:not\(:focus-visible\)\) \{\s*outline-style: none;/.test(block)
        && rest < block.indexOf('[aria-current="page"]'));
    // ...but only on controls: a region focused from code (the rating row,
    // a dialog) wore a square frame round its buttons.
    // The at-rest frame is 1px out; a state outline straddling the edge (2px at
    // -1px) ends at the same place, so the current button is not a box smaller.
    check('a state outline ends where the at-rest frame does',
        /\[aria-current="page"\],[^{]*\{\s*outline: 2px solid Highlight;\s*outline-offset: -1px;/.test(block));
    check('a region that is not a control wears no frame at rest',
        /\.outline-none:where\(:not\(:focus-visible, button, a,[^)]*\[role="button"\][^)]*\)\) \{\s*outline-style: none;/.test(block)
        && block.indexOf('outline-style: none') > rest && block.indexOf('outline-style: none') < block.indexOf('[aria-current="page"]'));
    check('a segmented row gets one frame (track) or one per chip',
        /\[data-segmented="track"\] \{\s*border: 1px solid ButtonText/.test(block) && /\[data-segmented="chips"\] > button\[data-segment\] \{\s*border: 1px solid ButtonText/.test(block)
        && /data-segmented=\{track && !wrapped \? 'track' : 'chips'\}/.test(read('src/components/ui/SegmentedControl.tsx')));
    // `button` outweighs a hover:bg-* utility (0,2,0, later in the file).
    check('the fill outweighs a hover background', /button\[data-rating\]\[data-armed\] \{[^}]*background: Highlight/.test(block));
    check('a segment carries its marker', /role="radio"[\s\S]{0,80}data-segment\b/.test(read('src/components/ui/SegmentedControl.tsx')));
    check('a rating carries its markers', /data-rating\b/.test(read('src/components/flashcards/RatingButton.tsx')) && /data-armed=/.test(read('src/components/flashcards/RatingButton.tsx')));
}

section('7. read aloud and motion follow the reader, not the page around them');
{
    const btn = read('src/components/ui/ReadAloudButton.tsx');
    // The course text's `lang` sits INSIDE the target; up from it is only <html lang>.
    check('read aloud takes the language from inside the text first',
        /el\.matches\('\[lang\]'\) \? el : el\.querySelector\('\[lang\]'\) \?\? el\.closest\('\[lang\]'\)/.test(btn));
    // On a card's back the question copy is skipped: the learner heard it a
    // moment ago, so the back reads only the answer (Anki, Quizlet).
    check('a flipped card reads only the answer',
        /<div data-read-skip=\{flipped \|\| undefined\} className="contents">\s*<p[\s\S]*?<CardText content=\{front\} \/>[\s\S]*?\{contextRows\}\s*<\/div>/.test(read('src/components/CardFace.tsx')));
    // After the voices wait the setting is read again: switched off meanwhile,
    // the button is gone and nothing on screen could stop the voice.
    const afterWait = code(btn).split('await voicesReady()')[1] ?? '';
    check('read aloud switched off during the voices wait says nothing',
        /if \(!mounted\.current \|\| !useStore\.getState\(\)\.a11y\.readAloud\) return;[\s\S]*speak\(/.test(afterWait));
    const settings = code(read('src/components/settings/AccessibilitySettings.tsx'));
    const testAfter = settings.split('await voicesReady()')[1] ?? '';
    check('"Try it" starts nothing once the tab was left, and runs once at a time',
        /if \(!shown\.current\) return;[\s\S]*speak\('settings-test'/.test(testAfter) && /if \(testing\.current\) return;/.test(settings));
    const scroll = read('src/utils/scrollWithin.ts');
    check('a scroll asked to be smooth is instant under reduced motion', /motionReduced\(\)/.test(code(scroll)) && /smooth && !motionReduced\(\)/.test(code(read('src/hooks/useStickToBottom.ts'))));
    // No smooth scroll goes around the two helpers: a direct scrollTo /
    // scrollBy / scrollIntoView asking for 'smooth' must ask motionReduced
    // (or the reduced flag it read) in the same expression.
    const bypass = SRC.filter(f => !f.endsWith('utils/scrollWithin.ts')).flatMap(f => {
        const src = code(read(f));
        return [...src.matchAll(/\.(?:scrollTo|scrollBy|scrollIntoView)\(\{[^}]*'smooth'[^}]*\}/g)]
            .filter(m => !/motionReduced\(\)|\breduced\b/.test(m[0])).map(() => f);
    });
    check('no direct smooth scroll ignores reduced motion', bypass.length === 0, bypass.join(', '));
    const spacing = [...css.matchAll(/^html\[data-(letter|word|line)-spacing="(wider|widest)"\] body \*(.*)\{/gm)];
    const bare = spacing.filter(m => !m[3].startsWith(':not(.katex, .katex *, svg, svg *)')).map(m => `${m[1]} ${m[2]}`);
    check(`text spacing leaves formulas and drawings alone (${spacing.length} rules)`, spacing.length === 6 && bare.length === 0, bare.join(', '));
}

section('8. larger text and buttons: one switch, two floors');
{
    // What it does on screen is measured in a browser (larger-ui-gates.mjs);
    // these are the wires a browser run cannot tell apart from luck.
    const access = code(read('src/utils/accessibility.ts'));
    check('one row, larger_ui, off by default', /largerUi: 'larger_ui'/.test(access) && /largerUi: false/.test(access) && /settings\.larger_ui === 'true'/.test(access));
    check('it lands as data-larger-ui on <html>', /setAttribute\('data-larger-ui'/.test(access) && /removeAttribute\('data-larger-ui'\)/.test(access));
    check('the first paint replays it', /largerUi: prefs\.largerUi/.test(access) && /a\.largerUi === true\) root\.setAttribute\('data-larger-ui'/.test(read('public/theme-boot.js')));
    // The small sizes read a variable, so every variant (sm:, touch:) follows
    // one rule; written per class, `sm:text-xs` would have kept 12px.
    check('the three small sizes read a variable with their old size as the fallback',
        /xs: \['var\(--text-xs, 0\.75rem\)'/.test(tw) && /'2xs': 'var\(--text-2xs, 0\.6875rem\)'/.test(tw) && /'3xs': 'var\(--text-3xs, 0\.625rem\)'/.test(tw));
    const root = /html\[data-larger-ui\] \{([^}]*)\}/.exec(css)?.[1] ?? '';
    const vars = ['--text-xs', '--text-2xs', '--text-3xs'].map(v => new RegExp(`${v}:\\s*([0-9.]+)rem`).exec(root)?.[1]);
    check('the switch raises all three to the body size, in rem', vars.every(v => Number(v) >= 0.875), vars.join(', '));
    // Two rules, height then width, so each can spare the controls that ask
    // for more than the floor in that direction.
    const rules = [...css.matchAll(/html\[data-larger-ui\] :is\(([^)]*(?:\([^)]*\)[^)]*)*)\):not\(([^{]*)\)\s*\{([^}]*)\}/g)];
    const [hRule, wRule] = rules;
    const kinds = ['button', 'select', 'summary', 'a[href]', 'input', '[role="button"]', '[role="tab"]', '[role="option"]'];
    check('every control kind is held to the floor each way, never under 44px at any interface size',
        rules.length === 2 && rules.every(r => kinds.every(s => r[1].includes(s)))
        && /^\s*min-height:\s*var\(--target-floor\);\s*$/.test(hRule[3]) && /^\s*min-width:\s*var\(--target-floor\);\s*$/.test(wRule[3])
        && /--target-floor:\s*max\(2\.75rem, 44px\)/.test(root), `${rules.length} rules`);
    // Only a link in a sentence; a chip drawn in an answer sits in .prose
    // under `not-prose` and is a control like any other.
    check('a link inside running text is left its line (WCAG 2.5.5), a chip in an answer is not',
        rules.length === 2 && rules.every(r => /:is\(p, blockquote, \.prose\) a:not\(\.not-prose \*\)/.test(r[2])));
    const switchTsx = read('src/components/ui/Switch.tsx');
    check('a switch keeps its track; its target already spills to 44px',
        rules.length === 2 && rules.every(r => /\[role="switch"\]/.test(r[2]))
        && /<span data-switch-spill className="absolute -inset-x-1\.5 -inset-y-2\.5"/.test(switchTsx));
    // In forced colours the border eats 1px of the spill; the fix must find
    // the spill by name: a tile with role="switch" (search providers) has an
    // icon as its first span, and `> span:first-child` moved it.
    check('the high-contrast spill fix touches only the switch spill',
        /\[role="switch"\] > \[data-switch-spill\] \{\s*inset:/.test(css) && !/\[role="switch"\] > span:first-child/.test(css));
    // The floor replaces a control's own min-height/min-width, so every class
    // in the app that asks for 44px or more must be spared by its rule.
    const remPx = v => { const m = /^([0-9.]+)(rem|px)$/.exec(v); return m ? Number(m[1]) * (m[2] === 'rem' ? 16 : 1) : null; };
    // Only a class on a control counts: the rule cannot match a layout box,
    // and a `min-w-[9.5rem]` on a div once had to be spared to pass. The
    // element is the nearest JSX tag opened before the class; it is a control
    // by its tag or by a role the floor names.
    const CONTROL_TAG = /^(button|a|select|summary|input|Button|IconButton|LinkButton|Link|NavLink)$/;
    const CONTROL_ROLE = /\brole=\{?["'`](button|tab|option|menuitem\w*|radio|checkbox)["'`]/;
    const onControl = (src, at) => {
        const opens = [...src.slice(0, at).matchAll(/(?:^|[\s({>])<([A-Za-z][\w.]*)/g)];
        const last = opens[opens.length - 1];
        return !!last && (CONTROL_TAG.test(last[1]) || CONTROL_ROLE.test(src.slice(last.index, at)));
    };
    const tallClasses = (prop, sources = SRC.map(f => read(f))) => {
        const out = new Set();
        for (const src of sources) {
            for (const m of src.matchAll(new RegExp(`\\b${prop}-(\\d+|\\[[^\\]]+\\])`, 'g'))) {
                const v = m[1];
                const px = v.startsWith('[') ? remPx(v.slice(1, -1)) : Number(v) * 4;
                if (px !== null && px > 44 && onControl(src, m.index)) out.add(`${prop}-${v}`);
            }
        }
        return [...out];
    };
    check('the spared-class scan reads controls only: a wide button counts, a wide div does not',
        tallClasses('min-w', ['<button type="button" className="min-w-[15rem]">', '<div role="option" className="min-w-[16rem]">'])
            .join() === 'min-w-[15rem],min-w-[16rem]'
        && tallClasses('min-w', ['<div className="min-w-[15rem]">{x}</div>', 'const c = useRef<HTMLDivElement>(null); <p className="min-w-[17rem]" />']).length === 0);
    const spared = (cls, not) => cls.includes('[')
        ? not.includes(`[class*="${cls}"]`) || (cls.startsWith('min-h-') && not.includes('[class*="min-h-["]'))
        : not.includes(`.${cls}`);
    const tallH = tallClasses('min-h').filter(c => !spared(c, hRule?.[2] ?? ''));
    const tallW = tallClasses('min-w').filter(c => !spared(c, wRule?.[2] ?? ''));
    check('a control that asks for more than the floor keeps its own size', rules.length === 2 && tallH.length === 0 && tallW.length === 0,
        [...tallH, ...tallW].join(', '));
    // Sized and placed explicitly, from the floor: `width: auto` leaves an
    // input its own size in an engine that treats it as replaced, and 2.75rem
    // is 35px at an 80% interface size. The browser gate measures it at 80%.
    check('a tickbox keeps its box; its input spills to the floor round it',
        /<span data-checkbox className=/.test(read('src/components/Checkbox.tsx'))
        && /html\[data-larger-ui\] \[data-checkbox\] > input \{\s*inset: auto;\s*left: min\(0px, calc\(\(100% - var\(--target-floor\)\) \/ 2\)\);\s*top: min\(0px, calc\(\(100% - var\(--target-floor\)\) \/ 2\)\);\s*width: max\(100%, var\(--target-floor\)\);\s*height: max\(100%, var\(--target-floor\)\);/.test(css));
    // Larger text in a narrow column cut tree and outline titles to a word or
    // two; with the switch on they wrap instead, and only the tree row (not
    // every [data-node-id]: cards, the calendar, the timeline) loses padding.
    const wraps = ['src/components/Sidebar.tsx', 'src/components/TreeItemRow.tsx', 'src/components/CategoryCard.tsx']
        .filter(f => !/data-larger-wraps/.test(read(f)));
    check('tree, outline and section titles wrap instead of being cut short',
        wraps.length === 0 && /html\[data-larger-ui\] \[data-larger-wraps\] \{\s*white-space: normal;/.test(css), wraps.join(', '));
    const sidebar = read('src/components/Sidebar.tsx');
    check('only the tree row trims its padding, and keeps some between wrapped titles',
        /data-sidebar-row/.test(sidebar) && /html\[data-larger-ui\] \[data-sidebar-row\] \{\s*padding-block: 0\.25rem;/.test(css)
        && !/html\[data-larger-ui\] \[data-node-id\]/.test(css));
    // A chapter's fold button is 44px wide with the switch on; a topic's
    // spacer stayed 20px, so topics slid left of their chapter.
    check('a topic still sits under its chapter: the spacer is as wide as the fold button',
        /<span data-fold-spacer className="w-5 shrink-0" \/>/.test(sidebar) && /html\[data-larger-ui\] \[data-fold-spacer\] \{\s*width: var\(--target-floor\);/.test(css));
    // The show button is the floor wide and sits 0.25rem in: 3.25rem left
    // typed text 5.6px under it at an 80% interface size.
    check('a password field keeps room for its show button at every interface size',
        /data-reveal-field=""/.test(read('src/components/ui/Field.tsx')) && /className="absolute right-1 top-1\/2/.test(read('src/components/ui/Field.tsx'))
        && /html\[data-larger-ui\] \[data-reveal-field\] \{\s*padding-right: calc\(var\(--target-floor\) \+ 0\.5rem\);/.test(css));
    check('the course tree is wide enough for two 44px buttons and a title, never past 30% of its row',
        /data-course-sidebar=\{isDrawer \? undefined : ''\}/.test(sidebar) && /html\[data-larger-ui\] \[data-course-sidebar\] \{\s*min-width: min\(17\.5rem, 30%\);/.test(css));
    check('the assistant may set it', /'larger_ui'/.test(read('server/assistantSettings.js')) && /larger_ui: k\(/.test(read('src/utils/assistantSettings.ts')));
    check('the row is in the Reading group, after Text size',
        /tr\("Text size"\)[\s\S]{0,700}tr\("Larger text and buttons"\)[\s\S]*tr\("Letter spacing"\)/.test(read('src/components/settings/AccessibilitySettings.tsx')));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
