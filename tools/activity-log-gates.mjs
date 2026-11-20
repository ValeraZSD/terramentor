#!/usr/bin/env node
/**
 * tools/activity-log-gates.mjs — the local activity log, and the one promise it
 * makes.
 *
 * Run:  node tools/activity-log-gates.mjs
 *
 * The log exists so a person can look at what the app did instead of being
 * asked to reproduce it, and so that file can be handed to a developer or
 * pasted into a coding agent. That last part is only true while the log holds
 * NO LEARNER CONTENT — no topic titles, no prompts, no notes, no model output.
 * It is a promise made in the panel's own copy ("no topic titles, no questions,
 * no notes, no model answers"), which means it is a promise a future call site
 * can break by passing something interesting into `detail`.
 *
 * So half of this suite is a source scan of every `logActivity(` call in
 * `server/`, and it fails on the fields that would carry content. The other
 * half pins the mechanics: the switch actually stops writes, the ring buffer
 * actually trims, a `detail` cannot smuggle a newline into a line-per-event
 * file, and a project deleted since keeps its row.
 *
 * The download also opens with a study summary (server/studySummary.js): its
 * counts are pinned against a seeded library in a non-UTC zone, the library's
 * text is marked and searched for in the file, and the summary must not move
 * when the log is empty, cleared, switched off or past its cap.
 *
 * Deterministic: a scratch database, no model, no network.
 */

