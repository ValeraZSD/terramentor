// tools/project-route-gates.mjs — the project routes answer what happened.
//
// Run:  node tools/project-route-gates.mjs
//
// WHY. Two project routes said yes to things that did not happen:
//   - DELETE /api/projects/:id of a project that does not exist answered
//     `{ success: true }` and wrote "project.deleted" to the activity log, so
//     a client (or an agent) that had the wrong id was told the course was
//     gone, and the log claimed a deletion nobody made;
//   - POST /api/ai/create-project stored `color` and `icon` as sent: a 2 MB
//     string or a number went into the row and came back inside every
//     GET /api/projects, while the plain create and the edit refused them.
//     A refused field must be refused before the first model call.
//
// The real app (`createApp()`) on a scratch library: DB_PATH, VAULT_ROOT and
// DATA_DIR set IN-PROCESS before any server module is imported. The model is a
// stub on loopback that refuses every call and counts them; nothing is billed
// and the real local Ollama is never reached.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

const scratch = mkdtempSync(join(tmpdir(), 'project-route-gates-'));
process.env.DB_PATH = join(scratch, 'test.db');
process.env.VAULT_ROOT = join(scratch, 'vault');
process.env.DATA_DIR = scratch;

let modelCalls = 0;
const stub = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
        modelCalls++;
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'the stub refuses every call' } }));
    });
});
await new Promise(r => stub.listen(0, '127.0.0.1', r));
process.env.AI_PROVIDER = 'openai';
process.env.AI_BASE_URL = `http://127.0.0.1:${stub.address().port}/v1`;
process.env.AI_MODEL = 'stub-model';
process.env.AI_API_KEY = 'stub-key';

const B = new URL('../server/', import.meta.url).href;
const { default: db } = await import(`${B}database.js`);
const setSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
setSetting.run('ai_enabled', 'true');
setSetting.run('creation_find_resources', 'false');
setSetting.run('embedding_enabled', 'false');
setSetting.run('ui_language', 'en');
const { createApp } = await import(`${B}app.js`);
const { readActivity } = await import(`${B}activityLog.js`);
const { stageImport } = await import(`${B}ankiImport.js`);

