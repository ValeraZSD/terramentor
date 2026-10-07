// tools/study-time-gates.mjs — the time a learner actually spent studying.
//
// Run:  node tools/study-time-gates.mjs
//
// WHY. "How long did this topic take me, and how long do I study a day" had
// no answer: `learning_sessions` existed from the first schema, a route wrote
// to it, and nothing in the app ever called that route — so the
// finished-project screen said, truthfully, that no time figure existed.
//
// What is counted is ACTIVE time, by one rule a learner can be told in a
// sentence (TimeMe.js and Moodle's course-dedication block measure the same
// way; this is ours, not theirs): the clock runs while a screen that teaches
// is in front of you and you are using it. Time between two of your actions
// counts when the pause is short; a longer pause counts NOTHING — the clock
// stopped at your last action — and leaving the window ends the count where
// you left. So a lesson read without touching anything for two minutes
// counts, and a laptop left open over lunch does not.
//
// Four halves:
//   1. THE CLOCK (`src/utils/studyTime.ts`, pure, driven here with explicit
//      times): the pause rule, leaving and coming back, a target that changes
//      in the middle of a pause, layers (a dialog over the feed is not the
//      feed), the hour split, the take/restore a failed send needs.
//   2. THE RECORD (`server/studyTime.js`, a scratch library): what a flush may
//      write, that the same flush twice writes once, the per-hour ceiling,
//      what is refused and counted, a deleted topic taking its time with it.
//   3. THE READINGS: a topic with everything under it, a project by day and by
//      topic, one day of the ledger, the finished-project screen — and the
//      date the clock started, so a course begun before it is never shown a
//      total that pretends to be all of it.
//   4. THE WIRING: every surface that teaches claims the clock, a dialog
//      pauses it, a widget's frame reports its use, and the old dead table and
//      route are gone — the last proved by booting a SECOND process.

import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');

