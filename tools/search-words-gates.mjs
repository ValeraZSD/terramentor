#!/usr/bin/env node
// tools/search-words-gates.mjs — each course's words for its search links.
//
// Run:  node tools/search-words-gates.mjs [--server <copy of server/>]
//
// A topic title searched alone searches the whole world ("Ownership" finds
// property law, "Alphabet" every language's alphabet). server/searchWords.js
// asks the model once per course for the words that go in front of it; the
// client half (`buildQuery`) is in search-provider-gates.mjs. This gate pins:
//   - what counts as words (the validator and the reply reader, pure);
//   - the sweep against a stub model on loopback and the REAL routes on a
//     scratch library: written once per course, '' kept as an answer, junk
//     recorded as a failure, three failures per model and then silence, a
//     different model starting again, an unreachable endpoint recording
//     nothing, AI off asking nothing, courses with no topics / still being
//     built / the Inbox skipped;
//   - the learner's own words through PUT /api/projects/:id: stamped 'user',
//     kept over a rename, a model's words cleared by a rename and NOT by the
//     same name sent back, `null` handing the course back, junk refused with
//     nothing applied;
//   - a SECOND BOOT of the same library changes nothing.
// Scratch DB + VAULT_ROOT are set IN-PROCESS before anything reaches database.js.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const argOf = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
const B = argOf('--server')
    ? pathToFileURL(resolve(argOf('--server')) + '/').href
    : new URL('../server/', import.meta.url).href;

const scratch = mkdtempSync(join(tmpdir(), 'search-words-gates-'));
process.env.DB_PATH = join(scratch, 'test.db');
process.env.VAULT_ROOT = join(scratch, 'vault');
process.env.DATA_DIR = scratch;

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${String(extra).slice(0, 300)}` : ''}`); }
};

// ---- the stub model -------------------------------------------------------------
// Answers by the course named in the prompt; `mode` 'down' drops every socket.
let mode = 'up';
let calls = [];
const ANSWERS = [
    [/Course: "Rust (?:from zero|for embedded)"/, '{"words": "Rust"}'],
    [/Course: "Нидерландский язык/, '```json\n{"words": "нидерландский"}\n```'],
    [/Course: "Pencil practice"/, 'pencil drawing'],
    [/Course: "Odds and ends"/, '{"words": ""}'],
    [/Course: "Junk course"/, 'Sure! The best words for this course would be: Rust programming language tutorial for everyone.'],
];
const stub = createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
        if (req.url.endsWith('/models')) {
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ data: [{ id: 'stub-model' }] }));
        }
        if (mode === 'down') return req.socket.destroy();
        const body = JSON.parse(raw || '{}');
        const user = (body.messages || []).filter(m => m.role === 'user').map(m => m.content).join('\n');
        const system = (body.messages || []).find(m => m.role === 'system')?.content || '';
        calls.push({ user, system, model: body.model });
        const content = ANSWERS.find(([re]) => re.test(user))?.[1] ?? '{"words": ""}';
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { completion_tokens: 8 } }));
    });
});
await new Promise(r => stub.listen(0, '127.0.0.1', r));
process.env.AI_PROVIDER = 'openai';
process.env.AI_BASE_URL = `http://127.0.0.1:${stub.address().port}/v1`;
process.env.AI_MODEL = 'stub-model';
process.env.AI_API_KEY = 'stub-key';

const { default: db } = await import(`${B}database.js`);
const setSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
setSetting.run('ai_enabled', 'true');
setSetting.run('embedding_enabled', 'false');
const W = await import(`${B}searchWords.js`);
const { AI_PROMPTS } = await import(`${B}ai.js`);
const tasks = await import(`${B}tasks.js`);
const { createApp } = await import(`${B}app.js`);

/* ── 1. what counts as words ─────────────────────────────────────────────── */
console.log('\n--- validateSearchWords / readWordsReply ---');
const v = (s) => W.validateSearchWords(s);
for (const good of ['Rust', 'pencil drawing', 'нидерландский', 'Node.js', 'C++', 'organic chemistry', 'IELTS']) {
    ok(`"${good}" is words`, v(good).ok && v(good).words === good, JSON.stringify(v(good)));
}
ok('quotes and a trailing full stop are stripped', v('"Rust."').words === 'Rust');
ok("'' is an answer: nothing to add", v('').ok && v('').words === '');
for (const [bad, reason] of [
    ['Sure, Rust', 'sentence'],
    ['one two three four five', 'too-many-words'],
    ['a'.repeat(41), 'too-long'],
    ['tutorial', 'filler'],
    ['beginner course', 'filler'],
    ['none', 'placeholder'],
    ['<b>Rust</b>', 'markup'],
    ['2024', 'no-letters'],
]) ok(`"${bad.slice(0, 30)}" is refused (${reason})`, !v(bad).ok && v(bad).reason === reason, JSON.stringify(v(bad)));
ok('a non-string is refused', !v(null).ok && !v(42).ok);

