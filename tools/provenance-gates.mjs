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
// Saving now asks the card checker first (checkItemKeys); with no model
// reachable that is no verdict, and the cards are kept unchecked.
const cards = await finalizeFlashcards(nodeId, JSON.stringify({
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
    'nodes', 'resources', 'media_files', 'documents']) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
    ok(cols.includes('generated_by'), `${table} has a generated_by column`);
}

// --- 4. the learner is told which text a model wrote -----------------------
//
// EU AI Act Art. 50: a person reading a model's text is told so. Every surface
// that teaches or tests carries the "This is wrong" flag (ui/ReportItem), and
// the flag already asks the server about its item by ref, so the server says
// WHO wrote the item in that same answer and the flag marks it. Each expected
// value below follows from how the fixture row was MADE (a model's call, a
// person's hand, a file's claim), never from the resolver's own rules.

const IR = await import('../server/itemReports.js');
const writtenByRefs = typeof IR.writtenByRefs === 'function' ? IR.writtenByRefs : null;
ok(!!writtenByRefs, 'itemReports.js exports writtenByRefs');
const who = (ref) => (writtenByRefs ? (writtenByRefs([ref])[ref] ?? null) : 'not built');
const BY_GATE = { model: 'gate-model:9b' };
const BY_OTHER = { model: 'other:70b' };
const STAMP = JSON.stringify({ provider: 'ollama', model: 'gate-model:9b' });

// The ref spelling (docs: item-reports.md): a drill is named by the FNV-1a of
// its fence body and of its item's prompt and key, written out here.
const fnv1a = (s) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0');
};
const drillRef = (node, body, prompt, answer) => `drill:${node}:f${fnv1a(body)}:i${fnv1a(`${prompt}\u0000${answer}`)}`;
const drillBody = (prompt, answer) => JSON.stringify({ title: 'Pairs', items: [
    { prompt, answer }, { prompt: `${prompt} two`, answer: `${answer} two` }, { prompt: `${prompt} three`, answer: `${answer} three` },
] });
const fence = (body) => `Some text.\n\n\`\`\`drill\n${body}\n\`\`\`\n`;

// Topics: one a model wrote at creation, one a person typed.
const mkNode = (title, stamp, description) => Number(db.prepare(`
    INSERT INTO nodes (project_id, parent_id, title, description, notes, status, is_note, position, generated_by)
    VALUES (?, NULL, ?, ?, '', 'not_started', 0, 0, ?)`).run(projectId, title, description, stamp).lastInsertRowid);
const aiBody = drillBody('ai prompt', 'ai answer');
const handBody = drillBody('hand prompt', 'hand answer');
const lessonBody = drillBody('lesson prompt', 'lesson answer');
const aiNode = mkNode('Written by the model', STAMP, fence(aiBody));
const handNode = mkNode('Typed by the learner', null, fence(handBody));

// Feed rows: only feedGen writes them, each with the model in its meta.
const feedRow = (node, kind, content, meta) => Number(db.prepare(`
    INSERT INTO feed_items (node_id, kind, seq, content, meta, status) VALUES (?, ?, ?, ?, ?, 'ready')`)
    .run(node, kind, kind === 'question' ? 2 : 1, content, JSON.stringify(meta)).lastInsertRowid);
const lessonRow = feedRow(handNode, 'lesson', fence(lessonBody), { partIndex: 1, provider: 'ollama', model: 'gate-model:9b' });
const questionRow = feedRow(aiNode, 'question', JSON.stringify({ question: 'Two plus two?', type: 'multiple_choice', options: ['3', '4'], correct_answer: '4' }),
    { partIndex: 1, provider: 'ollama', model: 'gate-model:9b' });
const paperRow = feedRow(aiNode, 'practice', JSON.stringify({ brief: 'Prove it.', mode: 'paper' }), { mode: 'paper', provider: 'ollama', model: 'gate-model:9b' });
// A row from before the stamp: still a model's, which model is not known.
const oldRow = feedRow(aiNode, 'lesson', 'An older lesson.', { partIndex: 1 });

