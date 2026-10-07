// tools/assistant-edits-gates.mjs — what the assistant prepares, CHECKED before
// it is offered, APPLIED on the learner's press, and UNDONE from a record.
//
// Run:  node tools/assistant-edits-gates.mjs
//
// The assistant can draft a change to a course (name, icon, colour,
// description, status, new cards a day), a topic's title, a page saved on a
// topic and a new course for the New course dialog, beside the cards it could
// already propose. Against the REAL routes on a scratch library, a stub model
// on loopback and a stub web page on loopback (nothing billed, nothing leaves
// the machine), this asserts:
//
//   1. the icon names and the palette the server judges by are the ones the
//      client draws (`server/projectFields.js` ↔ ProjectIcon.tsx, ColorField.tsx);
//   2. the rules: an icon is one of the drawings, a colour one the app can
//      paint (a palette name or a hex, never "teal"), a status one of three;
//   3. the client parser reads every block, refuses by the same rules and
//      NAMES what it refused, keeps the prose, and a Copy carries no ids;
//   4. Apply writes through one door: values judged, what the preview showed
//      compared first (a description edited since is not overwritten), each
//      field's before kept, model-written words stamped; Undo restores only
//      what still holds Apply's value, and the record survives a reload;
//   5. a card is checked cold before Add (a back a second look rejects is not
//      added), a link is opened before Save (a 404 is not saved, the page's own
//      title is), and a verdict is paid for once;
//   6. the assistant is told the blocks, the icon names, the palette and the
//      open course's current look.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const ROOT = fileURLToPath(new URL('..', import.meta.url));

const scratch = mkdtempSync(join(tmpdir(), 'assistant-edits-gates-'));
process.env.DB_PATH = join(scratch, 'test.db');
process.env.VAULT_ROOT = join(scratch, 'vault');
process.env.DATA_DIR = scratch;
// The link check's page is served on loopback, which the fetcher refuses by
// default; this reopens private targets for this process only.
process.env.ALLOW_PRIVATE_FETCH = '1';

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${String(extra).slice(0, 400)}` : ''}`); }
};
const section = (s) => console.log(`\n${s}`);

