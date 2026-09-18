#!/usr/bin/env node
/**
 * Deterministic gates for the finished-project screen.
 *
 * Three things are checked here and they fail in three different ways:
 *
 *   **Is it finished?** The rule has to agree with `server/progress.js` exactly
 *   — including in the one case where the ring says 100% and the answer is no,
 *   because a 5,000-card deck one card short rounds up.
 *   **What did it take?** Counts that must never include an imported Anki
 *   revlog, never count a card rating twice, and never estimate.
 *   **Does it fit on the page?** The poster's layout is pure arithmetic over a
 *   text measurer, so a title in Russian, a title that is one unbreakable
 *   80-character word and a title of one letter can all be laid out here and
 *   asserted to be inside the frame — the failure a screenshot finds late.
 *
 * No model, no network, a throwaway database.
 *
 *   node tools/completion-gates.mjs
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const { createCanvas } = require('@napi-rs/canvas');

const scratch = mkdtempSync(join(tmpdir(), 'completion-gates-'));
process.env.DB_PATH = join(scratch, 'test.db');
// …and VAULT_ROOT, or the startup media sweep runs against the learner's own
// library. It has deleted 12,531 real files once already.
process.env.VAULT_ROOT = join(scratch, 'vault');

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const S = new URL('../server/', import.meta.url).href;
const db = (await import(S + 'database.js')).default;
const {
    projectCompletion, markCelebrated, celebratedProjects,
    bucketActivity, bucketSizeFor, activitySpan, MAX_BUCKETS, MIN_BUCKETS,
} = await import(S + 'completion.js');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; } else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const eq = (label, actual, expected) =>
    check(label, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
const section = (name) => console.log(`\n${name}`);

/* ── fixtures ────────────────────────────────────────────────────────────── */

const mkProject = (name, extra = {}) => Number(db.prepare(`
    INSERT INTO projects (name, color, icon, status, start_date, deadline)
    VALUES (?, '#3B82F6', 'folder', ?, ?, ?)
`).run(name, extra.status ?? 'active', extra.start ?? null, extra.deadline ?? null).lastInsertRowid);

const mkNode = (projectId, title, extra = {}) => Number(db.prepare(`
    INSERT INTO nodes (project_id, parent_id, title, status, is_note, position, role, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`).run(
    projectId, extra.parent ?? null, title, extra.status ?? 'not_started',
    extra.note ? 1 : 0, extra.position ?? 0, extra.role ?? 'topic', extra.completedAt ?? null,
).lastInsertRowid);

const mkCard = (nodeId, met) => Number(db.prepare(`
    INSERT INTO flashcards (node_id, front, back, review_count, last_reviewed)
    VALUES (?, 'q', 'a', ?, ?)
`).run(nodeId, met ? 1 : 0, met ? '2026-06-01T10:00:00Z' : null).lastInsertRowid);

const mkReview = (cardId, at, source = 'app') => db.prepare(`
    INSERT INTO review_log (card_id, reviewed_at, rating, source, external_id)
    VALUES (?, ?, 3, ?, ?)
`).run(cardId, at, source, source === 'app' ? null : `ext-${cardId}-${at}-${Math.random()}`);

const mkEvidence = (nodeId, at, { type = 'quiz', score = 8, total = 10 } = {}) => db.prepare(`
    INSERT INTO mastery_evidence (node_id, evidence_type, score, total, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
`).run(nodeId, type, score, total, JSON.stringify({ source: 'feed' }), at);

/* ── is it finished? ─────────────────────────────────────────────────────── */
section('finished, and the cases where 100% is not');

{
    const empty = mkProject('nothing in it');
    const c = projectCompletion(empty);
    check('a project with no topics and no cards is never finished', c.complete === false);
    eq('…and its progress is zero, not NaN', c.work.fraction, 0);
}

{
    const course = mkProject('two topics');
    const a = mkNode(course, 'one');
    const b = mkNode(course, 'two');
    check('an open course is not finished', projectCompletion(course).complete === false);
    db.prepare(`UPDATE nodes SET status = 'completed', completed_at = '2026-06-02T09:00:00Z' WHERE id = ?`).run(a);
    check('half of it is still not finished', projectCompletion(course).complete === false);
    db.prepare(`UPDATE nodes SET status = 'completed', completed_at = '2026-06-05T09:00:00Z' WHERE id = ?`).run(b);
    const done = projectCompletion(course);
    check('closing the last topic finishes it', done.complete === true);
    eq('and the progress rule agrees', Math.round(done.work.fraction * 100), 100);
    eq('both topics counted as proven', done.work.topics.completed, 2);
    eq('none skipped', done.work.topics.skipped, 0);
}

