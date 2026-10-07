#!/usr/bin/env node
/**
 * tools/chapter-end-gates.mjs — a topic's checkpoint is the END of its chapter.
 *
 * Run:  node tools/chapter-end-gates.mjs
 *
 * Reported 5 Oct 2026 on the Dutch course: a topic stream opened on "End of
 * chapter" with the topic's own new cards under it, and a course stream
 * stacked one "End of chapter" per finished topic at the top. `composeFeed`
 * pushed a taught-out topic's checkpoint the moment its queue was empty, and
 * its new cards only arrived later as filler. Now the topic's new cards come
 * first and the checkpoint closes them, on both scopes; and a page too short
 * for all of them still carries the checkpoint.
 *
 * Deterministic: a scratch database, no model, no network.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'chapter-end-gates-'));
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
db.prepare("INSERT INTO settings (key, value) VALUES ('ai_enabled', 'false') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();

const day = (n) => new Date(Date.now() + n * 86400000).toISOString().split('T')[0];
const course = Number(db.prepare("INSERT INTO projects (name, position, start_date, deadline) VALUES ('Dutch', 0, ?, ?)").run(day(-10), day(300)).lastInsertRowid);
const mkTopic = (title, position) => Number(db.prepare(`
    INSERT INTO nodes (project_id, parent_id, title, position, role, scheduled_start, scheduled_end, description)
    VALUES (?, NULL, ?, ?, ?, ?, ?, 'Overview.')
`).run(course, title, position, ROLE_TOPIC, day(-5), day(-1)).lastInsertRowid);
// Taught out: a two-part plan, both parts read.
const teachOut = (nodeId) => {
    db.prepare("INSERT INTO feed_items (node_id, kind, seq, content, status) VALUES (?, 'plan', 0, ?, 'ready')")
        .run(nodeId, JSON.stringify({ parts: [{ title: 'One' }, { title: 'Two' }] }));
    for (const part of [1, 2]) {
        db.prepare("INSERT INTO feed_items (node_id, kind, seq, content, status, meta) VALUES (?, 'lesson', ?, 'Text.', 'consumed', ?)")
            .run(nodeId, part * 2 - 1, JSON.stringify({ partIndex: part, partCount: 2 }));
    }
};
const mkCards = (nodeId, n) => {
    for (let i = 0; i < n; i++) db.prepare('INSERT INTO flashcards (node_id, front, back) VALUES (?, ?, ?)').run(nodeId, `Q${i}`, `A${i}`);
};

const diphthongs = mkTopic('Diphthongs', 0);
const consonants = mkTopic('Consonants', 1);
teachOut(diphthongs); teachOut(consonants);
mkCards(diphthongs, 3);
mkCards(consonants, 2);
const gate = getGateConfig();
const order = (items, nodeId) => items
    .filter(c => (c.kind === 'flashcard' ? c.card.node_id : c.nodeId) === nodeId)
    .map(c => c.kind);

console.log('\n--- a topic stream: its new cards, then its end ---');
const topic = composeFeed({ gate, nodeId: diphthongs }).items;
const tk = order(topic, diphthongs);
check('the checkpoint is served', tk.includes('checkpoint'), JSON.stringify(tk));
check('every new card of the topic comes before its checkpoint',
    tk.indexOf('checkpoint') === tk.length - 1 && tk.filter(k => k === 'flashcard').length === 3, JSON.stringify(tk));

console.log('\n--- a course stream: each finished topic closes after its own cards ---');
const whole = composeFeed({ gate, projectId: course }).items;
for (const [name, id] of [['Diphthongs', diphthongs], ['Consonants', consonants]]) {
    const k = order(whole, id);
    check(`${name}: its checkpoint follows its new cards`,
        k.includes('checkpoint') && k.lastIndexOf('flashcard') < k.indexOf('checkpoint'), JSON.stringify(k));
}
const firstTwo = whole.slice(0, 2).map(c => c.kind);
check('the course stream does not open on a stack of checkpoints', !(firstTwo[0] === 'checkpoint' && firstTwo[1] === 'checkpoint'), JSON.stringify(firstTwo));

console.log('\n--- a topic still being READ already has its end, after its last part ---');
// Every part written, none read: the end card belongs on THIS page, after the
// last part — served only once every part was consumed, it landed on a page
// the learner never asked for, below the topics they had moved on to.
const reading = mkTopic('Stress', 2);
db.prepare("INSERT INTO feed_items (node_id, kind, seq, content, status) VALUES (?, 'plan', 0, ?, 'ready')")
    .run(reading, JSON.stringify({ parts: [{ title: 'One' }, { title: 'Two' }] }));
for (const part of [1, 2]) {
    db.prepare("INSERT INTO feed_items (node_id, kind, seq, content, status, meta) VALUES (?, 'lesson', ?, 'Text.', 'ready', ?)")
        .run(reading, part * 2 - 1, JSON.stringify({ partIndex: part, partCount: 2 }));
}
const rk = order(composeFeed({ gate, nodeId: reading }).items, reading);
check('lesson, lesson, then the checkpoint', JSON.stringify(rk) === JSON.stringify(['lesson', 'lesson', 'checkpoint']), JSON.stringify(rk));
const unwritten = mkTopic('Intonation', 3);
db.prepare("INSERT INTO feed_items (node_id, kind, seq, content, status) VALUES (?, 'plan', 0, ?, 'ready')")
    .run(unwritten, JSON.stringify({ parts: [{ title: 'One' }, { title: 'Two' }] }));
db.prepare("INSERT INTO feed_items (node_id, kind, seq, content, status, meta) VALUES (?, 'lesson', 1, 'Text.', 'ready', ?)")
    .run(unwritten, JSON.stringify({ partIndex: 1, partCount: 2 }));
const uk = order(composeFeed({ gate, nodeId: unwritten }).items, unwritten);
check('a part still unwritten: no end yet', !uk.includes('checkpoint'), JSON.stringify(uk));

console.log('\n--- a closed chapter gets nothing more on a later page ---');
// A bank the next page tops up: with the checkpoint held, none of it may come.
db.prepare('INSERT INTO quizzes (node_id, title, questions) VALUES (?, ?, ?)').run(reading, 'Bank', JSON.stringify(
    Array.from({ length: 8 }, (_, i) => ({ type: 'multiple_choice', question: `Q${i}?`, options: ['a', 'b', 'c', 'd'], correct_answer: 'a' }))));
const page1 = composeFeed({ gate, nodeId: reading, limit: 30 }).items;
const held = new Set(page1.map(c => c.key));
check('page 1 closes the topic', page1.some(c => c.kind === 'checkpoint' && c.nodeId === reading), JSON.stringify(order(page1, reading)));
const page2 = composeFeed({ gate, nodeId: reading, excludeKeys: held }).items.filter(c => c.nodeId === reading);
check('page 2 adds no teaching to it', page2.length === 0, JSON.stringify(page2.map(c => c.kind)));

console.log('\n--- the live numbers are the composed card\'s ---');
const { checkpointFacts } = await import('../server/feed.js');
const cp = composeFeed({ gate, nodeId: diphthongs }).items.find(c => c.kind === 'checkpoint');
const facts = checkpointFacts(diphthongs, gate);
check('checkpointFacts carries every number the card shows',
    ['feedCorrect', 'feedTotal', 'masteryScore', 'eligible', 'borrowedEstimate', 'borrowedFrom'].every(k => JSON.stringify(facts[k]) === JSON.stringify(cp[k])),
    JSON.stringify({ facts, cp }));

console.log('\n--- a page too short for every card still ends the chapter ---');
const short = composeFeed({ gate, nodeId: diphthongs, limit: 2 }).items.map(c => c.kind);
check('limit 2: one card, then the checkpoint', JSON.stringify(short) === JSON.stringify(['flashcard', 'checkpoint']), JSON.stringify(short));

db.close();
rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