const r = W.readWordsReply;
ok('a JSON object', r('{"words": "Rust"}') === 'Rust');
ok('a fenced JSON object', r('```json\n{"words": "Rust"}\n```') === 'Rust');
ok('{"words": ""} is the empty answer, not "no answer"', r('{"words": ""}') === '');
ok('a key in prose', r('Here: "words": "Rust" ok') === 'Rust');
ok('a bare one-line answer', r('pencil drawing') === 'pencil drawing');
ok('an empty reply is no answer', r('') === null && r(undefined) === null);
ok('a JSON object without the key is no answer', r('{"name": "Rust"}') === null);
ok('several lines of prose are no answer', r('Well.\nRust, I think.') === null);

const u = W.validateUserSearchWords;
ok("the learner's words may be '' (none)", u('  ').ok && u('').words === '');
ok("the learner's words may hold a digit", u('Python 3').ok);
ok("the learner's markup is refused", !u('<script>').ok);
ok("the learner's words are capped", !u('x'.repeat(81)).ok && u('x'.repeat(80)).ok);

/* ── 2. the prompt ───────────────────────────────────────────────────────── */
console.log('\n--- the prompt ---');
const p = AI_PROMPTS.search_words({ name: 'Rust from zero', description: 'Learn Rust', titles: ['Ownership', 'Borrowing'] });
ok('it carries the course name, the goal and every title', /"Rust from zero"/.test(p.user) && /Learn Rust/.test(p.user) && /- Ownership/.test(p.user) && /- Borrowing/.test(p.user));
ok('it asks for the language of the TITLES', /SAME language as the topic titles/.test(p.system));
ok('it asks for JSON with a "words" key', /\{"words": "\.\.\."\}/.test(p.system));

/* ── 3. the sweep on a scratch library ───────────────────────────────────── */
console.log('\n--- the sweep ---');
const addProject = (name, description = '', extra = {}) => {
    const id = Number(db.prepare('INSERT INTO projects (name, description) VALUES (?, ?)').run(name, description).lastInsertRowid);
    for (const [k, val] of Object.entries(extra)) db.prepare(`UPDATE projects SET ${k} = ? WHERE id = ?`).run(val, id);
    return id;
};
const addTopics = (projectId, titles) => {
    const section = Number(db.prepare('INSERT INTO nodes (project_id, title) VALUES (?, ?)').run(projectId, 'Section').lastInsertRowid);
    for (const t of titles) db.prepare('INSERT INTO nodes (project_id, parent_id, title) VALUES (?, ?, ?)').run(projectId, section, t);
};
const row = (id) => db.prepare('SELECT name, search_words, search_words_by, search_words_tries FROM projects WHERE id = ?').get(id);

const rust = addProject('Rust from zero', 'Systems programming in Rust');
addTopics(rust, ['1.1 Ownership', 'Borrowing', 'Variable Shadowing and Mutability']);
const dutch = addProject('Нидерландский язык: с нуля до C1', 'Учу нидерландский');
addTopics(dutch, ['Алфавит', 'Дифтонги ij/ei, ui']);
const pencil = addProject('Pencil practice');
addTopics(pencil, ['Value and Light', 'Learning to See']);
const mixed = addProject('Odds and ends');
addTopics(mixed, ['Tax return', 'Sourdough']);
const junk = addProject('Junk course');
addTopics(junk, ['Something']);
const empty = addProject('Nothing here yet');
const building = addProject('Still building', '', { ai_generating: 1 });
addTopics(building, ['Half a topic']);
const inbox = addProject('Inbox');
addTopics(inbox, ['A captured note']);
setSetting.run('inbox_project_id', String(inbox));

calls = [];
let written = await W.runSearchWordsSweep();
ok(`four courses got words (${written})`, written === 4);
ok('Rust: "Rust", written by the model', row(rust).search_words === 'Rust' && row(rust).search_words_by === 'stub-model', JSON.stringify(row(rust)));
ok('Dutch in Russian: "нидерландский" (out of a fenced reply)', row(dutch).search_words === 'нидерландский');
ok('a bare one-line reply is read', row(pencil).search_words === 'pencil drawing');
ok("a mixed course keeps '' — an answer, not a gap", row(mixed).search_words === '' && row(mixed).search_words_by === 'stub-model');
ok('junk is a recorded failure: still NULL, one try', row(junk).search_words === null && row(junk).search_words_tries === 1, JSON.stringify(row(junk)));
const asked = calls.map(c => c.user);
ok('a course with no topics is not asked', !asked.some(t => t.includes('Nothing here yet')));
ok('a course still being built is not asked', !asked.some(t => t.includes('Still building')));
ok('the Inbox is not asked', !asked.some(t => t.includes('"Inbox"')));
ok('the titles are sent with their numbering cleaned', asked.some(t => /- Ownership\n/.test(t)) && !asked.some(t => /1\.1 Ownership/.test(t)));
ok('a background task records the run, started by the app',
    tasks.listTasks().some(t => t.kind === 'search_words' && t.status === 'done' && t.origin?.job === 'search_words'),
    JSON.stringify(tasks.listTasks().map(t => [t.kind, t.status, t.origin])));