{
    // The whole reason this is not a comparison against the rounded percentage.
    const deck = mkProject('a big deck');
    const stage = mkNode(deck, 'Stage 1', { role: 'pagination' });
    for (let i = 0; i < 5168; i++) mkCard(stage, i < 5167);
    const almost = projectCompletion(deck);
    eq('5,167 of 5,168 cards rounds to 100% on the card', Math.round(almost.work.fraction * 100), 100);
    check('…and is NOT finished', almost.complete === false);
    db.prepare(`UPDATE flashcards SET review_count = 1, last_reviewed = '2026-06-09T10:00:00Z'
                WHERE node_id = ? AND review_count = 0`).run(stage);
    check('the last card finishes it', projectCompletion(deck).complete === true);
}

{
    // The same near-miss on the OTHER code path. A pagination stage is not a
    // work leaf, so the deck above never went through the per-topic rule at all
    // — and a "finished means roughly 100%" mutation survived the suite until
    // this case existed. A topic held in cards is the path that rule is on.
    const course = mkProject('a topic held in cards');
    const topic = mkNode(course, 'Vocabulary');
    for (let i = 0; i < 5168; i++) mkCard(topic, i < 5167);
    const almost = projectCompletion(course);
    eq('a topic 1 card short of its 5,168 rounds to 100%', Math.round(almost.work.fraction * 100), 100);
    check('…and the topic is not finished', almost.complete === false);
    db.prepare(`UPDATE flashcards SET review_count = 1, last_reviewed = '2026-06-09T10:00:00Z'
                WHERE node_id = ? AND review_count = 0`).run(topic);
    check('meeting the last card finishes the topic', projectCompletion(course).complete === true);
}

{
    const skipped = mkProject('skipped end to end');
    const a = mkNode(skipped, 'one');
    const b = mkNode(skipped, 'two');
    db.prepare(`UPDATE nodes SET status = 'skipped' WHERE id IN (?, ?)`).run(a, b);
    const c = projectCompletion(skipped);
    eq('skipping everything still reads 100%', Math.round(c.work.fraction * 100), 100);
    check('…but never opens the screen: nothing was actually done', c.complete === false);
    eq('and the skipped count is kept, to be said out loud', c.work.topics.skipped, 2);
}

{
    const mixed = mkProject('one skipped, one proven');
    const a = mkNode(mixed, 'one', { status: 'completed', completedAt: '2026-06-03T09:00:00Z' });
    mkNode(mixed, 'two', { status: 'skipped' });
    mkCard(a, true);
    const c = projectCompletion(mixed);
    check('a course finished with one skip IS finished', c.complete === true);
    eq('…and says how many were skipped', c.work.topics.skipped, 1);
    eq('…without folding them into the proven count', c.work.topics.completed, 1);
}

{
    const notes = mkProject('notes are not work');
    const parent = mkNode(notes, 'topic', { status: 'completed', completedAt: '2026-06-04T09:00:00Z' });
    mkNode(notes, 'reading', { parent, note: true });
    const c = projectCompletion(notes);
    check('a topic whose only children are notes is still a leaf', c.complete === true);
    eq('…and counts once', c.work.topics.total, 1);
}

/* ── what did it take? ───────────────────────────────────────────────────── */
section('counts that must not be inflated');

const effortProject = mkProject('effort', { deadline: '2026-06-30' });
{
    const topic = mkNode(effortProject, 'topic', { status: 'completed', completedAt: '2026-06-10T08:00:00Z' });
    const card = mkCard(topic, true);
    for (const day of ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-08']) {
        mkReview(card, `${day}T10:00:00Z`);
        mkReview(card, `${day}T10:05:00Z`);
    }
    // An imported Anki revlog: the learner's history, but not work done here.
    mkReview(card, '2019-04-04T10:00:00Z', 'anki');
    mkReview(card, '2019-04-05T10:00:00Z', 'anki');
    mkEvidence(topic, '2026-06-02T11:00:00Z', { score: 9, total: 10 });
    // Card evidence is a batch of ratings already counted as reviews.
    mkEvidence(topic, '2026-06-02T11:30:00Z', { type: 'flashcard', score: 18, total: 20 });

    const c = projectCompletion(effortProject);
    eq('reviews count rows this app wrote', c.effort.reviews, 8);
    eq('…and not the imported revlog', c.effort.cardsSeen, 1);
    eq('answers exclude card-derived evidence', c.effort.answers, 10);
    eq('…and so does the correct count', c.effort.correct, 9);
    eq('accuracy is the ratio of those two', Math.round((c.effort.accuracy ?? 0) * 100), 90);
    eq('the span starts at the first day of work HERE', c.span.firstDay, '2026-06-01');
    eq('…and ends at the last', c.span.lastDay, '2026-06-10');
    eq('days with any activity', c.span.studyDays, 5);
    eq('calendar days from end to end', c.span.calendarDays, 10);
    eq('the longest unbroken run', c.span.longestStreak, 3);
    eq('the busiest day is the one with the most records', c.span.bestDay.date, '2026-06-02');
    eq('…counting every record on it', c.span.bestDay.count, 3);
    eq('early is measured to the last day of work, not to today', c.schedule.daysEarly, 20);
}

