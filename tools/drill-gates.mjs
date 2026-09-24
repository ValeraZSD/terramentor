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
// No DOM, no model, no network.

import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
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
    // independent shuffles agree by chance about one run in sixteen, and this
    // assertion failed that often — a gate that cries wolf teaches people to
    // re-run the suite until it is green. Over 40 draws a shuffling
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
    // the bank, not from the item being asked, and it does not shuffle. (This
    // line used to assert case-insensitive dedup, which is what the check three
    // assertions below says, and nothing about order at all.)
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
    // checking — the label jumped back to "5s" on every press.
    const player = readFileSync(fileURLToPath(new URL('../src/components/drills/DrillPlayer.tsx', import.meta.url)), 'utf8');
    check('the player stops the clock on an answer instead of clearing it',
        /if \(feedback \|\| checking\) return;/.test(player)
        && !/setRemaining\(seconds && phase === 'playing' && !feedback \? seconds : null\)/.test(player));
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
    const index = readFileSync(fileURLToPath(new URL('../server/index.js', import.meta.url)), 'utf8');
    const m = index.match(/const DRILL_KEY = \/(.+)\/;/);
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
