// tools/first-lessons-gates.mjs — a course is studied while it is still being written.
//
// Run:  node tools/first-lessons-gates.mjs [--server <dir>]
//
// A course creation runs for minutes (an hour with links on a local model),
// and the lesson writer (server/feedGen.js) stood aside for ANY other task,
// the creation included. So Study on a course still being written showed its
// first topic's Overview and "Writing the lesson" until the whole course was
// done, and a learner could not start on the course they had just asked for.
//
// Now the creation asks for the lessons of the topics the course's Study
// starts on as soon as they exist (`askFirstLessons`), and a creation no longer
// holds back a lesson a learner is waiting on. This asserts, against the REAL
// routes on a scratch library and a stub model on loopback (nothing billed,
// nothing leaves the machine), with the creation held at its link search:
//
//   1. a fresh creation: the first two topics are taught (outline, every part,
//      every question) while the course is still being written, the second
//      one in the next section when the first section has one topic; they are
//      the topics the course's Study opens on, and neither Study nor the writer
//      takes a phase or section still waiting for its topics for a topic; the
//      third topic and a taught topic's paper exercise wait until the creation
//      ends (the look-ahead still waits), and then they are written;
//   2. the rule: with a creation running, a topic the learner opened in ANOTHER
//      course is written too, a topic nobody asked for is not, and any other
//      task (a quiz being written) still comes first;
//   3. a continued creation: the topics an earlier run wrote are taught while
//      the continuation fetches their links, and a section still waiting for
//      its topics is not;
//   4. a short course: its first topic is taught as soon as it lands.
//
// `--server <dir>` runs the same cases against another copy of server/ (the
// pre-change code, e.g. `git archive HEAD server | tar -x -C temp/head`); it is
// expected to FAIL cases 1–4.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';

const argv = process.argv.slice(2);
const argOf = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
const B = argOf('--server')
    ? pathToFileURL(resolve(argOf('--server')) + '/').href
    : new URL('../server/', import.meta.url).href;

const scratch = mkdtempSync(join(tmpdir(), 'first-lessons-gates-'));
process.env.DB_PATH = join(scratch, 'test.db');
process.env.VAULT_ROOT = join(scratch, 'vault');
process.env.DATA_DIR = scratch;

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${String(extra).slice(0, 400)}` : ''}`); }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 15000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (fn()) return true;
        await sleep(50);
    }
    return !!fn();
}

// ---- the stub model ---------------------------------------------------------------
const stageOf = (system) =>
    system.includes('review the name and description') ? 'identity'
    : system.includes('Write out your thoughts') ? 'thinking'
    : system.includes('Summarize this learning project') ? 'summary'
    : system.includes('top-level categories') ? 'categories'
    : system.includes('Create sub-topics (elements)') ? 'elements'
    : system.includes('for EVERY topic') ? 'sub_batch'
    : system.includes('detailed sub-elements (leaf nodes)') ? 'sub_one'
    : system.includes('You plan a SHORT COURSE') ? 'short'
    : system.includes('curriculum designer') ? 'outline'
    : system.includes('writing ONE segment') ? 'lesson'
    : system.includes('You write ONE question that checks') ? 'question'
    : system.includes('checking a question before it is shown') ? 'verify'
    : system.includes('checking ONE segment of a lesson') ? 'audit'
    : system.includes('You set ONE exercise the learner will work through BY HAND') ? 'practice'
    : 'other';

const LESSON = 'A wave carries energy from one place to another without carrying matter along with it. '
    + 'Think of a rope tied to a wall: you flick one end, a bump runs along the rope, and yet every piece of the rope only moves up and down. '
    + 'The height of the bump is the amplitude, the distance from one crest to the next is the wavelength, and the number of crests '
    + 'passing a point each second is the frequency. Multiply the wavelength by the frequency and you get the speed of the wave.';
const QUESTION = {
    question: 'What does a wave carry from one place to another?',
    type: 'multiple_choice',
    options: ['Energy', 'Matter', 'Air', 'Water'],
    correct_answer: 'Energy',
    explanation: 'Each piece of the rope only moves up and down; the energy travels along it.',
};