{
    const quiet = mkProject('never answered anything');
    const topic = mkNode(quiet, 'topic', { status: 'completed', completedAt: '2026-06-01T09:00:00Z' });
    mkCard(topic, true);
    const c = projectCompletion(quiet);
    eq('no questions asked is null accuracy, not 0%', c.effort.accuracy, null);
    eq('no deadline is no schedule line', c.schedule, null);
}

/* ── the dismissal, and getting the ending back ──────────────────────────── */
section('seen once, and offered again if it is finished again');

{
    const again = mkProject('finished twice');
    const a = mkNode(again, 'one', { status: 'completed', completedAt: '2026-06-01T09:00:00Z' });
    check('finished', projectCompletion(again).complete === true);
    check('not yet seen', projectCompletion(again).celebrated === false);
    markCelebrated(again);
    check('seen', projectCompletion(again).celebrated === true);
    check('the set holds it', celebratedProjects().has(again));

    mkNode(again, 'a new chapter');
    check('adding a topic unfinishes it', projectCompletion(again).complete === false);
    check('…which forgets the dismissal, so the next ending is shown', celebratedProjects().has(again) === false);

    db.prepare(`UPDATE nodes SET status = 'completed', completed_at = '2026-07-01T09:00:00Z'
                WHERE project_id = ? AND status != 'completed'`).run(again);
    const second = projectCompletion(again);
    check('finishing it again is a fresh ending', second.complete === true && second.celebrated === false);
    check('the first topic is still counted', second.work.topics.completed === 2, String(a));
}

/* ── the chart's arithmetic ──────────────────────────────────────────────── */
section('the activity series');

const daysFrom = (start, count, step = 1) => Array.from({ length: count }, (_, i) => ({
    day: new Date(Date.parse(`${start}T00:00:00Z`) + i * step * 86_400_000).toISOString().slice(0, 10),
    n: i + 1,
}));

check('two days of work draw no chart — a sentence says it better',
    bucketActivity(daysFrom('2026-06-01', 2)) === null);
check('three do', bucketActivity(daysFrom('2026-06-01', 3))?.buckets.length === 3);

for (const spanDays of [3, 7, 29, 30, 31, 60, 90, 180, 365, 900, 3650]) {
    const rows = [{ day: '2024-01-01', n: 1 }, {
        day: new Date(Date.parse('2024-01-01T00:00:00Z') + (spanDays - 1) * 86_400_000).toISOString().slice(0, 10),
        n: 1,
    }];
    const chart = bucketActivity(rows);
    check(`a ${spanDays}-day span fits the bar budget`,
        chart != null && chart.buckets.length <= MAX_BUCKETS && chart.buckets.length >= MIN_BUCKETS,
        `${chart?.buckets.length} bars of ${chart?.days}d`);
}

{
    const rows = daysFrom('2026-01-01', 200);
    const chart = bucketActivity(rows);
    const charted = chart.buckets.reduce((a, b) => a + b.count, 0);
    const real = rows.reduce((a, b) => a + b.n, 0);
    eq('bucketing loses nothing', charted, real);
    eq('the first bucket starts on the first day', chart.buckets[0].start, '2026-01-01');
    check('and the last bucket holds the last day',
        Date.parse(`${chart.buckets[chart.buckets.length - 1].start}T00:00:00Z`) + chart.days * 86_400_000
        > Date.parse('2026-07-19T00:00:00Z'));
}

eq('one day of work is one bucket wide', bucketSizeFor(1), 1);
check('a decade still buckets', bucketSizeFor(3650) >= 180);

{
    const span = activitySpan([
        { day: '2026-03-01', n: 5 }, { day: '2026-03-02', n: 40 }, { day: '2026-03-03', n: 1 },
        { day: '2026-03-09', n: 2 },
    ]);
    eq('the streak breaks on a gap', span.longestStreak, 3);
    eq('the busiest day is the busiest, not the last', span.bestDay.date, '2026-03-02');
    eq('study days are days, not records', span.studyDays, 4);
}
check('no activity at all has no span', activitySpan([]) === null);

