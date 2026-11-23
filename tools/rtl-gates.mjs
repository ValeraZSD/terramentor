#!/usr/bin/env node
// rtl-gates.mjs — the interface lays out right to left in Arabic.
//
// `<html dir="rtl">` (src/i18n/index.ts) flips every flex row and every
// logical property by itself; what it cannot flip is a side named in the
// code. Each rule below is a way a screen broke in right to left before it
// was fixed, so a new screen written with `ml-2` or `left-0` is caught here
// rather than by an Arabic reader:
//
//   1. Tailwind classes name the line's START and END, never a side:
//      ms/me, ps/pe, start/end, border-s/e, rounded-s/e/ss/se/es/ee,
//      text-start/end, float-start/end, safe-ps/pe. Centring (`left-1/2`
//      with `-translate-x-1/2`, an arbitrary value round 50%) is the same in
//      both directions and stays.
//   2. A sideways `translate-x-N` (a switch's knob, a drawer pushed off
//      screen) carries its `rtl:` mirror on the same line; `divide-x` and
//      `space-x-N` carry `rtl:divide-x-reverse` / `rtl:space-x-reverse`.
//   3. An inline style's spacing and borders are logical (`paddingInlineStart`,
//      `borderInlineStartColor`, `insetInlineEnd`); a colour set on
//      `borderLeftColor` painted the wrong side of a `border-s-4` card.
//      Files that are left-to-right islands on purpose are listed in ISLANDS.
//   4. A physical margin, padding, border, float or text-align in src/*.css
//      is mirrored in the same rule, or its selector is in CSS_ALLOWED.
//   5. A file that handles ArrowLeft/ArrowRight runs the key through
//      `inlineArrow()` (src/utils/direction.ts), or is an island.
//   6. `scrollLeft` is read only through `scrolledFromStart()`: in right to
//      left it is 0 at the start and NEGATIVE towards the end.
//   7. Every lucide icon the app imports whose name points sideways is either
//      mirrored by the `scale: -1 1` rule in index.css or listed in STAYS.
//   8. Every interface language Intl calls right to left is in the `RTL`
//      set of src/i18n/index.ts, and that file sets `dir` on <html>.
//
//   node tools/rtl-gates.mjs              # this checkout
//   node tools/rtl-gates.mjs --root DIR   # another checkout (a pre-fix tree must fail)

import { readFileSync, globSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** The lucide names a file imports by name (`X as Y` → X). no-sparkle-gates.mjs
 *  follows every other way of reaching an icon and fails closed on them. */
function lucideImports(source) {
    const names = [];
    for (const m of source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]lucide-react['"]/g)) {
        for (const part of m[1].replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '').split(',')) {
            const name = part.trim().split(/\s+as\s+/)[0].trim();
            if (name) names.push(name);
        }
    }
    return names;
}

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootArg = process.argv.indexOf('--root');
const ROOT = rootArg > 0 ? path.resolve(process.argv[rootArg + 1]) : HERE;

const findings = [];
let checked = 0;
const ok = (name, cond, detail) => { checked++; if (!cond) findings.push({ name, detail }); return cond; };