import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serverFiles, readServer } from './lib/serverSource.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'activity-log-gates-'));
process.env.DB_PATH = join(scratch, 'gate.db');
process.env.VAULT_ROOT = join(scratch, 'vault');
process.env.DATA_DIR = scratch;

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const eq = (label, actual, expected) =>
    check(label, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

const db = (await import('../server/database.js')).default;
const {
    logActivity, readActivity, activityStats, streamActivityLog, clearActivityLog,
    trimActivityLog, sanitizeDetail, invalidateActivityLogSetting, MAX_ROWS,
} = await import('../server/activityLog.js');

// The study summary at the top of the download. Imported softly so a missing
// module reads as a failed case, not a crash before the first line.
const summaryModule = await import('../server/studySummary.js').catch(e => {
    console.log(`  (server/studySummary.js did not load: ${e.code || e.message})`);
    return null;
});
// One fixed instant for every summary: a gate reads no clock.
const NOW = Date.parse('2026-11-20T10:00:00.000Z');
const exportText = () => (summaryModule
    ? [...summaryModule.activityExport({ now: NOW })].join('')
    : [...streamActivityLog()].join(''));
/** `# label   value` lines of the summary block, as a map of label → text. */
const summaryFields = (text) => {
    const fields = new Map();
    for (const m of text.matchAll(/^# {2}([a-z][a-z ]*[a-z]) {2,}(\S.*)$/gm)) fields.set(m[1], m[2]);
    return fields;
};
/** `# 2026-11-16  2  45 ...` week rows of the summary block. */
const weekRows = (text) => [...text.matchAll(/^# {2}(\d{4}-\d{2}-\d{2})((?: +\d+)+)$/gm)]
    .map(m => [m[1], ...m[2].trim().split(/ +/).map(Number)]);

console.log('\nActivity log\n');

// ---- a new library: the summary is zeros, never an error -------------------

{
    let text = '';
    let threw = null;
    try { text = exportText(); } catch (e) { threw = e; }
    check('a new library exports without an error', !threw, threw?.message);
    const f = summaryFields(text);
    check('a new library\'s download opens with the study summary', /^# Study summary\b/m.test(text),
        text.split('\n').slice(0, 6).join(' | '));
    for (const label of ['study days', 'study minutes', 'proven topics', 'checks', 'questions answered', 'card reviews', 'mock exams finished']) {
        eq(`a new library counts 0 ${label}`, (f.get(label) || '').split(' ')[0], '0');
    }
    eq('a new library has no study week yet', weekRows(text).length, 0);
}

// ---- the shape of a row -----------------------------------------------------

// The column list IS the privacy promise: there is nowhere to put a title.
const columns = db.prepare('PRAGMA table_info(activity_log)').all().map(c => c.name).sort();
check('the table holds only software facts',
    JSON.stringify(columns) === JSON.stringify(
        ['area', 'at', 'detail', 'event', 'id', 'level', 'ms', 'node_id', 'project_id']),
    columns.join(','));

// No foreign keys: "project 12 deleted" is the most useful row in the table and
// a cascade would take it with the project.
const fks = db.prepare('PRAGMA foreign_key_list(activity_log)').all();
eq('nothing cascades into the log', fks.length, 0);

// ---- writing ----------------------------------------------------------------

logActivity({ area: 'ai', event: 'ai.request', ms: 1234, detail: 'openai · a-model · summary · 300 chars' });
logActivity({ area: 'task', event: 'task.error', level: 'error', detail: 'feed · model refused' });
logActivity({ area: 'server', event: 'server.started' });

let rows = readActivity({ limit: 10 });
eq('every event lands', rows.length, 3);
eq('newest first', rows[0].event, 'server.started');
eq('a duration is kept as a number', rows[2].ms, 1234);
eq('a level survives', rows[1].level, 'error');
eq('the default level is info', rows[2].level, 'info');

// An event with no area or no verb is not an event.
logActivity({ event: 'no.area' });
logActivity({ area: 'ai' });
logActivity(null);
eq('a malformed event is dropped, not stored', readActivity({ limit: 10 }).length, 3);

// ---- problems filter --------------------------------------------------------

const problems = readActivity({ limit: 10, level: 'problems' });
eq('"problems only" is warn + error', problems.length, 1);
eq('and it is the failure', problems[0].event, 'task.error');

// ---- detail can never break the file ---------------------------------------

eq('a newline in detail is flattened',
    sanitizeDetail('two\nlines\there'), 'two lines here');
eq('an empty detail is null', sanitizeDetail('   '), null);
check('a runaway provider error is capped',
    (sanitizeDetail('x'.repeat(5000)) || '').length <= 400,
    String((sanitizeDetail('x'.repeat(5000)) || '').length));

logActivity({ area: 'ai', event: 'ai.failed', level: 'error', detail: 'line one\nline two' });
const exported = [...streamActivityLog()].join('');
const body = exported.split('\n').filter(l => l && !l.startsWith('#'));
eq('one line per event, always', body.length, readActivity({ limit: 500 }).length);
check('the export says what it does not contain',
    /No topic titles, prompts, notes, answers or model output/.test(exported));
check('the export is oldest first', body[0].includes('ai.request'), body[0]);

// ---- a deleted project keeps its row ---------------------------------------

const projectId = db.prepare("INSERT INTO projects (name, position) VALUES ('Gate', 0)").run().lastInsertRowid;
logActivity({ area: 'project', event: 'project.created', projectId });
check('a live project resolves to its name for the screen only',
    readActivity({ limit: 1 })[0].projectTitle === 'Gate');
db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
const orphan = readActivity({ limit: 1 })[0];
eq('the row outlives the project', orphan.event, 'project.created');
eq('and keeps the id', orphan.projectId, Number(projectId));
eq('with no name left to show', orphan.projectTitle, null);

// ---- the switch stops writes ------------------------------------------------

const before = activityStats().rows;
db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('activity_log_enabled', 'false')").run();
invalidateActivityLogSetting();
logActivity({ area: 'ai', event: 'ai.request', detail: 'must not be written' });
eq('off means nothing is recorded', activityStats().rows, before);
check('and the panel can say so', activityStats().enabled === false);

db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('activity_log_enabled', 'true')").run();
invalidateActivityLogSetting();
logActivity({ area: 'ai', event: 'ai.request', detail: 'written again' });
eq('on means it is', activityStats().rows, before + 1);

// Absent means ON: a diagnostic switched off by default has already missed the
// thing it was needed for.
db.prepare("DELETE FROM settings WHERE key = 'activity_log_enabled'").run();
invalidateActivityLogSetting();
check('an unset switch records', activityStats().enabled === true);

// ---- the ring buffer --------------------------------------------------------

clearActivityLog();
eq('clearing empties it', activityStats().rows, 0);

const insert = db.prepare(`INSERT INTO activity_log (at, level, area, event) VALUES (?, 'info', 'ai', 'ai.request')`);
const many = db.transaction((n) => {
    for (let i = 0; i < n; i++) insert.run(new Date(Date.now() + i).toISOString());
});
many(MAX_ROWS + 500);
trimActivityLog();
check('the log is a ring buffer, not an archive',
    activityStats().rows <= MAX_ROWS, String(activityStats().rows));

// ---- the study summary: counts of what the learner did ---------------------

// A seeded library whose every count is known, written straight into the
// tables (the evidence through the app's own writer, so "proven" is the app's
// answer and not a hand-set score). Every piece of text a learner or a model
// could have written carries a CANARY mark, and the file is searched for it.
//
// The learner lives in Auckland (UTC+13 in November), so the summary's days
// are not UTC days: 2026-11-15T20:05Z is Monday 16 November there, which puts
// it in the week of 16 November, not the UTC week before.
{
    const { setSettingValue } = await import('../server/settingsStore.js');
    const { updateMasteryFromAttempt } = await import('../server/mastery.js');
    setSettingValue('time_zone', 'Pacific/Auckland');

    const course = Number(db.prepare("INSERT INTO projects (name, position) VALUES ('CANARYCOURSE Thermodynamics', 0)").run().lastInsertRowid);
    const topic = db.prepare('INSERT INTO nodes (project_id, title, is_note, position) VALUES (?, ?, ?, ?)');
    const proven = Number(topic.run(course, 'CANARYTOPIC entropy', 0, 0).lastInsertRowid);
    const cardsOnly = Number(topic.run(course, 'CANARYTOPIC heat engines', 0, 1).lastInsertRowid);
    const quizzed = Number(topic.run(course, 'CANARYTOPIC enthalpy', 0, 2).lastInsertRowid);
    topic.run(course, 'CANARYNOTE my own words about Carnot', 1, 3);
    const card = Number(db.prepare('INSERT INTO flashcards (node_id, front, back) VALUES (?, ?, ?)')
        .run(cardsOnly, 'CANARYFRONT what is a heat engine', 'CANARYBACK it turns heat into work').lastInsertRowid);

    const MON_9 = '2026-11-08T22:10:00.000Z';   // Auckland Monday 9 Nov
    const MON_16 = '2026-11-15T20:05:00.000Z';  // Auckland Monday 16 Nov (UTC Sunday 15th)
    const WED_18 = '2026-11-17T21:30:00.000Z';  // Auckland Wednesday 18 Nov

    const time = db.prepare('INSERT INTO study_time (node_id, hour, activity, active_ms) VALUES (?, ?, ?, ?)');
    time.run(proven, '2026-11-08T22', 'reading', 30 * 60000);
    time.run(proven, '2026-11-15T20', 'checks', 20 * 60000);
    time.run(cardsOnly, '2026-11-15T20', 'cards', 10 * 60000);
    time.run(quizzed, '2026-11-17T21', 'questions', 15 * 60000);

    const review = db.prepare('INSERT INTO review_log (card_id, reviewed_at, rating, source, external_id) VALUES (?, ?, 3, ?, ?)');
    for (let i = 0; i < 3; i++) review.run(card, MON_9, 'app', null);
    for (let i = 0; i < 2; i++) review.run(card, MON_16, 'app', null);
    // History brought in from another app is not studying done here.
    review.run(card, MON_9, 'anki', 'imported-1');

    // Evidence through the real writer, then dated: the writer stamps "now".
    const evidence = [];
    const attempt = (node, score, total, type, at) => {
        updateMasteryFromAttempt(node, score, total, type, { answer: 'CANARYANSWER the learner typed this' });
        evidence.push([Number(db.prepare('SELECT MAX(id) AS id FROM mastery_evidence').get().id), at]);
    };
    for (let i = 0; i < 3; i++) attempt(proven, 5, 5, 'mastery_check', MON_16);
    attempt(proven, 2, 2, 'paper', WED_18);
    attempt(quizzed, 3, 4, 'quiz', WED_18);
    for (let i = 0; i < 6; i++) attempt(cardsOnly, 10, 10, 'flashcard', WED_18);
    const dateEvidence = db.prepare('UPDATE mastery_evidence SET created_at = ? WHERE id = ?');
    for (const [id, at] of evidence) dateEvidence.run(at, id);

    const paper = Number(db.prepare('INSERT INTO exam_papers (project_id, title, minutes) VALUES (?, ?, 90)')
        .run(course, 'CANARYPAPER June exam').lastInsertRowid);
    const sitting = db.prepare(`INSERT INTO mock_sittings (paper_id, question, time_allowed, elapsed, status, started_at, finished_at)
        VALUES (?, 'CANARYPROMPT question four', 5400, 5400, ?, ?, ?)`);
    sitting.run(paper, 'done', WED_18, WED_18);
    sitting.run(paper, 'writing', WED_18, null);

    const text = exportText();
    const f = summaryFields(text);
    const count = (label) => (f.get(label) || '').split(' ')[0];
    eq('study days are counted on the learner\'s days', count('study days'), '3');
    eq('study minutes are the study clock\'s total', count('study minutes'), '75');
    eq('a topic proven by checks counts, one with only cards does not', count('proven topics'), '1');
    eq('checks are the attempts that can prove a topic', f.get('checks'), '5 (mastery checks 3, quizzes 1, paper exercises 1)');
    eq('questions answered leave card ratings out', count('questions answered'), '21');
    eq('card reviews are the ones done in this app', count('card reviews'), '5');
    eq('a mock exam counts once it is finished', count('mock exams finished'), '1');
    eq('courses are a number', count('courses'), '1');
    eq('the first study day is the learner\'s date', f.get('first study day'), '2026-11-09');
    // week of, days, minutes, checks, answers, reviews
    eq('one line per week, a Monday in the learner\'s calendar',
        JSON.stringify(weekRows(text)),
        JSON.stringify([['2026-11-09', 1, 30, 0, 0, 3], ['2026-11-16', 2, 45, 5, 21, 2]]));

    check('no title, note, card, answer or prompt from the library is in the file',
        !text.includes('CANARY'), text.split('\n').find(l => l.includes('CANARY')));
    check('the file\'s header still says what it does not contain',
        /No topic titles, prompts, notes, answers or model output/.test(text), text.split('\n').slice(0, 4).join(' | '));

    // The summary does not come from the log, so nothing done to the log moves it.
    const summaryOf = (t) => t.split('\n').filter(l => /^# {2}/.test(l)).join('\n');
    const expected = summaryOf(text);
    clearActivityLog();
    eq('an empty log still carries the same summary', summaryOf(exportText()), expected);
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('activity_log_enabled', 'false')").run();
    invalidateActivityLogSetting();
    eq('a log switched off still carries the same summary', summaryOf(exportText()), expected);
    db.prepare("DELETE FROM settings WHERE key = 'activity_log_enabled'").run();
    invalidateActivityLogSetting();
    many(MAX_ROWS + 10);
    check('the log now holds more rows than it keeps', activityStats().rows > MAX_ROWS, String(activityStats().rows));
    const full = exportText();
    eq('a log past its cap still carries the same summary', summaryOf(full), expected);
    check('and the summary comes before the first event',
        full.indexOf('# Study summary') >= 0 && full.indexOf('# Study summary') < full.indexOf(' ai.request'));
    trimActivityLog();

    // The edges the seed above does not reach. Evidence the writer stamped
    // with CURRENT_TIMESTAMP ('YYYY-MM-DD HH:MM:SS', no T, no Z): Thursday 19th
    // in Auckland. A topic marked done on Friday 20th; a NOTE marked done
    // the Saturday before, which is not work. A clock row past `now` (Monday
    // 23rd in Auckland), which folds into this week instead of adding one. And
    // a row from June 2025, which moves the first day but not the 52-line cap.
    db.prepare("INSERT INTO mastery_evidence (node_id, evidence_type, score, total, created_at) VALUES (?, 'quiz', 1, 1, '2026-11-19 08:00:00')").run(quizzed);
    db.prepare("UPDATE nodes SET completed_at = '2026-11-19 20:00:00' WHERE id = ?").run(quizzed);
    db.prepare("UPDATE nodes SET completed_at = '2026-11-13 20:00:00' WHERE project_id = ? AND is_note = 1").run(course);
    time.run(cardsOnly, '2026-11-22T11', 'reading', 10 * 60000);
    time.run(proven, '2025-06-01T22', 'reading', 5 * 60000);
    const edges = exportText();
    const e = summaryFields(edges);
    eq('a stored timestamp without T or Z lands on its learner\'s day, and a finished topic is a study day',
        (e.get('study days') || '').split(' ')[0], '7');
    eq('study minutes include the early and the late row', (e.get('study minutes') || '').split(' ')[0], '90');
    eq('the CURRENT_TIMESTAMP-shaped check counts', e.get('checks'), '6 (mastery checks 3, quizzes 2, paper exercises 1)');
    eq('the first study day is the oldest one', e.get('first study day'), '2025-06-02');
    const rows = weekRows(edges);
    eq('at most 52 week lines, a row after now included', rows.length, 52);
    eq('they start 51 weeks before this one', rows[0]?.[0], '2025-11-24');
    eq('and end on this week, holding the late row and the new days',
        JSON.stringify(rows.slice(-2)), JSON.stringify([['2026-11-09', 1, 30, 0, 0, 3], ['2026-11-16', 5, 55, 6, 22, 2]]));

    // A summary that cannot be read still leaves the events in the file.
    logActivity({ area: 'server', event: 'server.started' });
    db.exec('ALTER TABLE mock_sittings RENAME TO mock_sittings_gate_hidden');
    let broken = '';
    try { broken = exportText(); } catch (err) { broken = `threw ${err.name}`; }
    db.exec('ALTER TABLE mock_sittings_gate_hidden RENAME TO mock_sittings');
    check('a summary that fails says so in one line', /^# Study summary: could not be worked out \(\w+\)\.$/m.test(broken),
        broken.split('\n').slice(0, 5).join(' | '));
    check('and the events are still exported', /server\.started/.test(broken));
}

// ---- every call site keeps the promise --------------------------------------

// The fields a call site must never pass into an event: they are where a title,
// a question, a note or a model's answer would come from. This is a source
// scan, so it also covers call sites this suite never runs.
const FORBIDDEN = /\b(title|name|label|prompt|question|answer|notes?|content|description|front|back|filename|fileName|path)\b/;

const offenders = [];
const errorOffenders = [];
let callSites = 0;
for (const file of serverFiles()) {
    const src = readServer(file);
    // Each `logActivity({ ... })` call, braces balanced crudely but adequately:
    // these calls are object literals one or two lines long by construction.
    const re = /logActivity\(\s*\{([\s\S]{0,600}?)\}\s*\)/g;
    let m;
    while ((m = re.exec(src))) {
        callSites++;
        const args = m[1];
        // `projectId`/`nodeId` are ids and always fine; strip them before the
        // scan so `projectId: project.id` does not read as a name.
        const scanned = args
            // `content.length` is a COUNT of what came back, not what came
            // back; the same goes for any `.length`. A number about the
            // learner's text is a fact about the call.
            .replace(/\b[\w.?]+\.length\b/g, '0')
            .replace(/project(Id)?\s*:\s*[^,\n]+/g, '')
            .replace(/node(Id)?\s*:\s*[^,\n]+/g, '')
            .replace(/event\s*:\s*'[^']*'/g, '')
            .replace(/'[^']*'/g, "''")
            .replace(/"[^"]*"/g, '""');
        const hit = scanned.match(FORBIDDEN);
        if (hit) offenders.push(`${file}: ${hit[0]} in ${m[0].slice(0, 80).replace(/\s+/g, ' ')}…`);
        // An error's message is free text a provider wrote, and providers echo
        // the request back. Only `failureFacts(…)` may look at an error, and it
        // reads the structured fields, never the sentence.
        const errText = args.replace(/failureFacts\([^()]*\)/g, '0')
            .replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""')
            .match(/\.message\b|\.stack\b|\.responseBody\b|\b(?:err|error|e|failure|cause|reason|ex)\b/);
        if (errText) errorOffenders.push(`${file}: ${errText[0]} in ${m[0].slice(0, 80).replace(/\s+/g, ' ')}…`);
    }
}
check('every logActivity call site was found', callSites >= 8, `found ${callSites}`);
check('no call site passes anything the learner wrote',
    offenders.length === 0, offenders.join(' | '));
check('no call site puts an error\'s text in an event (only failureFacts reads an error)',
    errorOffenders.length === 0, errorOffenders.join(' | '));

// ---- a failed model call records facts, never the provider's text -----------

// The source scan above cannot see what an error CARRIES. A provider answering
// 400 commonly echoes the request, so the message of the thrown error can hold
// the prompt, a line of the learner's document, the key the request was signed
// with and the URL it went to. This sends marked text through the real failure
// paths — a call, a stream, a timeout, a refused connection, and a background
// task — against a loopback stub, and reads the EXPORT for any of it.
{
    const http = await import('node:http');
    const MARKS = {
        prompt: 'MARKPROMPT the mitochondria is the powerhouse of the cell',
        document: 'MARKDOC chapter three, line nine of my notes',
        key: 'sk-MARKKEY0123456789abcdef',
        query: 'MARKQUERY',
    };
    // Ports the system hands out, never fixed ones: a fixed port another
    // session holds killed this suite with EADDRINUSE before its first case.
    const freePort = () => new Promise((resolve, reject) => {
        const s = http.createServer();
        s.once('error', reject);
        s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    });
    const hanging = new Set();
    const stub = http.createServer((req, res) => {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
            if (body.includes('HANG')) { hanging.add(res); return; }
            res.writeHead(400, { 'Content-Type': 'application/json' });
            // What llama.cpp and several hosted routers do: say what they got.
            res.end(JSON.stringify({ error: { message: `invalid request ${req.url} auth=${req.headers.authorization} body=${body}` } }));
        });
    });
    await new Promise(r => stub.listen(0, '127.0.0.1', r));
    const STUB_PORT = stub.address().port;
    const base = `http://127.0.0.1:${STUB_PORT}/v1?token=${MARKS.query}`;
    const setSetting = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    setSetting.run('ai_provider', 'openai');
    setSetting.run('ai_openai_base_url', base);
    setSetting.run('ai_openai_model', 'gate/model-1');
    // The key goes where every saved key goes (the credentials file beside
    // the library), so the stub really receives it and echoes it back.
    (await import('../server/ai.js')).saveActiveKey(MARKS.key, `http://127.0.0.1:${STUB_PORT}`);

    // The task observer that writes `task.error` is installed by server/app.js,
    // so the real server boots — on a scratch library and a free port.
    process.env.PORT = String(await freePort());
    process.env.HOST = '127.0.0.1';
    const { serverReady } = await import('../server/index.js');
    await serverReady;
    const ai = await import('../server/ai.js');
    const tasks = await import('../server/tasks.js');
    clearActivityLog();

    const system = `Reference material:\n${MARKS.document}`;
    const threw = async (fn) => { try { await fn(); return false; } catch { return true; } };
    check('a call the provider refuses throws',
        await threw(() => ai.generateResponse(MARKS.prompt, system, [], { operation: 'summary' })));
    check('a stream the provider refuses throws',
        await threw(async () => { for await (const _ of ai.streamResponse(MARKS.prompt, system, [])) { /* drain */ } }));
    check('a call past its timeout throws',
        await threw(() => ai.generateResponse(`HANG ${MARKS.prompt}`, system, [], { operation: 'summary', timeout: 300 })));
    const { task } = tasks.createTask({
        kind: 'summary', label: 'gate',
        run: () => ai.generateResponse(MARKS.prompt, system, [], { operation: 'summary' }),
    });
    for (let i = 0; i < 100 && task.status !== 'error'; i++) await new Promise(r => setTimeout(r, 50));
    eq('the background task failed', task.status, 'error');
    // Nothing listens here, so the connection is refused.
    setSetting.run('ai_openai_base_url', `http://127.0.0.1:${await freePort()}/v1?token=${MARKS.query}`);
    check('a refused connection throws',
        await threw(() => ai.generateResponse(MARKS.prompt, system, [], { operation: 'summary' })));

    const log = [...streamActivityLog()].join('');
    for (const [what, mark] of Object.entries({ ...MARKS, prompt: 'MARKPROMPT', document: 'MARKDOC', key: 'MARKKEY' })) {
        check(`the exported log carries no ${what} a provider echoed back`, !log.includes(mark),
            log.split('\n').find(l => l.includes(mark))?.slice(0, 160));
    }
    const failed = readActivity({ limit: 50 }).filter(r => /failed|error/.test(r.event));
    // The whole grammar of a failure: a word from a fixed list and/or a
    // status, then numbers and fixed words. Nothing here can hold a sentence.
    const NET = '(?:E[A-Z]{2,20}|UND_ERR_[A-Z_]+)';
    const WHY = `(?:(?:timeout|aborted|looped|emptyReply|error|${NET})(?: · http \\d{3})?|http \\d{3})`
        + `(?: · ${NET})?(?: · \\d+ attempts?)?(?: · finish [a-z_]+)?$`;
    const FACTS = new RegExp(`^(?:openai|ollama) · gate/model-1(?: · [a-z]+)? · (?:\\d+ chars(?: · thinking \\d+)? · )?${WHY}`);
    const TASK_FACTS = new RegExp(`^summary · ${WHY}`);
    eq('every failure path wrote its event (3 calls, 1 stream, 1 task)',
        failed.map(r => r.event).sort().join(','), 'ai.failed,ai.failed,ai.failed,ai.failed,ai.stream_failed,task.error');
    for (const r of failed) {
        console.log(`        ${r.event}: ${r.detail}`);
        check(`${r.event}: detail is structured facts only`, (r.event === 'task.error' ? TASK_FACTS : FACTS).test(r.detail || ''), r.detail);
    }
    check('a timeout is named as one', failed.some(r => r.event === 'ai.failed' && / · timeout$/.test(r.detail || '')),
        failed.map(r => r.detail).join(' | '));
    check('a refusal carries its status', failed.some(r => / · http 400\b/.test(r.detail || '')));
    check('a refused connection carries its network code', failed.some(r => /ECONNREFUSED/.test(r.detail || '')),
        failed.map(r => r.detail).join(' | '));

    for (const res of hanging) { try { res.destroy(); } catch { /* gone */ } }
    stub.close();

    // The button's own URL: the summary has to reach the file a person saves,
    // not only the function this suite calls.
    const download = await fetch(`http://127.0.0.1:${process.env.PORT}/api/activity/export`)
        .then(r => r.text()).catch(e => `fetch failed: ${e.message}`);
    check('the download a person saves opens with the study summary', /^# Study summary\b/m.test(download),
        download.split('\n').slice(0, 5).join(' | '));
    eq('and carries the library\'s counts', (summaryFields(download).get('proven topics') || '').split(' ')[0], '1');
    check('and no text from the library', !download.includes('CANARY'));
}

// The panel's promise and the exported header have to say the same thing, or
// one of them is a lie the other cannot see.
const panel = readFileSync(join(ROOT, 'src/components/settings/ActivityLogPanel.tsx'), 'utf8');
check('the panel states the rule to the reader',
    /no topic titles/i.test(panel) && /never what you (?:are )?stud(?:y|ying)\b/i.test(panel));
check('the panel says the download starts with a summary of numbers, before it is pressed',
    /summary of how much and when you studied/i.test(panel) && /numbers only/i.test(panel) && /study days/i.test(panel));

// ---- report -----------------------------------------------------------------

console.log(`\n${pass} passed, ${fail} failed`);
try { db.close(); } catch { /* best effort */ }
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* Windows file locks */ }
process.exit(fail ? 1 : 0);
