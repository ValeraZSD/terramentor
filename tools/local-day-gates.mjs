#!/usr/bin/env node
/**
 * tools/local-day-gates.mjs — "today" is the learner's own calendar day.
 *
 * Run:  node tools/local-day-gates.mjs
 *
 * Stored dates stay UTC (`parseDate`, `scheduled_start`/`scheduled_end`, the
 * study clock's hour keys). What changes with the learner is the CURRENT day:
 * which topics are due today, which are overdue, which answers and cards were
 * today's. That day used to be `new Date().toISOString().split('T')[0]`, the
 * UTC date, so in New York the study day turned over at 19:00 and evening
 * work counted against a day that had not started, while in Auckland the feed
 * said Tuesday until 13:00 on Wednesday.
 *
 * Two learners, each at an hour where the UTC date and their own date differ:
 *
 *   New York 20:00 on Tuesday 13 Jan (UTC−5): UTC already says the 14th.
 *   Auckland 02:00 on Wednesday 18 Feb (UTC+13): UTC still says the 17th.
 *
 * Each library holds one topic per case and one deck. Every surface the
 * learner reads "today" from is asked over HTTP, with the page's own
 * `X-Time-Zone` header, so the same requests run against the old code and
 * fail there.
 *
 * The clock is PINNED, never read: `Date` is replaced by one that answers the
 * case's instant (a constructor with arguments still builds that date). SQL's
 * own clock (`NOW_ISO`) is not pinned, so nothing here asserts a card's
 * due-ness against it; every card a case counts is either new or due years
 * away from both clocks. The pure helpers in server/studyDay.js take `now`
 * and a zone as arguments and are asked directly, every day of a year, in
 * zones whose offsets are odd (+5:45, +12:45, a 30-minute DST) or whose clocks
 * change AT midnight, so that day has no 00:00.
 *
 * Deterministic: a scratch database, an in-process server on loopback, no
 * model. The client half bundles src/utils/tree.ts and runs it under TZ.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scratch = mkdtempSync(join(tmpdir(), 'local-day-gates-'));
process.env.DB_PATH = join(scratch, 'gate.db');
process.env.VAULT_ROOT = join(scratch, 'vault');

let pass = 0;
const failures = [];
const check = (name, cond, detail = '') => {
    if (cond) { pass++; return; }
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};
const eq = (name, actual, expected) =>
    check(name, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

// ---- the pinned clock ------------------------------------------------------

const RealDate = globalThis.Date;
let pinnedMs = null;
class PinnedDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [pinnedMs ?? RealDate.now()])); }
    static now() { return pinnedMs ?? RealDate.now(); }
}
globalThis.Date = PinnedDate;
const pin = (iso) => { pinnedMs = RealDate.parse(iso); };

const db = (await import('../server/database.js')).default;
const { setNewPerDay } = await import('../server/decks.js');
const { createApp } = await import('../server/app.js');

let appServer = null;
const bundleDir = mkdtempSync(join(tmpdir(), 'local-day-bundle-'));
process.on('exit', () => {
    try { appServer?.close(); } catch { /* already closed */ }
    try { db.close(); } catch { /* already closed */ }
    rmSync(scratch, { recursive: true, force: true });
    rmSync(bundleDir, { recursive: true, force: true });
});

appServer = createServer(createApp());
const port = await new Promise(ok => appServer.listen(0, '127.0.0.1', () => ok(appServer.address().port)));
const get = async (path, zone) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: zone ? { 'X-Time-Zone': zone } : {} });
    check(`GET ${path} answers`, res.ok, `status ${res.status}`);
    return res.ok ? res.json() : null;
};

// ---- the two learners ------------------------------------------------------