// ---- 1. one list on both sides ----------------------------------------------------
section('1. the server judges by the lists the client draws');
const F = await import('../server/projectFields.js');
const iconSrc = readFileSync(join(ROOT, 'src/components/ProjectIcon.tsx'), 'utf8');
const drawn = [...iconSrc.matchAll(/\{\s*name:\s*'([a-z0-9]+)',\s*Icon:/g)].map(m => m[1]);
ok('64 drawings, and the server knows the same names in the same order',
    drawn.length === 64 && JSON.stringify(drawn) === JSON.stringify(F.PROJECT_ICON_NAMES), JSON.stringify(drawn));
const fieldSrc = readFileSync(join(ROOT, 'src/components/ui/ColorField.tsx'), 'utf8');
const block = fieldSrc.slice(fieldSrc.indexOf('export const PROJECT_COLORS = ['), fieldSrc.indexOf('];', fieldSrc.indexOf('export const PROJECT_COLORS = [')));
const swatches = [...block.matchAll(/'(#[0-9a-fA-F]{6})',\s*\/\/\s*([A-Za-z]+)/g)].map(m => ({ hex: m[1].toLowerCase(), name: m[2] }));
ok('the palette is the project palette, hex and name, slot for slot',
    swatches.length === 16 && JSON.stringify(swatches) === JSON.stringify(F.PROJECT_PALETTE.map(c => ({ hex: c.hex, name: c.name }))),
    JSON.stringify(swatches));

// ---- 2. the rules -------------------------------------------------------------------
section('2. a value is judged by a rule, never by the model\'s word');
ok('an icon is one of the drawings; case and word gaps are not part of a name',
    F.projectIconName('Book') === 'book' && F.projectIconName('test tube') === 'testtube' && F.projectIconName('unicorn') === null && F.projectIconName('') === null);
ok('a colour is a palette name or a hex, written as #rrggbb',
    F.projectColour('Cornflower') === '#6e98cf' && F.projectColour('#ABC') === '#aabbcc' && F.projectColour('22c55e') === '#22c55e');
ok('a CSS keyword is not a colour here, nor is nonsense', F.projectColour('teal') === null && F.projectColour('#12345') === null && F.projectColour('blue-ish') === null);
ok('a status is one of three, from its synonyms', F.projectStatus('finished') === 'completed' && F.projectStatus('Archive') === 'archived'
    && F.projectStatus('restore') === 'active' && F.projectStatus('deleted') === null);
ok('a name is one line of at most 80', F.projectName('  Wave\n physics ') === 'Wave physics' && F.projectName('x'.repeat(81)) === null && F.projectName('   ') === null);
ok('new cards a day is a whole number 0–9999', F.newPerDay('25') === 25 && F.newPerDay('0') === 0 && F.newPerDay('-3') === null && F.newPerDay('12.5') === null && F.newPerDay('10000') === null);

// ---- 3. the client parser ------------------------------------------------------------
section('3. the blocks are read by the same rules, and what is refused is named');
const outWrites = join(scratch, 'assistantWrites.mjs');
await esbuild.build({
    entryPoints: [join(ROOT, 'src/utils/assistantWrites.ts')],
    bundle: true, format: 'esm', platform: 'node', outfile: outWrites, logLevel: 'silent',
});
const { splitWriteBlocks, writeBlocksAsText } = await import(pathToFileURL(outWrites).href);
const PROJECT = 'Here is a fresher look:\n\n```project\nproject: 7\nname: Waves and Sound\nicon: Music\ncolour: Cornflower\ndescription: Waves on strings, sound in air.\nWhat you hear, and why.\nstatus: archived\nnew cards per day: 15\n```\n\nPress Apply if you like it.';
const pw = splitWriteBlocks(PROJECT);
const pe = pw.projects[0];
ok('a project block becomes a proposal with every field normalised',
    pe?.projectId === 7 && pe.changes.name === 'Waves and Sound' && pe.changes.icon === 'music' && pe.changes.color === '#6e98cf'
    && pe.changes.status === 'archived' && pe.changes.new_per_day === 15, JSON.stringify(pe));
ok('a description keeps its lines', pe?.changes.description === 'Waves on strings, sound in air.\nWhat you hear, and why.', JSON.stringify(pe?.changes.description));
ok('the prose around it stays, the block does not', pw.body === 'Here is a fresher look:\n\nPress Apply if you like it.', JSON.stringify(pw.body));
const bad = splitWriteBlocks('```project\nproject: 7\nicon: unicorn\ncolor: teal\nname: Fine name\n```').projects[0];
ok('an icon and a colour no rule accepts are REFUSED and named, the rest proposed',
    bad?.changes.name === 'Fine name' && !('icon' in bad.changes) && !('color' in bad.changes)
    && bad.refused.map(r => `${r.field}=${r.value}`).join(',') === 'icon=unicorn,color=teal', JSON.stringify(bad));
const allBad = splitWriteBlocks('```project\nproject: 7\nicon: unicorn\n```').projects[0];
ok('a block with nothing valid still shows what it refused (never silent)', allBad && Object.keys(allBad.changes).length === 0 && allBad.refused.length === 1);
ok('a block with no course id proposes nothing', splitWriteBlocks('```project\nname: X\n```').projects.length === 0
    && splitWriteBlocks('```project\nname: X\n```').body === '');
ok('an empty value proposes nothing (a model that ran out does not clear a description)',
    !('description' in (splitWriteBlocks('```project\nproject: 7\nname: A\ndescription:\n```').projects[0]?.changes ?? { description: 1 })));
ok('one change per course a message',
    splitWriteBlocks('```project\nproject: 7\nname: A\n```\n```project\nproject: 7\nname: B\n```').projects.length === 1);
const tw = splitWriteBlocks('```topic\ntopic: 7:41\ntitle: Standing waves on a string\n```');
ok('a topic block names the topic and its new title', tw.topics[0]?.nodeId === 41 && tw.topics[0]?.projectId === 7 && tw.topics[0]?.title === 'Standing waves on a string');
const lw = splitWriteBlocks('```link\ntopic: 7:41\nurl: https://example.org/waves\ntitle: Waves explained\n```');
ok('a link block names the topic, the address and a title', lw.links[0]?.url === 'https://example.org/waves' && lw.links[0]?.title === 'Waves explained' && lw.links[0]?.nodeId === 41);
ok('an address with a space in it is not a link', splitWriteBlocks('```link\ntopic: 7:41\nurl: see the wiki\n```').links.length === 0);
const cw = splitWriteBlocks('```course\nname: Dutch for travel\ngoal: Hold a conversation in a café.\nlanguage: ru\nicon: languages\ncolour: Coral\n```');
ok('a course block is a draft for the New course dialog', cw.courses[0]?.name === 'Dutch for travel' && cw.courses[0]?.goal === 'Hold a conversation in a café.'
    && cw.courses[0]?.language === 'ru' && cw.courses[0]?.icon === 'languages' && cw.courses[0]?.color === '#de7373', JSON.stringify(cw.courses[0]));
ok('a half-streamed block is hidden and proposes nothing', splitWriteBlocks('Let me fix that.\n\n```project\nproject: 7\nname: Wav', true).body === 'Let me fix that.'
    && splitWriteBlocks('Let me fix that.\n\n```project\nproject: 7\nname: Wav', true).projects.length === 0);
const copy = writeBlocksAsText(PROJECT);
ok('a Copy carries the new values in words and no id', copy.includes('Name: Waves and Sound') && copy.includes('Colour: #6e98cf') && !/project:\s*7/.test(copy) && !copy.includes('```'), copy);
ok('a Copy of a link is its title and address', writeBlocksAsText('```link\ntopic: 7:41\nurl: https://example.org/w\ntitle: W\n```') === 'W: https://example.org/w');

// ---- stub model and stub web page ----------------------------------------------------
const modelCalls = [];
let modelDown = false;
const COLD = { 'What is the capital of France?': 'Paris', 'What is 2 + 2?': '4', 'What is the speed of light in a vacuum?': '299,792 km/s' };
const stub = createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
        if (req.url.endsWith('/models')) {
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ data: [{ id: 'stub-model' }] }));
        }
        const body = JSON.parse(raw || '{}');
        modelCalls.push(body);
        if (modelDown) {
            res.writeHead(400, { 'content-type': 'application/json' });
            return res.end('{"error":{"message":"stub: refused on purpose"}}');
        }
        const sys = (body.messages || []).find(m => m.role === 'system')?.content || '';
        const user = (body.messages || []).filter(m => m.role === 'user').pop()?.content || '';
        let content = 'A stub answer.';
        if (/checking a practice drill/.test(sys)) {
            const prompts = user.split('PROMPTS:')[1]?.split('\n').map(l => l.match(/^(\d+)\. (.*)$/)).filter(Boolean) || [];
            content = JSON.stringify({ answers: prompts.map(m => ({ n: Number(m[1]), answer: COLD[m[2].trim()] ?? 'no idea' })) });
        } else if (/settling disagreements/.test(sys)) {
            const rows = [...user.matchAll(/(\d+)\. (.*)\n\s+A: (.*)\n\s+B: (.*)/g)];
            content = JSON.stringify({ verdicts: rows.map(m => ({
                n: Number(m[1]),
                correct: /speed of light/i.test(m[2]) ? 'both' : (m[3].trim() === '4' ? 'A' : m[4].trim() === '4' ? 'B' : 'neither'),
            })) });
        }
        if (body.stream) {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
            res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
            res.write('data: [DONE]\n\n');
            return res.end();
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { completion_tokens: 3 } }));
    });
});
await new Promise(r => stub.listen(0, '127.0.0.1', r));
process.env.AI_PROVIDER = 'openai';
process.env.AI_BASE_URL = `http://127.0.0.1:${stub.address().port}/v1`;
process.env.AI_MODEL = 'stub-model';
process.env.AI_API_KEY = 'stub-key';