function answer(stage, user) {
    if (stage === 'identity') return JSON.stringify({ keep_name: true, name: '', keep_description: true, description: '', reason: 'both are good' });
    if (stage === 'thinking') return 'Plan: waves first, then light.';
    if (stage === 'summary') return 'A course on waves and light.';
    if (stage === 'categories') return JSON.stringify({ categories: [
        { title: 'Waves', description: 'What a wave is' },
        { title: 'Light', description: 'Light as a wave' },
    ] });
    if (stage === 'elements') return JSON.stringify({ elements: user.includes('Learning Phase: Light') ? [
        { title: 'Describing light', description: 'Rays and wavefronts' },
        { title: 'Lenses and mirrors', description: 'Images' },
    ] : [
        { title: 'Describing a wave', description: 'Amplitude, wavelength, frequency' },
        { title: 'Wave behaviour', description: 'Reflection, refraction, interference' },
        { title: 'Sound waves', description: 'Pressure waves in air' },
    ] });
    if (stage === 'sub_batch') {
        // The first section has ONE topic: the second topic Study opens on is
        // the next section's first, so the creation must ask again.
        const listed = [...user.matchAll(/^\d+\. (.+?)(?: — .*)?$/gm)].map(m => m[1]);
        return JSON.stringify({ topics: listed.map(title => ({
            element: title,
            subElements: title === 'Describing a wave'
                ? [{ title: `${title}: the idea`, description: 'The idea' }]
                : [{ title: `${title}: the idea`, description: 'The idea' }, { title: `${title}: in practice`, description: 'Practice' }],
        })) });
    }
    if (stage === 'sub_one') return JSON.stringify({ subElements: [{ title: 'One leaf', description: 'One' }] });
    if (stage === 'short') return JSON.stringify({ topics: [
        { title: 'What a wave carries', description: 'Energy, not matter' },
        { title: 'Measuring a wave', description: 'Amplitude, wavelength, frequency' },
        { title: 'How fast a wave moves', description: 'Speed from wavelength and frequency' },
    ] });
    if (stage === 'outline') return JSON.stringify({ parts: [
        { title: 'What moves', focus: 'Energy travels, matter stays' },
        { title: 'Measuring it', focus: 'Amplitude, wavelength, frequency' },
    ] });
    if (stage === 'lesson') return LESSON;
    if (stage === 'question') return JSON.stringify(QUESTION);
    if (stage === 'verify') return JSON.stringify({ verdict: 'ok', answer: QUESTION.correct_answer, reason: 'agrees', eliminable: 0 });
    if (stage === 'audit') return JSON.stringify({ verdict: 'ok', quote: '', reason: '' });
    return null;
}

const calls = [];
const stub = createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
        if (req.url.endsWith('/models')) {
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ data: [{ id: 'stub-model' }] }));
        }
        const body = (() => { try { return JSON.parse(raw || '{}'); } catch { return {}; } })();
        const msgs = body.messages || [];
        const system = msgs.find(m => m.role === 'system')?.content || '';
        const user = msgs.filter(m => m.role === 'user').map(m => m.content).join('\n');
        const stage = stageOf(system);
        calls.push({ stage, user });
        const content = answer(stage, user);
        if (content == null) {
            res.writeHead(400, { 'content-type': 'application/json' });
            return res.end('{"error":{"message":"stub: not part of this gate"}}');
        }
        if (body.stream) {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
            res.write('data: [DONE]\n\n');
            return res.end();
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { completion_tokens: 20 } }));
    });
});
await new Promise(r => stub.listen(0, '127.0.0.1', r));
process.env.AI_PROVIDER = 'openai';
process.env.AI_BASE_URL = `http://127.0.0.1:${stub.address().port}/v1`;
process.env.AI_MODEL = 'stub-model';
process.env.AI_API_KEY = 'stub-key';

// ---- the real app on a scratch library --------------------------------------------
const { default: db } = await import(`${B}database.js`);
if (db.name !== process.env.DB_PATH) {
    console.log(`refusing to run: the database is ${db.name}, not the scratch file`);
    process.exit(1);
}
const setSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
setSetting.run('ai_enabled', 'true');
setSetting.run('ai_model', 'stub-model');
// Links on, so the run has a link stage to hold; the search itself is the stub below.
setSetting.run('creation_find_resources', 'true');
setSetting.run('lesson_reads_links', 'false');
setSetting.run('embedding_enabled', 'false');
setSetting.run('pdf_math_recovery', 'off');
setSetting.run('ui_language', 'en');
// No widgets, no paper exercise: the writer's work is the outline, lessons and questions.
setSetting.run('feed_widgets', 'false');
setSetting.run('feed_practice', 'false');

const { createApp } = await import(`${B}app.js`);
const tasks = await import(`${B}tasks.js`);
const feedGen = await import(`${B}feedGen.js`);
const { composeFeed } = await import(`${B}feed.js`);
const { setLinkSearchForTest } = await import(`${B}creationStages.js`);
const { ROLE_TOPIC } = await import(`${B}nodeRole.js`);