const addDays = (date, n) => new RealDate(RealDate.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
// `mastery_evidence.created_at` is a CURRENT_TIMESTAMP column: SQLite's own shape.
const sqliteShape = (iso) => iso.slice(0, 19).replace('T', ' ');
const hourKey = (iso) => iso.slice(0, 13);

const LEARNERS = [
    {
        name: 'New York, 20:00 (UTC−5)',
        zone: 'America/New_York',
        at: '2026-01-14T01:00:00.000Z',
        local: '2026-01-13',
        utc: '2026-01-14',
        // 18:00 the same evening: the learner's today, UTC's yesterday.
        earlier: '2026-01-13T23:00:00.000Z',
        earlierIsToday: true,
        // 00:30 tomorrow on the learner's clock, still the 14th in UTC.
        due: '2026-01-14T05:30:00.000Z',
        dueBucket: 1,
    },
    {
        name: 'Auckland, 02:00 (UTC+13)',
        zone: 'Pacific/Auckland',
        at: '2026-02-17T13:00:00.000Z',
        local: '2026-02-18',
        utc: '2026-02-17',
        // 22:00 the evening before: the learner's yesterday, UTC's today.
        earlier: '2026-02-17T09:00:00.000Z',
        earlierIsToday: false,
        // 14:00 today on the learner's clock, already the 18th in UTC.
        due: '2026-02-18T01:00:00.000Z',
        dueBucket: 0,
    },
];

const FEED = '{"source":"feed"}';
const QUESTIONS = JSON.stringify(Array.from({ length: 6 }, (_, i) => ({
    type: 'multiple_choice', question: `Question ${i + 1}?`, options: ['a', 'b', 'c', 'd'], correct_answer: 'a',
})));

function build(l) {
    const course = Number(db.prepare(`
        INSERT INTO projects (name, position, start_date, deadline, study_days)
        VALUES (?, 0, ?, ?, '[1,2,3,4,5,6,7]')
    `).run(`Course — ${l.name}`, addDays(l.local, -30), addDays(l.local, 60)).lastInsertRowid);
    const topic = (title, start, end, position) => Number(db.prepare(`
        INSERT INTO nodes (project_id, title, description, position, scheduled_start, scheduled_end)
        VALUES (?, ?, 'Read this first.', ?, ?, ?)
    `).run(course, title, position, start, end).lastInsertRowid);
    const ids = {
        course,
        dueToday: topic('Due today', l.local, l.local, 0),
        dueYesterday: topic('Due yesterday', addDays(l.local, -1), addDays(l.local, -1), 1),
        answered: topic('Answered four times', addDays(l.local, 2), addDays(l.local, 8), 2),
    };
    db.prepare('INSERT INTO quizzes (node_id, title, questions) VALUES (?, ?, ?)').run(ids.answered, 'Bank', QUESTIONS);
    // Four feed answers on one topic: the day's limit for it (NODE_QUESTIONS_PER_DAY).
    const evidence = db.prepare(`INSERT INTO mastery_evidence (node_id, evidence_type, score, total, metadata, created_at)
        VALUES (?, 'quiz', 1, 1, ?, ?)`);
    for (let i = 0; i < 4; i++) evidence.run(ids.answered, FEED, sqliteShape(l.earlier));
    // Ten minutes on the study clock in the hour of `earlier`.
    db.prepare(`INSERT INTO study_time (node_id, hour, activity, active_ms) VALUES (?, ?, 'reading', 600000)`)
        .run(ids.dueToday, hourKey(l.earlier));

    const deck = Number(db.prepare(`INSERT INTO projects (name, kind, position) VALUES (?, 'deck', 1)`)
        .run(`Deck — ${l.name}`).lastInsertRowid);
    const stage = Number(db.prepare(`INSERT INTO nodes (project_id, title, role) VALUES (?, 'Stage 1', 'pagination')`)
        .run(deck).lastInsertRowid);
    setNewPerDay(deck, 5);
    const card = db.prepare(`INSERT INTO flashcards (node_id, front, back) VALUES (?, ?, 'back')`);
    for (let i = 0; i < 12; i++) {
        const id = Number(card.run(stage, `card ${i}`).lastInsertRowid);
        if (i < 5) {
            // Met at `earlier` and not due for years by either clock.
            db.prepare(`UPDATE flashcards SET last_reviewed = ?, next_review = '2031-01-01T00:00:00.000Z',
                        stability = 30, state = 2, review_count = 1 WHERE id = ?`).run(l.earlier, id);
            db.prepare(`INSERT INTO review_log (card_id, reviewed_at, rating, state_before, source)
                        VALUES (?, ?, 3, 0, 'app')`).run(id, l.earlier);
        }
    }
    // One card in its own deck, reviewed long ago and due at `due`: where the
    // forecast puts it.
    const forecastDeck = Number(db.prepare(`INSERT INTO projects (name, kind, position) VALUES (?, 'deck', 2)`)
        .run(`Forecast — ${l.name}`).lastInsertRowid);
    const forecastStage = Number(db.prepare(`INSERT INTO nodes (project_id, title, role) VALUES (?, 'Stage 1', 'pagination')`)
        .run(forecastDeck).lastInsertRowid);
    db.prepare(`INSERT INTO flashcards (node_id, front, back, last_reviewed, next_review, stability, state, review_count)
                VALUES (?, 'due later', 'back', '2025-06-01T00:00:00.000Z', ?, 30, 2, 1)`).run(forecastStage, l.due);
    return { ...ids, deck, forecastDeck, projects: [course, deck, forecastDeck] };
}

const built = LEARNERS.map(build);
const onlyActive = (keep) => {
    db.prepare("UPDATE projects SET status = 'archived'").run();
    const mark = db.prepare("UPDATE projects SET status = 'active' WHERE id = ?");
    for (const id of keep) mark.run(id);
};

// ---- every surface, per learner ---------------------------------------------

for (const [i, l] of LEARNERS.entries()) {
    const ids = built[i];
    onlyActive(ids.projects);
    pin(l.at);
    const tag = (s) => `${l.name}: ${s}`;
    const today = (x) => (l.earlierIsToday ? x : 0);

    const feed = await get(`/api/feed?limit=30`, l.zone);
    eq(tag('the feed header names the learner\'s date'), feed?.header?.date, l.local);
    eq(tag('…and so does the feed itself'), feed?.date, l.local);
    // A topic's checkpoint is what says "overdue", and it follows the topic's
    // reading card: the page after it, with the reading held by the client.
    const held = [ids.dueToday, ids.dueYesterday, ids.answered].map(id => `read-${id}`).join(',');
    const ends = await get(`/api/feed?projectId=${ids.course}&limit=30&exclude=${held}`, l.zone);
    const checkpoint = (nodeId) => ends?.items?.find(c => c.kind === 'checkpoint' && c.nodeId === nodeId);
    eq(tag('a topic due today is in the feed and not overdue'), checkpoint(ids.dueToday)?.isOverdue ?? null, false);
    eq(tag('a topic due yesterday is in the feed and overdue'), checkpoint(ids.dueYesterday)?.isOverdue ?? null, true);
    eq(tag('the header counts one overdue topic (yesterday\'s)'), feed?.header?.catchUp?.overdueLeaves, 1);
    eq(tag('questions answered today, by the learner\'s day'), feed?.header?.stats?.questionsAnsweredToday, today(4));
    eq(tag('cards met today, by the learner\'s day'), feed?.header?.stats?.newCardsIntroducedToday, today(5));
    eq(tag('cards reviewed today, by the learner\'s day'), feed?.header?.stats?.cardsReviewedToday, today(5));

    const todayData = await get('/api/today', l.zone);
    const proj = todayData?.projects?.find(p => p.id === ids.course);
    eq(tag('the today list names the learner\'s date'), todayData?.date, l.local);
    eq(tag('the today list holds the topic due today'), proj?.todayTasks?.map(t => t.id), [ids.dueToday]);
    eq(tag('overdue holds only the topic due yesterday'), proj?.overdueTasks?.map(t => t.id), [ids.dueYesterday]);
    eq(tag('the today list\'s study time is the learner\'s day'), todayData?.completedToday?.studyMs, today(600000));

    // The per-day answer guard: four feed answers on a topic close it to more
    // saved questions for the day, and only for that day.
    const scoped = await get(`/api/feed?nodeId=${ids.answered}&limit=30`, l.zone);
    const questions = (scoped?.items || []).filter(c => c.kind === 'question' && c.nodeId === ids.answered).length;
    check(tag(l.earlierIsToday
        ? 'four answers earlier this evening close the topic to more questions today'
        : 'four answers last night leave today\'s questions open'),
    l.earlierIsToday ? questions === 0 : questions > 0, `${questions} question card(s) served`);

    // New-card introduction: five met earlier, five a day.
    const deck = await get(`/api/projects/${ids.deck}/deck`, l.zone);
    eq(tag('the deck counts the cards met on the learner\'s day'), deck?.introducedToday, today(5));
    eq(tag('…and offers what is left of the day\'s five'), deck?.newRemaining, 5 - today(5));
    const queue = await get(`/api/projects/${ids.deck}/deck/queue`, l.zone);
    eq(tag('the review session serves that many new cards'), queue?.fresh, 5 - today(5));
    const deckFeed = await get(`/api/feed?projectId=${ids.deck}&limit=30`, l.zone);
    eq(tag('the feed serves that many new cards'), (deckFeed?.items || []).filter(c => c.kind === 'flashcard' && c.isNew).length, 5 - today(5));

    const forecast = await get(`/api/projects/${ids.forecastDeck}/deck`, l.zone);
    const bucket = forecast?.forecast?.days?.findIndex(n => n > 0);
    eq(tag('the forecast puts a card on the learner\'s day it falls due'), bucket, l.dueBucket);

    const ledger = await get('/api/today/activity', l.zone);
    eq(tag('the day\'s ledger names the learner\'s date'), ledger?.date, l.local);
    eq(tag('…and lists the answers given on it'), ledger?.summary?.questionsAnswered, today(4));
    eq(tag('…and the study time spent on it'), ledger?.time?.totalMs, today(600000));
    eq(tag('…and its week ends on that date'), ledger?.time?.week?.at(-1)?.day, l.local);

    const schedule = await get('/api/schedule/overview', l.zone);
    eq(tag('the schedule board\'s today is the learner\'s'), schedule?.today, l.local);
}

// ---- one library, two devices, no header -----------------------------------

{
    const ny = LEARNERS[0];
    onlyActive(built[0].projects);
    pin(ny.at);
    const desk = await get('/api/feed?limit=1', ny.zone);
    const phone = await get('/api/feed?limit=1', 'Pacific/Auckland');
    eq('at one instant the desktop in New York reads its own date', desk?.date, '2026-01-13');
    eq('…and a phone in Auckland reads its own', phone?.date, '2026-01-14');
    await get('/api/feed?limit=1', ny.zone);
    eq('a request with no zone reads the zone the learner\'s page last sent', (await get('/api/feed?limit=1'))?.date, '2026-01-13');
    eq('a zone the platform does not know is ignored, not obeyed', (await get('/api/feed?limit=1', 'Mars/Olympus_Mons'))?.date, '2026-01-13');
    const remembered = db.prepare("SELECT value FROM settings WHERE key = 'time_zone'").get()?.value ?? null;
    eq('the last zone heard is kept for work that has no request', remembered, ny.zone);
}

// ---- New York's two clock changes, read off the header ----------------------

for (const [label, at, date] of [
    ['23:30 on the day the clocks go back (a 25-hour day)', '2026-11-02T04:30:00.000Z', '2026-11-01'],
    ['00:30 on that day, before they go back', '2026-11-01T04:30:00.000Z', '2026-11-01'],
    ['23:30 on the day the clocks go forward (a 23-hour day)', '2026-03-09T03:30:00.000Z', '2026-03-08'],
]) {
    pin(at);
    eq(`New York, ${label}`, (await get('/api/feed?limit=1', 'America/New_York'))?.date, date);
}
pinnedMs = null;
appServer.close();

// ---- the helpers: every day of 2026 in zones that make days odd -------------

let day = null;
try { day = await import('../server/studyDay.js'); } catch { /* the old code has none */ }
check('server/studyDay.js exports localDate and dayBounds',
    typeof day?.localDate === 'function' && typeof day?.dayBounds === 'function');
if (day) {
    const ZONES = [
        'UTC', 'America/New_York', 'Pacific/Auckland', 'Asia/Kolkata', 'Asia/Kathmandu',
        'Pacific/Chatham', 'Australia/Lord_Howe', 'America/Havana', 'America/Santiago',
        'Asia/Beirut', 'Pacific/Kiritimati', 'Pacific/Pago_Pago', 'America/St_Johns', 'Europe/Amsterdam',
    ];
    const HOUR = 3_600_000;
    for (const zone of ZONES) {
        const odd = [];
        let date = '2026-01-01';
        while (date < '2027-01-01') {
            const { start, end } = day.dayBounds(date, zone);
            const s = RealDate.parse(start), e = RealDate.parse(end);
            const ok = day.localDate(s, zone) === date
                && day.localDate(s - 1, zone) === addDays(date, -1)
                && day.localDate(e - 1, zone) === date
                && day.localDate(e, zone) === addDays(date, 1)
                && e - s >= 22 * HOUR && e - s <= 26 * HOUR;
            if (!ok) odd.push(`${date} ${start}..${end}`);
            date = addDays(date, 1);
        }
        check(`${zone}: every day of 2026 starts at its first instant and ends where the next begins`, odd.length === 0, odd.slice(0, 3).join('; '));
    }
    const len = (date, zone) => {
        const { start, end } = day.dayBounds(date, zone);
        return (RealDate.parse(end) - RealDate.parse(start)) / HOUR;
    };
    eq('New York, 8 Mar 2026 is 23 hours long', len('2026-03-08', 'America/New_York'), 23);
    eq('New York, 1 Nov 2026 is 25 hours long', len('2026-11-01', 'America/New_York'), 25);
    eq('Lord Howe Island, 4 Oct 2026 is 23½ hours long', len('2026-10-04', 'Australia/Lord_Howe'), 23.5);
    eq('New York, 13 Jan 2026 begins at 05:00 UTC', day.dayBounds('2026-01-13', 'America/New_York').start, '2026-01-13T05:00:00.000Z');
    eq('the learner\'s date at an instant is the zone\'s, not UTC\'s',
        [day.localDate(RealDate.parse(LEARNERS[0].at), LEARNERS[0].zone), day.localDate(RealDate.parse(LEARNERS[1].at), LEARNERS[1].zone)],
        [LEARNERS[0].local, LEARNERS[1].local]);
    eq('studyDay takes its instant and zone as arguments',
        day.studyDay({ now: RealDate.parse(LEARNERS[1].at), timeZone: LEARNERS[1].zone }).date, LEARNERS[1].local);
}

// ---- the client: tree.ts's todayStr on the device's own clock ---------------

{
    const esbuild = createRequire(import.meta.url)('esbuild');
    const stub = join(bundleDir, 'i18n-stub.js');
    writeFileSync(stub, 'export const k = (s) => s;\nexport default {};\n');
    const out = join(bundleDir, 'tree.mjs');
    await esbuild.build({
        entryPoints: [fileURLToPath(new URL('../src/utils/tree.ts', import.meta.url))],
        bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent',
        plugins: [{ name: 'stub-i18n', setup(b) { b.onResolve({ filter: /(^|\/)i18n$/ }, () => ({ path: stub })); } }],
    });
    const probe = join(bundleDir, 'probe.mjs');
    writeFileSync(probe, [
        `const { todayStr } = await import(${JSON.stringify(pathToFileURL(out).href)});`,
        'const at = new Date(process.argv[2]);',
        'process.stdout.write(JSON.stringify(todayStr(at)));',
    ].join('\n'));
    for (const l of LEARNERS) {
        const run = spawnSync(process.execPath, [probe, l.at], { env: { ...process.env, TZ: l.zone }, encoding: 'utf8' });
        let said = null;
        try { said = JSON.parse(run.stdout); } catch { said = run.stderr.trim().split('\n').pop() || null; }
        eq(`client todayStr on a device in ${l.zone} at ${l.at}`, said, l.local);
    }

    // The page's two other halves: every call it makes names the device's zone,
    // and its live study-time count files an hour on the day the server does.
    const bundle = async (entry, name) => {
        const file = join(bundleDir, name);
        await esbuild.build({
            entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
            bundle: true, format: 'esm', platform: 'node', outfile: file, logLevel: 'silent',
            plugins: [{ name: 'stub-i18n', setup(b) { b.onResolve({ filter: /(^|\/)(i18n|locale)$/ }, () => ({ path: stub })); } }],
        });
        return pathToFileURL(file).href;
    };
    const apiUrl = await bundle('../src/api.ts', 'api.mjs');
    const clockUrl = await bundle('../src/utils/studyTime.ts', 'studyTime.mjs');
    const clientProbe = join(bundleDir, 'client-probe.mjs');
    writeFileSync(clientProbe, [
        'const sent = [];',
        "globalThis.fetch = async (url, init = {}) => { sent.push({ url: String(url), zone: new Headers(init.headers).get('X-Time-Zone'), type: new Headers(init.headers).get('Content-Type') }); return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }); };",
        `const { api } = await import(${JSON.stringify(apiUrl)});`,
        `const { sumForDay } = await import(${JSON.stringify(clockUrl)});`,
        'await api.getTodayActivity();',
        "await api.uploadDocumentFiles([new File(['x'], 'a.txt')], { projectId: 1 });",
        "const entries = JSON.parse(process.argv[2]);",
        'process.stdout.write(JSON.stringify({ sent, day: sumForDay(entries, process.argv[3]) }));',
    ].join('\n'));
    // An hour that UTC files on one date and the learner on the other: New
    // York's 19:00 on the 13th is 00Z on the 14th; Auckland's 00:00 on the 18th
    // is 11Z on the 17th.
    const lateHour = {
        'America/New_York': [{ nodeId: 1, activity: 'reading', hour: '2026-01-14T00', ms: 600000 }],
        'Pacific/Auckland': [{ nodeId: 1, activity: 'reading', hour: '2026-02-17T11', ms: 600000 }],
    };
    for (const l of LEARNERS) {
        const run = spawnSync(process.execPath, [clientProbe, JSON.stringify(lateHour[l.zone]), l.local], { env: { ...process.env, TZ: l.zone }, encoding: 'utf8' });
        let said = null;
        try { said = JSON.parse(run.stdout); } catch { said = { error: run.stderr.trim().split('\n').slice(-3).join(' | ') }; }
        eq(`the page's JSON call from ${l.zone} names its zone`, said.sent?.[0]?.zone ?? said.error ?? null, l.zone);
        eq(`…and keeps its JSON content type`, said.sent?.[0]?.type ?? null, 'application/json');
        eq(`the page's file upload from ${l.zone} names its zone too, with no forced content type`,
            [said.sent?.[1]?.zone ?? null, said.sent?.[1]?.type ?? null], [l.zone, null]);
        eq(`the page's live count in ${l.zone} files the evening hour on the learner's day`, said.day ?? null, 600000);
    }
}

for (const f of failures) console.log(`  ✗ ${f}`);
console.log(`\nlocal-day-gates: ${pass} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
