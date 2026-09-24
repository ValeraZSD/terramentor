#!/usr/bin/env node
/**
 * Provenance gates — "which model wrote this row".
 *
 * Two things are asserted here and the second is the one that actually breaks.
 *
 * 1. `aiProvenance()` shape: provider + model, and **null when there is no
 *    model to name**, so a row written by the degraded no-AI path stays
 *    honestly unstamped rather than claiming an author.
 *
 * 2. The write paths. Adding a column to an `INSERT` means adding a placeholder
 *    AND an argument, in two different places, and getting that wrong throws at
 *    runtime — which for `finalizeFlashcards` means flashcard generation simply
 *    stops working. So the real functions are driven end-to-end against a
 *    scratch database with a canned model response: no model call, no network,
 *    but the identical SQL.
 *
 * Runs with no model and no network. DB_PATH must be set BEFORE importing
 * anything that reaches `database.js`, which opens a database at module load.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRATCH = mkdtempSync(join(tmpdir(), 'mnem-prov-gate-'));
process.env.DB_PATH = join(SCRATCH, 'gate.db');
// …and VAULT_ROOT, or the blob store resolves to the learner's real server/vault.
process.env.VAULT_ROOT = join(SCRATCH, 'vault');
// The env overrides in getAISettings are applied last and never written back,
// which is exactly what a test wants: a known identity without touching the
// settings row of the app the learner is running.
process.env.AI_PROVIDER = 'ollama';
process.env.AI_MODEL = 'gate-model:9b';

const { default: db } = await import('../server/database.js');
const { aiProvenance, aiProvenanceFields } = await import('../server/ai.js');
const { finalizeFlashcards, finalizeQuiz } = await import('../server/studyMaterial.js');

let passed = 0;
const failures = [];
const ok = (cond, label) => { if (cond) passed += 1; else failures.push(label); };
const eq = (a, b, label) => {
    const x = JSON.stringify(a), y = JSON.stringify(b);
    if (x === y) passed += 1; else failures.push(`${label}\n      expected ${y}\n      got      ${x}`);
};

// --- 1. the helper ---------------------------------------------------------

const raw = aiProvenance();
ok(typeof raw === 'string', 'aiProvenance returns a string ready to bind');
eq(JSON.parse(raw), { provider: 'ollama', model: 'gate-model:9b' },
    'aiProvenance names the provider and the model');
eq(aiProvenanceFields(), { provider: 'ollama', model: 'gate-model:9b' },
    'aiProvenanceFields returns the same identity as an object');
eq(JSON.parse(aiProvenance({ model: 'other:70b' })), { provider: 'ollama', model: 'other:70b' },
    'an explicit model override wins (the vision model is not the chat model)');

// No model configured is not an error — it is the degraded path, and it must
// leave the row unstamped rather than inventing an author.
const savedModel = process.env.AI_MODEL;
delete process.env.AI_MODEL;
ok(aiProvenance() === null, 'no model configured yields null, never a fabricated author');
eq(aiProvenanceFields(), {}, 'aiProvenanceFields degrades to an empty object');
process.env.AI_MODEL = savedModel;

// --- 2. the write paths ----------------------------------------------------

const projectId = Number(db.prepare(
    "INSERT INTO projects (name, description) VALUES ('Gate', '')").run().lastInsertRowid);
const nodeId = Number(db.prepare(`
    INSERT INTO nodes (project_id, parent_id, title, description, notes, status, is_note, position)
    VALUES (?, NULL, 'Topic', '', '', 'not_started', 0, 0)`).run(projectId).lastInsertRowid);

// A canned model response — the same shape the real generator hands these.
const cards = finalizeFlashcards(nodeId, JSON.stringify({
    flashcards: [
        { front: 'What is a gate?', back: 'A deterministic check.' },
        { front: 'Second card', back: 'Second answer.' },
    ],
}));
eq(cards.count, 2, 'finalizeFlashcards reports two cards saved');

const savedCards = db.prepare('SELECT front, generated_by FROM flashcards WHERE node_id = ?').all(nodeId);
eq(savedCards.length, 2, 'both cards are in the database');
ok(savedCards.every(c => c.generated_by), 'every generated flashcard carries provenance');
eq(JSON.parse(savedCards[0].generated_by), { provider: 'ollama', model: 'gate-model:9b' },
    'the flashcard names the model that wrote it');

// finalizeQuiz reads a bare JSON ARRAY out of the response and keys on
// snake_case `correct_answer` — the shape the prompt actually asks for. The
// question also has to survive the real quality gates (a true/false item must
// be a STATEMENT to judge, not a question), which is the right behaviour to be
// subject to: a fixture that bypassed them would not be testing the real path.
const quiz = finalizeQuiz(nodeId, JSON.stringify([{
    question: 'A deterministic gate asserts the same result on every run.',
    type: 'true_false',
    options: ['True', 'False'],
    correct_answer: 'True',
    explanation: 'Determinism is what makes the assertion repeatable.',
}]), false);
ok(!!quiz?.id, 'the quiz was saved');
const savedQuiz = db.prepare('SELECT generated_by FROM quizzes WHERE id = ?').get(quiz.id);
eq(JSON.parse(savedQuiz.generated_by), { provider: 'ollama', model: 'gate-model:9b' },
    'the quiz names the model that wrote it');

// --- 3. an unstamped row is the signal, not a gap --------------------------

// A card a person typed, or one that arrived from an Anki import, must stay
// NULL — that NULL is how "nobody generated this" is expressed, so nothing may
// backfill it and no write path may default it.
db.prepare('INSERT INTO flashcards (node_id, front, back) VALUES (?, ?, ?)')
    .run(nodeId, 'hand written', 'by a person');
const handWritten = db.prepare(
    "SELECT generated_by FROM flashcards WHERE front = 'hand written'").get();
ok(handWritten.generated_by === null, 'a hand-written card is left unstamped');

// Every table that claims the column really has it — a migration that silently
// failed would otherwise only surface as a 500 during a generation.
for (const table of ['flashcards', 'quizzes', 'chat_messages', 'paper_attempts',
    'nodes', 'resources', 'media_files']) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
    ok(cols.includes('generated_by'), `${table} has a generated_by column`);
}

db.close();
rmSync(SCRATCH, { recursive: true, force: true });

if (failures.length) {
    console.error(`\n${failures.length} FAILED:`);
    for (const f of failures) console.error(`  ✗ ${f}`);
    console.error(`\n${passed} passed, ${failures.length} failed`);
    process.exit(1);
}
console.log(`\n${passed} passed, 0 failed`);