const pageHits = [];
const web = createServer((req, res) => {
    pageHits.push(req.url);
    if (req.url === '/waves') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end('<!doctype html><html><head><title>Standing Waves &amp; Harmonics — Physics Notes</title></head><body>...</body></html>');
    }
    if (req.url === '/blocked') { res.writeHead(403); return res.end('no robots'); }
    res.writeHead(404); res.end('not here');
});
await new Promise(r => web.listen(0, '127.0.0.1', r));
const page = (p) => `http://127.0.0.1:${web.address().port}${p}`;

// ---- the real app on a scratch library ---------------------------------------------
const { default: db } = await import('../server/database.js');
if (!/assistant-edits-gates-/.test(process.env.DB_PATH)) throw new Error('refusing to run against a library that is not the scratch one');
const setSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
setSetting.run('ai_enabled', 'true');
setSetting.run('embedding_enabled', 'false');
setSetting.run('ai_web_search', 'off');
setSetting.run('ui_language', 'en');

const course = Number(db.prepare("INSERT INTO projects (name, description, color, icon) VALUES ('Wave physics', 'Old description.', '#3B82F6', 'folder')").run().lastInsertRowid);
const other = Number(db.prepare("INSERT INTO projects (name) VALUES ('Another course')").run().lastInsertRowid);
const deck = Number(db.prepare("INSERT INTO projects (name) VALUES ('A deck')").run().lastInsertRowid);
const addNode = (pid, title) => Number(db.prepare("INSERT INTO nodes (project_id, parent_id, title, position, status) VALUES (?, NULL, ?, 0, 'not_started')").run(pid, title).lastInsertRowid);
const topic = addNode(course, 'Standing wavs');
const deckStage = addNode(deck, 'Cards 1–25');
db.prepare("INSERT INTO flashcards (node_id, front, back) VALUES (?, 'q', 'a')").run(deckStage);