/* ── what the screen says ────────────────────────────────────────────────── */
section('the tiles and the sentence');

const stub = join(scratch, 'stub.js');
writeFileSync(stub, 'export const api = {};\nexport const k = (s) => s;\nexport default {};\n');
async function bundleClient(entry) {
    const outfile = join(scratch, entry.replace(/[\\/]/g, '_').replace(/\.tsx?$/, '.mjs'));
    await esbuild.build({
        entryPoints: [join(repoRoot, entry)],
        bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent',
        plugins: [{
            name: 'stub-runtime',
            setup(build) { build.onResolve({ filter: /(^|\/)(api|i18n)$/ }, () => ({ path: stub })); },
        }],
    });
    return outfile;
}

const summary = await import(pathToFileURL(await bundleClient('src/components/completion/summary.ts')).href);
const cert = await import(pathToFileURL(await bundleClient('src/components/completion/certificate.ts')).href);

// An identity translator with visible interpolation: a gate must never assert
// English, only that the right VALUES reach the right slot.
const text = {
    t: (key, vars) => String(key).replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars?.[k] ?? `{{${k}}}`)),
    num: (v) => String(v),
    date: (d) => d,
    shortDate: (d) => d,
};

{
    const rich = projectCompletion(effortProject);
    const stats = summary.completionStats(rich, text);
    check('the tiles stop at six', stats.length <= summary.MAX_STATS, String(stats.length));
    check('no tile reads a number nobody measured', stats.every(s => s.value !== '' && s.value != null));
    check('topics come first', stats[0].key === 'topics');

    const quiet = projectCompletion(mkProject('quiet'));
    check('a project with nothing in it offers no tiles', summary.completionStats(quiet, text).length === 0);

    const deckOnly = mkProject('cards only');
    const stage = mkNode(deckOnly, 'Stage 1', { role: 'pagination' });
    mkCard(stage, true);
    const deckStats = summary.completionStats(projectCompletion(deckOnly), text);
    check('a deck has no topic tile', deckStats.every(s => s.key !== 'topics'));
    check('…and no accuracy tile, because nothing was asked',
        deckStats.every(s => s.key !== 'accuracy'));

    const eyebrow = summary.completionEyebrow(projectCompletion(deckOnly), text);
    check('a collection of cards is not called a course', /Deck/.test(eyebrow), eyebrow);

    const story = summary.completionStory(rich, text);
    check('the sentence names both ends of the span', story.includes('2026-06-01') && story.includes('2026-06-10'), story);
    check('…and how it sat against the plan', /before the date you set/.test(story), story);

    const skippedOne = projectCompletion(
        db.prepare('SELECT id FROM projects WHERE name = ?').get('one skipped, one proven').id,
    );
    check('a skip is stated in the footnote', summary.completionFootnote(skippedOne, text).includes('1'));
    // …and is not quietly added to the headline. Both projects have two topics;
    // only one of them proved both, and the tiles have to be able to say so.
    const skippedTile = summary.completionStats(skippedOne, text).find(s => s.key === 'topics');
    eq('the topics tile counts what was PROVEN', skippedTile.value, '1');
    eq('…and not what the project contains', skippedOne.work.topics.total, 2);
    eq('…and nothing is said when nothing was skipped', summary.completionFootnote(rich, text), '');
}

/* ── the poster fits ─────────────────────────────────────────────────────── */
section('the poster');

const probe = createCanvas(8, 8).getContext('2d');
const measure = cert.measurerFor(probe);
const palette = {
    bg: '#ffffff', fg: '#0f172a', muted: '#64748b', border: '#e2e8f0',
    accent: '#7c3aed', accentFg: '#ffffff',
};
const baseContent = {
    emoji: '📘', eyebrow: 'Course complete', title: 'A short name',
    subtitle: '14 September 2026',
    stats: [{ value: '48', label: 'topics finished' }, { value: '3,412', label: 'card reviews' }],
    story: 'Ninety days from June to September.', caption: 'Busiest day 3 Aug',
    chart: { buckets: [3, 0, 9, 4], startLabel: '1 Jun', endLabel: '14 Sep' },
};