eq(who(`fi:${lessonRow}`), BY_GATE, 'a lesson names the model that wrote it');
eq(who(`fi:${questionRow}`), BY_GATE, 'a feed question names the model that wrote it');
eq(who(`fi:${paperRow}`), BY_GATE, 'a paper exercise names the model that wrote it');
eq(who(`fi:${oldRow}`), { model: null }, 'a lesson older than its stamp is still marked a model\'s, the model unnamed');
eq(who('fi:987654'), null, 'a feed row that does not exist claims no author');

// Bank questions: the model's quiz (section 2), a file's claim, a person's.
const quizUuid = JSON.parse(db.prepare('SELECT questions FROM quizzes WHERE id = ?').get(quiz.id).questions)[0]?.uuid;
ok(!!quizUuid, 'the saved quiz question has a uuid');
const imported = Number(db.prepare(`INSERT INTO quizzes (node_id, title, questions, generated_by) VALUES (?, 'Imported', ?, NULL)`).run(nodeId, JSON.stringify([
    { question: 'Typed by a teacher: is water wet?', type: 'true_false', options: ['True', 'False'], correct_answer: 'True' },
    { question: 'A file says a model wrote this: is ice cold?', type: 'true_false', options: ['True', 'False'], correct_answer: 'True', generated_by: 'other:70b' },
])).lastInsertRowid);
const importedQs = JSON.parse(db.prepare('SELECT questions FROM quizzes WHERE id = ?').get(imported).questions);
ok(importedQs.every(q => q.uuid), 'the imported questions have uuids');
eq(who(`q:${quizUuid}`), BY_GATE, 'a question in a model\'s quiz names that model');
eq(who(`q:${importedQs[0].uuid}`), null, 'a question a person wrote is not marked');
eq(who(`q:${importedQs[1].uuid}`), BY_OTHER, 'a question a file says a model wrote names that model');

// Cards: the model's (section 2), a person's (section 3), a file's claim.
const aiCard = db.prepare('SELECT id FROM flashcards WHERE node_id = ? AND generated_by IS NOT NULL ORDER BY id').get(nodeId).id;
const handCard = db.prepare("SELECT id FROM flashcards WHERE front = 'hand written'").get().id;
const claimedCard = Number(db.prepare('INSERT INTO flashcards (node_id, front, back, generated_by) VALUES (?, ?, ?, ?)')
    .run(nodeId, 'claimed', 'by a file', JSON.stringify({ model: 'other:70b', via: 'import' })).lastInsertRowid);
eq(who(`card:${aiCard}`), BY_GATE, 'a model\'s card names that model');
eq(who(`card:${handCard}`), null, 'a card a person typed is not marked');
eq(who(`card:${claimedCard}`), BY_OTHER, 'a card a file says a model wrote names that model');

// Placement questions are only ever written by a model (placement.js).
const probeQ = (question, stamp) => ({ question, type: 'true_false', options: ['True', 'False'], correct_answer: 'True', node_id: aiNode, ...(stamp ? { generated_by: stamp } : {}) });
const probeId = Number(db.prepare(`INSERT INTO placement_probes (project_id, state, targets, questions) VALUES (?, 'ready', '[]', ?)`)
    .run(projectId, JSON.stringify([probeQ('Stamped?', 'gate-model:9b'), probeQ('Older, unstamped?', null)])).lastInsertRowid);
eq(who(`probe:${probeId}:0`), BY_GATE, 'a placement question names the model that wrote it');
eq(who(`probe:${probeId}:1`), { model: null }, 'an older placement question is still marked a model\'s');
eq(who(`probe:${probeId}:7`), null, 'a placement question that does not exist claims no author');