const { createApp } = await import('../server/app.js');
const server = createServer(createApp());
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const call = async (method, path, body) => {
    const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    let json = null;
    try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, json };
};
const row = () => db.prepare('SELECT name, description, color, icon, status, generated_by FROM projects WHERE id = ?').get(course);

// ---- 4. apply and undo ----------------------------------------------------------------
section('4. Apply goes through one door; Undo is a restore from its record');
const cur = await call('GET', `/api/assistant/targets/project/${course}`);
ok('the preview reads the course as it is now (colour as #rrggbb)',
    cur.status === 200 && cur.json.name === 'Wave physics' && cur.json.icon === 'folder' && cur.json.color === '#3b82f6' && cur.json.description === 'Old description.' && cur.json.status === 'active',
    JSON.stringify(cur.json));
ok('a course that does not exist is a 404 and draws nothing', (await call('GET', '/api/assistant/targets/project/9999')).status === 404);
ok('an unknown kind is refused', (await call('GET', `/api/assistant/targets/dog/${course}`)).status === 400);

const refusedIcon = await call('POST', '/api/assistant/edits', { kind: 'project', targetId: course, changes: { icon: 'unicorn', name: 'Waves' }, expect: { icon: 'folder', name: 'Wave physics' } });
ok('an icon the app has no drawing of is refused at the door, and nothing is written',
    refusedIcon.status === 400 && refusedIcon.json?.fields?.includes('icon') && row().name === 'Wave physics' && row().icon === 'folder', JSON.stringify(refusedIcon.json));
ok('so is a colour it cannot paint, a status it does not have, and a name past 80',
    (await call('POST', '/api/assistant/edits', { kind: 'project', targetId: course, changes: { color: 'teal' }, expect: { color: '#3b82f6' } })).status === 400
    && (await call('POST', '/api/assistant/edits', { kind: 'project', targetId: course, changes: { status: 'deleted' }, expect: { status: 'active' } })).status === 400
    && (await call('POST', '/api/assistant/edits', { kind: 'project', targetId: course, changes: { name: 'x'.repeat(81) }, expect: { name: 'Wave physics' } })).status === 400);
const missingExpect = await call('POST', '/api/assistant/edits', { kind: 'project', targetId: course, changes: { name: 'Waves' } });
ok('Apply must say what the preview showed: no `expect`, no write', missingExpect.status === 409 && row().name === 'Wave physics');

// The learner edits the description in Edit project after the preview was drawn.
db.prepare("UPDATE projects SET description = 'Mine, typed just now.' WHERE id = ?").run(course);
const stale = await call('POST', '/api/assistant/edits', {
    kind: 'project', targetId: course,
    changes: { description: 'A model\'s description.', name: 'Waves and Sound' },
    expect: { description: 'Old description.', name: 'Wave physics' },
});
ok('a description edited after the preview was drawn is not overwritten (409, nothing written)',
    stale.status === 409 && stale.json.stale?.join() === 'description' && row().description === 'Mine, typed just now.' && row().name === 'Wave physics', JSON.stringify(stale.json));