/** Left-to-right on purpose, each with its reason. */
const ISLANDS = {
    'src/components/evidence/EstimateChart.tsx': 'a time chart drawn in pixels from the left (dir="ltr")',
    'src/components/plan/WeeklyChart.tsx': 'a time chart drawn in pixels from the left (dir="ltr")',
    'src/components/attachments/MarkedImage.tsx': 'a box on a picture, placed in the picture\'s own left-to-right space (dir="ltr"); its label has dir="auto", so a logical inset would follow the label\'s language',
    'src/components/answer/CodeEditor.tsx': 'program code reads left to right (.cm-editor is direction: ltr)',
};
const CSS_ALLOWED = {
    'pre': 'program code reads left to right',
    'html[data-larger-ui] [data-checkbox] > input': 'centred on its box, the same offset either way',
    'body > div[id^="dvisual-mermaid-"]': 'parked off screen while a diagram is measured',
};
/** Sideways-looking icons that must NOT turn round, each with its reason. */
const STAYS = {
    ArrowDown: 'vertical', ArrowUp: 'vertical', ArrowDownUp: 'vertical', ArrowUpDown: 'vertical',
    ArrowDownCircle: 'vertical', ArrowUpCircle: 'vertical', ChevronDown: 'vertical', ChevronUp: 'vertical',
    ChevronsUpDown: 'vertical', ChevronsDownUp: 'vertical', ArrowLeftRight: 'symmetric',
    // Playback glyphs keep the direction of the tape in every language, as
    // Play does (the convention of Material and Apple's guidelines).
    SkipForward: 'a playback glyph', SkipBack: 'a playback glyph', FastForward: 'a playback glyph', Rewind: 'a playback glyph',
};
const SIDEWAYS = /Left|Right|Chevron|Arrow|Undo|Redo|Send|LogIn|LogOut|Reply|Forward|Corner|ListTree|Indent|Outdent/;

// ------------------------------------------------------------------ helpers

const rel = (f) => path.relative(ROOT, f).replace(/\\/g, '/');
const SOURCES = globSync('src/**/*.{ts,tsx}', { cwd: ROOT }).map((f) => path.join(ROOT, f))
    .filter((f) => !rel(f).startsWith('src/locales/'));

/** Comments that open a line are prose, not classes ("the right-hand pane"). */
const code = (text) => text.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '').replace(/^[ \t]*\/\/[^\n]*/gm, '')
    .replace(/^[ \t]*\*[^\n]*/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const SPACE = String.raw`(?:\d+(?:\.\d+)?|px|auto|full|\d+\/\d+|\[[^\]\s"'\`]+\])`;
const COLOR = String.raw`(?:\d+|\[[^\]\s"'\`]+\]|[a-z]+(?:-\d{2,3})?(?:\/\d+)?)`;
const RADIUS = String.raw`(?:none|sm|md|lg|xl|2xl|3xl|full|\[[^\]\s"'\`]+\])`;
const PRE = String.raw`(?<=^|[\s"'\`{(,])((?:[\w-]+:|\[[^\]\s]+\]:)*)!?-?`;
const POST = String.raw`(?=$|[\s"'\`})\],;])`;
const PHYSICAL = [
    new RegExp(`${PRE}((?:scroll-)?(?:ml|mr|pl|pr)-${SPACE})${POST}`, 'gm'),
    new RegExp(`${PRE}((?:left|right)-(${SPACE}))${POST}`, 'gm'),
    new RegExp(`${PRE}((?:border-l|border-r)(?:-${COLOR})?)${POST}`, 'gm'),
    new RegExp(`${PRE}((?:rounded-l|rounded-r|rounded-tl|rounded-tr|rounded-bl|rounded-br)(?:-${RADIUS})?)${POST}`, 'gm'),
    new RegExp(`${PRE}(text-left|text-right|float-left|float-right|clear-left|clear-right)${POST}`, 'gm'),
    new RegExp(`${PRE}(safe-p[lr]-${SPACE})${POST}`, 'gm'),
];
const CENTRED = /^(?:left|right)-(?:1\/2|\[[^\]]*50%[^\]]*\])$/;

/** The physical classes in a piece of source, centring excepted. */
export function physicalClasses(text) {
    const out = [];
    for (const re of PHYSICAL) {
        for (const m of text.matchAll(re)) if (!CENTRED.test(m[2])) out.push(m[2]);
    }
    return out;
}

