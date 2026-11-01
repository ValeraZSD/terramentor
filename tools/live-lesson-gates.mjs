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
}

db.close();
rmSync(scratch, { recursive: true, force: true });
rmSync(bundleDir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