// The link search, held until released: the long stage a real creation sits in.
// `title` holds only that topic's search (and every one after it); none holds the first.
let linkGate = null;
let linkCalls = 0;
let heldAt = null;
const holdLinks = (title = null) => { let open; const p = new Promise(r => { open = r; }); linkGate = { p, open, title }; heldAt = null; };
const releaseLinks = () => { linkGate?.open(); linkGate = null; };
setLinkSearchForTest(async (title) => {
    linkCalls++;
    if (linkGate && (!linkGate.title || title === linkGate.title || heldAt)) {
        heldAt ??= title;
        await linkGate.p;
    }
    return [];
});

const server = createServer(createApp());
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// An SSE route read as it streams, so the gate can look at the library mid-run.
function stream(path, payload) {
    const frames = [];
    const done = (async () => {
        const res = await fetch(`${base}${path}`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
        });
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
            const { value, done: end } = await reader.read();
            if (end) break;
            buf += dec.decode(value, { stream: true });
            let i;
            while ((i = buf.indexOf('\n\n')) >= 0) {
                const chunk = buf.slice(0, i);
                buf = buf.slice(i + 2);
                if (chunk.startsWith('data: ')) { try { frames.push(JSON.parse(chunk.slice(6))); } catch { /* keepalive */ } }
            }
        }
        return frames;
    })();
    return { frames, done };
}

const leavesOf = (projectId) => db.prepare(`
    SELECT n.id, n.title FROM nodes n
    WHERE n.project_id = ? AND n.is_note = 0
      AND NOT EXISTS (SELECT 1 FROM nodes c WHERE c.parent_id = n.id AND c.is_note = 0)
    ORDER BY n.id
`).all(projectId);
// A phased course's topics: the nodes under a section under a phase, in the
// order the outline reads. Never "every leaf": while a course is written its
// later phases and sections are leaves too, waiting for their children.
const topicsOf = (projectId) => db.prepare(`
    SELECT t.id, t.title FROM nodes t
    JOIN nodes s ON s.id = t.parent_id JOIN nodes ph ON ph.id = s.parent_id
    WHERE t.project_id = ? AND t.is_note = 0 AND ph.parent_id IS NULL
    ORDER BY ph.position, ph.id, s.position, s.id, t.position, t.id
`).all(projectId);
const containersOf = (projectId) => db.prepare(`
    SELECT n.id, n.title FROM nodes n
    WHERE n.project_id = ? AND n.is_note = 0
      AND (n.parent_id IS NULL OR (SELECT parent_id FROM nodes p WHERE p.id = n.parent_id) IS NULL)
`).all(projectId);
const rowsOf = (nodeId, kind) => db.prepare('SELECT COUNT(*) AS c FROM feed_items WHERE node_id = ? AND kind = ?').get(nodeId, kind).c;
const planParts = (nodeId) => {
    const row = db.prepare("SELECT content FROM feed_items WHERE node_id = ? AND kind = 'plan'").get(nodeId);
    try { return JSON.parse(row?.content || '{}').parts?.length ?? 0; } catch { return 0; }
};
// Every part the outline names has its lesson and its question.
const taught = (nodeId) => {
    const parts = planParts(nodeId);
    return parts > 0 && rowsOf(nodeId, 'lesson') >= parts && rowsOf(nodeId, 'question') >= parts;
};
const generating = (projectId) => db.prepare('SELECT ai_generating AS g FROM projects WHERE id = ?').get(projectId)?.g === 1;