calls = [];
await W.runSearchWordsSweep();
await W.runSearchWordsSweep();
ok('a course with words is never asked again', !calls.some(c => /Rust from zero|Odds and ends/.test(c.user)));
ok('junk: three tries for this model', row(junk).search_words_tries === 3, JSON.stringify(row(junk)));
calls = [];
await W.runSearchWordsSweep();
ok('...then this model stops asking', calls.length === 0, calls.length);
await W.runSearchWordsSweep({ model: 'other-model' });
ok('a different model starts again from one try', calls.length === 1 && row(junk).search_words_by === 'other-model' && row(junk).search_words_tries === 1, JSON.stringify(row(junk)));

console.log('\n--- an unreachable endpoint and AI off ---');
const fresh = addProject('Pencil practice two');
addTopics(fresh, ['Hatching']);
mode = 'down';
await W.runSearchWordsSweep({ model: 'third-model' });
mode = 'up';
ok('an unreachable endpoint records nothing against the course', row(fresh).search_words === null && row(fresh).search_words_tries === 0, JSON.stringify(row(fresh)));
setSetting.run('ai_enabled', 'false');
calls = [];
ok('AI off: nothing is asked', (await W.runSearchWordsSweep()) === 0 && calls.length === 0);
setSetting.run('ai_enabled', 'true');

/* ── 4. the learner's words through the real route ───────────────────────── */
console.log("\n--- the learner's words (PUT /api/projects/:id) ---");
const server = createServer(createApp());
await new Promise(res => server.listen(0, '127.0.0.1', res));
const base = `http://127.0.0.1:${server.address().port}`;
const put = (id, body) => fetch(`${base}/api/projects/${id}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

let res = await put(rust, { name: 'Rust from zero', description: 'Systems programming in Rust' });
ok("the same name sent back (the Edit dialog sends every field) keeps the model's words", row(rust).search_words === 'Rust');
res = await put(rust, { name: 'Rust for embedded' });
ok("a rename clears the model's words, to be written again", (await res.json()).search_words === null && row(rust).search_words === null);
res = await put(pencil, { search_words: '  graphite   drawing ' });
ok("the learner's words are stored tidied and stamped 'user'", row(pencil).search_words === 'graphite drawing' && row(pencil).search_words_by === 'user', JSON.stringify(row(pencil)));
res = await put(pencil, { name: 'Pencil practice, renamed', description: 'new goal' });
ok("a rename keeps the learner's words", row(pencil).search_words === 'graphite drawing');
res = await put(dutch, { search_words: '' });
ok("the learner may say 'none' ('' stamped 'user')", row(dutch).search_words === '' && row(dutch).search_words_by === 'user');
res = await put(dutch, { search_words: null });
ok("null hands the course back to the model, even the learner's words", row(dutch).search_words === null && row(dutch).search_words_by === null);
const before = row(mixed).name;
res = await put(mixed, { name: 'Should not land', search_words: '<img src=x>' });
ok('junk words are refused with a 400', res.status === 400);
ok('...and nothing else in that edit is applied', row(mixed).name === before);
calls = [];
await W.runSearchWordsSweep();
ok('the sweep writes the renamed course and the returned one again', row(rust).search_words === 'Rust' && row(dutch).search_words === 'нидерландский', JSON.stringify([row(rust), row(dutch)]));
ok("and never asks for the learner's", !calls.some(c => /Pencil practice, renamed/.test(c.user)));
server.close();

/* ── 5. a second boot ────────────────────────────────────────────────────── */
console.log('\n--- a second boot of the same library ---');
const snapshot = () => JSON.stringify(db.prepare('SELECT id, search_words, search_words_by, search_words_tries FROM projects ORDER BY id').all());
const was = snapshot();
const launcher = join(scratch, 'second-boot.mjs');
writeFileSync(launcher, `process.env.DB_PATH = ${JSON.stringify(process.env.DB_PATH)};
process.env.VAULT_ROOT = ${JSON.stringify(process.env.VAULT_ROOT)};
process.env.DATA_DIR = ${JSON.stringify(scratch)};
const { default: db } = await import(${JSON.stringify(`${B}database.js`)});
process.stdout.write(JSON.stringify(db.prepare('SELECT id, search_words, search_words_by, search_words_tries FROM projects ORDER BY id').all()));
process.exit(0);
`);
const second = spawnSync(process.execPath, [launcher], { encoding: 'utf8', timeout: 60000 });
ok('a second process boots the library', second.status === 0, second.stderr);
ok('...and every course keeps its words, source and tries', second.stdout.trim() === was, `${second.stdout.slice(0, 200)} vs ${was.slice(0, 200)}`);

stub.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