const scratch = mkdtempSync(join(tmpdir(), 'study-time-gates-'));
process.env.DB_PATH = join(scratch, 'test.db');
process.env.VAULT_ROOT = join(scratch, 'vault');
delete process.env.AI_API_KEY; delete process.env.OPENAI_API_KEY; delete process.env.AI_BASE_URL;

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const src = (p) => readFileSync(join(repoRoot, p), 'utf8');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const eq = (label, got, want) => check(label, Object.is(got, want) || JSON.stringify(got) === JSON.stringify(want),
    `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const section = (s) => console.log(`\n--- ${s} ---`);

const stub = join(scratch, 'stub.js');
writeFileSync(stub, "export const uiLocale = () => 'en-US';\nexport const k = (s) => s;\nexport default {};\n");
async function bundleClient(entry) {
    const outfile = join(scratch, entry.replace(/[\\/]/g, '_').replace(/\.tsx?$/, '.mjs'));
    await esbuild.build({
        entryPoints: [join(repoRoot, entry)],
        bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent',
        plugins: [{
            name: 'stub-runtime',
            setup(build) { build.onResolve({ filter: /(^|\/)(i18n|locale)$/ }, () => ({ path: stub })); },
        }],
    });
    return outfile;
}

const T = await import(pathToFileURL(await bundleClient('src/utils/studyTime.ts')).href);
const { createStudyClock, PAUSE_LIMIT_MS, splitByHour, hourKey, feedCardActivity, formatStudyTime, sumForDay } = T;

const S = 1000, M = 60 * S, H = 60 * M;
const T0 = Date.parse('2026-10-04T09:00:00Z');
const A = { nodeId: 11, activity: 'reading' };
const B = { nodeId: 12, activity: 'questions' };
const C = { nodeId: 13, activity: 'cards' };
/** Total credited per node id, from a clock's committed entries. */
const credited = (clock) => {
    const out = {};
    for (const e of clock.pending()) out[e.nodeId] = (out[e.nodeId] || 0) + e.ms;
    return out;
};
/** A clock that is present and studying `target` from `at`. */
function studying(target, at = T0, layer = 'page') {
    const clock = createStudyClock();
    clock.claim(1, target, layer, at);
    clock.arrive(at);
    clock.act(at);
    return clock;
}

// ============================================================================
section('1. the clock: what counts');
{
    const c = studying(A);
    for (let t = 30 * S; t <= 3 * M; t += 30 * S) c.act(T0 + t);
    eq('three minutes of reading with a scroll every 30 s is three minutes', credited(c), { 11: 3 * M });
}
{
    const limit = PAUSE_LIMIT_MS.reading;
    check('the reading pause limit is minutes, not seconds', limit >= 2 * M && limit <= 5 * M, String(limit));
    const c = studying(A);
    c.act(T0 + limit);
    eq('a pause exactly at the limit counts', credited(c), { 11: limit });
    const d = studying(A);
    d.act(T0 + limit + 1);
    eq('a pause one ms past the limit counts NOTHING', credited(d), {});
    d.act(T0 + limit + 1 + 30 * S);
    eq('…and the clock restarts at the action that ended it', credited(d), { 11: 30 * S });
}
{
    const c = studying(A);
    c.act(T0 + 40 * S);
    c.leave(T0 + 90 * S);
    eq('leaving counts up to the moment you left', credited(c), { 11: 90 * S });
    c.act(T0 + 3 * M);
    eq('an action while away (a mouse crossing the unfocused window) counts nothing', credited(c), { 11: 90 * S });
    c.arrive(T0 + 10 * M);
    c.act(T0 + 10 * M + 20 * S);
    eq('coming back counts from the return, never the time away', credited(c), { 11: 110 * S });
}
{
    const c = studying(A);
    c.leave(T0 + PAUSE_LIMIT_MS.reading + 5 * S);
    eq('leaving after a long still pause adds nothing (the lunch-break case)', credited(c), {});
    check('…and the clock is away', c.isPresent() === false);
}
{
    const c = studying(A);
    c.claim(1, B, 'page', T0 + 20 * S);     // the card on screen changed (no action of its own)
    c.act(T0 + 50 * S);
    eq('a target change inside a pause splits it: 20 s to the first, 30 s to the second', credited(c), { 11: 20 * S, 12: 30 * S });
}
{
    const c = studying(A);
    c.claim(1, B, 'page', T0 + 60 * S);     // new cards appended, the topmost moved
    c.leave(T0 + 20 * M);
    eq('a target change is not an action: with nothing after it, nothing is credited', credited(c), {});
}
{
    const c = studying(C);
    c.act(T0 + PAUSE_LIMIT_MS.cards + 10 * S);
    eq('cards have a shorter pause limit than reading', credited(c), {});
    check('cards < reading ≤ questions < paper',
        PAUSE_LIMIT_MS.cards < PAUSE_LIMIT_MS.reading && PAUSE_LIMIT_MS.reading <= PAUSE_LIMIT_MS.questions
        && PAUSE_LIMIT_MS.questions < PAUSE_LIMIT_MS.paper);
    const p = studying({ nodeId: 14, activity: 'paper' });
    p.act(T0 + 20 * M);
    eq('twenty minutes working on paper without touching the screen counts', credited(p), { 14: 20 * M });
}
{
    const c = studying(C);
    c.claim(1, A, 'page', T0 + 10 * S);
    c.act(T0 + PAUSE_LIMIT_MS.cards + 30 * S);
    eq('a pause that spans two activities is judged by the longer limit', credited(c), {
        13: 10 * S, 11: PAUSE_LIMIT_MS.cards + 20 * S,
    });
}
{
    const c = studying(A);
    c.claim(2, null, 'dialog', T0 + 10 * S);
    c.act(T0 + 40 * S);
    eq('a dialog over the page (the day\'s ledger, Settings) is not the page: 10 s, not 40', credited(c), { 11: 10 * S });
    c.claim(3, B, 'session', T0 + 50 * S);
    c.act(T0 + 80 * S);
    eq('a learning session above a dialog owns the clock', credited(c), { 11: 10 * S, 12: 30 * S });
    c.release(3, T0 + 90 * S);
    c.release(2, T0 + 90 * S);
    c.act(T0 + 100 * S);
    eq('closing both hands it back to the page', credited(c), { 11: 20 * S, 12: 40 * S });
    eq('current() names the page again', c.current(), A);
}
{
    const c = studying(A);
    c.claim(5, null, 'page', T0 + 5 * S);    // a second page claim, mounted later, with nothing to study
    c.act(T0 + 20 * S);
    eq('the LATEST claim on a layer wins, even when it has nothing to study', credited(c), { 11: 5 * S });
}
{
    const c = createStudyClock();
    c.arrive(T0);
    c.act(T0);
    c.act(T0 + M);
    eq('no claim at all: nothing is studied, nothing counts', credited(c), {});
}
{
    const c = studying(A, Date.parse('2026-10-04T10:59:30Z'));
    c.act(Date.parse('2026-10-04T11:00:30Z'));
    eq('a span across an hour boundary is split into both hours', c.pending().map(e => [e.hour, e.ms]),
        [['2026-10-04T10', 30 * S], ['2026-10-04T11', 30 * S]]);
    eq('splitByHour over three hours', splitByHour(Date.parse('2026-10-04T22:30:00Z'), Date.parse('2026-10-05T00:10:00Z')),
        [{ hour: '2026-10-04T22', ms: 30 * M }, { hour: '2026-10-04T23', ms: H }, { hour: '2026-10-05T00', ms: 10 * M }]);
    eq('hourKey is the UTC hour', hourKey(Date.parse('2026-10-04T23:59:59.999Z')), '2026-10-04T23');
}
{
    const c = studying(A);
    c.act(T0 + 30 * S);
    c.act(T0 + 60 * S);
    eq('repeated credits to one topic and hour merge into one entry', c.pending().length, 1);
    const taken = c.take();
    eq('take() hands the entries over and empties the clock', [taken.length, c.pending().length], [1, 0]);
    c.act(T0 + 90 * S);
    c.restore(taken);
    eq('restore() merges a failed batch back with what came since', c.pending().map(e => e.ms), [90 * S]);
    eq('sumForDay counts one UTC day', sumForDay(c.pending(), '2026-10-04'), 90 * S);
    eq('…and not another', sumForDay(c.pending(), '2026-10-05'), 0);
}
{
    const c = studying(A);
    c.act(T0 + 100 * S);
    let threw = false;
    try { c.act(T0 + 50 * S); c.act(T0 + 70 * S); } catch { threw = true; }
    check('a clock that steps backwards credits nothing for the step and does not throw', !threw);
    eq('…and counts again from the step', credited(c), { 11: 100 * S + 20 * S });
}
{
    eq('a lesson is reading', feedCardActivity('lesson'), 'reading');
    eq('a question is questions', feedCardActivity('question'), 'questions');
    eq('a recall question is questions', feedCardActivity('recall'), 'questions');
    eq('a flashcard is cards', feedCardActivity('flashcard'), 'cards');
    eq('a written exercise is paper', feedCardActivity('practice'), 'paper');
    eq('the checkpoint is part of the chapter it closes', feedCardActivity('checkpoint'), 'reading');
    eq('a notice teaches nothing', feedCardActivity('notice'), null);
}

// ============================================================================
section('1b. saying a duration');
{
    const less = 'less than a minute';
    eq('nothing is an empty string, never "0 min"', formatStudyTime(0, 'en', less), '');
    eq('20 seconds', formatStudyTime(20 * S, 'en', less), less);
    eq('90 seconds rounds to 2 min', formatStudyTime(90 * S, 'en', less), '2 min');
    eq('59 min 40 s is an hour', formatStudyTime(59 * M + 40 * S, 'en', less), '1 hr');
    eq('1 h 2 min, Russian', formatStudyTime(H + 2 * M, 'ru', less), '1 ч 2 мин');
    eq('compact (a tile): ten hours and up are whole hours', formatStudyTime(152 * H + 25 * M, 'pl', less, { compact: true }), '152 godz.');
    eq('…rounded, not cut', formatStudyTime(12 * H + 40 * M, 'en', less, { compact: true }), '13 hr');
    {
        // WHAT is asked for, not ICU's wording of it. The words belong to the
        // runtime: Node 22 has no Intl.DurationFormat and the fallback says
        // "1 hr 2 min", Node 24's ICU says "1 hr, 2 min", and a browser says
        // whatever its own ICU says. These pinned the comma and went red on the
        // Linux runners on 2026-10-07; the decision this code makes is which
        // units, rounded how, in which style — so that is what a recording
        // stand-in for DurationFormat pins, on every runtime alike.
        const saved = Intl.DurationFormat;
        Intl.DurationFormat = class {
            constructor(locale, options) { this.locale = locale; this.style = options?.style; }
            format(parts) { return JSON.stringify({ locale: this.locale, style: this.style, ...parts }); }
        };
        try {
            const asked = (ms, opts) => JSON.parse(formatStudyTime(ms, 'en', less, opts));
            eq('1 h 2 min asks for hours and minutes, short', asked(H + 2 * M + 5 * S), { locale: 'en', style: 'short', hours: 1, minutes: 2 });
            eq('152 hours stays hours (no days)', asked(152 * H + 5 * M), { locale: 'en', style: 'short', hours: 152, minutes: 5 });
            eq('…and under ten hours the minutes stay', asked(9 * H + 40 * M, { compact: true }), { locale: 'en', style: 'short', hours: 9, minutes: 40 });
            eq('under an hour is minutes alone', asked(42 * M), { locale: 'en', style: 'short', minutes: 42 });
        } finally {
            Intl.DurationFormat = saved;
        }
    }
    {
        // Every interface language's compact tile value FITS the poster's tile
        // (456px wide, 432px of it for the value).
        // How wide it comes out is the reader's system font: "9 godz. i 45 min"
        // measured 408px on Windows (Segoe UI, Node 24.14) and the widest was
        // 504px on the Linux runner (a wider fallback, Node 24.21), against a
        // 456px tile — so the
        // poster fits each value at layout time (`fitSize`), and this checks
        // the fit with whatever font this machine has AND with a deliberately
        // wide stand-in, so neither result depends on the machine.
        const { createCanvas } = require('@napi-rs/canvas');
        const cert = await import(pathToFileURL(await bundleClient('src/components/completion/certificate.ts')).href);
        const ctx = createCanvas(10, 10).getContext('2d');
        const values = ['en', 'de', 'es', 'fr', 'it', 'ja', 'nl', 'pl', 'pt', 'ru', 'uk', 'zh']
            .flatMap(l => [152 * H + 25 * M, 9 * H + 45 * M].map(ms => formatStudyTime(ms, l, less, { compact: true })));
        const content = {
            title: 'A course', eyebrow: 'Finished', subtitle: '2026', icon: null, emoji: '', caption: '', story: '', chart: null,
            stats: values.map(value => ({ value, label: 'studied' })),
        };
        const real = cert.measurerFor(ctx);
        const wide = (text, px) => String(text).length * px * 0.75;
        for (const [name, measure] of [['this machine\'s font', real], ['a font 0.75 em a character', wide]]) {
            const layout = cert.layoutCertificate(content, measure);
            const room = layout.stats[0].w - 24;
            const over = layout.stats.filter(s => !Number.isFinite(s.valueSize)
                || (s.valueSize > cert.STAT_VALUE_MIN && measure(s.value, s.valueSize, 600) > room));
            check(`every compact duration fits its ${Math.round(room)}px tile, in ${name}`, over.length === 0,
                over.map(s => `${s.value} ${Math.round(measure(s.value, s.valueSize, 600))}px at ${s.valueSize}px`).join('; '));
        }
        const shrunk = cert.layoutCertificate(content, wide).stats.filter(s => s.valueSize < 56);
        check('the wide font shrinks the long ones and only them', shrunk.length > 0
            && shrunk.length < values.length && shrunk.every(s => wide(s.value, 56) > s.w - 24), `${shrunk.length} of ${values.length}`);
    }
    const saved = Intl.DurationFormat;
    try {
        delete Intl.DurationFormat;
        eq('without Intl.DurationFormat it still says it in units', formatStudyTime(H + 2 * M, 'en', less), '1 hr 2 min');
    } finally {
        Intl.DurationFormat = saved;
    }
}

// ============================================================================
section('2. the record');
const B_URL = new URL('../server/', import.meta.url).href;
const { default: db } = await import(B_URL + 'database.js');
db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('ai_enabled', 'false')").run();
const ST = await import(B_URL + 'studyTime.js');
const { recordStudyTime, nodeStudyTime, projectStudyTime, dayStudyTime, recentDays, studyTimeSince, StudyTimeError } = ST;

const tableCols = db.prepare('PRAGMA table_info(study_time)').all().map(c => c.name);
eq('the table holds a topic, an hour, an activity and milliseconds', tableCols, ['node_id', 'hour', 'activity', 'active_ms']);
check('the dead table is gone from a new library',
    !db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'learning_sessions'").get());
check('the clock records the day it started', /^\d{4}-\d{2}-\d{2}$/.test(studyTimeSince() || ''), String(studyTimeSince()));

const mkProject = (name, created = null) => {
    const id = Number(db.prepare('INSERT INTO projects (name) VALUES (?)').run(name).lastInsertRowid);
    if (created) db.prepare('UPDATE projects SET created_at = ? WHERE id = ?').run(created, id);
    return id;
};
const mkNode = (projectId, title, parent = null) => Number(db.prepare(
    'INSERT INTO nodes (project_id, parent_id, title) VALUES (?, ?, ?)').run(projectId, parent, title).lastInsertRowid);
const rowMs = (node) => db.prepare('SELECT COALESCE(SUM(active_ms), 0) AS ms FROM study_time WHERE node_id = ?').get(node).ms;

const NOW = Date.parse('2026-10-04T12:30:00Z');
let flushSeq = 0;
const flush = (entries, id = `gate-flush-${++flushSeq}`) => recordStudyTime({ flushId: id, entries }, { now: NOW });

const P = mkProject('Physics');
const section1 = mkNode(P, 'Mechanics');
const t1 = mkNode(P, 'Kinematics', section1);
const t2 = mkNode(P, 'Forces', section1);
const t3 = mkNode(P, 'Waves');
{
    const r = flush([
        { nodeId: t1, activity: 'reading', hour: '2026-10-04T10', ms: 10 * M },
        { nodeId: t1, activity: 'questions', hour: '2026-10-04T11', ms: 5 * M },
    ]);
    eq('a flush writes its entries', [r.written, r.dropped, r.duplicate], [2, 0, false]);
    eq('…and answers with today\'s total for the live count', [r.date, r.todayMs], ['2026-10-04', 15 * M]);
    const again = recordStudyTime({ flushId: `gate-flush-${flushSeq}`, entries: [
        { nodeId: t1, activity: 'reading', hour: '2026-10-04T10', ms: 10 * M },
    ] }, { now: NOW });
    eq('the SAME flush sent twice (a lost response, retried) writes nothing', [again.duplicate, again.written, rowMs(t1)], [true, 0, 15 * M]);
    eq('…and still answers with today\'s total', again.todayMs, 15 * M);
    flush([{ nodeId: t1, activity: 'reading', hour: '2026-10-04T10', ms: 4 * M }]);
    eq('a NEW flush for the same topic and hour adds to its row', rowMs(t1), 19 * M);
    eq('…in one row, not two', db.prepare("SELECT COUNT(*) AS c FROM study_time WHERE node_id = ? AND hour = '2026-10-04T10' AND activity = 'reading'").get(t1).c, 1);
    flush([{ nodeId: t2, activity: 'cards', hour: '2026-10-04T09', ms: 50 * M }]);
    flush([{ nodeId: t2, activity: 'cards', hour: '2026-10-04T09', ms: 50 * M }]);
    eq('no row holds more than the hour it is in', rowMs(t2), H);
}
{
    const bad = flush([
        { nodeId: 999999, activity: 'reading', hour: '2026-10-04T10', ms: M },        // no such topic
        { nodeId: t3, activity: 'sleeping', hour: '2026-10-04T10', ms: M },           // no such activity
        { nodeId: t3, activity: 'reading', hour: '2026-10-04T24', ms: M },            // no such hour
        { nodeId: t3, activity: 'reading', hour: '2026-13-01T00', ms: M },            // no such month
        { nodeId: t3, activity: 'reading', hour: '2026-10-04 10', ms: M },            // not the shape
        { nodeId: t3, activity: 'reading', hour: '2026-10-04T14', ms: M },            // later than the next hour
        { nodeId: t3, activity: 'reading', hour: '2026-09-20T10', ms: M },            // older than a week
        { nodeId: t3, activity: 'reading', hour: '2026-10-04T10', ms: 0 },            // nothing
        { nodeId: t3, activity: 'reading', hour: '2026-10-04T10', ms: 1.5 },          // not whole ms
        { nodeId: t3, activity: 'reading', hour: '2026-10-04T10', ms: H + 1 },        // more than an hour
        { nodeId: '7', activity: 'reading', hour: '2026-10-04T10', ms: M },           // id as text
        null,
    ]);
    eq('every bad entry is refused and COUNTED, none written', [bad.written, bad.dropped, rowMs(t3)], [0, 12, 0]);
    const ok = flush([{ nodeId: t3, activity: 'reading', hour: '2026-10-04T13', ms: M }]);
    eq('the hour after now is allowed (a clock a little ahead)', ok.written, 1);
    for (const body of [null, {}, { flushId: 'x', entries: [] }, { flushId: 'ok-flush-id', entries: 'no' },
        { flushId: 'bad id with spaces', entries: [] }, { flushId: 'ok-flush-id-2', entries: new Array(501).fill(null) }]) {
        let err = null;
        try { recordStudyTime(body, { now: NOW }); } catch (e) { err = e; }
        check(`a malformed body is a 400, not a write: ${JSON.stringify(body)?.slice(0, 50)}`,
            err instanceof StudyTimeError && err.status === 400, err?.message || 'no error');
    }
    const empty = recordStudyTime({ flushId: 'empty-flush-01', entries: [] }, { now: NOW });
    eq('an EMPTY flush is how the page asks for today\'s total', [empty.written, empty.todayMs > 0], [0, true]);
}
{
    const q = mkNode(P, 'Temporary');
    flush([{ nodeId: q, activity: 'reading', hour: '2026-10-04T10', ms: M }]);
    db.prepare('DELETE FROM nodes WHERE id = ?').run(q);
    eq('a deleted topic takes its time with it', db.prepare('SELECT COUNT(*) AS c FROM study_time WHERE node_id = ?').get(q).c, 0);
}
{
    const fresh = Date.parse('2026-10-08T12:00:00Z');
    db.prepare('INSERT INTO study_time_flushes (id, at) VALUES (?, ?)').run('old-flush-0001', '2026-10-01T00:00:00.000Z');
    recordStudyTime({ flushId: 'new-flush-0001', entries: [] }, { now: fresh });
    check('remembered flush ids are forgotten after a few days',
        !db.prepare("SELECT 1 FROM study_time_flushes WHERE id = 'old-flush-0001'").get());
}

// ============================================================================
section('3. the readings');
{
    // Two days on Physics: the 4th (above) and the 2nd.
    flush([
        { nodeId: t3, activity: 'reading', hour: '2026-10-02T08', ms: 20 * M },
        { nodeId: t2, activity: 'checks', hour: '2026-10-02T09', ms: 6 * M },
    ]);
    const topic = nodeStudyTime(t1);
    eq('a topic: its own total', topic.totalMs, 19 * M);
    eq('…by what was done', Object.entries(topic.byActivity).sort(), [['questions', 5 * M], ['reading', 14 * M]]);
    eq('…by day, newest first', topic.days, [{ day: '2026-10-04', ms: 19 * M }]);
    const sec = nodeStudyTime(section1);
    eq('a section is everything under it', sec.totalMs, 19 * M + H + 6 * M);
    eq('…on two days', sec.days.map(d => d.day), ['2026-10-04', '2026-10-02']);
    eq('…first and last', [sec.firstDay, sec.lastDay], ['2026-10-02', '2026-10-04']);
    eq('an unknown node is null (a 404)', nodeStudyTime(999999), null);
    const none = nodeStudyTime(mkNode(P, 'Untouched'));
    eq('a topic never studied is zero with no days, not null', [none.totalMs, none.days.length], [0, 0]);

    const proj = projectStudyTime(P, { today: '2026-10-04', recent: 7 });
    eq('a project: everything in it', proj.totalMs, 19 * M + H + 6 * M + M + 20 * M);
    eq('…on how many days', proj.studyDays, 2);
    eq('…the recent strip is one entry per day, oldest first, zeros kept',
        proj.recent.map(d => [d.day, d.ms]),
        [['2026-09-28', 0], ['2026-09-29', 0], ['2026-09-30', 0], ['2026-10-01', 0],
         ['2026-10-02', 26 * M], ['2026-10-03', 0], ['2026-10-04', 19 * M + H + M]]);
    eq('…topics ranked by time', proj.topics.map(t => t.nodeId), [t2, t3, t1]);
    eq('…each with its title', proj.topics[0].title, 'Forces');
    eq('a project created on or after the clock started is complete', proj.predates, false);

    const old = mkProject('Older course', '2025-01-01 10:00:00');
    const oldTopic = mkNode(old, 'Something');
    flush([{ nodeId: oldTopic, activity: 'cards', hour: '2026-10-04T08', ms: 3 * M }]);
    const oldP = projectStudyTime(old, { today: '2026-10-04' });
    eq('a project older than the clock says so, and from when', [oldP.predates, oldP.countedSince], [true, studyTimeSince()]);
    eq('…and so does each of its topics', nodeStudyTime(oldTopic).predates, true);
    eq('an unknown project is null', projectStudyTime(999999, { today: '2026-10-04' }), null);

    const day = dayStudyTime('2026-10-04');
    eq('one day across the library', day.totalMs, 19 * M + H + M + 3 * M);
    eq('…by topic, most first, with where it lives', day.topics.slice(0, 2).map(t => [t.nodeTitle, t.projectName]),
        [['Forces', 'Physics'], ['Kinematics', 'Physics']]);
    eq('…a day with nothing is zero and no topics', [dayStudyTime('2026-10-03').totalMs, dayStudyTime('2026-10-03').topics.length], [0, 0]);
    eq('recentDays ends on the day asked', recentDays('2026-10-04', 3).map(d => d.day), ['2026-10-02', '2026-10-03', '2026-10-04']);
}
{
    const { buildTodayActivity } = await import(B_URL + 'today.js');
    const ledger = buildTodayActivity('2026-10-04');
    eq('the day\'s ledger carries the day\'s time', ledger.time.totalMs, dayStudyTime('2026-10-04').totalMs);
    eq('…its topics', ledger.time.topics.length, dayStudyTime('2026-10-04').topics.length);
    eq('…and the week up to it, so the other days can be opened', ledger.time.week.map(d => d.day),
        ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']);
}
{
    const { projectCompletion } = await import(B_URL + 'completion.js');
    const c = projectCompletion(P);
    eq('the finished-project record carries the total', c.time?.totalMs, projectStudyTime(P, { today: '2026-10-04' }).totalMs);
    eq('…the days and the longest', [c.time?.studyDays, c.time?.bestDay], [2, { date: '2026-10-04', ms: 19 * M + H + M }]);
    eq('…and is not partial for a course begun under the clock', c.time?.partial, false);
    eq('a day with study time and nothing else is a day studied (the tile and "days studied" agree)',
        [c.span?.studyDays, c.span?.firstDay, c.span?.lastDay], [2, '2026-10-02', '2026-10-04']);
    eq('…and adds no "things done" to the busiest day', c.span?.bestDay?.count, 0);
    eq('the chart is drawn in TIME when the clock saw the whole course', c.timeline?.measure, 'time');
    eq('…bucketed over the same days, in milliseconds', c.timeline?.buckets.reduce((s, b) => s + b.count, 0), c.time?.totalMs);
    const empty = projectCompletion(mkProject('No time at all'));
    eq('no time is null — no tile — never a zero', empty.time, null);
}
{
    // A course whose first records are older than the clock: its time is real
    // but not the whole, and the screen must be able to say so.
    const old = mkProject('Begun before the clock', '2025-03-01 10:00:00');
    const topic = mkNode(old, 'Done long ago');
    db.prepare("UPDATE nodes SET status = 'completed', completed_at = '2025-03-02T10:00:00Z' WHERE id = ?").run(topic);
    flush([{ nodeId: topic, activity: 'reading', hour: '2026-10-04T08', ms: 7 * M }]);
    const { projectCompletion } = await import(B_URL + 'completion.js');
    const c = projectCompletion(old);
    eq('activity before the clock started makes the total PARTIAL', [c.time?.partial, c.time?.since], [true, studyTimeSince()]);
    eq('…and the chart stays in things done, or its first weeks would read as empty', c.timeline?.measure, 'count');
}

// ============================================================================
section('3b. the screen says it');
{
    const sum = await import(pathToFileURL(await bundleClient('src/components/completion/summary.ts')).href);
    const text = {
        t: (key, vars = {}) => key.replace(/\{\{(\w+)\}\}/g, (_, v) => String(vars[v] ?? '')),
        num: (n) => String(n), date: (d) => d, shortDate: (d) => d,
        duration: (ms) => formatStudyTime(ms, 'en', 'less than a minute'),
    };
    const base = {
        complete: true, celebrated: false,
        project: { id: 1, name: 'X', icon: 'book', color: '#000', status: 'active', deadline: null, startDate: null },
        work: { fraction: 1, topics: { total: 4, completed: 4, skipped: 0 }, cards: { total: 0, met: 0 } },
        effort: { reviews: 0, cardsSeen: 0, answers: 20, correct: 15, accuracy: 0.75, sittings: 2, quizzes: 0, papers: 0 },
        mastery: { tracked: 4, proven: 4, average: 0.9, threshold: 0.85 },
        span: { firstDay: '2026-10-01', lastDay: '2026-10-04', calendarDays: 4, studyDays: 3, longestStreak: 2, bestDay: { date: '2026-10-04', count: 9 } },
        schedule: null, timeline: null,
    };
    const withTime = { ...base, time: { totalMs: 5 * H + 20 * M, studyDays: 3, bestDay: { date: '2026-10-04', ms: 2 * H }, since: '2026-10-01', partial: false } };
    const stats = sum.completionStats(withTime, text);
    const tile = stats.find(s => s.key === 'time');
    eq('a time tile, said as a duration', tile?.value, text.duration(5 * H + 20 * M));
    eq('…right after what was got through', stats.map(s => s.key).slice(0, 2), ['topics', 'time']);
    check('no time, no tile', !sum.completionStats({ ...base, time: null }, text).some(s => s.key === 'time'));
    check('the caption names the longest day in time', /2 hr/.test(sum.completionCaption(withTime, text)), sum.completionCaption(withTime, text));
    const partial = { ...withTime, time: { ...withTime.time, partial: true, since: '2026-10-02' } };
    check('a partial total says from when it counts', /2026-10-02/.test(sum.completionFootnote(partial, text)), sum.completionFootnote(partial, text));
    eq('a whole total has no such footnote', sum.completionFootnote(withTime, text), '');
    const fewTiles = { ...withTime, effort: { ...withTime.effort, answers: 0, correct: 0, accuracy: null }, mastery: { ...withTime.mastery, proven: 0 } };
    for (const [label, d] of [['six tiles, no streak tile', withTime], ['four tiles, one of them the streak', fewTiles]]) {
        const tiles = sum.completionStats(d, text).map(s => s.key);
        const caption = sum.completionCaption(d, text);
        check(`the caption says "in a row" only when no tile does (${label})`,
            /in a row/.test(caption) === !tiles.includes('streak'), `${tiles.join(',')} | ${caption}`);
    }
}
{
    // The sentence shown beside every figure states the limits; it must be the
    // limits the clock uses, or the one place a reader can check the rule lies.
    const how = /HOW_COUNTED = k\("([^"]+)"\)/.exec(src('src/components/studyTime/StudyTime.tsx'))?.[1] ?? '';
    const min = (a) => PAUSE_LIMIT_MS[a] / 60_000;
    check('the shown rule names the reading limit', how.includes(`longer than ${min('reading')} minutes counts as nothing`), how);
    check('…the cards limit', how.includes(`${min('cards')} minutes on cards`), how);
    check('…the questions and tests limit (one number for both)', min('questions') === min('checks') && how.includes(`${min('questions')} on questions and tests`), how);
    check('…and the written-work limit', how.includes(`${min('paper')} on written work`), how);
    eq('the day reading says what the time was spent doing', Object.keys(dayStudyTime('2026-10-04').byActivity).sort(), ['cards', 'questions', 'reading']);
}

// ============================================================================
section('4. the wiring');
for (const [file, why] of [
    ['src/components/feed/FeedView.tsx', 'the feed'],
    ['src/components/GlobalFlashcardReview.tsx', 'the review session'],
    ['src/components/FlashcardView.tsx', 'a topic\'s own cards'],
    ['src/components/QuizView.tsx', 'a practice quiz'],
    ['src/components/MasteryGateModal.tsx', 'the mastery check'],
    ['src/components/PlacementModal.tsx', 'placement'],
]) {
    check(`${why} claims the clock (${file})`, /useStudyClock\(/.test(src(file)));
}
check('a session surface claims above a dialog', /'session'/.test(src('src/components/GlobalFlashcardReview.tsx'))
    && /'session'/.test(src('src/components/MasteryGateModal.tsx')) && /'session'/.test(src('src/components/PlacementModal.tsx')));
check('every Modal pauses the page beneath it', /useStudyClock\(null,[^)]*'dialog'/.test(src('src/components/Modal.tsx')));
check('a widget\'s frame reports that it is being used', /type:\s*'active'|send\('active'/.test(src('src/components/visuals/renderWidget.ts')));
check('…and so does a p5 sketch\'s', /'active'/.test(src('src/components/visuals/renderP5.ts')));
check('…and the clock hears both', /__widget/.test(src('src/hooks/useStudyClock.ts')) && /__p5/.test(src('src/hooks/useStudyClock.ts')));
check('the old route file is gone', !existsSync(join(repoRoot, 'server/routes/sessions.js')));
check('…and nothing mounts it', !/sessions\.js/.test(src('server/app.js')));
check('…and the client has no call to it', !/logSession/.test(src('src/api.ts')));
check('the new route is mounted', /routes\/studyTime\.js/.test(src('server/app.js')));

// The migration, on a library that HAS the old table: booted in a second
// process, because the code under test runs once, at import.
{
    const launcher = join(scratch, 'boot.mjs');
    writeFileSync(launcher, `process.env.DB_PATH = process.argv[2];
process.env.VAULT_ROOT = process.argv[3];
const { default: db } = await import(${JSON.stringify(B_URL + 'database.js')});
const has = !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'learning_sessions'").get();
const rows = has ? db.prepare('SELECT COUNT(*) AS c FROM learning_sessions').get().c : null;
const st = !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'study_time'").get();
console.log(JSON.stringify({ has, rows, st }));
`);
    const Database = require('better-sqlite3');
    const boot = (file) => {
        const out = spawnSync(process.execPath, [launcher, file, join(scratch, 'vault2')], { encoding: 'utf8' });
        try { return JSON.parse(out.stdout.trim().split('\n').pop()); } catch { return { error: out.stderr.slice(0, 400) }; }
    };
    const oldLib = (rows) => {
        const file = join(scratch, `old-${rows}.db`);
        const odb = new Database(file);
        odb.exec(`CREATE TABLE learning_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL,
            node_id INTEGER, activity_type TEXT NOT NULL, duration_seconds INTEGER DEFAULT 0, metadata TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
        for (let i = 0; i < rows; i++) odb.prepare("INSERT INTO learning_sessions (project_id, activity_type) VALUES (1, 'x')").run();
        odb.close();
        return file;
    };
    eq('an EMPTY old table is dropped on boot', boot(oldLib(0)), { has: false, rows: null, st: true });
    eq('an old table with ROWS in it is left alone (nothing is thrown away unread)', boot(oldLib(2)), { has: true, rows: 2, st: true });
}

try { db.close(); } catch { /* already closed */ }
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* Windows may still hold the WAL; the OS temp dir is swept anyway */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