ok('...and the answer carries what is there now, for the preview to redraw', stale.json?.current?.description === 'Mine, typed just now.');

const applied = await call('POST', '/api/assistant/edits', {
    kind: 'project', targetId: course, source: '501:project:0',
    changes: { name: 'Waves and Sound', icon: 'Music', color: 'Cornflower', description: 'Waves on strings.' },
    expect: { name: 'Wave physics', icon: 'folder', color: '#3b82f6', description: 'Mine, typed just now.' },
});
ok('Apply writes every judged value', applied.status === 200 && row().name === 'Waves and Sound' && row().icon === 'music' && row().color === '#6e98cf'
    && row().description === 'Waves on strings.', JSON.stringify(applied.json));
ok('...returns each field\'s before and after', applied.json?.before?.name === 'Wave physics' && applied.json?.before?.color === '#3B82F6'
    && applied.json?.after?.icon === 'music' && !('generated_by' in (applied.json?.before ?? {})), JSON.stringify(applied.json));
const stamp = JSON.parse(row().generated_by || '{}');
ok('words a model wrote are stamped with the model (name, description — not the icon)',
    stamp.model === 'stub-model' && JSON.stringify(stamp.fields?.sort()) === JSON.stringify(['description', 'name']), row().generated_by);
const same = await call('POST', '/api/assistant/edits', { kind: 'project', targetId: course, changes: { name: 'Waves and Sound' }, expect: { name: 'Waves and Sound' } });
ok('a value already in place is not a change', same.status === 200 && same.json.unchanged === true);
const bySource = await call('GET', '/api/assistant/edits?source=501%3Aproject%3A0');
ok('a preview redrawn after a reload finds its record by source', bySource.json?.edit?.id === applied.json.id && bySource.json.edit.undone === false);

const undone = await call('POST', `/api/assistant/edits/${applied.json.id}/undo`);
ok('Undo puts every field back exactly as it was stored', undone.status === 200 && row().name === 'Wave physics' && row().icon === 'folder'
    && row().color === '#3B82F6' && row().description === 'Mine, typed just now.', JSON.stringify(row()));
ok('...and the stamp with them', row().generated_by == null, row().generated_by);
ok('a second Undo changes nothing', (await call('POST', `/api/assistant/edits/${applied.json.id}/undo`)).json?.alreadyUndone === true);
ok('the record says it was undone', (await call('GET', '/api/assistant/edits?source=501%3Aproject%3A0')).json?.edit?.undone === true);

const again = await call('POST', '/api/assistant/edits', {
    kind: 'project', targetId: course, changes: { name: 'Waves and Sound', icon: 'music' }, expect: { name: 'Wave physics', icon: 'folder' },
});
db.prepare("UPDATE projects SET name = 'My own name' WHERE id = ?").run(course);
const partial = await call('POST', `/api/assistant/edits/${again.json.id}/undo`);
ok('Undo keeps a field the learner changed since, and says so; the rest goes back',
    partial.json?.kept?.join() === 'name' && partial.json?.restored?.join() === 'icon' && row().name === 'My own name' && row().icon === 'folder', JSON.stringify(partial.json));

const archive = await call('POST', '/api/assistant/edits', { kind: 'project', targetId: course, changes: { status: 'archive' }, expect: { status: 'active' } });
ok('a course can be archived, and restored by Undo', archive.status === 200 && row().status === 'archived'
    && (await call('POST', `/api/assistant/edits/${archive.json.id}/undo`)).status === 200 && row().status === 'active');