/* ── 1. a fresh creation ─────────────────────────────────────────────────── */
console.log('\n--- 1. a fresh creation: the first topics are taught while it runs ---');
{
    // The paper exercise on for this case: the step after a topic is taught,
    // which beside a creation waits like the look-ahead (the stub refuses it,
    // so it is recorded as skipped, never written).
    setSetting.run('feed_practice', 'true');
    // Held at the second section's first topic: by then section 1 (one topic)
    // and section 2 (two) are written, while phase 2 and section 3 are still
    // empty, and, written before any topic, have the lower ids.
    holdLinks('Wave behaviour: the idea');
    const run = stream('/api/ai/create-project', { name: 'Waves and light', description: 'Understand waves', color: '#3b82f6' });
    await until(() => heldAt != null, 20000);
    const projectId = run.frames.find(f => f.projectId)?.projectId;
    ok('the run reached its link search with a project', heldAt != null && Number.isInteger(projectId), JSON.stringify(run.frames.slice(-3)));
    const topics = projectId ? topicsOf(projectId) : [];
    const [first, second, third] = topics;
    ok('two sections wrote their topics before the hold', topics.map(t => t.title).join(' | ')
        === 'Describing a wave: the idea | Wave behaviour: the idea | Wave behaviour: in practice', JSON.stringify(topics));
    const containers = projectId ? containersOf(projectId) : [];
    const empty = containers.filter(c => !db.prepare('SELECT 1 FROM nodes WHERE parent_id = ? AND is_note = 0').get(c.id));
    ok('...while a phase and a section are still empty', empty.map(c => c.title).sort().join(' | ') === 'Light | Sound waves', JSON.stringify(empty));

    const both = await until(() => first && second && taught(first.id) && taught(second.id), 20000);
    ok('the first topic is taught while the course is being written', !!first && taught(first.id),
        first && JSON.stringify({ plan: planParts(first.id), lessons: rowsOf(first.id, 'lesson'), questions: rowsOf(first.id, 'question') }));
    ok('...and the one after it, the next section\'s first', both, second && JSON.stringify({ plan: planParts(second.id), lessons: rowsOf(second.id, 'lesson') }));
    ok('no lesson is written for a phase or a section', containers.every(c => rowsOf(c.id, 'plan') === 0),
        JSON.stringify(containers.map(c => [c.title, rowsOf(c.id, 'plan')])));
    ok('...still mid-creation: the course is marked as being written', !!projectId && generating(projectId));
    ok('...and the run has not ended', !run.frames.some(f => f.done || f.phase === 'complete' || f.phase === 'error'), JSON.stringify(run.frames.slice(-2)));

    // The topics written first are the ones the course's Study opens on.
    const study = projectId ? composeFeed({ projectId, limit: 15 }).items : [];
    // A written part (`fi-<row>`), not the Overview standing in for one (`read-<node>`).
    const firstLesson = study.find(c => c.kind === 'lesson' && String(c.key).startsWith('fi-'));
    ok("the course's Study opens on a written lesson of the first topic", firstLesson?.nodeId === first?.id,
        JSON.stringify(study.slice(0, 4).map(c => [c.kind, c.nodeId, c.key])));
    const containerIds = new Set(containers.map(c => c.id));
    ok('...and shows no phase or section as a topic', study.length > 0 && !study.some(c => containerIds.has(c.nodeId)),
        JSON.stringify(study.map(c => [c.kind, c.nodeId])));

    // Nobody waits on the third topic yet: the look-ahead still waits for the creation.
    await sleep(1500);
    ok('the third topic is not written while the creation runs', !!third && rowsOf(third.id, 'plan') === 0,
        third && JSON.stringify({ plan: rowsOf(third.id, 'plan') }));
    ok("...nor a taught topic's paper exercise", !calls.some(c => c.stage === 'practice'),
        JSON.stringify(calls.filter(c => c.stage === 'practice').length));

    releaseLinks();
    const frames = await run.done;
    ok('the creation completes', frames.some(f => f.phase === 'complete'), JSON.stringify(frames.slice(-2)));
    // …and once it has, the look-ahead carries on where it was held.
    const later = await until(() => !!third && rowsOf(third.id, 'plan') > 0, 25000);
    ok('after the creation, the look-ahead writes the next topic', later);
    ok('...and the paper exercise is asked for', calls.some(c => c.stage === 'practice'));
    setSetting.run('feed_practice', 'false');
}

/* ── 2. the rule, task by task ───────────────────────────────────────────── */
console.log('\n--- 2. a creation holds back only what nobody is waiting on ---');
{
    // The creation first, then the writer left to go quiet: the look-ahead
    // from case 1 stops at its next step, before this course exists, so the
    // only writing below is what this case asks for.
    const creation = tasks.registerExternal({ kind: 'create_project', label: 'Creating another course', cancel: () => { } });
    await until(() => !tasks.listTasks().some(t => t.kind === 'feed' && t.status === 'running'), 30000);
    const course = Number(db.prepare("INSERT INTO projects (name, position) VALUES ('Optics', 5)").run().lastInsertRowid);
    const mk = (title, position) => Number(db.prepare(
        "INSERT INTO nodes (project_id, parent_id, title, position, role, description) VALUES (?, NULL, ?, ?, ?, 'Overview of the topic.')",
    ).run(course, title, position, ROLE_TOPIC).lastInsertRowid);
    const opened = mk('Refraction at a boundary', 0);
    const blocked = mk('Total internal reflection', 1);
    const unasked = mk('Dispersion of white light', 2);

    feedGen.requestNode(opened);
    ok('with a creation running, a topic the learner opened is written', await until(() => taught(opened), 20000),
        JSON.stringify({ plan: planParts(opened), lessons: rowsOf(opened, 'lesson') }));

    const quiz = tasks.registerExternal({ kind: 'quiz', label: 'Writing a quiz', cancel: () => { } });
    ok('...while a topic nobody asked for waits', rowsOf(unasked, 'plan') === 0);
    feedGen.requestNode(blocked);
    await sleep(1500);
    ok('...but any other task still comes first', rowsOf(blocked, 'plan') === 0);
    quiz.finish();
    ok('...and the topic is written once that task is done', await until(() => taught(blocked), 25000),
        JSON.stringify({ plan: planParts(blocked), lessons: rowsOf(blocked, 'lesson') }));
    creation.finish();
}