/** Lines whose sideways move has no right-to-left mirror. */
export function unmirroredLines(text) {
    const out = [];
    text.split('\n').forEach((line, i) => {
        const moves = [...line.matchAll(/(?<![\w:-])((?:[\w-]+:)*)-?translate-x-([\w./[\]-]+)/g)]
            .filter((m) => !/(^|:)rtl:$/.test(m[1]) && !/^(0|px|1\/2|\[.*50%.*\])$/.test(m[2]));
        // One mirror per move: an `rtl:` beside one move does not excuse another.
        const mirrors = [...line.matchAll(/(?<![\w-])rtl:-?translate-x-/g)].length;
        if (moves.length > mirrors) out.push({ line: i + 1, what: `translate-x-${moves[mirrors]?.[2] ?? moves[0][2]} without an rtl: mirror` });
        if (/(?<![\w:-])divide-x(?![\w-])/.test(line) && !/rtl:divide-x-reverse/.test(line)) out.push({ line: i + 1, what: 'divide-x without rtl:divide-x-reverse' });
        if (/(?<![\w:-])space-x-\d/.test(line) && !/rtl:space-x-reverse/.test(line)) out.push({ line: i + 1, what: 'space-x without rtl:space-x-reverse' });
    });
    return out;
}

/** dnd-kit's sideways drag delta not turned into "towards the end" first. */
export function rawDeltaX(text) {
    return [...text.matchAll(/(?<!inlineDelta\()\b\w+\.delta\.x\b/g)].length;
}

/** Style-object keys that name a side. */
export function physicalStyleKeys(text) {
    return [...text.matchAll(/(?<![\w.$])(padding(?:Left|Right)|margin(?:Left|Right)|border(?:Left|Right)\w*)\s*:/g)].map((m) => m[1])
        .concat([...text.matchAll(/textAlign\s*:\s*['"](left|right)['"]/g)].map((m) => `textAlign: ${m[1]}`));
}

/** Physical declarations in a stylesheet whose rule does not mirror them. */
export function cssOneSided(css) {
    const out = [];
    const flat = css.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const selector = m[1].trim().replace(/\s+/g, ' ');
        const decls = new Map();
        for (const d of m[2].split(';')) {
            const [p, ...v] = d.split(':');
            if (p && v.length) decls.set(p.trim(), v.join(':').trim());
        }
        for (const [prop, value] of decls) {
            let mirror = null;
            const side = /^(margin|padding|border)-(left|right)(-\w+)?$/.exec(prop) || /^()(left|right)()$/.exec(prop);
            if (side) mirror = `${side[1] ? `${side[1]}-` : ''}${side[2] === 'left' ? 'right' : 'left'}${side[3] || ''}`;
            const physicalValue = (prop === 'text-align' || prop === 'float' || prop === 'clear') && /^(left|right)$/.test(value);
            if (!side && !physicalValue) continue;
            if (side && decls.get(mirror) === value) continue;
            if (CSS_ALLOWED[selector] !== undefined) continue;
            out.push(`${selector} { ${prop}: ${value} }`);
        }
    }
    return out;
}

// ------------------------------------------------------------------ 0. the scanner itself

{
    const bad = `<div className="ml-2 pr-4 left-0 -right-1 border-l-4 border-r-slate-200 rounded-tl-lg text-right sm:float-left safe-pl-0 hover:mr-[3px]" />`;
    const found = physicalClasses(bad);
    ok('the class scanner sees every physical class in a known-bad line', found.length === 11, `found ${found.length}: ${found.join(' ')}`);
    const good = `<div className="ms-2 pe-4 start-0 -end-1 border-s-4 rounded-ss-lg text-end left-1/2 -translate-x-1/2 right-[calc(50%-1rem)] safe-ps-0" /> // the right-hand pane, left-to-right`;
    ok('the class scanner passes logical classes and centring', physicalClasses(good).length === 0, physicalClasses(good).join(' '));
    ok('a knob moved sideways without its mirror is caught', unmirroredLines(`'translate-x-5'`).length === 1 && unmirroredLines(`'translate-x-5 rtl:-translate-x-5'`).length === 0);
    ok('one mirror on a line does not excuse a second move', unmirroredLines(`'translate-x-5 rtl:-translate-x-5 peer-checked:translate-x-3'`).length === 1);
    ok('a drag delta read raw is caught, one through inlineDelta() is not',
        rawDeltaX('setX(event.delta.x)') === 1 && rawDeltaX('setX(inlineDelta(event.delta.x))') === 0);
    ok('divide-x without its reverse is caught', unmirroredLines(`'flex divide-x'`).length === 1 && unmirroredLines(`'flex divide-x rtl:divide-x-reverse'`).length === 0);
    ok('a side named in a style object is caught, a computed-style read is not',
        physicalStyleKeys(`{ borderLeftColor: 'red', paddingRight: 4 }`).length === 2 && physicalStyleKeys(`parseFloat(cs.paddingLeft)`).length === 0);
    ok('a one-sided CSS padding is caught, a mirrored one is not',
        cssOneSided('.a { padding-left: 1rem; } .b { padding-left: 1rem; padding-right: 1rem; } .c { text-align: right; }').length === 2);
}

// ------------------------------------------------------------------ 1-3, 5-6. source files

const iconsUsed = new Map();
for (const f of SOURCES) {
    const r = rel(f);
    const raw = readFileSync(f, 'utf8');
    const text = code(raw);
    const island = ISLANDS[r] !== undefined;

    const phys = physicalClasses(text);
    ok(`${r}: classes name start and end, not left and right`, phys.length === 0, phys.slice(0, 6).join(' '));

    // Course text (a name, a title) on a line that truncates is read in the
    // interface's direction unless it gets its own: an English title in the
    // Arabic interface was cut at its START ("…omy for Beginners").
    const ownless = raw.split('\n').filter((line) => /\btruncate\b[^>]*>\s*\{[\w?.]*(?:title|name|Name|Title)\}\s*</.test(line) && !/dir="auto"/.test(line));
    ok(`${r}: a truncated name or title reads in its own direction (OwnLine)`, ownless.length === 0, ownless.map((l) => l.trim()).slice(0, 3).join(' | '));

    const moves = unmirroredLines(text);
    ok(`${r}: sideways moves are mirrored in right to left`, moves.length === 0, moves.slice(0, 3).map((m) => m.what).join('; '));

    if (!island) {
        const keys = physicalStyleKeys(text);
        ok(`${r}: inline styles name start and end`, keys.length === 0, keys.join(', '));
        if (/['"]Arrow(?:Left|Right)['"]/.test(text)) {
            ok(`${r}: ArrowLeft/ArrowRight go through inlineArrow()`, /\binlineArrow\(/.test(text), 'handles a sideways arrow key without inlineArrow()');
        }
    }
    if (r !== 'src/utils/direction.ts') {
        ok(`${r}: scrollLeft is read through scrolledFromStart()`, !/\.scrollLeft\b/.test(text), 'reads .scrollLeft');
        // offsetLeft is measured from the left whatever the direction; two
        // getBoundingClientRect() boxes say where a thing is in either.
        ok(`${r}: no position read from offsetLeft`, !/\.offsetLeft\b/.test(text.replace(/\bvv\?\.offsetLeft\b/g, '')), 'reads .offsetLeft');
    }
    ok(`${r}: a sideways drag goes through inlineDelta()`, rawDeltaX(text) === 0, 'reads .delta.x raw');
    for (const name of lucideImports(raw)) if (SIDEWAYS.test(name)) iconsUsed.set(name, r);
}

// ------------------------------------------------------------------ 4. stylesheets

const cssFiles = globSync('src/**/*.css', { cwd: ROOT }).map((f) => path.join(ROOT, f));
ok('src/index.css is among the stylesheets read', cssFiles.some((f) => rel(f) === 'src/index.css'));
for (const f of cssFiles) {
    const one = cssOneSided(readFileSync(f, 'utf8'));
    ok(`${rel(f)}: physical sides are mirrored or allowed`, one.length === 0, one.slice(0, 4).join(' | '));
}

// ------------------------------------------------------------------ 7. icons

const indexCss = readFileSync(path.join(ROOT, 'src/index.css'), 'utf8');
const mirrorRule = /((?:\.lucide-[a-z0-9-]+:dir\(rtl\)\s*,?\s*)+)\{\s*scale:\s*-1 1;?\s*\}/.exec(indexCss);
ok('index.css mirrors sideways icons with `scale: -1 1` under :dir(rtl)', !!mirrorRule);
const mirrored = new Set(mirrorRule ? [...mirrorRule[1].matchAll(/\.lucide-([a-z0-9-]+):dir/g)].map((m) => m[1]) : []);
const kebab = (n) => n.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([A-Za-z])(\d)/g, '$1-$2').toLowerCase();
ok('the icon scan found the app\'s sideways icons', iconsUsed.has('ChevronRight') && iconsUsed.has('ArrowLeft'), [...iconsUsed.keys()].join(' '));
for (const [name, file] of iconsUsed) {
    const name2 = name.replace(/Icon$/, '').replace(/^Lucide/, '');
    ok(`${name2} (${file}) is mirrored in right to left or listed as staying`, mirrored.has(kebab(name2)) || STAYS[name2] !== undefined,
        `add .lucide-${kebab(name2)}:dir(rtl) to the rule in src/index.css, or ${name2} to STAYS with a reason`);
}

// ------------------------------------------------------------------ 8. the switch itself

{
    const i18n = readFileSync(path.join(ROOT, 'src/i18n/index.ts'), 'utf8');
    const listed = [...(/export const LANGUAGES[^=]*=\s*\[([\s\S]*?)\];/.exec(i18n)?.[1] ?? '').matchAll(/code:\s*'([a-z-]+)'/g)].map((m) => m[1]);
    const rtlSet = new Set([...(/const RTL\s*=\s*new Set\(\[([^\]]*)\]\)/.exec(i18n)?.[1] ?? '').matchAll(/'([a-z-]+)'/g)].map((m) => m[1]));
    ok('src/i18n/index.ts lists its languages and an RTL set', listed.length > 5 && rtlSet.size > 0, `languages ${listed.length}, RTL ${rtlSet.size}`);
    for (const c of listed) {
        const dir = new Intl.Locale(c).getTextInfo?.().direction ?? new Intl.Locale(c).textInfo?.direction;
        ok(`${c}: the RTL set agrees with Intl (${dir})`, (dir === 'rtl') === rtlSet.has(c));
    }
    ok('applyToDocument sets dir on <html>', /\.dir\s*=|setAttribute\(\s*'dir'/.test(i18n));
    // The boot script runs before the bundle, so the first frame is already
    // laid out the right way; it names the same right-to-left languages.
    const boot = readFileSync(path.join(ROOT, 'public/lang-boot.js'), 'utf8');
    const bootRtl = [...(/var RTL\s*=\s*\[([^\]]*)\]/.exec(boot)?.[1] ?? '').matchAll(/'([a-z-]+)'/g)].map((m) => m[1]).sort();
    const want = listed.filter((c) => rtlSet.has(c)).sort();
    ok('public/lang-boot.js sets dir for the same right-to-left languages', JSON.stringify(bootRtl) === JSON.stringify(want) && /documentElement\.dir\s*=/.test(boot),
        `boot ${bootRtl.join(',')}, LANGUAGES ${want.join(',')}`);
    // "Settings → Devices" read right to left puts the arrow against the
    // reading: Unicode mirrors brackets in right to left, never an arrow.
    for (const c of want) {
        const locale = JSON.parse(readFileSync(path.join(ROOT, `src/locales/${c}.json`), 'utf8'));
        const wrong = Object.entries(locale).filter(([, v]) => typeof v === 'string' && v.includes('→')).map(([k]) => k);
        ok(`${c}: a path or a change points with ← in right to left`, wrong.length === 0, `${wrong.length} with →: ${wrong.slice(0, 3).join(' | ')}`);
    }
}

// ------------------------------------------------------------------ report

for (const f of findings) console.log(`FAIL  ${f.name}${f.detail ? `\n      ${f.detail}` : ''}`);
console.log(`\nrtl-gates: ${checked - findings.length} passed, ${findings.length} failed`);
process.exit(findings.length ? 1 : 0);