const noCards = await call('POST', '/api/assistant/edits', { kind: 'project', targetId: course, changes: { new_per_day: '15' }, expect: { new_per_day: cur.json.new_per_day } });
ok('a course with no cards has no daily allowance to change', noCards.status === 400 && /no cards/.test(noCards.json?.error), JSON.stringify(noCards.json));
const deckNow = (await call('GET', `/api/assistant/targets/project/${deck}`)).json;
const perDay = await call('POST', '/api/assistant/edits', { kind: 'project', targetId: deck, changes: { new_per_day: 35 }, expect: { new_per_day: deckNow.new_per_day } });
const keyRow = () => db.prepare('SELECT value FROM settings WHERE key = ?').get(`deck_new_per_day_${deck}`);
ok('a deck\'s new cards a day is written as its own setting', perDay.status === 200 && keyRow()?.value === '35', JSON.stringify(perDay.json));
await call('POST', `/api/assistant/edits/${perDay.json.id}/undo`);
ok('...and Undo puts back the ABSENCE of a setting, not today\'s default as a number', keyRow() === undefined);

const rename = await call('POST', '/api/assistant/edits', { kind: 'topic', targetId: topic, projectId: course, changes: { title: 'Standing waves' }, expect: { title: 'Standing wavs' } });
ok('a topic is renamed through the same door', rename.status === 200 && db.prepare('SELECT title FROM nodes WHERE id = ?').get(topic).title === 'Standing waves');
ok('...a topic named under the wrong course is not', (await call('POST', '/api/assistant/edits', { kind: 'topic', targetId: topic, projectId: other, changes: { title: 'X' }, expect: { title: 'Standing waves' } })).status === 404);
await call('POST', `/api/assistant/edits/${rename.json.id}/undo`);
ok('...and Undo restores its title', db.prepare('SELECT title FROM nodes WHERE id = ?').get(topic).title === 'Standing wavs');

// ---- 5. checks ----------------------------------------------------------------------
section('5. what is offered was checked first');
const cards = [
    { nodeId: topic, front: 'What is the capital of France?', back: 'Paris' },
    { nodeId: topic, front: 'What is 2 + 2?', back: '5' },
    { nodeId: topic, front: 'What is the speed of light in a vacuum?', back: '3.0 × 10^8 m/s' },
];
modelCalls.length = 0;
const checked = await call('POST', '/api/assistant/checks', { cards });
const v = checked.json?.cards ?? [];
ok('a card a cold answer agrees with is ok', v[0]?.verdict === 'ok', JSON.stringify(v));
ok('a back a second look rejects is DISPUTED, with the answer it gave', v[1]?.verdict === 'disputed' && /“4”/.test(v[1]?.reason), JSON.stringify(v[1]));
ok('a different wording a second look accepts is ok (not every difference is an error)', v[2]?.verdict === 'ok', JSON.stringify(v[2]));
ok('the cold pass never saw a back', modelCalls.length === 2 && !JSON.stringify(modelCalls[0]).includes('3.0 × 10^8') && !JSON.stringify(modelCalls[0]).includes('Paris'));
modelCalls.length = 0;
const recheck = await call('POST', '/api/assistant/checks', { cards });
ok('a verdict is paid for once: a re-read asks no model', modelCalls.length === 0 && recheck.json?.cards?.[1]?.verdict === 'disputed');
const addBad = await call('POST', '/api/assistant/cards', { nodeId: topic, front: 'What is 2 + 2?', back: '5' });
ok('a disputed card is not added, whatever the button said', addBad.status === 409 && !db.prepare("SELECT 1 FROM flashcards WHERE front = 'What is 2 + 2?'").get(), JSON.stringify(addBad.json));
const addGood = await call('POST', '/api/assistant/cards', { nodeId: topic, front: 'What is the capital of France?', back: 'Paris' });
ok('a checked card is added', addGood.status === 200 && addGood.json?.id > 0);
modelDown = true;
const down = await call('POST', '/api/assistant/checks', { cards: [{ nodeId: topic, front: 'Name a noble gas.', back: 'Neon' }] });
ok('a checker that cannot be asked says UNCHECKED, and why', down.json?.cards?.[0]?.verdict === 'unchecked' && /could not be asked/.test(down.json.cards[0].reason), JSON.stringify(down.json));
const addUnchecked = await call('POST', '/api/assistant/cards', { nodeId: topic, front: 'Name a noble gas.', back: 'Neon' });
ok('...which is not evidence against the card: it can still be added', addUnchecked.status === 200);
modelDown = false;
ok('an unchecked verdict is not kept: the next look asks again', db.prepare("SELECT COUNT(*) AS n FROM assistant_checks WHERE verdict = 'unchecked'").get().n === 0);

