#!/usr/bin/env node
/**
 * tools/live-lesson-gates.mjs — a lesson written while its topic is open is shown.
 *
 * Run:  node tools/live-lesson-gates.mjs
 *
 * Study on a topic with no lesson yet serves the topic's Overview as a
 * stand-in (`read-N`), and once that is all there is, the topic's checkpoint
 * (`checkpoint-N`). The background writer stores the real lesson a few seconds
 * later and the open page pulls again, holding both keys. A held checkpoint
 * closes its chapter for later pages (chapter-end-gates), so the lesson was
 * never served: the page stayed on the Overview until a reload (found filming
 * the Taylor take, 1 Nov 2026). A chapter that held only the stand-in was never
 * taught, so its real lessons still come; and on screen they go in BEFORE its
 * "End of chapter", never under it.
 *
 * And while that first lesson is being written, the topic's page holds still:
 * the server says so (`lessonWrite`), serves no checkpoint and no notice, the
 * page draws the lesson's slot under the Overview and no end under it, and a
 * write that fails says why and gives the chapter its end back.
 *
 * Deterministic: a scratch database, no model, no network; the client half is
 * the shipped `src/utils/feedPlacement.ts`, bundled with esbuild.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const scratch = mkdtempSync(join(tmpdir(), 'live-lesson-gates-'));
process.env.DB_PATH = join(scratch, 'gate.db');
process.env.VAULT_ROOT = join(scratch, 'vault');
process.env.DATA_DIR = scratch;

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};

const db = (await import('../server/database.js')).default;
const { ROLE_TOPIC } = await import('../server/nodeRole.js');
const { composeFeed } = await import('../server/feed.js');
const { getGateConfig } = await import('../server/settingsStore.js');

if (db.name !== process.env.DB_PATH) {
    console.log(`refusing to run: the database is ${db.name}, not the scratch file`);
    process.exit(1);
}
const setting = (key, value) => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
// AI on, as in the take: the lesson is on its way, so the Overview is a stand-in.
setting('ai_enabled', 'true');
setting('ai_model', 'gate-model');

const day = (n) => new Date(Date.now() + n * 86400000).toISOString().split('T')[0];
const course = Number(db.prepare("INSERT INTO projects (name, position, start_date, deadline) VALUES ('Taylor', 0, ?, ?)").run(day(-10), day(300)).lastInsertRowid);
const mkTopic = (title, position) => Number(db.prepare(`
    INSERT INTO nodes (project_id, parent_id, title, position, role, scheduled_start, scheduled_end, description)
    VALUES (?, NULL, ?, ?, ?, ?, ?, 'Overview.')
`).run(course, title, position, ROLE_TOPIC, day(-5), day(-1)).lastInsertRowid);
const writePlan = (nodeId, parts) => db.prepare("INSERT INTO feed_items (node_id, kind, seq, content, status) VALUES (?, 'plan', 0, ?, 'ready')")
    .run(nodeId, JSON.stringify({ parts: Array.from({ length: parts }, (_, i) => ({ title: `Part ${i + 1}` })) }));
const writeLesson = (nodeId, part, parts) => Number(db.prepare("INSERT INTO feed_items (node_id, kind, seq, content, status, meta) VALUES (?, 'lesson', ?, 'Text.', 'ready', ?)")
    .run(nodeId, part * 2 - 1, JSON.stringify({ partIndex: part, partCount: parts })).lastInsertRowid);
const gate = getGateConfig();

// The open page: load, then pull with everything held until nothing comes —
// which is where the take's page sat for fifteen minutes.
const openPage = (nodeId) => {
    const held = new Set();
    for (let i = 0; i < 4; i++) {
        const items = composeFeed({ gate, nodeId, excludeKeys: held }).items;
        if (!items.length) break;
        for (const c of items) held.add(c.key);
    }
    return held;
};

console.log('\n--- the page holds the stand-in and the checkpoint ---');
const topic = mkTopic('The Maclaurin series', 0);
const held = openPage(topic);
check('the Overview stood in for the lesson', held.has(`read-${topic}`), JSON.stringify([...held]));
check('and the checkpoint closed it', held.has(`checkpoint-${topic}`), JSON.stringify([...held]));

console.log('\n--- the real lesson is written while the page is open ---');
writePlan(topic, 2);
const part1 = writeLesson(topic, 1, 2);
const pull1 = composeFeed({ gate, nodeId: topic, excludeKeys: held }).items.filter(c => c.nodeId === topic);
check('the next pull serves it', pull1.some(c => c.key === `fi-${part1}`), JSON.stringify(pull1.map(c => c.key)));
check('and no second checkpoint', !pull1.some(c => c.kind === 'checkpoint'), JSON.stringify(pull1.map(c => c.key)));
for (const c of pull1) held.add(c.key);
const part2 = writeLesson(topic, 2, 2);
const pull2 = composeFeed({ gate, nodeId: topic, excludeKeys: held }).items.filter(c => c.nodeId === topic);
check('the part written after it comes too', pull2.some(c => c.key === `fi-${part2}`), JSON.stringify(pull2.map(c => c.key)));
for (const c of pull2) held.add(c.key);
// Everything written is held now: the chapter closes again, or every later
// pull tops the bank up above "End of chapter" (review of #161).
db.prepare('INSERT INTO quizzes (node_id, title, questions) VALUES (?, ?, ?)').run(topic, 'Bank', JSON.stringify(
    Array.from({ length: 12 }, (_, i) => ({ type: 'multiple_choice', question: `B${i}?`, options: ['a', 'b', 'c', 'd'], correct_answer: 'a' }))));
const pull3 = composeFeed({ gate, nodeId: topic, excludeKeys: held }).items.filter(c => c.nodeId === topic);
check('with every written card held, a later pull adds nothing', pull3.length === 0, JSON.stringify(pull3.map(c => c.key)));

console.log('\n--- on the course stream the chapter stays closed ---');
// There the learner has usually moved on past the checkpoint: a card put in
// before it would land above them, out of sight. It waits for the next load.
const elsewhere = mkTopic('Radius of convergence', 2);
const heldCourse = new Set([`read-${elsewhere}`, `checkpoint-${elsewhere}`]);
writePlan(elsewhere, 1);
writeLesson(elsewhere, 1, 1);
const coursePull = composeFeed({ gate, projectId: course, excludeKeys: heldCourse, limit: 40 }).items.filter(c => c.nodeId === elsewhere);
check('the course stream serves nothing more for it', coursePull.length === 0, JSON.stringify(coursePull.map(c => c.key)));

console.log('\n--- a chapter closed after real teaching stays closed ---');
// The chapter-end rule itself: held checkpoint, no stand-in held, more bank.
const taught = mkTopic('Remainders', 1);
writePlan(taught, 1);
writeLesson(taught, 1, 1);
db.prepare('INSERT INTO quizzes (node_id, title, questions) VALUES (?, ?, ?)').run(taught, 'Bank', JSON.stringify(
    Array.from({ length: 8 }, (_, i) => ({ type: 'multiple_choice', question: `Q${i}?`, options: ['a', 'b', 'c', 'd'], correct_answer: 'a' }))));
const page1 = composeFeed({ gate, nodeId: taught, limit: 4 }).items;
const heldTaught = new Set(page1.map(c => c.key));
check('page 1 ends the taught topic', heldTaught.has(`checkpoint-${taught}`), JSON.stringify(page1.map(c => c.key)));
check('it held no stand-in', !heldTaught.has(`read-${taught}`), JSON.stringify(page1.map(c => c.key)));
const later = composeFeed({ gate, nodeId: taught, excludeKeys: heldTaught }).items.filter(c => c.nodeId === taught);
check('a later page adds nothing to it', later.length === 0, JSON.stringify(later.map(c => c.key)));

console.log('\n--- Study on a topic whose lesson is being written: one stable page ---');
// Without a write state the page passes through four layouts in its first
// seconds: Overview + "That's all of this topic", then "End of chapter" +
// "Writing more lessons · 0%", then the lesson landing under the Overview with
// the checkpoint pushed below it. While the writer is on the topic's first
// lesson the page is the Overview and the lesson's slot; nothing closes the
// chapter.
{
    const pending = mkTopic('The function e to the minus one over x squared', 3);
    const writing = { nodeId: pending, state: 'writing' };
    const first = composeFeed({ gate, nodeId: pending, lessonWrite: writing });
    const keysOf = (r) => r.items.map(c => c.key);
    check('page 1 is the Overview standing in', keysOf(first).includes(`read-${pending}`), JSON.stringify(keysOf(first)));
    check('page 1 serves no checkpoint', !first.items.some(c => c.kind === 'checkpoint'), JSON.stringify(keysOf(first)));
    check('the page is told the lesson is being written', first.lessonWrite?.nodeId === pending && first.lessonWrite?.state === 'writing',
        JSON.stringify(first.lessonWrite));
    check('no "being prepared" notice above it: the lesson\'s slot says it', !keysOf(first).includes('notice-ai'), JSON.stringify(keysOf(first)));
    const heldPending = new Set(keysOf(first));
    const pulls = [];
    for (let i = 0; i < 3; i++) {
        const r = composeFeed({ gate, nodeId: pending, excludeKeys: heldPending, lessonWrite: writing });
        pulls.push(...keysOf(r));
        for (const k of keysOf(r)) heldPending.add(k);
    }
    check('pulls while it is written serve no checkpoint either', !pulls.some(k => k.startsWith('checkpoint-')), JSON.stringify(pulls));
    // The writer stores the outline first: a reload then still opens on the
    // Overview, not on an empty topic.
    writePlan(pending, 2);
    const reload = composeFeed({ gate, nodeId: pending, lessonWrite: writing });
    check('with only the outline written, a reload still opens on the Overview', keysOf(reload).includes(`read-${pending}`), JSON.stringify(keysOf(reload)));
    check('…and no checkpoint', !reload.items.some(c => c.kind === 'checkpoint'), JSON.stringify(keysOf(reload)));
    // The write fails: the page goes back to how it ends today, and says why.
    const failed = { nodeId: pending, state: 'failed', reason: 'model not found' };
    const afterFail = composeFeed({ gate, nodeId: pending, excludeKeys: heldPending, lessonWrite: failed });
    check('a failed write closes the chapter as before', afterFail.items.some(c => c.key === `checkpoint-${pending}`), JSON.stringify(keysOf(afterFail)));
    check('…and carries the reason to the page', afterFail.lessonWrite?.state === 'failed' && afterFail.lessonWrite?.reason === 'model not found',
        JSON.stringify(afterFail.lessonWrite));
    // A state for a topic that is not the one on the page changes nothing.
    const other = composeFeed({ gate, nodeId: taught, lessonWrite: { nodeId: pending, state: 'writing' } });
    const plain = composeFeed({ gate, nodeId: taught });
    // Bank cards by kind: each page draws its own random few.
    const shape = (r) => r.items.map(c => (c.key.startsWith('savedq-') ? 'savedq' : c.key));
    check('a topic whose lesson exists is served exactly as before',
        JSON.stringify(shape(other)) === JSON.stringify(shape(plain)) && other.lessonWrite == null,
        `${JSON.stringify(keysOf(other))} vs ${JSON.stringify(keysOf(plain))}`);
}

// --- client: where a pulled card lands on screen -----------------------------
const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const cache = fileURLToPath(new URL('../node_modules/.cache', import.meta.url));
mkdirSync(cache, { recursive: true });
const bundleDir = mkdtempSync(join(cache, 'live-lesson-gates-'));
const out = join(bundleDir, 'feedPlacement.mjs');
await esbuild.build({
    entryPoints: [fileURLToPath(new URL('../src/utils/feedPlacement.ts', import.meta.url))],
    bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent',
});
const { placeCheckpoints } = await import(pathToFileURL(out).href);
const keys = (cards) => cards.map(c => c.key).join(' ');
const card = (key, kind, nodeId) => ({ key, kind, nodeId });
const flash = (key, nodeId) => ({ key, kind: 'flashcard', card: { node_id: nodeId } });

console.log('\n--- on screen, a new lesson goes in before its End of chapter ---');
{
    const screen = [card('notice-ai', 'notice'), card('read-1', 'lesson', 1), card('checkpoint-1', 'checkpoint', 1), card('read-2', 'lesson', 2)];
    const merged = placeCheckpoints(screen, [card('fi-7', 'lesson', 1), card('fi-8', 'question', 1), card('fi-9', 'lesson', 2)]);
    check('lesson and question before checkpoint-1, in order; topic 2 appended',
        keys(merged) === 'notice-ai read-1 fi-7 fi-8 checkpoint-1 read-2 fi-9', keys(merged));
    const nothingUnder = merged.findIndex(c => c.key === 'checkpoint-1');
    check('no card of topic 1 under its End of chapter',
        !merged.slice(nothingUnder + 1).some(c => c.kind !== 'flashcard' && c.nodeId === 1), keys(merged));
}

console.log('\n--- a checkpoint pulled with its topic\'s cards keeps the page\'s order ---');
{
    // The stand-in held, then lesson + new cards + checkpoint in ONE pull: the
    // checkpoint went after the held stand-in, above the lesson it closes.
    const merged = placeCheckpoints([card('read-1', 'lesson', 1)],
        [card('fi-7', 'lesson', 1), flash('fcnew-3', 1), card('checkpoint-1', 'checkpoint', 1)]);
    check('read-1 fi-7 fcnew-3 checkpoint-1', keys(merged) === 'read-1 fi-7 fcnew-3 checkpoint-1', keys(merged));
}

console.log('\n--- what was already right stays right ---');
{
    // A checkpoint pulled alone still goes straight after its topic's last card.
    const merged = placeCheckpoints([card('fi-1', 'lesson', 1), card('fi-2', 'lesson', 2)], [card('checkpoint-1', 'checkpoint', 1)]);
    check('a lone checkpoint closes its topic in place', keys(merged) === 'fi-1 checkpoint-1 fi-2', keys(merged));
    const fresh = placeCheckpoints([card('fi-1', 'lesson', 1)], [card('checkpoint-9', 'checkpoint', 9), card('fi-3', 'lesson', 3)]);
    check('cards of topics not on screen are appended in order', keys(fresh) === 'fi-1 checkpoint-9 fi-3', keys(fresh));
    // A topic's flashcard pulled with its checkpoint: the checkpoint still
    // closes the topic in place, not below the next topic (review of #161).
    const withCard = placeCheckpoints([card('fi-1', 'lesson', 1), card('fi-2', 'lesson', 2)], [flash('fcnew-5', 1), card('checkpoint-1', 'checkpoint', 1)]);
    check('a flashcard in the pull does not push the checkpoint past topic 2', keys(withCard) === 'fi-1 checkpoint-1 fi-2 fcnew-5', keys(withCard));
}

console.log('\n--- the lesson\'s slot holds the page still, and the lesson takes it ---');
{
    const { lessonSlot, lessonPending } = await import(pathToFileURL(out).href);
    const overview = { ...card('read-1', 'lesson', 1), degraded: true };
    const writing = { nodeId: 1, state: 'writing' };
    const screen = [card('notice-ai', 'notice'), overview];
    check('the slot stands right after the Overview',
        JSON.stringify(lessonSlot?.(screen, writing)) === JSON.stringify({ key: 'read-1', place: 'after' }), JSON.stringify(lessonSlot?.(screen, writing)));
    check('while it is written the stream has no end yet (no junction, no "Writing more lessons" line)',
        lessonPending?.(screen, writing) === true);
    // A flashcard of the topic served after the Overview: the lesson still
    // lands in the slot, above it, not appended under it as a new chapter.
    const withCard = [overview, flash('fc-3', 1)];
    const landed = placeCheckpoints(withCard, [card('fi-7', 'lesson', 1), card('fi-8', 'question', 1)], 1);
    check('the lesson and its question go where the slot was', keys(landed) === 'read-1 fi-7 fi-8 fc-3', keys(landed));
    // While it was written the page showed only "Writing the lesson": the
    // Overview standing in for it was never on screen, so the lesson replaces
    // it, as a reload would serve the topic.
    const replaced = placeCheckpoints(withCard, [card('fi-7', 'lesson', 1), card('fi-8', 'question', 1)], 1, true);
    check('a lesson that ends "Writing the lesson" replaces the unseen stand-in', keys(replaced) === 'fi-7 fi-8 fc-3', keys(replaced));
    const notYet = placeCheckpoints(withCard, [card('fi-8', 'question', 1)], 1, true);
    check('…but only once a lesson came, never for a lone question', keys(notYet) === 'read-1 fi-8 fc-3', keys(notYet));
    check('and the slot is gone, even before the state says so',
        lessonSlot?.(landed, writing) === null && lessonPending?.(landed, writing) === false, JSON.stringify(lessonSlot?.(landed, writing)));
    const failed = { nodeId: 1, state: 'failed', reason: 'model not found' };
    const closed = placeCheckpoints([overview], [card('checkpoint-1', 'checkpoint', 1)], 1);
    check('a failed write keeps its slot (with the reason), above the End of chapter',
        JSON.stringify(lessonSlot?.(closed, failed)) === JSON.stringify({ key: 'checkpoint-1', place: 'before' }), JSON.stringify(lessonSlot?.(closed, failed)));
    check('…and the stream ends as it does today', lessonPending?.(closed, failed) === false);
    check('no state, no slot', lessonSlot?.(screen, null) === null && lessonPending?.(screen, null) === false);
    check('a state for a topic with no card on screen draws nothing', lessonSlot?.(screen, { nodeId: 9, state: 'writing' }) === null);
    // A recall card carries its topic's id but is drawn on its own, outside the
    // chapter: a slot anchored on it would never be drawn, with the end held.
    const withRecall = [overview, card('recall-1', 'recall', 1)];
    check('the slot anchors on a chapter card, never on a recall card drawn alone',
        JSON.stringify(lessonSlot?.(withRecall, writing)) === JSON.stringify({ key: 'read-1', place: 'after' }), JSON.stringify(lessonSlot?.(withRecall, writing)));
    const landedPastRecall = placeCheckpoints(withRecall, [card('fi-7', 'lesson', 1)], 1);
    check('…and the lesson lands there too', keys(landedPastRecall) === 'read-1 fi-7 recall-1', keys(landedPastRecall));
    // Source check only: the behaviour is in the functions above; this pins
    // that FeedView is wired to them, and the Edge walk shows it drawn.
    const { readFileSync } = await import('node:fs');
    const view = readFileSync(fileURLToPath(new URL('../src/components/feed/FeedView.tsx', import.meta.url)), 'utf8');
    check('FeedView shows only "Writing the lesson" while it is pending, the failed note in the chapter',
        /lessonPending\(feedCards, lessonWrite\)/.test(view) && /if \(pending\) \{[\s\S]{0,200}<LessonBeingWritten/.test(view)
        && /slot && lessonWrite\?\.state === 'failed'/.test(view) && /lessonSlot\(feedCards, lessonWrite\)/.test(view));
    const storeSrc = readFileSync(fileURLToPath(new URL('../src/store.ts', import.meta.url)), 'utf8');
    check('the pull replaces the stand-in only when the page was showing "Writing the lesson"',
        /placeCheckpoints\(state\.feedCards, fresh, state\.feedLessonWrite\?\.nodeId \?\? null,\s*lessonPending\(state\.feedCards, state\.feedLessonWrite\)\)/.test(storeSrc));
}

console.log('\n--- the signal that a lesson landed is never thrown away ---');
{
    // Measured on the pre-fix build (1 Nov 2026): the page pulled at :15 on the
    // generator's previous tick, the lesson was written at :16, and both later
    // ticks fell inside the 4 s window and were dropped: no pull, no lesson.
    const { pullGate } = await import(pathToFileURL(out).href);
    let t = 0;
    const timers = [];
    const clock = { now: () => t, later: (fn, ms) => timers.push({ at: t + ms, fn }) };
    const pulls = [];
    const admit = pullGate(4000, clock);
    // The retry re-reads whether a page is in flight, as the store does.
    let busyUntil = -1;
    const signal = (opts = {}) => { if (admit({ ...opts, busy: t < busyUntil }, () => signal(opts))) pulls.push(t); };
    const runTimersUntil = (end) => {
        for (;;) {
            timers.sort((a, b) => a.at - b.at);
            if (!timers.length || timers[0].at > end) break;
            const next = timers.shift();
            t = next.at;
            next.fn();
        }
        t = end;
    };
    t = 15000; signal();
    t = 16000; signal();
    t = 17500; signal();
    runTimersUntil(30000);
    check('a pull, then ONE trailing pull at the end of the window',
        JSON.stringify(pulls) === JSON.stringify([15000, 19000]), JSON.stringify(pulls));
    pulls.length = 0;
    t = 40000; busyUntil = 41000; signal();
    runTimersUntil(50000);
    check('a signal while a page is in flight pulls after it', JSON.stringify(pulls) === JSON.stringify([44000]), JSON.stringify(pulls));
    const { readFileSync } = await import('node:fs');
    const store = readFileSync(fileURLToPath(new URL('../src/store.ts', import.meta.url)), 'utf8');
    const from = store.indexOf('pullFeedUpdates: async');
    const body = store.slice(from, store.indexOf('repairFeedVisual:', from));
    check('pullFeedUpdates goes through the gate and has no bare throttle return',
        body.includes('admitFeedPull(') && !/FEED_PULL_MIN_MS\)\s*return/.test(body) && !/if \(get\(\)\.feedLoading\) return;/.test(body),
        body.slice(0, 200));
    // A failed burst's task stays listed for minutes, and it is the OLDEST
    // 'feed' task: a signal read from it alone never changed while the retry
    // wrote the lesson, so the page never pulled.
    const { feedGenSignal } = await import(pathToFileURL(out).href);
    const task = (id, status, percent, message) => ({ id, kind: 'feed', status, progress: { percent, message } });
    const before = feedGenSignal?.([task('a', 'error', 10, 'outline'), task('b', 'running', 20, 'lesson 1')]);
    const after = feedGenSignal?.([task('a', 'error', 10, 'outline'), task('b', 'running', 99, 'question 1')]);
    check('the pull signal moves with the newest burst, not a failed one left in the list', !!before && before !== after, `${before} → ${after}`);
    check('…and a failure is still a signal (held from before, not new)',feedGenSignal?.([task('b', 'running', 20, 'lesson 1')]) !== feedGenSignal?.([task('b', 'error', 20, 'lesson 1')]));
}

console.log('\n--- the route: Study asks for the lesson, and says whether it is being written ---');
{
    // A stand-in model server on this machine. It HOLDS every request (the
    // writer is "on it"), then refuses them all, as a missing model does.
    const { createServer } = await import('node:http');
    const heldRes = [];
    let refuse = false;
    const refuseNow = (res) => { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: "model 'gate-model' not found" })); };
    let asked = 0;
    const stub = createServer((req, res) => { req.resume(); asked++; if (refuse) refuseNow(res); else heldRes.push(res); });
    await new Promise(r => stub.listen(0, '127.0.0.1', r));
    setting('ai_ollama_url', `http://127.0.0.1:${stub.address().port}`);
    // No other topic may be in the writer's way: only the one Study opens.
    db.prepare('UPDATE nodes SET completed_at = CURRENT_TIMESTAMP WHERE project_id = ?').run(course);
    const route = mkTopic('Uniform convergence', 9);
    const { createApp } = await import('../server/app.js');
    const appServer = createServer(createApp());
    await new Promise(r => appServer.listen(0, '127.0.0.1', r));
    const feed = async (exclude = []) => (await fetch(`http://127.0.0.1:${appServer.address().port}/api/feed?nodeId=${route}&exclude=${encodeURIComponent(exclude.join(','))}`)).json();
    const p1 = await feed();
    const k1 = (p1.items || []).map(c => c.key);
    check('the first page already knows the lesson is being written', p1.lessonWrite?.nodeId === route && p1.lessonWrite?.state === 'writing',
        JSON.stringify(p1.lessonWrite ?? p1.error));
    check('…serves the Overview and no checkpoint', k1.includes(`read-${route}`) && !k1.some(k => k.startsWith('checkpoint-')), JSON.stringify(k1));
    const until = async (cond, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await cond()) return true; await new Promise(r => setTimeout(r, 100)); } return false; };
    check('the writer is on it (the model was asked)', await until(() => heldRes.length > 0), `held ${heldRes.length}`);
    const p2 = await feed(k1);
    check('a pull meanwhile adds no checkpoint', !(p2.items || []).some(c => c.kind === 'checkpoint') && p2.lessonWrite?.state === 'writing',
        JSON.stringify({ keys: (p2.items || []).map(c => c.key), lessonWrite: p2.lessonWrite }));
    refuse = true;
    for (const res of heldRes.splice(0)) refuseNow(res);
    let p3 = null;
    await until(async () => { p3 = await feed(k1); return p3.lessonWrite?.state === 'failed'; });
    check('the write fails: the page is told why', p3?.lessonWrite?.state === 'failed' && /not found/.test(p3?.lessonWrite?.reason || ''),
        JSON.stringify(p3?.lessonWrite));
    check('…with what plainCause needs to say it in plain words', p3?.lessonWrite?.httpStatus === 404, JSON.stringify(p3?.lessonWrite));
    check('…and gets its End of chapter back', (p3?.items || []).some(c => c.key === `checkpoint-${route}`), JSON.stringify((p3?.items || []).map(c => c.key)));
    // The backoff belongs to the writer, the failure to the topic it was on: a
    // topic opened meanwhile was never tried, and is written when it ends.
    const other = mkTopic('The Weierstrass M-test', 10);
    const po = await (await fetch(`http://127.0.0.1:${appServer.address().port}/api/feed?nodeId=${other}`)).json();
    check('a topic opened during that backoff is not told the other topic failed', po.lessonWrite?.nodeId === other && po.lessonWrite?.state === 'writing',
        JSON.stringify(po.lessonWrite));
    // Nothing on the page kicks the writer while it backs off; it must kick
    // itself when the backoff ends, or the failed page stays failed (and the
    // other topic's slot spins) until a reload. Only time passes here.
    const askedAtFail = asked;
    check('the writer tries again when the backoff ends', await until(() => asked > askedAtFail, 25000), `asked ${askedAtFail} → ${asked}`);
    setting('ai_enabled', 'false');
    const off = await feed();
    check('with AI off nothing is being written: no state, the page as today', off.lessonWrite == null, JSON.stringify(off.lessonWrite));
    appServer.close();
    stub.close();
}

db.close();
rmSync(scratch, { recursive: true, force: true });
rmSync(bundleDir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