/* ── 3. a continued creation ─────────────────────────────────────────────── */
console.log('\n--- 3. a continued creation teaches the topics an earlier run wrote ---');
{
    await until(() => !tasks.listTasks().some(t => t.kind === 'feed' && t.status === 'running'), 30000);
    const course = Number(db.prepare(
        "INSERT INTO projects (name, position, ai_generating, creation_finished) VALUES ('Sound', 6, 0, 0)",
    ).run().lastInsertRowid);
    const node = (parent, title, position, role = null) => Number(db.prepare(
        "INSERT INTO nodes (project_id, parent_id, title, position, role, description, generated_by) VALUES (?, ?, ?, ?, ?, 'Overview.', 'stub-model')",
    ).run(course, parent, title, position, role).lastInsertRowid);
    // Written in the creation's order, containers first: the second phase's
    // section has no topics yet and a lower id than every topic.
    const phase = node(null, 'Sound waves', 0);
    const later = node(null, 'Hearing', 1);
    const section = node(phase, 'What sound is', 0);
    const emptySection = node(later, 'The ear', 0);
    const t1 = node(section, 'Sound as a pressure wave', 0, ROLE_TOPIC);
    const t2 = node(section, 'Pitch and loudness', 1, ROLE_TOPIC);
    db.prepare('UPDATE projects SET creation_pending_links = ? WHERE id = ?').run(JSON.stringify([t1, t2]), course);

    holdLinks();
    const run = stream('/api/ai/continue-creation', { projectId: course });
    await until(() => run.frames.some(f => f.phase === 'resuming' || f.phase === 'error'), 20000);
    const both = await until(() => taught(t1) && taught(t2), 20000);
    ok('the topics it already has are taught while it fetches their links', both,
        JSON.stringify({ t1: rowsOf(t1, 'lesson'), t2: rowsOf(t2, 'lesson'), frames: run.frames.slice(-2) }));
    ok('...mid-run', !run.frames.some(f => f.done || f.phase === 'complete'), JSON.stringify(run.frames.slice(-2)));
    ok('...and no lesson is written for the section still waiting for its topics',
        rowsOf(emptySection, 'plan') === 0 && rowsOf(later, 'plan') === 0,
        JSON.stringify({ section: rowsOf(emptySection, 'plan'), phase: rowsOf(later, 'plan') }));
    releaseLinks();
    const frames = await run.done;
    ok('the continuation completes', frames.some(f => f.phase === 'complete'), JSON.stringify(frames.slice(-2)));
}

/* ── 4. a short course ───────────────────────────────────────────────────── */
console.log('\n--- 4. a short course is taught as soon as it lands ---');
{
    await until(() => !tasks.listTasks().some(t => t.kind === 'feed' && t.status === 'running'), 30000);
    // Another course is being created the whole time, so the look-ahead (which
    // also serves short courses) is held back: the first topic is written
    // because the short course ASKED for it, not because the look-ahead got there.
    const creation = tasks.registerExternal({ kind: 'create_project', label: 'Creating another course', cancel: () => { } });
    const res = await fetch(`${base}/api/short-courses`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fromTopic: { title: 'How waves carry energy' } }),
    });
    const body = await res.json().catch(() => ({}));
    const projectId = body.projectId ?? body.project?.id ?? null;
    ok('a short course is started from a topic', res.ok && Number.isInteger(projectId), `${res.status} ${JSON.stringify(body).slice(0, 200)}`);
    const firstTopic = () => (projectId ? leavesOf(projectId)[0] : null);
    await until(() => !!firstTopic(), 15000);
    const t = firstTopic();
    ok('its first topic is taught without anyone opening it', !!t && await until(() => taught(t.id), 20000),
        t && JSON.stringify({ plan: planParts(t.id), lessons: rowsOf(t.id, 'lesson') }));
    creation.finish();
}

console.log(`\n${pass} passed, ${fail} failed`);
server.close();
stub.close();
try { db.close(); } catch { /* already closed */ }
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* Windows may hold the WAL a moment */ }
process.exit(fail ? 1 : 0);