// Drills: as the text they sit in, or the card they drill.
eq(who(drillRef(aiNode, aiBody, 'ai prompt', 'ai answer')), BY_GATE, 'a drill in a model\'s Overview names that model');
eq(who(drillRef(handNode, handBody, 'hand prompt', 'hand answer')), null, 'a drill in an Overview the learner typed is not marked');
eq(who(drillRef(handNode, lessonBody, 'lesson prompt', 'lesson answer')), BY_GATE, 'a drill in a lesson names the lesson\'s model');
eq(who(`drill:${nodeId}:cards:c${aiCard}`), BY_GATE, 'a card drill item names its card\'s model');
eq(who(`drill:${nodeId}:cards:c${handCard}`), null, 'a card drill item of a typed card is not marked');

// The flag's own request carries it: GET /api/item-reports?refs=.
const { createServer } = await import('node:http');
const { createApp } = await import('../server/app.js');
const server = createServer(createApp());
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const listed = await (await fetch(`${base}/api/item-reports?refs=${[`fi:${lessonRow}`, `card:${handCard}`, `q:${importedQs[1].uuid}`].join(',')}`)).json();
eq(listed.written ?? null, { [`fi:${lessonRow}`]: BY_GATE, [`q:${importedQs[1].uuid}`]: BY_OTHER },
    'GET /api/item-reports?refs= says which of its refs a model wrote, and leaves the rest out');

// --- 5. exports say which model wrote what ---------------------------------
//
// Text inside a file is "containerised" (Code of Practice on AI-generated
// content): it carries its mark as metadata. Questions and cards already do;
// a topic's Overview and an Anki card did not.

const exported = await (await fetch(`${base}/api/export/${projectId}`)).json();
const exportedNode = (title) => (exported.nodes || []).find(n => n.title === title);
eq(exportedNode('Written by the model')?.generated_by ?? null, 'gate-model:9b', 'a JSON export names the model that wrote a topic');
eq(exportedNode('Typed by the learner')?.generated_by ?? null, null, 'a JSON export names no model for a typed topic');

const JSZip = (await import('jszip')).default;
const bundleRes = await fetch(`${base}/api/export/${projectId}/bundle`);
const bundleZip = await JSZip.loadAsync(Buffer.from(await bundleRes.arrayBuffer()));
const manifest = JSON.parse(await bundleZip.file('manifest.json').async('string'));
const bundleNode = (title) => (manifest.nodes || []).find(n => n.title === title);
eq(bundleNode('Written by the model')?.generated_by ?? null, 'gate-model:9b', 'a .studyvault bundle names the model that wrote a topic');
eq(bundleNode('Typed by the learner')?.generated_by ?? null, null, 'a .studyvault bundle names no model for a typed topic');

// Read back: the file's claim is kept as a claim, an unmarked topic stays NULL.
const importRes = await (await fetch(`${base}/api/import`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project: { name: 'Round trip' }, nodes: [
        { title: 'Claimed topic', description: 'x', generated_by: 'other:70b' },
        { title: 'Unclaimed topic', description: 'y' },
    ] }),
})).json();
const importedNodes = Object.fromEntries(db.prepare('SELECT title, generated_by FROM nodes WHERE project_id = ?')
    .all(importRes.id ?? -1).map(n => [n.title, n.generated_by]));
eq(importedNodes['Claimed topic'] ? JSON.parse(importedNodes['Claimed topic']) : null, { model: 'other:70b', via: 'import' },
    'an imported topic keeps the file\'s claim as a claim');
eq('Unclaimed topic' in importedNodes ? importedNodes['Unclaimed topic'] : 'missing', null, 'an imported topic with no claim stays unstamped');

