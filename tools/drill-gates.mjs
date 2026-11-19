// tools/drill-gates.mjs — the ```drill item bank and how its options are ordered.
//
// Run:  node tools/drill-gates.mjs
//
// WHY. A drill is the one surface in this app that is timed, and everything
// about it has to be readable in about a second. The option ORDER is therefore
// not a detail: a classification drill ("approaching or receding?", "der/die/
// das", "prime or composite?") asks the same question of every item and answers
// it from the same two or three words, and reshuffling those between items
// means the learner re-reads two words they already know while the clock runs.
// That measures reading speed, not the thing being drilled.
//
// The opposite is true of an ordinary bank, where the options are drawn from
// the whole item list: there a fixed order IS learnable and the shuffle is what
// keeps the question honest. So the rule is conditional, and both halves are
// asserted here — a fix that stabilised every drill would have broken the
// larger and more common kind.
//
// No model, no network. One check mounts the real player in jsdom (the clock's
// stop on an answer lives in an effect, which only a mounted player shows).

import { mkdirSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');

const scratch = mkdtempSync(join(tmpdir(), 'drill-gates-'));
const out = join(scratch, 'drill.mjs');
await esbuild.build({
    entryPoints: [fileURLToPath(new URL('../src/components/drills/parseDrill.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: out,
    logLevel: 'silent',
});
const { closedOptionSet, buildOptions, parseDrillSpec, answersMatch, drillBarFill, drillKeyOf, FLASHCARD_DRILL_KEY, itemSeconds, normalizeDrillTimeScale, DRILL_TIME_SCALES, drillTimeSummary } = await import(pathToFileURL(out).href);

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
    if (ok) { pass++; console.log(`  ok    ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = (name) => console.log(`\n${name}`);

/**
 * Mount the real DrillPlayer in jsdom, start a timed round, let `elapsed` ms of
 * the first item pass, press a wrong option, and read the countdown label and
 * the bar's width before the press, right after it, and a second later. The
 * clock is moved through `Date.now` (what the player measures with); real
 * timers run, so its 100 ms tick fires.
 */
async function answerPartWay({ seconds, elapsed }) {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true, url: 'http://localhost/' });
    Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
    for (const k of ['HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent']) globalThis[k] = dom.window[k];
    Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });

    // The bundle keeps react and the icon set external, so it is written where
    // node resolves them: under this checkout's node_modules.
    const cacheDir = join(fileURLToPath(new URL('..', import.meta.url)), 'node_modules', '.cache');
    mkdirSync(cacheDir, { recursive: true });
    const dir = mkdtempSync(join(cacheDir, 'drill-gates-'));
    const stubs = {
        'react-i18next': `export const useTranslation = () => ({ t: (k, o) => k.replace(/\\{\\{(\\w+)\\}\\}/g, (_, n) => String(o?.[n] ?? '')) });
            export const initReactI18next = { type: '3rdParty', init() { } };`,
        'api': 'export const api = {};',
        'i18n': `export default { t: (k) => k, language: 'en' }; export const k = (s) => s; export const currentLocale = () => 'en';`,
        'MathText': `import { createElement } from 'react'; export default function MathText({ content }) { return createElement('span', null, content); }`,
        // The "This is wrong" flag pulls in the app store and Modal; the timer
        // under test does not need either, so the flag (and the line under a
        // wrong answer that opens it) renders nothing here; its scope only
        // passes its children through.
        'ReportItem': `import { createElement, Fragment } from 'react';
            export default function ReportItem() { return null; } export const reportedLine = () => "";
            export function ReportScope({ children }) { return createElement(Fragment, null, children); }
            export function ReportLink() { return null; }`,
        'itemReportStore': `const state = { byRef: {}, load() { return Promise.resolve(); }, setReport() { } };
            export const useItemReports = Object.assign((sel) => sel(state), { getState: () => state });`,
    };
    try {
        const out = join(dir, 'player.cjs');
        await esbuild.build({
            stdin: { contents: `export { default } from './src/components/drills/DrillPlayer';`, resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'tsx' },
            bundle: true, format: 'cjs', platform: 'node', outfile: out, jsx: 'automatic', packages: 'external',
            loader: { '.css': 'empty' }, logLevel: 'silent',
            plugins: [{
                name: 'stubs',
                setup(b) {
                    b.onResolve({ filter: /^react-i18next$/ }, () => ({ path: 'react-i18next', namespace: 'stub' }));
                    b.onResolve({ filter: /^(\.\.\/)+api$/ }, () => ({ path: 'api', namespace: 'stub' }));
                    b.onResolve({ filter: /^(\.\.\/)+i18n$/ }, () => ({ path: 'i18n', namespace: 'stub' }));
                    b.onResolve({ filter: /^\.\.?\/(\.\.\/)*MathText$/ }, () => ({ path: 'MathText', namespace: 'stub' }));
                    b.onResolve({ filter: /\/ui\/ReportItem$/ }, () => ({ path: 'ReportItem', namespace: 'stub' }));
                    b.onResolve({ filter: /\/utils\/itemReportStore$/ }, () => ({ path: 'itemReportStore', namespace: 'stub' }));
                    b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({ contents: stubs[args.path], loader: 'js', resolveDir: dir }));
                },
            }],
        });
        const React = require(join(cacheDir, '..', 'react'));
        const { createRoot } = require(join(cacheDir, '..', 'react-dom', 'client'));
        const DrillPlayer = require(out).default;

        const realNow = Date.now;
        let shift = 0;
        Date.now = () => realNow() + shift;
        const host = document.getElementById('root');
        const root = createRoot(host);
        const wait = (ms) => React.act(() => new Promise((r) => setTimeout(r, ms)));
        const read = () => ({
            label: [...host.querySelectorAll('span')].map((s) => s.textContent.trim()).find((t) => /^\d+s$/.test(t)) ?? null,
            width: host.querySelector('[style*="width"]')?.style.width ?? null,
        });
        try {
            const spec = {
                modes: ['choice'], target: { secondsPerItem: seconds },
                items: CLASSIFICATION.slice(0, 3).map(({ prompt, answer }) => ({ prompt, answer })),
            };
            await React.act(() => root.render(React.createElement(DrillPlayer, { spec })));
            const start = [...host.querySelectorAll('button')].find((b) => b.textContent.includes('Start drill'));
            await React.act(() => start.click());
            shift += elapsed;
            await wait(250);
            const before = read();
            const prompt = host.textContent;
            const item = spec.items.find((i) => prompt.includes(i.prompt));
            const wrong = [...host.querySelectorAll('[data-answer-option]')].find((b) => b.textContent.trim() !== item?.answer);
            await React.act(() => wrong.click());
            const answered = read();
            shift += 1000;
            await wait(250);
            const later = read();
            return { before, answered, later };
        } finally {
            Date.now = realNow;
            await React.act(() => root.unmount());
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

/** The drill from the screenshot that started this: five items, two answers. */
const CLASSIFICATION = [
    { prompt: 'Galaxy spectral line shifts to red', answer: 'Receding' },
    { prompt: 'Wavelength gets longer', answer: 'Receding' },
    { prompt: 'Siren pitch rises', answer: 'Approaching' },
    { prompt: 'Blue shift observed', answer: 'Approaching' },
    { prompt: 'Observed frequency below the source frequency', answer: 'Receding' },
];

/** An ordinary recognition bank: every item has its own answer. */
const CAPITALS = [
    { prompt: 'Peru', answer: 'Lima' },
    { prompt: 'Norway', answer: 'Oslo' },
    { prompt: 'Kenya', answer: 'Nairobi' },
    { prompt: 'Japan', answer: 'Tokyo' },
    { prompt: 'Chile', answer: 'Santiago' },
    { prompt: 'Ghana', answer: 'Accra' },
];

section('Closed answer sets — a classification drill must not move its buttons');
{
    const closed = closedOptionSet(CLASSIFICATION);
    check('a two-answer bank is recognised as a closed set',
        Array.isArray(closed) && closed.length === 2 && closed.includes('Receding') && closed.includes('Approaching'),
        JSON.stringify(closed));

    // THE PRE-FIX BEHAVIOUR, so the gate is not green against the bug it
    // replaced: buildOptions reshuffles for every item, which is exactly what
    // made the two buttons swap between one question and the next.
    // Drawn many times, not once: with two labels and five items, five
    // independent shuffles agree by chance about one run in sixteen — a gate
    // that cries wolf teaches people to re-run the suite until it is green.
    // Over 40 draws a shuffling
    // implementation produces both orders with probability 1 - 2^-39, while a
    // fixed-order one still produces exactly one, so the bug it guards against
    // is caught just as surely and the run is deterministic in practice.
    const draws = [];
    for (let i = 0; i < 40; i++) draws.push(...CLASSIFICATION.map((item) => buildOptions(item, CLASSIFICATION).join('|')));
    check('buildOptions alone does NOT hold an order across items (the bug)',
        new Set(draws).size > 1 || CLASSIFICATION.length < 2,
        [...new Set(draws)].join(' · '));

    // With a closed set the player shuffles ONCE per round and reuses it, so
    // whatever order a round opens with is the order every item shows. That
    // rests on closedOptionSet itself being ORDER-STABLE — it is derived from
    // the bank, not from the item being asked, and it does not shuffle.
    const orders = new Set();
    for (let i = 0; i < 40; i++) orders.add(closedOptionSet(CLASSIFICATION).join('|'));
    check('closedOptionSet is order-stable across calls, so the round can hold one order',
        orders.size === 1, [...orders].join(' · '));
    check('…and the order does not depend on which item is being asked',
        CLASSIFICATION.every(() => closedOptionSet(CLASSIFICATION).join('|') === closed.join('|')));
    check('the order is first-seen order, not sorted or reversed',
        closed.join('|') === 'Receding|Approaching', closed.join('|'));

    // Distractors count toward the set: three labels is still a vocabulary.
    const withDistractors = closedOptionSet([
        { prompt: 'das Haus', answer: 'das', distractors: ['der', 'die'] },
        { prompt: 'der Tisch', answer: 'der', distractors: ['die', 'das'] },
    ]);
    check('distractors are part of the vocabulary', withDistractors?.length === 3, JSON.stringify(withDistractors));

    // Case and spacing are the same answer, not two.
    check('the set is deduplicated case-insensitively',
        closedOptionSet([
            { prompt: 'a', answer: 'Yes' },
            { prompt: 'b', answer: 'yes ' },
            { prompt: 'c', answer: 'No' },
        ])?.length === 2);
}

section('Open banks keep the shuffle — the fix must not reach them');
{
    check('a bank with an answer per item is NOT a closed set',
        closedOptionSet(CAPITALS) === null, JSON.stringify(closedOptionSet(CAPITALS)));

    // Right at the boundary: five distinct answers is past the cap of four.
    check('five distinct answers is past the cap', closedOptionSet(CLASSIFICATION.concat([
        { prompt: 'x', answer: 'Stationary' }, { prompt: 'y', answer: 'Both' }, { prompt: 'z', answer: 'Neither' },
    ])) === null);

    // One answer everywhere is not a drill, it is a single card.
    check('a single-answer bank is not a vocabulary',
        closedOptionSet([{ prompt: 'a', answer: 'Yes' }, { prompt: 'b', answer: 'yes' }]) === null);

    // And the open path still produces a playable question.
    const opts = buildOptions(CAPITALS[0], CAPITALS);
    check('an open bank still gets the answer plus distractors',
        opts.length >= 2 && opts.includes('Lima') && new Set(opts).size === opts.length,
        JSON.stringify(opts));
}

section('The spec a model writes still parses');
{
    const { spec, error } = await parseDrillSpec(JSON.stringify({
        title: 'Doppler quick-fire',
        prompt_label: 'Approaching or receding?',
        modes: ['choice'],
        target: { count: 5, seconds_per_item: 5 },
        items: CLASSIFICATION,
    }));
    check('a classification drill parses', !error && !!spec, error);
    // The prompt label is the QUESTION, and the intro screen states it before
    // the first item — a round that opens on a bare noun phrase over two
    // buttons leaves the learner working out what is being asked on the clock.
    check('the repeating question survives parsing as promptLabel',
        spec?.promptLabel === 'Approaching or receding?', spec?.promptLabel);
    check('the parsed items are a closed set', closedOptionSet(spec.items)?.length === 2);
    check('grading is insensitive to case and stray punctuation',
        answersMatch('receding', 'Receding.') && !answersMatch('Receding', 'Approaching'));
    // A decimal point or comma inside a number is the number: a numeric drill's
    // distractor 35 must not pass for the answer 3.5.
    check('a number is not graded equal to the same digits without their decimal mark',
        !answersMatch('35', '3.5') && !answersMatch('981', '9.81') && !answersMatch('12', '1,2') && !answersMatch('1,5', '15'));
    // This row passes on the old rule too: it guards what the fix must keep.
    check('a number still matches itself, with a full stop or case ignored around it',
        answersMatch('3.5', '3.5.') && answersMatch(' (9.81) ', '9.81') && answersMatch('1,2', '1,2'));
    // Either mark is the same number: the typed answer 3,5 is the key 3.5.
    check('a comma and a point are the same decimal mark, and trailing zeros do not matter',
        answersMatch('3,5', '3.5') && answersMatch('3.5', '3,5') && answersMatch('3.50', '3.5') && !answersMatch('3,5', '35') && !answersMatch('3.5', '3.6'));
    // Grouped thousands typed without the marks are the same number (as they
    // were when every mark was dropped); a mark before two digits never groups.
    check('thousands typed with or without grouping marks are the same number',
        answersMatch('299,792,458', '299792458') && answersMatch('3.024.000', '3024000') && answersMatch('1,000', '1000')
        && !answersMatch('9.81', '981') && !answersMatch('299,792,458', '299792'));
    check('a number is not compared to text by its leading digits', !answersMatch('3 apples', '3') && answersMatch('3 apples', '3 Apples'));
    check('the answer rule compiles with no lookbehind, which Safari before 16.4 cannot parse',
        !/\(\?<[=!]/.test(readFileSync(fileURLToPath(new URL('../src/components/drills/parseDrill.ts', import.meta.url)), 'utf8')));
}

section('The bar under the counter — a timed drill\'s bar is its clock, and only its clock');
{
    // A 5-second item answered with 3.5 s left, as item 1 and item 2 of a round of 3. The
    // player holds `remaining` where the answer stopped it (3.5) through the feedback beat.
    const secs = 5, left = 3.5;
    // THE PRE-FIX SHAPE, run through the same assertions: the clock was cleared on an
    // answer and the bar fell back to the round's progress.
    const preFix = (seconds, remaining, pos, total) =>
        seconds && remaining != null ? Math.max(0, (remaining / seconds) * 100) : (pos / total) * 100;
    const answered = (fill, pos) => fill(secs, null, pos, 3);
    check('control: the pre-fix bar SNAPPED on an answer (70% -> 0% on item 1, -> 33% on item 2)',
        preFix(secs, left, 0, 3) === 70 && answered(preFix, 0) === 0 && Math.round(answered(preFix, 1)) === 33);
    check('a stopped clock shows where it stopped, on every item',
        [0, 1, 2].every(pos => drillBarFill(secs, left, pos, 3) === 70),
        [0, 1, 2].map(pos => drillBarFill(secs, left, pos, 3)).join(', '));
    check('a timed bar never shows the round\'s progress, even with the clock unset (it is full)',
        drillBarFill(secs, null, 1, 3) === 100, String(drillBarFill(secs, null, 1, 3)));
    check('a clock that ran out is empty, and never below it',
        drillBarFill(secs, 0, 2, 3) === 0 && drillBarFill(secs, -0.2, 2, 3) === 0);
    check('an untimed drill\'s bar is still the round\'s progress',
        drillBarFill(null, null, 1, 4) === 25 && drillBarFill(null, null, 0, 4) === 0);

    // The other half lives in the player's effect, which a pure function cannot see: an
    // answer (or a typed answer out with the grader) must leave `remaining` alone rather
    // than reset it. The pre-fix line reset it to null on feedback and to `seconds` while
    // checking — the label jumped back to "5s" on every press. So the real player is
    // mounted in jsdom, 1.5 s of a 5 s item go by on a moved clock, a wrong option is
    // pressed (a wrong one waits for Next instead of advancing), and the label and the
    // bar are read before the press, after it, and a second later.
    const stopped = await answerPartWay({ seconds: 5, elapsed: 1500 });
    check('control: the mounted clock was part way down when it was answered', stopped.before.label !== '5s'
        && parseFloat(stopped.before.width) > 0 && parseFloat(stopped.before.width) < 100,
        JSON.stringify(stopped.before));
    check('the player stops the clock on an answer instead of clearing it',
        JSON.stringify(stopped.answered) === JSON.stringify(stopped.before), JSON.stringify(stopped));
    check('…and it stays stopped while the feedback is up',
        JSON.stringify(stopped.later) === JSON.stringify(stopped.before), JSON.stringify(stopped));
    const player = readFileSync(fileURLToPath(new URL('../src/components/drills/DrillPlayer.tsx', import.meta.url)), 'utf8');
    check('the player draws the bar through drillBarFill, not a fallback of its own',
        /drillBarFill\(seconds, remaining, pos, order\.length\)/.test(player) && !/timerPct/.test(player));
}

// --- how long an item may take ------------------------------------------------
// The model writes ONE number per drill (`seconds_per_item`), and before this the
// player gave it to every item in both modes. A tap and a typed answer are not
// the same task: a learner reported that in a typed round they could not find
// the letters in time. Two answers to that, both asserted here: a typed answer
// gets time for each letter on top of the base, and the learner may stretch the
// limit or turn it off before the round starts (WCAG 2.2.1, Timing Adjustable).
section('How long an item may take — typing gets time per letter, the learner sets the scale');
{
    const base = 8;
    check('a choice item keeps the drill\'s own number',
        itemSeconds(base, 'choice', 'Santiago', '1') === 8, String(itemSeconds(base, 'choice', 'Santiago', '1')));
    check('a typed item adds a second per letter of the answer (Santiago: 8 + 8)',
        itemSeconds(base, 'type', 'Santiago', '1') === 16, String(itemSeconds(base, 'type', 'Santiago', '1')));
    check('a letter is a character, not a UTF-16 unit (Bogotá is six, 日本 is two)',
        itemSeconds(base, 'type', 'Bogotá', '1') === 14 && itemSeconds(base, 'type', '日本', '1') === 10
        && itemSeconds(base, 'type', '𝑥', '1') === 9);
    check('surrounding spaces are not letters to type',
        itemSeconds(base, 'type', '  Lima ', '1') === 12);
    check('double and triple stretch the whole limit, typing allowance included',
        itemSeconds(base, 'type', 'Lima', '2') === 24 && itemSeconds(base, 'type', 'Lima', '3') === 36
        && itemSeconds(base, 'choice', 'Lima', '3') === 24);
    check('"off" removes the clock in both modes',
        itemSeconds(base, 'choice', 'Lima', 'off') === null && itemSeconds(base, 'type', 'Lima', 'off') === null);
    check('an untimed drill stays untimed whatever the scale',
        itemSeconds(null, 'type', 'Lima', '3') === null && itemSeconds(0, 'choice', 'Lima', '2') === null);
    check('a stored value the player does not know reads as the normal limit',
        normalizeDrillTimeScale(undefined) === '1' && normalizeDrillTimeScale('7') === '1'
        && normalizeDrillTimeScale('off') === 'off' && normalizeDrillTimeScale('3') === '3');
    check('the scales the player offers are the ones the server stores',
        JSON.stringify(DRILL_TIME_SCALES) === JSON.stringify(['1', '2', '3', 'off']));

    const summary = (m, s) => JSON.stringify(drillTimeSummary(base, m, s));
    check('the intro states the base for a tap, and the base plus a rate per letter when typed',
        summary('choice', '1') === '{"seconds":8,"perLetter":null}' && summary('type', '2') === '{"seconds":16,"perLetter":2}',
        `${summary('choice', '1')} ${summary('type', '2')}`);
    check('the intro says "off" when the learner turned the clock off, and nothing for an untimed drill',
        drillTimeSummary(base, 'type', 'off') === 'off' && drillTimeSummary(null, 'type', '2') === null);
    check('a fractional number the model wrote prints rounded, not as float noise (1.1 x3 = 3.3)',
        drillTimeSummary(1.1, 'choice', '3')?.seconds === 3.3, String(drillTimeSummary(1.1, 'choice', '3')?.seconds));
    const tiny = (await parseDrillSpec('{"items":[{"prompt":"a","answer":"b"},{"prompt":"c","answer":"d"}],"target":{"seconds_per_item":0.04}}')).spec;
    check('a limit under a second is raised to one (0.04 s would time out on the first tick and print "0s")',
        tiny?.target?.secondsPerItem === 1, String(tiny?.target?.secondsPerItem));

    const player = readFileSync(fileURLToPath(new URL('../src/components/drills/DrillPlayer.tsx', import.meta.url)), 'utf8');
    check('the player times each item through itemSeconds, by the mode it is asked in and its answer',
        /itemSeconds\(baseSeconds, itemMode, currentItem\?\.answer \?\? '', timeScale\)/.test(player));
    check('the intro offers the scale only on a timed drill',
        /\{baseSeconds \? \(/.test(player) && /DRILL_TIME_SCALES\.map/.test(player));
    check('the intro line comes from drillTimeSummary, in the chosen mode and scale',
        /drillTimeSummary\(baseSeconds, mode, timeScale\)/.test(player));
    check('the countdown restarts when the item\'s limit changes',
        /\}, \[phase, pos, feedback, checking, seconds(, \w+)*\]\);/.test(player));
    // The choice is remembered: read back at load, written under its own row.
    const store = readFileSync(fileURLToPath(new URL('../src/store.ts', import.meta.url)), 'utf8');
    check('the store reads the scale back at load and keeps it',
        /normalizeDrillTimeScale\(settings\.drill_time_scale\)/.test(store)
        && /set\(\{[^}]*atlasSettings, drillTimeScale, numberFormat[^}]*\}\);/.test(store));
    check('the store saves the scale under drill_time_scale',
        /saveSetting\(get, 'drill_time_scale', scale,/.test(store));
    const { settingSpec } = await import(pathToFileURL(fileURLToPath(new URL('../server/settingsSchema.js', import.meta.url))).href);
    const row = settingSpec('drill_time_scale');
    check('the scale is a row a learner may write', row?.writable === 'client' && row?.sensitivity === 'learning');
    const stores = (v) => { try { return row.validate(v) === v; } catch { return false; } };
    check('the server stores every scale the player offers, and nothing else',
        DRILL_TIME_SCALES.every(stores) && !stores('10') && !stores('slow'));
}

// --- a drill's last full round survives a reload -----------------------------
// The client names each drill (a hash of its fence, or the one flashcard drill)
// and the server stores the name with the round's evidence, but only a name that
// matches its own pattern. Two lists that must agree: a key the server drops is
// a score that silently never comes back.
section('A drill keeps its last full round');
{
    const { httpLayer } = await import('./lib/serverSource.mjs');
    const m = httpLayer().match(/const DRILL_KEY = \/(.+)\/;/);
    check('the server declares the drill-key pattern', !!m);
    const serverKey = m ? new RegExp(m[1]) : /$^/;
    const a = drillKeyOf('```drill\n{"items":[1]}\n```');
    const b = drillKeyOf('```drill\n{"items":[2]}\n```');
    check('a fence hashes to a key the server accepts', serverKey.test(a), a);
    check('the flashcard drill key is accepted too', serverKey.test(FLASHCARD_DRILL_KEY));
    check('the same fence always gets the same key', a === drillKeyOf('```drill\n{"items":[1]}\n```'));
    check('a rewritten drill is a different drill', a !== b);
    check('a made-up key is refused', !serverKey.test('../x') && !serverKey.test('f123') && !serverKey.test('cards2'));
    const launcher = readFileSync(fileURLToPath(new URL('../src/components/drills/DrillLauncher.tsx', import.meta.url)), 'utf8');
    const modal = readFileSync(fileURLToPath(new URL('../src/components/drills/DrillModal.tsx', import.meta.url)), 'utf8');
    check('the round is recorded WITH its key and its items', /recordDrillResult\(spec\.nodeId, result\.correct, result\.total, spec\.key, result\.items\)/.test(modal));
    check('the launcher reads the stored score back', /api\.getDrillScores\(spec\.nodeId\)/.test(launcher));
}

// --- the flashcard drill asks each card's own question -----------------------
// A course gives one topic cards of several kinds: listening cards (a sound, then
// the sentence), word cards both ways, de/het cards with a blank. The drill made
// from them once showed a listening card with no sound under "What is this?" and
// offered "лошадь", a rule explanation and "het podium" beside the one Dutch
// sentence, so the answer was the only option of its kind. The fixture below is
// that topic's shape.
section('The flashcard drill keeps each card its question and its kind');
{
    const { drillFromFlashcards } = await import(pathToFileURL(out).href);
    const audio = (n) => JSON.stringify({ front: [{ hash: String(n).repeat(64).slice(0, 64), kind: 'audio', name: `nl_${n}.mp3`, alt: '' }] });
    const LISTEN = '🎧 Послушай. Что сказал диктор?';
    let id = 1;
    const card = (front, back, extra_front = null, media = null) => ({ id: id++, node_id: 1, front, back, extra_front, media });
    const cards = [
        card(LISTEN, 'Onder de tafel ligt een bal. Hij is rond.', null, audio(1)),
        card(LISTEN, 'De bus komt. Hij is te laat.', null, audio(2)),
        card(LISTEN, 'Op het podium speelt een orkest.', null, audio(3)),
        card(LISTEN, 'Het paard loopt in de wei.', null, audio(4)),
        card(LISTEN, 'We gaan vandaag naar het park.', null, audio(5)),
        card('het paard', 'лошадь', 'переведите на русский'),
        card('de bal', 'мяч', 'переведите на русский'),
        card('de bus', 'автобус', 'переведите на русский'),
        card('het park', 'парк', 'переведите на русский'),
        card('лошадь', 'het paard', 'назовите слово вместе с артиклем'),
        card('мяч', 'de bal', 'назовите слово вместе с артиклем'),
        card('___ bal', 'de bal', 'de или het?'),
        card('___ paard', 'het paard', 'de или het?'),
        card('___ bus', 'de bus', 'de или het?'),
        card('___ park', 'het park', 'de или het?'),
        card('Каким местоимением заменяют предметы во множественном числе?', 'Ze, независимо от рода: de boeken → ze.'),
        card('Каким местоимением заменяют de-слово, а каким het-слово?', 'De-слово — hij, het-слово — het: de tafel → hij, het boek → het.'),
        card('Как hij и het выглядят в роли дополнения?', 'Hij → hem, het → het: ik zie hem (de sleutel), ik zie het (het boek).'),
    ];
    const spec = drillFromFlashcards(cards, 'hij вместо het', (s) => s);
    const byFront = (f, a) => spec.items.find(it => it.prompt === f && (!a || it.answer === a));
    const listen = byFront(LISTEN, 'Onder de tafel ligt een bal. Hij is rond.');
    const listenAnswers = new Set(cards.filter(c => c.front === LISTEN).map(c => c.back));
    const draws = (item) => Array.from({ length: 60 }, () => buildOptions(item, spec.items)).flat();

    check('a listening card keeps its sound in the drill', !!listen?.media && JSON.parse(listen.media).front[0].kind === 'audio');
    const strays = [...new Set(draws(listen))].filter(o => !listenAnswers.has(o));
    check('a listening card is offered only other heard sentences', strays.length === 0, strays.join(' | '));
    check('a listening card still gets four options', buildOptions(listen, spec.items).length === 4);

    check('the card drill puts no generic label over a card\'s own question', !spec.promptLabel, spec.promptLabel);

    const word = byFront('het paard');
    check('a card keeps the task line its author printed', word?.context === 'переведите на русский');
    const notRussian = [...new Set(draws(word))].filter(o => !/^[а-яё ,]+$/i.test(o));
    check('a word to translate is offered only translations', notRussian.length === 0, notRussian.join(' | '));

    const blank = byFront('___ bal');
    const blankOpts = new Set(draws(blank));
    check('a de/het blank is offered its own word with each article, nothing else',
        blankOpts.size === 2 && blankOpts.has('de bal') && blankOpts.has('het bal'), [...blankOpts].join(' | '));

    const rule = byFront('Каким местоимением заменяют de-слово, а каким het-слово?');
    const ruleAnswers = new Set(cards.filter(c => c.front.startsWith('Как')).map(c => c.back));
    const ruleStrays = [...new Set(draws(rule))].filter(o => !ruleAnswers.has(o));
    check('a rule question is offered only the other rules, even if that makes three options',
        ruleStrays.length === 0 && buildOptions(rule, spec.items).length === 3, ruleStrays.join(' | '));

    id = 100;
    const synonyms = drillFromFlashcards([
        card('конь', 'het paard', 'назовите слово'), card('лошадь', 'het paard', 'назовите слово'),
        card('шар', 'de bal', 'назовите слово'), card('мяч', 'de bal', 'назовите слово'),
        card('автобус', 'de bus', 'перевод'),
    ], 't', (s) => s);
    const thin = synonyms.items.filter(it => buildOptions(it, synonyms.items).length < 2).map(it => it.prompt);
    check('a card whose kind shares its answer still gets another option', thin.length === 0, thin.join(', '));
    const fourBlanks = drillFromFlashcards([card('___ bal', 'de bal', 'de или het?'), card('___ paard', 'het paard', 'de или het?'),
        card('___ bus', 'de bus', 'de или het?'), card('___ park', 'het park', 'de или het?')], 't', (s) => s);
    check('four cards are not read as one small fixed vocabulary', closedOptionSet(fourBlanks.items) === null);

    id = 200;
    const allDe = drillFromFlashcards([card('___ bal', 'de bal', 'de или het?'), card('___ bus', 'de bus', 'de или het?'),
        card('___ tafel', 'de tafel', 'de или het?'), card('лошадь', 'het paard', 'назовите слово'),
        card('театр', 'het theater', 'назовите слово')], 't', (s) => s);
    const allDeBal = allDe.items.find(it => it.prompt === '___ bal');
    const allDeOffers = new Set(Array.from({ length: 60 }, () => buildOptions(allDeBal, allDe.items)).flat());
    check('a blank whose siblings all take its article is offered the other article, never a whole answer',
        [...allDeOffers].sort().join('|') === 'de bal|het bal', [...allDeOffers].join(' | '));
    const verb = drillFromFlashcards([card('Ik ___ naar huis', 'Ik ga naar huis', 'вставьте глагол'),
        card('Ik ga naar huis', 'Я иду домой', 'переведите'), card('мяч', 'de bal', 'назовите слово'),
        card('лошадь', 'het paard', 'назовите слово')], 't', (s) => s);
    const loneFill = verb.items.find(it => it.prompt === 'Ik ___ naar huis');
    check('a blank with no other fill of its kind is typed (its answer alone), not offered another card',
        buildOptions(loneFill, verb.items).length === 1, buildOptions(loneFill, verb.items).join(' | '));

    const tiered = drillFromFlashcards([
        card('het paard', 'лошадь', 'переведите'), card('de bal', 'мяч', 'переведите'),
        card('het huis', 'дом', 'переведите'),
        card('Ik fiets naar school.', 'Я еду на велосипеде в школу каждый день.', 'переведите'),
        card('Het paard loopt in de wei.', 'Лошадь бежит по лугу очень быстро сегодня.', 'переведите'),
        card('De bal ligt onder de tafel.', 'Мяч лежит под столом в большой комнате.', 'переведите'),
    ], 't', (s) => s);
    const horse = tiered.items.find(it => it.prompt === 'het paard');
    const dropped = Array.from({ length: 200 }, () => buildOptions(horse, tiered.items))
        .filter(opts => !opts.includes('мяч') || !opts.includes('дом'));
    check('answers in the card\'s own shape come before other shapes of the same task',
        dropped.length === 0, `${dropped.length} of 200 draws left out a word: ${(dropped[0] ?? []).join(' | ')}`);

    const loneListen = drillFromFlashcards([card(LISTEN, 'Het paard is groot.', '', audio(9)),
        card('het paard', 'лошадь', 'переведите'), card('de bal', 'мяч', 'переведите'),
        card('Ik fiets naar school elke dag.', 'Я каждый день езжу в школу.', 'переведите'),
        card('мяч', 'de bal', 'назовите слово'), card('лошадь', 'het paard', 'назовите слово'),
        card('Hij ligt onder de tafel.', 'Hij ligt onder de tafel en rolt weg.', 'перепишите')], 't', (s) => s);
    const heard = loneListen.items.find(it => it.media);
    check('a lone listening card is typed, never offered an answer to a question it does not ask',
        buildOptions(heard, loneListen.items).length === 1, buildOptions(heard, loneListen.items).join(' | '));

    const ai = { prompt: 'x', answer: 'a' };
    const bank = [ai, { prompt: 'y', answer: 'b' }, { prompt: 'z', answer: 'c' }];
    check('a drill item with no pool still draws from the whole bank (AI drills)',
        new Set(Array.from({ length: 40 }, () => buildOptions(ai, bank)).flat()).size === 3);

    const player = readFileSync(fileURLToPath(new URL('../src/components/drills/DrillPlayer.tsx', import.meta.url)), 'utf8');
    check('the player plays the card\'s question-side sound as the item opens',
        /parseCardMedia\(currentItem\.media\)\.front/.test(player) && /<CardAudioProvider[^\n]*\sautoPlay>/.test(player));
    check('the player shows the card\'s own task line before the drill\'s label',
        /<MathText content=\{currentItem\.context \|\| spec\.promptLabel/.test(player));
    check('the player asks an item typed when its options hold the answer alone',
        /mode === 'choice' && currentItem && options\.length < 2 \? 'type' : mode/.test(player)
        && /\) : itemMode === 'choice' \? \(/.test(player));
}

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