const offline = await call('POST', '/api/assistant/checks', { links: [page('/waves')] });
ok('with the web off a link is not opened, and says so', offline.json?.links?.[0]?.verdict === 'unchecked' && /web access is off/.test(offline.json.links[0].reason) && pageHits.length === 0);
setSetting.run('ai_web_search', 'on');
const online = await call('POST', '/api/assistant/checks', { links: [page('/waves'), page('/gone'), 'javascript:alert(1)'] });
const lv = [...(online.json?.links ?? []), ...((await call('POST', '/api/assistant/checks', { links: [page('/blocked')] })).json?.links ?? [])];
ok('a page that answers is ok, with its OWN title read', lv[0]?.verdict === 'ok' && lv[0]?.detail?.title === 'Standing Waves & Harmonics — Physics Notes', JSON.stringify(lv[0]));
ok('a page that does not exist is disputed, said in words', lv[1]?.verdict === 'disputed' && lv[1]?.detail?.status === 404 && !/\d/.test(lv[1]?.reason ?? '1'), JSON.stringify(lv[1]));
ok('an address the app cannot open is disputed without a request', lv[2]?.verdict === 'disputed' && !pageHits.some(h => /alert/.test(h)));
ok('a site that refuses robots is unchecked, not called missing', lv[3]?.verdict === 'unchecked' && lv[3]?.detail?.status === 403, JSON.stringify(lv[3]));
const saved = await call('POST', '/api/assistant/links', { projectId: course, nodeId: topic, url: page('/waves'), title: 'A model\'s name for it', source: '502:link:0' });
const res0 = db.prepare('SELECT title, url FROM resources WHERE node_id = ?').all(topic);
ok('a saved link takes the page\'s own title', saved.status === 200 && res0.length === 1 && res0[0].title === 'Standing Waves & Harmonics — Physics Notes', JSON.stringify(res0));
ok('the same page twice is one row', (await call('POST', '/api/assistant/links', { projectId: course, nodeId: topic, url: page('/waves') })).json?.existed === true
    && db.prepare('SELECT COUNT(*) AS n FROM resources WHERE node_id = ?').get(topic).n === 1);
ok('a page that does not exist is not saved', (await call('POST', '/api/assistant/links', { projectId: course, nodeId: topic, url: page('/gone') })).status === 409
    && db.prepare('SELECT COUNT(*) AS n FROM resources WHERE node_id = ?').get(topic).n === 1);
await call('POST', `/api/assistant/edits/${saved.json.id}/undo`);
ok('Undo removes the saved link', db.prepare('SELECT COUNT(*) AS n FROM resources WHERE node_id = ?').get(topic).n === 0);
setSetting.run('ai_web_search', 'off');

// ---- 6. what the assistant is told --------------------------------------------------
section('6. the assistant is told the blocks, the names, and the course\'s look');
modelCalls.length = 0;
const turn = await fetch(`${base}/api/ai/assistant/stream`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'Give my course a better icon', context: { view: 'workspace', projectId: course }, timeZone: 'UTC' }),
});
await turn.text();
const answerCall = modelCalls.find(r => r.stream) || modelCalls[modelCalls.length - 1];
const sys = (answerCall?.messages || []).find(m => m.role === 'system')?.content || '';
ok('the four blocks are taught', ['```project', '```topic', '```link', '```course'].every(b => sys.includes(b)), sys.slice(0, 200));
ok('every icon name and every palette name is listed', F.PROJECT_ICON_NAMES.every(n => sys.includes(n)) && F.PROJECT_PALETTE.every(c => sys.includes(c.name)));
ok('the open course\'s current look is on the page context', /icon "folder"/.test(sys) && /#3B82F6|Blue/.test(sys) && sys.includes('My own name'), sys.match(/Open project[^\n]*\n[^\n]*\n[^\n]*/)?.[0]);
ok('it is told that what it prepares is checked and the learner presses', /checked/i.test(sys));

server.close(); stub.close(); web.close();
try { db.close(); } catch { /* closing */ }
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* Windows may hold the file a moment */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