// Anki: a tag on the note, `ai-written::<model>`, read back on import as the
// card's claim and never used to file the deck.
const { exportProjectApkg } = await import('../server/ankiExport.js');
const { mediaStorage } = await import('../server/vaultStorage.js');
const { buffer: apkg } = await exportProjectApkg({ db, mediaStorage }, projectId);
const apkgZip = await JSZip.loadAsync(apkg);
const { writeFileSync } = await import('node:fs');
const colPath = join(SCRATCH, 'export.anki2');
writeFileSync(colPath, await apkgZip.file('collection.anki2').async('nodebuffer'));
const Database = (await import('better-sqlite3')).default;
const col = new Database(colPath, { readonly: true });
const tagsOf = (front) => col.prepare('SELECT tags FROM notes WHERE sfld = ?').get(front)?.tags ?? 'missing';
const aiFront = db.prepare('SELECT front FROM flashcards WHERE id = ?').get(aiCard).front;
const aiTags = tagsOf(aiFront).trim().split(/\s+/).filter(Boolean);
const handTags = tagsOf('hand written').trim().split(/\s+/).filter(Boolean);
const claimedTags = tagsOf('claimed').trim().split(/\s+/).filter(Boolean);
col.close();
eq(aiTags, ['ai-written::gate-model:9b'], 'an Anki export tags a model\'s card with the model');
eq(claimedTags, ['ai-written::other:70b'], 'an Anki export tags a card a file said a model wrote');
eq(handTags, [], 'an Anki export tags no typed card');

const { parseApkg, commitImport } = await import('../server/ankiImport.js');
const parsedDeck = await parseApkg(apkg, { importMedia: false });
const parsedCard = (front) => parsedDeck.cards.find(c => c.front === front);
eq(parsedCard(aiFront)?.tags ?? 'missing', [], 'the importer does not keep the ai-written tag as a tag (it would file the deck by model)');
eq(parsedCard(aiFront)?.generated_by ?? null, 'gate-model:9b', 'the importer reads the ai-written tag as the card\'s claim');
eq(parsedCard('hand written')?.generated_by ?? null, null, 'the importer claims nothing for an untagged card');
const deckImport = commitImport(parsedDeck, { projectName: 'Anki round trip' });
const reimported = db.prepare(`SELECT f.front, f.generated_by FROM flashcards f JOIN nodes n ON n.id = f.node_id WHERE n.project_id = ?`).all(deckImport.projectId);
const reStamp = (front) => reimported.find(c => c.front === front)?.generated_by ?? null;
eq(reStamp(aiFront) ? JSON.parse(reStamp(aiFront)) : null, { model: 'gate-model:9b', via: 'import' }, 'an Anki import stores the tag\'s claim on the card');
eq(reStamp('hand written'), null, 'an Anki import leaves an untagged card unstamped');

// A shared deck's tags are anyone's: the claim is bounded as a course file's is.
const { splitAiWrittenTag } = await import('../server/ankiAiTag.js');
eq(splitAiWrittenTag(['AI-Written::m:1', 'verbs']), { model: 'm:1', tags: ['verbs'] }, 'the tag is read whatever its case');
eq(splitAiWrittenTag([`ai-written::${'x'.repeat(201)}`, 'ai-written::second:2']), { model: 'second:2', tags: [] },
    'a name longer than a course file may claim is no claim, and every ai-written tag leaves the deck\'s tags');
eq(splitAiWrittenTag(['ai-written::evil\u202emodel\u0007']).model, 'evilmodel', 'control and direction characters are dropped from the name');
eq(splitAiWrittenTag(['ai-written::', 'ai-written::\u200b']), { model: null, tags: [] }, 'an empty name claims nothing');

await new Promise(r => server.close(r));

// --- 6. the flag says it -----------------------------------------------------
//
// The real ReportItem, bundled and rendered with the store holding the
// server's answer. Every surface that teaches or tests mounts this one
// control; that each passes its item's ref is
// report-link-gates' and item-report-gates' to check, not this section's.

