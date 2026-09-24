// tools/evidence-rename-gates.mjs — the "Boss Fight" → "mastery check" rename,
// proved on the half a rename usually forgets: what is already STORED.
//
// Run:  node tools/evidence-rename-gates.mjs
//
// Deterministic, no model, no network. A scratch library (DB_PATH) is seeded
// with the PRE-FIX shapes a real 2026-09-20 database holds, then the migration
// is run the way it actually ships — by BOOTING A SECOND PROCESS against the
// same file, not by re-running a copy of the statement here, which would
// assert nothing about `server/database.js`.
//
// Why a gate rather than a look at the one library on this machine: the rename
// is silent when it half-works. `checkMasteryEligibility` counts a literal set
// (`evidence_type IN ('quiz','mastery_check','paper')`), so a row left saying
// `boss_fight` is not an error anywhere — it is a topic that was proven last
// week and is quietly unproven today, with the row still sitting in the table.
// Every assertion below is therefore run against a seeded pre-fix row, and the
// eligibility clause is re-checked afterwards rather than assumed.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const scratch = mkdtempSync(join(tmpdir(), 'evidence-rename-gates-'));
process.env.DB_PATH = join(scratch, 'gate.db');
// …and VAULT_ROOT, or the blob store resolves to the learner's real server/vault.
process.env.VAULT_ROOT = join(scratch, 'vault');

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
    cond ? pass++ : fail++;
    console.log(`${cond ? '  ok   ' : ' FAIL  '}${label}${cond || !detail ? '' : ` — ${detail}`}`);
};

const db = (await import('../server/database.js')).default;
const { checkMasteryEligibility, MIN_GATE_QUESTIONS, VALID_EVIDENCE_TYPES } =
    await import('../server/mastery.js');

/** Boot database.js in its own process, which is where the migration lives. */
const boot = `await import(${JSON.stringify(pathToFileURL(join(repoRoot, 'server', 'database.js')).href)}); process.exit(0);`;
const restart = () => spawnSync(process.execPath, ['--input-type=module', '-e', boot], {
    cwd: repoRoot, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
});

const projectId = Number(db.prepare(`INSERT INTO projects (name) VALUES ('gate')`).run().lastInsertRowid);
const mkNode = (title) => Number(db.prepare(
    `INSERT INTO nodes (project_id, parent_id, title, position) VALUES (?, NULL, ?, 0)`
).run(projectId, title).lastInsertRowid);

const setting = (key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;

// ---------------------------------------------------------------------------
console.log('\n--- the name is gone from the code that ships ---');
// ---------------------------------------------------------------------------

ok('no evidence type is still called boss_fight',
    !VALID_EVIDENCE_TYPES.includes('boss_fight'), VALID_EVIDENCE_TYPES.join(','));
ok('…and mastery_check is one', VALID_EVIDENCE_TYPES.includes('mastery_check'));

// ---------------------------------------------------------------------------
console.log('\n--- a pre-fix library, migrated by a second boot ---');
// ---------------------------------------------------------------------------

const proven = mkNode('proved by the old name');
const questions = MIN_GATE_QUESTIONS;

// The five shapes a 2026-09-20 database really holds.
db.prepare(`INSERT INTO mastery_evidence (node_id, evidence_type, score, total, metadata)
            VALUES (?, 'boss_fight', ?, ?, ?)`)
    .run(proven, questions, questions, JSON.stringify({ type: 'boss_fight', questionType: 'multiple_choice' }));
const quizId = Number(db.prepare(`INSERT INTO quizzes (node_id, title, questions) VALUES (?, 'q', '[]')`)
    .run(proven).lastInsertRowid);
db.prepare(`INSERT INTO quiz_attempts (quiz_id, score, total, answers) VALUES (?, ?, ?, ?)`)
    .run(quizId, questions, questions, JSON.stringify({ source: 'boss_fight' }));
db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('boss_fight_pass', '0.65')`).run();
db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('bulk_avg_ms_boss_fight', '81234')`).run();
db.prepare('DELETE FROM settings WHERE key IN (?, ?)').run('mastery_check_pass', 'bulk_avg_ms_mastery_check');
const marked = Number(db.prepare(
    `INSERT INTO chat_messages (node_id, project_id, role, content) VALUES (?, ?, 'assistant', ?)`
).run(proven, projectId, 'Ready when you are.\n\n[[boss-fight]]').lastInsertRowid);
const oddCase = Number(db.prepare(
    `INSERT INTO chat_messages (node_id, project_id, role, content) VALUES (?, ?, 'assistant', ?)`
).run(proven, projectId, 'Off you go.\n\n[[ Boss-Fight ]]').lastInsertRowid);

ok('the pre-fix row is seeded under the old name',
    db.prepare(`SELECT COUNT(*) n FROM mastery_evidence WHERE evidence_type = 'boss_fight'`).get().n === 1);
