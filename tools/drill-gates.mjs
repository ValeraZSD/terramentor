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
const { closedOptionSet, buildOptions, parseDrillSpec, answersMatch, drillBarFill, drillKeyOf, FLASHCARD_DRILL_KEY } = await import(pathToFileURL(out).href);

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
    check('the round is recorded WITH its key', /recordDrillResult\(spec\.nodeId, result\.correct, result\.total, spec\.key\)/.test(modal));
    check('the launcher reads the stored score back', /api\.getDrillScores\(spec\.nodeId\)/.test(launcher));
}

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
