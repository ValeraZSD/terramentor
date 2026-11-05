// tools/docs-gates.mjs — the README and docs/ still describe the app that ships.
//
// Run:  node tools/docs-gates.mjs
//
// The pictures are watched by `tools/docs-shots.mjs`, which opens the built
// app in a browser. These are the checks that need no browser, so they run in
// `npm test` on every machine:
//
//  * EVERY PICTURE HAS A SCREEN ON RECORD. docs/screenshots/manifest.json names
//    the state each picture shows and the interface text on that screen. A
//    picture with no entry is a picture nothing watches; an entry nobody links
//    to is a picture nobody sees; an entry whose state is not in docs-shots.mjs
//    cannot be checked at all.
//
//  * A RENAMED LABEL IS CAUGHT BEFORE ANY BROWSER RUNS. Each label recorded
//    for a picture is a string from src/locales/en.json. When the interface
//    stops saying one, the picture shows a word the app no longer has, and this
//    fails naming the picture and the word.
//
//  * A PATH THROUGH THE INTERFACE IS A LIST OF ITS LABELS. "Settings → Library
//    & about → About" is followed by a reader click by click, so every step of
//    such a path in the docs must be a label the interface still shows. Paths
//    in other programs (Windows, Claude Desktop, a phone's browser) are named
//    below, each with where it belongs.
//
//  * NAMES THE APP HAS RETIRED stay out of the docs. A short list, each with
//    the name that replaced it.
//
// The checkers are run on made-up input first, so a checker that stopped
// finding anything fails here rather than passing everything.
//
// No model, no network, no dependency on the learner's own library.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = join(ROOT, 'docs', 'screenshots');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
    cond ? pass++ : fail++;
    console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${cond || !detail ? '' : `\n         ${detail}`}`);
};

// ---------------------------------------------------------------------------
// What the interface says, and what the docs say.
// ---------------------------------------------------------------------------

const en = JSON.parse(readFileSync(join(ROOT, 'src', 'locales', 'en.json'), 'utf8'));
const LABELS = new Set(Object.values(en).filter((v) => typeof v === 'string').map((v) => v.trim()));

/** The shipped documents a reader follows: the README, the guides in docs/, contributing and security. */
const DOCS = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md',
    ...readdirSync(join(ROOT, 'docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`)];
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

// ---------------------------------------------------------------------------
// The checkers.
// ---------------------------------------------------------------------------

/** A recorded label is "<en.json value> · <part of the window>". */
const labelText = (recorded) => recorded.replace(/ · (top|middle|bottom)-(left|centre|right)$/, '');

/** Labels recorded for a picture that the interface no longer says. */
function retiredLabels(screen, labels) {
    return [...new Set((screen ?? []).map(labelText))].filter((l) => !labels.has(l));
}

/**
 * Paths through the interface: "A → B → C" where A is a label. Markdown
 * emphasis, quotes and line breaks are not part of a label. A step that starts
 * lower-case ("→ on", "→ make sure…") is prose after the path, which ends there.
 */