ok('…and it does NOT count as evidence before the migration',
    checkMasteryEligibility(proven, 0.85, 0.8).passed_assessment === false);

const first = restart();
ok('a second process boots against the same library', first.status === 0, (first.stderr || '').slice(0, 300));

const typeOf = () => db.prepare('SELECT evidence_type FROM mastery_evidence WHERE node_id = ?').get(proven)?.evidence_type;
const metaOf = () => db.prepare('SELECT metadata FROM mastery_evidence WHERE node_id = ?').get(proven)?.metadata;
const answersOf = () => db.prepare('SELECT answers FROM quiz_attempts WHERE quiz_id = ?').get(quizId)?.answers;
const contentOf = (id) => db.prepare('SELECT content FROM chat_messages WHERE id = ?').get(id)?.content;

ok('the evidence type moved', typeOf() === 'mastery_check', String(typeOf()));
ok('the metadata that records which path wrote it moved',
    JSON.parse(metaOf()).type === 'mastery_check', String(metaOf()));
ok('…without touching the rest of that JSON',
    JSON.parse(metaOf()).questionType === 'multiple_choice', String(metaOf()));
ok('the quiz attempt\'s recorded source moved',
    JSON.parse(answersOf()).source === 'mastery_check', String(answersOf()));

// The point of the whole migration: the row still proves the topic.
const after = checkMasteryEligibility(proven, 0.85, 0.8);
ok('a topic proved under the old name is STILL proved', after.passed_assessment === true,
    JSON.stringify(after));

// ---------------------------------------------------------------------------
console.log('\n--- the settings are the learner\'s, not the defaults ---');
// ---------------------------------------------------------------------------

// database.js seeds `mastery_check_pass: '0.8'` earlier in the same boot, so a
// migration written as INSERT OR IGNORE would silently reset a learner who had
// moved their pass mark. 0.65 is the value under test for exactly that reason.
ok('the pass mark carried its VALUE across, beating the freshly seeded default',
    setting('mastery_check_pass') === '0.65', String(setting('mastery_check_pass')));
ok('…and the old key is gone', setting('boss_fight_pass') === null, String(setting('boss_fight_pass')));
ok('the measured per-call average carried across',
    setting('bulk_avg_ms_mastery_check') === '81234', String(setting('bulk_avg_ms_mastery_check')));
ok('…and its old key is gone', setting('bulk_avg_ms_boss_fight') === null);

// ---------------------------------------------------------------------------
console.log('\n--- the marker inside stored chat, which is parsed at RENDER ---');
// ---------------------------------------------------------------------------

ok('a stored [[boss-fight]] became [[mastery-check]]',
    contentOf(marked) === 'Ready when you are.\n\n[[mastery-check]]', String(contentOf(marked)));
ok('…including a casing SQL replace() would have missed',
    contentOf(oddCase) === 'Off you go.\n\n[[mastery-check]]', String(contentOf(oddCase)));
ok('no stored message still carries the old marker',
    db.prepare("SELECT COUNT(*) n FROM chat_messages WHERE content LIKE '%boss-fight%'").get().n === 0);

// ---------------------------------------------------------------------------
console.log('\n--- running it twice changes nothing ---');
// ---------------------------------------------------------------------------

const snapshot = [typeOf(), metaOf(), answersOf(), setting('mastery_check_pass'),
    setting('bulk_avg_ms_mastery_check'), contentOf(marked), contentOf(oddCase)];
const second = restart();
ok('a third boot succeeds', second.status === 0, (second.stderr || '').slice(0, 300));
ok('…and every migrated value is byte-identical',
    JSON.stringify([typeOf(), metaOf(), answersOf(), setting('mastery_check_pass'),
        setting('bulk_avg_ms_mastery_check'), contentOf(marked), contentOf(oddCase)]) === JSON.stringify(snapshot));
ok('…and it reported no work to do',
    !(second.stdout || '').includes('Renamed'), (second.stdout || '').slice(0, 200));

// ---------------------------------------------------------------------------
console.log('\n--- a library that never held the old name is untouched ---');
// ---------------------------------------------------------------------------

const fresh = mkNode('written under the new name');
db.prepare(`INSERT INTO mastery_evidence (node_id, evidence_type, score, total, metadata)
            VALUES (?, 'mastery_check', ?, ?, '{"type":"mastery_check"}')`).run(fresh, questions, questions);
const freshBefore = db.prepare('SELECT * FROM mastery_evidence WHERE node_id = ?').get(fresh);
restart();
ok('a row already written under the new name is left alone',
    JSON.stringify(db.prepare('SELECT * FROM mastery_evidence WHERE node_id = ?').get(fresh))
    === JSON.stringify(freshBefore));

try { db.close(); } catch { /* best effort */ }
rmSync(scratch, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