const server = createServer(createApp());
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${String(extra).slice(0, 300)}` : ''}`); }
};
const call = async (method, path, body) => {
    const res = await fetch(base + path, {
        method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* an SSE stream or plain text */ }
    return { status: res.status, json, text };
};
const deletions = () => readActivity({ limit: 200, area: 'project' }).filter(r => r.event === 'project.deleted').length;

// ---- DELETE of a project that is not there --------------------------------------
console.log('\n=== deleting a project that does not exist ===');
{
    const before = deletions();
    const missing = await call('DELETE', '/api/projects/987654');
    ok('a missing id is a 404, not a success', missing.status === 404 && missing.json?.success !== true, `${missing.status} ${missing.text}`);
    const word = await call('DELETE', '/api/projects/not-a-number');
    ok('an id that is not a number is a 404 too', word.status === 404, `${word.status} ${word.text}`);
    ok('…and the activity log records no deletion for either', deletions() === before, `${deletions() - before} logged`);

    const pid = Number(db.prepare("INSERT INTO projects (name) VALUES ('Fixture: delete me')").run().lastInsertRowid);
    const first = await call('DELETE', `/api/projects/${pid}`);
    ok('a real project is deleted (200) and logged once', first.status === 200 && first.json?.success === true && deletions() === before + 1,
        `${first.status} ${first.text}`);
    const again = await call('DELETE', `/api/projects/${pid}`);
    ok('deleting it a second time is a 404', again.status === 404 && deletions() === before + 1, `${again.status} ${again.text}`);
}

// ---- create-project: colour and icon are checked like every other create ---------
console.log('\n=== create-project refuses a colour or icon the plain create refuses ===');
{
    const huge = 'x'.repeat(2 * 1024 * 1024);
    const cases = [
        ['a 2 MB colour', { color: huge }],
        ['a colour that is a number', { color: 5 }],
        ['a blank icon', { icon: '   ' }],
        ['an icon that is an object', { icon: { name: 'folder' } }],
    ];
    for (const [label, fields] of cases) {
        const projectsBefore = db.prepare('SELECT COUNT(*) AS n FROM projects').get().n;
        const callsBefore = modelCalls;
        const r = await call('POST', '/api/ai/create-project', { name: 'Waves', description: 'Waves and light', content_language: 'en', ...fields });
        ok(`${label}: a 400 naming the field`, r.status === 400 && /color|icon/.test(r.json?.error || ''), `${r.status} ${r.text.slice(0, 200)}`);
        ok(`${label}: no model call, no project row`,
            modelCalls === callsBefore && db.prepare('SELECT COUNT(*) AS n FROM projects').get().n === projectsBefore,
            `${modelCalls - callsBefore} calls`);
    }
    for (const [label, fields] of [['a picked colour and icon', { color: '#10B981', icon: 'book' }], ['an unset colour and icon', { color: '', icon: null }]]) {
        const callsBefore = modelCalls;
        const r = await call('POST', '/api/ai/create-project', { name: 'Waves', description: 'Waves and light', content_language: 'en', ...fields });
        ok(`${label}: the run starts (the stub then refuses it)`, r.status === 200 && modelCalls > callsBefore, `${r.status} ${r.text.slice(0, 200)}`);
    }
    const plain = await call('POST', '/api/projects', { name: 'Plain', color: 5 });
    ok('the plain create refuses the same colour (the rule both share)', plain.status === 400, `${plain.status} ${plain.text}`);

    // The Anki import takes its colour from the request too. An empty deck is
    // enough: the colour is checked before anything is written.
    const deck = () => stageImport({ cards: [], media: [], stats: { cards: 0, decks: [{ name: 'Fixture deck' }] } });
    const staged = deck();
    const projectsBefore = db.prepare('SELECT COUNT(*) AS n FROM projects').get().n;
    const bad = await call('POST', '/api/import/anki/commit', { stagingId: staged, color: huge });
    ok('the Anki import refuses a 2 MB colour with a 400 and writes no project',
        bad.status === 400 && /color/.test(bad.json?.error || '') && db.prepare('SELECT COUNT(*) AS n FROM projects').get().n === projectsBefore,
        `${bad.status} ${bad.text.slice(0, 200)}`);
    const retried = await call('POST', '/api/import/anki/commit', { stagingId: staged, color: '#10B981' });
    ok('…and keeps the upload, so the same import goes through with a real colour',
        retried.status === 200 && db.prepare('SELECT color FROM projects WHERE id = ?').get(retried.json?.projectId)?.color === '#10B981',
        `${retried.status} ${retried.text.slice(0, 200)}`);
    for (const [label, projectName] of [['a blank name', '   '], ['a name that is a number', 5]]) {
        const before = db.prepare('SELECT COUNT(*) AS n FROM projects').get().n;
        const r = await call('POST', '/api/import/anki/commit', { stagingId: deck(), projectName });
        ok(`the Anki import refuses ${label} with a 400 and writes no project`,
            r.status === 400 && db.prepare('SELECT COUNT(*) AS n FROM projects').get().n === before, `${r.status} ${r.text.slice(0, 200)}`);
    }
    const unset = await call('POST', '/api/import/anki/commit', { stagingId: deck(), color: null });
    ok('an Anki import with no colour gets the default one',
        unset.status === 200 && db.prepare('SELECT color FROM projects WHERE id = ?').get(unset.json?.projectId)?.color === '#3B82F6',
        `${unset.status} ${unset.text.slice(0, 200)}`);

    const stored = db.prepare('SELECT MAX(LENGTH(color)) AS c, MAX(LENGTH(icon)) AS i FROM projects').get();
    ok('no stored colour or icon is longer than 64 characters', (stored.c ?? 0) <= 64 && (stored.i ?? 0) <= 64, JSON.stringify(stored));
}

console.log(`\n${pass} passed, ${fail} failed`);
await new Promise(r => server.close(r));
await new Promise(r => stub.close(r));
try { db.close(); rmSync(scratch, { recursive: true, force: true }); } catch { /* a held WAL file is fine */ }
process.exit(fail ? 1 : 0);
