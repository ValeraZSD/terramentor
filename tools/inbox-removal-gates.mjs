#!/usr/bin/env node
/**
 * tools/inbox-removal-gates.mjs — there is no Inbox, and a library that had
 * one keeps everything in it.
 *
 *   node tools/inbox-removal-gates.mjs [--root DIR]
 *
 * A short course (server/shortCourses.js) is how a link, a file or a pasted
 * page becomes something to study, and a lone fact goes as a card into the
 * course it belongs to (the assistant's `card` fence). So the capture box,
 * its `c` key, POST /api/capture, the Inbox's standing slot in the feed, the
 * assistant's `capture` fence, its "save to the Inbox" place and the MCP
 * add_capture tool are gone. Nothing is deleted from a library that had an
 * Inbox: that project stays as an ordinary course under the name the learner
 * knows, with its topics and evidence, and the setting that marked it is
 * dropped at startup. A card collection and a short course keep their
 * standing slot in the feed: they share the code the Inbox used.
 *
 * --root runs the same cases against another checkout; on the code before the
 * removal every line fails.
 *
 * Deterministic: a scratch library, no model, no network.
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const argOf = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const ROOT = resolve(argOf('--root') || repo);

// Set in-process, before any server module is imported.
const scratch = mkdtempSync(join(tmpdir(), 'inbox-removal-gates-'));
process.env.DB_PATH = join(scratch, 'gate.db');
process.env.VAULT_ROOT = join(scratch, 'vault');
process.env.DATA_DIR = scratch;
process.env.HOST = '127.0.0.1';

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${String(extra).slice(0, 400)}` : ''}`); }
};
const read = (rel) => (existsSync(join(ROOT, rel)) ? readFileSync(join(ROOT, rel), 'utf8') : '');
const S = pathToFileURL(join(ROOT, 'server') + '/').href;

// ---------------------------------------------------------------------------
// An OLD library, written by a separate process before this one opens it, so
// the startup this process runs is the upgrade: an Inbox project marked by
// `inbox_project_id`, holding a captured topic (its text as Material) with an
// answer on it; a dated course with work overdue; and a card collection.
// ---------------------------------------------------------------------------
const NOW = new Date('2026-11-11T12:00:00Z');
const seed = `
const { default: db } = await import(${JSON.stringify(S + 'database.js')});
if (!process.env.DB_PATH.startsWith(${JSON.stringify(scratch)})) throw new Error('not the scratch library');
const project = (name, extra = '') => Number(db.prepare(\`INSERT INTO projects (name, icon, start_date, deadline) VALUES (?, 'book', \${extra || 'NULL, NULL'})\`).run(name).lastInsertRowid);
const node = (pid, parent, title, more = {}) => Number(db.prepare(
    'INSERT INTO nodes (project_id, parent_id, title, description, is_note, position, scheduled_start, scheduled_end) VALUES (?, ?, ?, ?, ?, 0, ?, ?)',
).run(pid, parent, title, more.description ?? '', more.note ? 1 : 0, more.start ?? null, more.end ?? null).lastInsertRowid);
const inbox = project('Inbox');
const captured = node(inbox, null, 'A pasted article');
node(inbox, captured, 'Captured text', { note: true, description: 'Standing waves form when two waves of equal frequency travel in opposite directions.' });
db.prepare("INSERT INTO mastery_evidence (node_id, evidence_type, score, total) VALUES (?, 'quiz', 1, 1)").run(captured);
db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('inbox_project_id', ?)").run(String(inbox));
const course = project('Waves', "'2026-11-01', '2026-12-01'");
for (let i = 0; i < 8; i++) node(course, null, 'Overdue topic ' + i, { start: '2026-11-02', end: '2026-11-05' });
const deck = project('Kana');
const card = node(deck, null, 'Hiragana');
db.prepare("INSERT INTO flashcards (node_id, front, back) VALUES (?, 'あ', 'a')").run(card);
console.log(JSON.stringify({ inbox, captured, course, deck, card }));
`;
const seeded = spawnSync(process.execPath, ['--input-type=module', '-e', seed], { env: process.env, encoding: 'utf8' });
const ids = JSON.parse(String(seeded.stdout || '').trim().split('\n').pop() || 'null');
if (!ids) { console.log(seeded.stderr); throw new Error('the old library could not be written'); }

const { default: db } = await import(S + 'database.js');
if (!process.env.DB_PATH.startsWith(scratch)) throw new Error('refusing: not the scratch library');
const { getFocusNodes } = await import(S + 'feed.js');
const { createApp } = await import(S + 'app.js');
const server = createServer(createApp());
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const post = async (path, body) => {
    const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
};

try {
    console.log('\n1. the server has no capture door');
    const nodesBefore = db.prepare('SELECT COUNT(*) c FROM nodes').get().c;
    const cap = await post('/api/capture', { text: 'Remember the speed of sound in air' });
    const enrich = await post(`/api/capture/${ids.captured}/enrich`, {});
    check('POST /api/capture and its enrich route answer 404, and nothing is written',
        cap.status === 404 && enrich.status === 404 && db.prepare('SELECT COUNT(*) c FROM nodes').get().c === nodesBefore,
        `${cap.status} ${enrich.status}`);

    console.log('\n2. a library that had an Inbox keeps it as an ordinary course');
    const inboxRow = db.prepare('SELECT name FROM projects WHERE id = ?').get(ids.inbox);
    const own = getFocusNodes({ projectId: ids.inbox, now: NOW }).focus.map(f => f.nodeId);
    check('the inbox_project_id row is dropped at startup; the course keeps its name, topic, Material and answer, and serves the topic in its own stream',
        db.prepare("SELECT 1 FROM settings WHERE key = 'inbox_project_id'").get() === undefined
        && inboxRow?.name === 'Inbox'
        && db.prepare('SELECT COUNT(*) c FROM nodes WHERE project_id = ?').get(ids.inbox).c === 2
        && db.prepare('SELECT COUNT(*) c FROM mastery_evidence WHERE node_id = ?').get(ids.captured).c === 1
        && own.includes(ids.captured),
        JSON.stringify({ row: db.prepare("SELECT value FROM settings WHERE key = 'inbox_project_id'").get(), inboxRow, own }));

    console.log('\n3. the home feed on a busy day');
    const home = getFocusNodes({ now: NOW }).focus;
    const fromInbox = home.filter(f => f.projectId === ids.inbox).length;
    const fromDeck = home.filter(f => f.projectId === ids.deck).length;
    check('the card collection keeps its standing slot; the old Inbox, with no cards and no dates, holds none (cards would give it one, as they give any undated course)',
        fromDeck >= 1 && fromInbox === 0 && home.some(f => f.projectId === ids.course),
        JSON.stringify(home.map(f => [f.projectId, f.nodeId])));

    console.log('\n4. the assistant offers no Inbox');
    const att = Number(db.prepare(`INSERT INTO chat_attachments (conversation_id, message_id, kind, name, mime, file_hash, file_type, file_size, content, created_at)
        VALUES (NULL, 1, 'document', 'notes.txt', 'text/plain', 'h', 'txt', 4, 'Ohm', '2026-11-11T12:00:00.000Z')`).run().lastInsertRowid);
    const projectsBefore = db.prepare('SELECT COUNT(*) c FROM projects').get().c;
    const saved = await post(`/api/assistant/attachments/${att}/save`, { inbox: true });
    check('a file from the chat is not saved to an Inbox: with no topic or course named it is refused and no project appears',
        saved.status === 400 && db.prepare('SELECT COUNT(*) c FROM projects').get().c === projectsBefore
        && !/inbox/i.test(saved.body?.error ?? ''),
        JSON.stringify(saved));
    const prompts = read('server/ai.js') + read('server/chatAttachments.js');
    check('no prompt teaches a capture fence or an Inbox place',
        prompts !== '' && !/```capture|\\`\\`\\`capture|inbox/i.test(prompts),
        (prompts.match(/.{0,60}(capture\n|inbox).{0,60}/i) || [''])[0]);

    const require = createRequire(join(repo, 'package.json'));
    const { build } = require('esbuild');
    const outfile = join(scratch, 'assistantWrites.mjs');
    await build({ entryPoints: [join(ROOT, 'src/utils/assistantWrites.ts')], bundle: true, format: 'esm', outfile, logLevel: 'silent', platform: 'neutral' });
    const { splitWriteBlocks } = await import(pathToFileURL(outfile).href);
    const old = splitWriteBlocks('I can keep that.\n```capture\nAsk about standing waves in a closed pipe\n```\n```save\nfile: 13\nto: inbox\n```');
    check('in a saved conversation a capture fence proposes nothing and its words stay in the answer; a save to "inbox" proposes nothing',
        old.captures === undefined && old.saves.length === 0 && /standing waves in a closed pipe/.test(old.body) && !/```/.test(old.body),
        JSON.stringify(old));

    console.log('\n5. nothing on screen opens a capture box');
    const layout = read('src/components/Layout.tsx');
    check('the app frame binds no `c` key and draws no Capture button; CaptureModal is gone',
        layout !== '' && !/key === 'c'/.test(layout) && !/CaptureModal|setCaptureOpen|t\("Capture"\)/.test(layout)
        && !existsSync(join(ROOT, 'src/components/CaptureModal.tsx')));
    const client = read('src/api.ts') + read('src/components/shortCourses/ShortCourses.tsx') + read('src/components/AssistantProposals.tsx')
        + read('src/utils/taskPlace.ts') + read('src/components/feed/OnboardingCard.tsx')
        + read('src/components/settings/GeneralSettings.tsx');
    check('no client path saves to an Inbox: no api.capture, no "Save to Inbox" under a short source, no Inbox task place, no capture key in the shortcut list',
        client !== '' && !/capture\s*:\s*\(|api\.capture|Save to Inbox|Inbox|Capture something/.test(client),
        (client.match(/.{0,60}(api\.capture|capture\s*:\s*\(|Inbox).{0,60}/) || [''])[0]);
    const mcp = read('mcp/tools.js');
    check('the MCP server has no add_capture tool and names no Inbox',
        mcp !== '' && !/add_capture|Inbox|\/api\/capture/.test(mcp));
} finally {
    server.close();
    try { db.close(); } catch { /* closed */ }
    rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