const POSTER_CASES = {
    'a one-letter name': { title: 'A' },
    'a long Russian name': {
        title: 'Универсальная программа технических наук: интегрированный путь 4TU и RUG',
        eyebrow: 'Курс завершён',
    },
    'one unbreakable 80-character word': { title: 'x'.repeat(80) },
    'a name of two hundred characters': { title: 'Advanced '.repeat(22) },
    'no chart at all': { chart: null, caption: '', story: '' },
    'thirty buckets': { chart: { buckets: Array.from({ length: 30 }, (_, i) => i % 5), startLabel: '1 Jan 2024', endLabel: '14 Sep 2026' } },
    'a single bucket': { chart: { buckets: [7], startLabel: '1 Jun', endLabel: '1 Jun' } },
    'six statistics': {
        stats: Array.from({ length: 6 }, (_, i) => ({ value: String(1000 + i), label: `a statistic number ${i}` })),
    },
    'one statistic': { stats: [{ value: '1', label: 'card met' }] },
    'no statistics at all': { stats: [] },
    'no emoji on this machine': { emoji: '' },
};

for (const [name, patch] of Object.entries(POSTER_CASES)) {
    const content = { ...baseContent, ...patch };
    const layout = cert.layoutCertificate(content, measure);
    const left = layout.inner.x;
    const right = layout.inner.x + layout.inner.w;

    check(`${name}: the poster has a real height`, layout.height > 400 && layout.height < 4000, String(layout.height));
    check(`${name}: the title stays inside the frame`,
        layout.titleLines.every(line => measure(line, layout.titleSize, 600) <= layout.inner.w + 0.5),
        layout.titleLines.map(l => Math.round(measure(l, layout.titleSize, 600))).join(','));
    check(`${name}: the title is at most three lines`, layout.titleLines.length <= 3, String(layout.titleLines.length));
    // Cutting a name is the last resort, not the first. An unbreakable word is
    // always going to lose its tail, but it must lose it at the SMALLEST size —
    // fitting by line count alone truncates it at 66px and throws away twice as
    // much of the name for no reason, which the "inside the frame" check above
    // cannot see.
    if (layout.titleLines.some(line => line.endsWith('…'))) {
        check(`${name}: a cut title was shrunk as far as it goes first`,
            layout.titleSize === Math.min(...cert.TITLE_SIZES), `cut at ${layout.titleSize}px`);
    }
    check(`${name}: every statistic sits between the margins`,
        layout.stats.every(s => s.x > left && s.x < right));
    check(`${name}: nothing is drawn below the frame`,
        layout.stats.every(s => s.y < layout.height)
        && layout.storyY <= layout.height
        && (!layout.chart || layout.chart.y + layout.chart.h <= layout.height));
    if (layout.chart) {
        const bars = layout.chart.bars;
        check(`${name}: the bars fill the width exactly`,
            bars[0].x >= left - 0.5 && bars[bars.length - 1].x + bars[bars.length - 1].w <= right + 0.5,
            `${bars[0].x} → ${bars[bars.length - 1].x + bars[bars.length - 1].w} in ${left}…${right}`);
        check(`${name}: every bar is drawable`, bars.every(b => b.w > 0 && b.h > 0));
        check(`${name}: a bar never escapes its box`,
            bars.every(b => b.y >= layout.chart.y - 0.5 && b.y + b.h <= layout.chart.y + layout.chart.h + 0.5));
    }

    // …and it really paints. A layout that is arithmetically fine and throws on
    // an empty string is still a broken download button.
    const canvas = createCanvas(layout.width, layout.height);
    let painted = true;
    try { cert.paintCertificate(canvas.getContext('2d'), layout, content, palette); } catch (e) { painted = false; console.log(`        ${e.message}`); }
    check(`${name}: paints without throwing`, painted);
    const png = canvas.toBuffer('image/png');
    check(`${name}: the picture is not blank`, png.length > 2000, `${png.length} bytes`);

    // The tick on the badge went out twice in one sitting, painted in the
    // accent ON the accent — invisible, and invisible in a way no layout
    // assertion can see. So this one is a PIXEL check: read the badge back off
    // the canvas and demand more than one colour in it.
    if (content.emoji) {
        const bx = Math.round(layout.disc.cx + layout.disc.r * 0.72);
        const by = Math.round(layout.disc.cy + layout.disc.r * 0.72);
        const size = 34;
        const pixels = canvas.getContext('2d').getImageData(bx - size / 2, by - size / 2, size, size).data;
        const seen = new Set();
        for (let i = 0; i < pixels.length; i += 4) {
            seen.add(`${pixels[i] >> 4},${pixels[i + 1] >> 4},${pixels[i + 2] >> 4}`);
        }
        check(`${name}: the tick on the badge is actually visible`, seen.size >= 3, `${seen.size} colours in the badge`);
    }
}

/* ── done ────────────────────────────────────────────────────────────────── */
console.log(`\n${pass} passed, ${fail} failed`);
try { db.close(); } catch { /* already closed */ }
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* Windows holds the wal briefly */ }
process.exit(fail === 0 ? 0 : 1);