const { JSDOM } = await import('jsdom');
const page = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost:3001/' }).window;
for (const k of ['window', 'document', 'navigator', 'localStorage', 'HTMLElement', 'Node', 'getComputedStyle']) {
    try { globalThis[k] = page[k]; } catch { /* a read-only global stays node's */ }
}
page.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.matchMedia = page.matchMedia;
const { build } = await import('esbuild');
const { fileURLToPath, pathToFileURL } = await import('node:url');
const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const renderBundle = join(SCRATCH, 'report-item.mjs');
await build({
    stdin: {
        contents: `
            import React from 'react';
            import { createRoot } from 'react-dom/client';
            import i18n from 'i18next';
            import { initReactI18next } from 'react-i18next';
            import ReportItem from './components/ui/ReportItem';
            import { useItemReports } from './utils/itemReportStore';
            export async function boot() { await i18n.use(initReactI18next).init({ lng: 'en', resources: {}, returnEmptyString: false }); }
            // Every ref already known, so mounting asks the server nothing.
            export const setWritten = (written, refs) => useItemReports.setState({ written, byRef: Object.fromEntries(refs.map(r => [r, null])) });
            // Mounted, not rendered to a string: a store renders its INITIAL
            // state on the server (zustand's server snapshot).
            export function flag(itemRef) {
                const el = document.createElement('div');
                const root = createRoot(el);
                React.act(() => root.render(React.createElement(ReportItem, { itemRef, surface: 'feed' })));
                const html = el.innerHTML;
                React.act(() => root.unmount());
                return html;
            }
        `,
        resolveDir: join(repoRoot, 'src'), loader: 'tsx',
    },
    bundle: true, format: 'esm', platform: 'node', outfile: renderBundle, logLevel: 'silent', jsx: 'automatic',
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    loader: { '.css': 'empty', '.svg': 'text', '.png': 'dataurl', '.woff2': 'empty', '.woff': 'empty', '.ttf': 'empty' },
    define: { 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true', 'import.meta.env.MODE': '"production"', 'import.meta.env.BASE_URL': '"/"' },
});
const R = await import(pathToFileURL(renderBundle).href);
await R.boot();
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
R.setWritten({ 'fi:1': { model: 'gate-model:9b' }, 'fi:2': { model: null }, 'card:3': null }, ['fi:1', 'fi:2', 'card:3']);
// What a sighted reader sees, what hovering shows, and what a screen reader hears.
const readMark = (html) => {
    const box = page.document.createElement('div');
    box.innerHTML = html;
    const mark = box.querySelector('[data-ai-written]');
    if (!mark) return null;
    const seen = [...mark.querySelectorAll('*')].filter(e => !e.closest('.sr-only') && !e.classList.contains('sr-only'))
        .map(e => e.textContent).join('').trim();
    const heard = [...box.querySelectorAll('*')].filter(e => !e.closest('[aria-hidden="true"]') && !e.children.length)
        .map(e => e.textContent).join(' ').replace(/\s+/g, ' ').trim();
    return { seen, hover: mark.getAttribute('title'), heard, flag: /This is wrong/.test(html) };
};
const named = readMark(R.flag('fi:1'));
const unnamed = readMark(R.flag('fi:2'));
const noneHtml = R.flag('card:3');
eq(named?.seen, 'Written by AI', 'the flag of a model\'s item shows "Written by AI"');
eq(named?.hover, 'Written by AI (gate-model:9b)', 'hovering it names the model');
ok(named?.heard.includes('Written by AI (gate-model:9b)') && named.heard.split('Written by AI').length === 2,
    'a screen reader hears the model named, and the mark once');
eq([unnamed?.seen, unnamed?.hover ?? null], ['Written by AI', null], 'an unnamed model\'s item says "Written by AI" with no empty name');
ok(!/Written by AI/.test(noneHtml), 'an item no model wrote says nothing about AI');
ok(/This is wrong/.test(noneHtml), 'and still carries its flag');

db.close();
rmSync(SCRATCH, { recursive: true, force: true });

if (failures.length) {
    console.error(`\n${failures.length} FAILED:`);
    for (const f of failures) console.error(`  ✗ ${f}`);
    console.error(`\n${passed} passed, ${failures.length} failed`);
    process.exit(1);
}
console.log(`\n${passed} passed, 0 failed`);