function interfacePaths(markdown) {
    const text = markdown.replace(/^>\s?/gm, '').replace(/`[^`]*`/g, ' ').replace(/\s+/g, ' ');
    const clean = (s) => s.replace(/[*"“”]/g, '').trim();
    const trim = (s) => s.replace(/[\s.,;:()'’]+$/, '').replace(/^[\s(]+/, '');
    const paths = [];
    const arrow = / → /g;
    let m;
    let consumed = 0;
    while ((m = arrow.exec(text))) {
        if (m.index < consumed) continue;
        // Mid-way along arrows that did not start with a label ("Discover → Plan → Study"): not a path.
        if (/→\s*\S+(?:\s+\S+){0,3}\s*$/.test(text.slice(Math.max(0, m.index - 60), m.index))) continue;
        // The first step: the longest run of words before the arrow that is a label.
        const before = clean(text.slice(Math.max(0, m.index - 80), m.index)).split(' ');
        let first = null;
        for (let n = Math.min(6, before.length); n >= 1 && !first; n--) {
            const words = trim(before.slice(-n).join(' '));
            if (LABELS.has(words)) first = words;
        }
        if (!first) continue;
        const steps = [first];
        let rest = text.slice(m.index + 3);
        for (;;) {
            const next = rest.indexOf(' → ');
            const raw = clean(next === -1 ? rest.slice(0, 120) : rest.slice(0, next)).replace(/^(open|press|pick) /, '');
            if (!raw || /^[a-z⋮]/.test(raw)) break;
            const words = raw.split(' ');
            // A step in the middle is all label; the last runs on into the sentence.
            let step = trim(raw);
            if (next === -1 || !LABELS.has(step)) {
                step = null;
                for (let n = Math.min(8, words.length); n >= 1 && !step; n--) {
                    const candidate = trim(words.slice(0, n).join(' '));
                    if (LABELS.has(candidate)) step = candidate;
                }
                if (!step) { steps.push({ missing: trim(words.slice(0, 6).join(' ')) }); break; }
            }
            steps.push(step);
            if (next === -1 || step !== trim(raw)) break;
            rest = rest.slice(next + 3);
        }
        consumed = m.index + 3 + text.slice(m.index + 3).indexOf(rest) + 1;
        paths.push(steps);
    }
    return paths;
}

const showPath = (steps) => steps.map((s) => (typeof s === 'string' ? s : `[${s.missing}]`)).join(' → ');

/** Paths in other programs, which the app's labels cannot vouch for. */
const OTHER_PROGRAMS = [
    { path: 'Settings → [Developer]', where: "Claude Desktop's own settings (docs/MCP.md)" },
];

/** Names the interface has retired, and what replaced each. */
const RETIRED = [
    { re: /\bBoss Fight\b/i, now: 'the mastery check' },
    { re: /\bGantt\b/i, now: 'the timeline and the calendar' },
    { re: /\bSchedule (screen|page|tab|view)\b/i, now: 'the dates on each Projects card' },
    { re: /\bhours? (per|a) day\b/i, now: 'study days (there is no hours-a-day setting)' },
    { re: /\*Source\*/, now: '*Code* on a visual\'s toolbar' },
];

// ---------------------------------------------------------------------------
// The checkers find what they are for.
// ---------------------------------------------------------------------------

console.log('\nthe checkers, on made-up input:');
ok('a label the interface stopped saying is found', retiredLabels(['Settings · top-right', 'Shedule · top-left'], LABELS).join() === 'Shedule');
ok('a label recorded twice in two places is named once', retiredLabels(['Gone · top-left', 'Gone · bottom-right'], LABELS).length === 1);
{
    const paths = interfacePaths('Open **Settings → Library & about → About** and press it.');
    ok('a path of labels reads as its steps', paths.length === 1 && showPath(paths[0]) === 'Settings → Library & about → About', JSON.stringify(paths));
}
{
    const paths = interfacePaths('In Settings → General → *Interface\nlanguage* picks one.');
    ok('a step broken over two lines is one step', paths.length === 1 && showPath(paths[0]) === 'Settings → General → Interface language', JSON.stringify(paths));
}
{
    const paths = interfacePaths('Settings → Libary & about → About.');
    ok('a step that is not a label is named', paths.length === 1 && showPath(paths[0]) === 'Settings → [Libary & about]', JSON.stringify(paths));
}
ok('a sequence of words that are not all labels is not a path', interfacePaths('The loop is Discover → Plan → Study → Prove → Remember.').length === 0);
{
    const paths = interfacePaths('Settings → Library & about → *This computer* → make sure it runs.');
    ok('prose after a path ends the path', paths.length === 1 && showPath(paths[0]) === 'Settings → Library & about → This computer', JSON.stringify(paths));
}
ok('an arrow between words that are not labels is not a path', interfacePaths('macOS wants a right-click → *Open* the first time.').length === 0);
ok('a retired name is found', RETIRED.some((r) => r.re.test('Open the Schedule screen.')));

// ---------------------------------------------------------------------------
// The pictures.
// ---------------------------------------------------------------------------

console.log('\nthe pictures under docs/screenshots/:');
const manifest = JSON.parse(readFileSync(join(SHOTS, 'manifest.json'), 'utf8'));
const shotsSource = read('tools/docs-shots.mjs');
const STATES = new Set([...shotsSource.matchAll(/^\s+async '?([\w-]+)'?\(page/gm)].map((m) => m[1]));
const linked = new Set(DOCS.flatMap((rel) => [...read(rel).matchAll(/(?:^|[("'\s])((?:\.\.\/)?docs\/screenshots\/[\w.-]+|screenshots\/[\w.-]+)/g)]
    .map((m) => basename(m[1]))));
const files = readdirSync(SHOTS).filter((f) => f !== 'manifest.json');
const entries = new Map(manifest.shots.map((s) => [basename(s.file), s]));

ok('docs-shots.mjs has states to check', STATES.size >= 5, [...STATES].join(', '));
for (const f of files) ok(`${f} has an entry in manifest.json`, entries.has(f));
for (const [f, s] of entries) {
    ok(`${f} is in docs/screenshots/`, files.includes(f));
    ok(`${f} is shown somewhere in the docs`, linked.has(f));
    const screens = s.clip ? Object.entries(s.scenes ?? {}) : [[s.state, s.screen]];
    ok(`${f} names at least one screen`, screens.length > 0);
    for (const [state, screen] of screens) {
        const what = s.clip ? `${f}, scene "${state}"` : f;
        ok(`${what}: the state "${state}" is in docs-shots.mjs`, STATES.has(state));
        ok(`${what}: its screen is on record`, Array.isArray(screen) && screen.length > 0,
            'record it with: node tools/docs-shots.mjs --accept ' + basename(f).replace(/\.[^.]+$/, ''));
        const gone = retiredLabels(screen, LABELS);
        ok(`${what}: every label it shows is still in the interface`, gone.length === 0,
            `no longer in en.json: ${gone.map((l) => `"${l}"`).join(', ')}. Re-shoot the picture (node tools/docs-shots.mjs --library <dir>) or, if it still tells the truth, --accept it.`);
    }
}
for (const name of linked) ok(`docs/screenshots/${name}, linked from the docs, exists`, existsSync(join(SHOTS, name)));

// ---------------------------------------------------------------------------
// The words.
// ---------------------------------------------------------------------------

console.log('\npaths through the interface in the docs:');
let paths = 0;
for (const rel of DOCS) {
    for (const steps of interfacePaths(read(rel))) {
        paths++;
        const shown = showPath(steps);
        const elsewhere = OTHER_PROGRAMS.find((o) => o.path === shown);
        if (elsewhere) { ok(`${rel}: ${shown} belongs to ${elsewhere.where}`, true); continue; }
        ok(`${rel}: ${shown}`, steps.every((s) => typeof s === 'string'),
            'the step in [brackets] is not a label the interface shows (src/locales/en.json)');
    }
}
ok('the docs hold paths to check', paths >= 20, `found ${paths}`);
// A path is only read when its first step is a label, so a renamed first step
// would drop its paths unseen. Most start at Settings: each one must be read.
for (const rel of DOCS) {
    const said = (read(rel).replace(/`[^`]*`/g, ' ').match(/\bSettings\**"?\s+→/g) ?? []).length;
    const read_ = interfacePaths(read(rel)).filter((s) => s[0] === 'Settings').length;
    if (said) ok(`${rel}: every "Settings →" is read as a path`, read_ === said, `${said} in the text, ${read_} read`);
}
for (const o of OTHER_PROGRAMS) {
    const found = DOCS.some((rel) => interfacePaths(read(rel)).some((s) => showPath(s) === o.path));
    ok(`the exception "${o.path}" is still in the docs`, found, 'remove it from OTHER_PROGRAMS');
}

console.log('\nnames the app has retired:');
for (const rel of DOCS) {
    const text = read(rel);
    for (const r of RETIRED) {
        const hit = text.match(r.re);
        ok(`${rel} does not say ${r.re}`, !hit, hit ? `it says "${hit[0]}"; the app calls it ${r.now}` : '');
    }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
