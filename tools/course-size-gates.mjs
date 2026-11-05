// tools/course-size-gates.mjs — an AI-created course is the size the learner
// asked for, and no phase writes again what another already has.
//
// Run:  node tools/course-size-gates.mjs [--server <dir>]
//
// A course on one calculus topic, with the goal "I want to understand it", came
// back as 8 phases, 89 sections and 811 topics. Nothing budgeted the
// size: the phase plan named no count, a phase's sections no count, and the
// per-section topic prompt (taken by every phase wider than BATCH_MAX, five of
// the eight) no count at all, so those phases wrote 9 to 14 topics a section.
// And each phase's sections were written by a call that saw only that phase,
// so "Building New Series from Known Ones" was written in phases 3, 4 and 8.
//
// This asserts, against the real routes on a scratch library and a stub model
// on loopback that answers every level with MORE than it was asked for and
// with repeats (nothing billed, nothing leaves the machine):
//
//   1. the plan's size reaches every prompt as a range: the phase plan offers
//      the three sizes, a phase's sections and a section's topics (batched and
//      per section) are asked for in the size's range;
//   2. the counts hold whatever the model answers: phases, sections a phase
//      and topics a section are cut to the top of the range;
//   3. a later phase's sections are written with the course plan and the
//      earlier phases' sections in view, and a section or topic title the
//      course already has is not written twice;
//   4. a plan that names no size is a standard course;
//   5. a continued creation knows the size from the phases it finds and shows
//      the phase it writes the sections that already exist;
//   6. a repeat is judged on letters of any script: two Cyrillic titles are
//      not "the same" because neither has a Latin letter.
//
// `--server <dir>` runs it against another copy of server/ (the pre-change
// code), where it must fail.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';

const argv = process.argv.slice(2);
const argOf = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
const B = argOf('--server')
    ? pathToFileURL(resolve(argOf('--server')) + '/').href
    : new URL('../server/', import.meta.url).href;

const scratch = mkdtempSync(join(tmpdir(), 'course-size-gates-'));
// In-process, before any import reaches database.js: never the real library.
process.env.DB_PATH = join(scratch, 'test.db');
process.env.VAULT_ROOT = join(scratch, 'vault');
process.env.DATA_DIR = scratch;

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${String(extra).slice(0, 400)}` : ''}`); }
};

// ---- the stub model: always too much, always with repeats -----------------------
const bodies = [];
let sizeAnswer = 'short';     // what the phase plan says; null = says nothing
let brokenPhase = null;       // a phase whose sections come back unusable
const stage = (system) =>
    system.includes('review the name and description') ? 'identity'
    : system.includes('Write out your thoughts') ? 'thinking'
    : system.includes('Summarize this learning project') ? 'summary'
    : system.includes('top-level categories') ? 'categories'
    : system.includes('Create sub-topics (elements)') ? 'elements'
    : system.includes('for EVERY topic') ? 'sub_batch'
    : system.includes('detailed sub-elements (leaf nodes)') ? 'sub_one'
    : 'other';

const PHASES = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta'];
const phaseOf = (user) => (user.match(/Learning Phase: (\w+)/) || [])[1] || '';

function answer(st, user) {
    if (st === 'identity') return JSON.stringify({ keep_name: true, name: '', keep_description: true, description: '', reason: 'both are good' });
    if (st === 'thinking') return 'Plan: one chapter.';
    if (st === 'summary') return 'A course on one chapter.';
    if (st === 'categories') {
        // Six phases, the last a repeat of the first's title.
        const categories = [...PHASES.slice(0, 5), 'Alpha'].map(t => ({ title: t, description: `About ${t}` }));
        return JSON.stringify(sizeAnswer ? { size: sizeAnswer, categories } : { categories });
    }
    if (st === 'elements') {
        const p = phaseOf(user);
        if (p === brokenPhase) return 'Sorry, no sections today.';
        // Beta has one section, so its topics take the per-section prompt.
        if (p === 'Beta') return JSON.stringify({ elements: [{ title: 'Beta only', description: 'One' }] });
        // Seven sections: the first the same in every phase (worded the same
        // but for case and punctuation after the first phase), the second a
        // short label a course may rightly have in every phase.
        const shared = p === 'Alpha' ? 'Building on shared ideas' : 'building on SHARED ideas!';
        const elements = [shared, 'Review', ...[1, 2, 3, 4, 5].map(i => `${p} section ${i}`)].map(t => ({ title: t, description: `About ${t}` }));
        return JSON.stringify({ elements });
    }
    if (st === 'sub_batch') {
        const listed = [...user.matchAll(/^\d+\. (.+?)(?: — .*)?$/gm)].map(m => m[1]);
        // Twelve topics a section: the first the same in every section, the
        // second a short label every section may rightly have.
        return JSON.stringify({ topics: listed.map(title => ({
            element: title,
            subElements: ['Practising the repeated idea', 'Worked examples', ...Array.from({ length: 10 }, (_, i) => `${title} topic ${i + 1}`)]
                .map(t => ({ title: t, description: t })),
        })) });
    }
    if (st === 'sub_one') {
        const at = (user.match(/CURRENT TOPIC to expand: (.+)/) || [])[1] || 'x';
        return JSON.stringify({ subElements: Array.from({ length: 12 }, (_, i) => ({ title: `${at} leaf ${i + 1}`, description: 'd' })) });
    }
    return null;
}

const stub = createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
        if (req.url.endsWith('/models')) {
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ data: [{ id: 'stub-model' }] }));
        }
        const body = JSON.parse(raw || '{}');
        const msgs = body.messages || [];
        const system = msgs.find(m => m.role === 'system')?.content || '';
        const user = msgs.filter(m => m.role === 'user').map(m => m.content).join('\n');
        const st = stage(system);
        bodies.push({ stage: st, system, user });
        const content = answer(st, user);
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

// ---- the real app on a scratch library ------------------------------------------
const { default: db } = await import(`${B}database.js`);
const setSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
setSetting.run('ai_enabled', 'true');
setSetting.run('creation_find_resources', 'false');   // no web search from a gate
setSetting.run('embedding_enabled', 'false');
setSetting.run('ui_language', 'en');
const { createApp } = await import(`${B}app.js`);
const server = createServer(createApp());
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

async function stream(path, payload) {
    bodies.length = 0;
    const res = await fetch(`${base}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    });
    const frames = [];
    if (res.ok) {
        for (const line of (await res.text()).split('\n\n')) if (line.startsWith('data: ')) frames.push(JSON.parse(line.slice(6)));
    }
    const id = frames.find(f => f.projectId)?.projectId ?? payload.projectId;
    return { status: res.status, frames, id, bodies: bodies.slice() };
}

/** The project's outline as phases → sections → topic titles. */
function outlineOf(projectId) {
    const rows = db.prepare('SELECT id, parent_id, title FROM nodes WHERE project_id = ? AND is_note = 0 ORDER BY position').all(projectId);
    const kids = (pid) => rows.filter(r => r.parent_id === pid);
    return kids(null).map(p => ({ title: p.title, sections: kids(p.id).map(s => ({ title: s.title, topics: kids(s.id).map(t => t.title) })) }));
}

const PAYLOAD = { name: 'One chapter', description: 'I want to understand one chapter of a subject for my exam.', content_language: '' };

// ---- 1-3. a short course, asked for too much ------------------------------------
console.log('\n=== the plan says "short"; the model answers every level with too much ===');
sizeAnswer = 'short';
let r = await stream('/api/ai/create-project', PAYLOAD);
ok('the creation completes', r.frames.some(f => f.phase === 'complete'), JSON.stringify(r.frames.at(-1)));
let tree = outlineOf(r.id);
const sections = tree.flatMap(p => p.sections);
const topics = sections.flatMap(s => s.topics);
console.log(`  (written: ${tree.length} phases, ${sections.length} sections, ${topics.length} topics)`);

const cats = r.bodies.find(b => b.stage === 'categories');
ok('the phase plan offers the three sizes with their phase ranges',
    /"short"[^\n]*2 to 4 phases/.test(cats?.system) && /"standard"[^\n]*3 to 6 phases/.test(cats?.system) && /"full"[^\n]*5 to 10 phases/.test(cats?.system),
    cats?.system.slice(0, 600));
ok('the phase plan asks for "size" in its reply', /"size":/.test(cats?.system));

ok('six phases offered, a short course keeps four', tree.length === 4, tree.map(p => p.title).join(', '));
ok('a repeated phase title is not written twice', new Set(tree.map(p => p.title)).size === tree.length);
ok('no phase has more than four sections', tree.every(p => p.sections.length <= 4), tree.map(p => p.sections.length).join(','));
ok('no section has more than five topics', sections.every(s => s.topics.length <= 5), sections.map(s => s.topics.length).join(','));
ok('the per-section path is cut too (Beta\'s one section)',
    (tree.find(p => p.title === 'Beta')?.sections[0]?.topics.length ?? 99) <= 5,
    JSON.stringify(tree.find(p => p.title === 'Beta')));

const els = r.bodies.filter(b => b.stage === 'elements');
ok('every sections prompt asks for 2 to 4 of them', els.length >= 4 && els.every(b => b.system.includes('Write 2 to 4 elements')),
    els.map(b => b.system.slice(0, 260)).join(' | '));
const batch = r.bodies.filter(b => b.stage === 'sub_batch');
ok('the batched topics prompt asks for 3 to 5 a section', batch.length > 0 && batch.every(b => b.system.includes('3 to 5 per topic')), batch[0]?.system.slice(0, 500));
const one = r.bodies.filter(b => b.stage === 'sub_one');
ok('the per-section topics prompt asks for 3 to 5', one.length > 0 && one.every(b => b.system.includes('Write 3 to 5 sub-elements')), one[0]?.system.slice(0, 900));

const elFor = (p) => els.find(b => phaseOf(b.user) === p);
ok('the first phase\'s sections prompt lists no earlier sections', !elFor('Alpha')?.user.includes('SECTIONS EARLIER PHASES'));
const gamma = elFor('Gamma')?.user || '';
ok('a later phase sees every section the earlier phases kept',
    gamma.includes('SECTIONS EARLIER PHASES ALREADY TEACH')
    && tree[0].sections.every(s => gamma.includes(s.title)) && gamma.includes('Beta only'),
    gamma.slice(0, 900));
ok('…and the whole course plan, itself marked, the dropped phases not in it',
    /COURSE PLAN[\s\S]*1\. Alpha[\s\S]*2\. Beta[\s\S]*3\. Gamma {2}<- THIS PHASE[\s\S]*4\. Delta/.test(gamma) && !gamma.includes('Epsilon'),
    gamma.slice(0, 900));
const gammaBatch = batch.find(b => phaseOf(b.user) === 'Gamma')?.user || '';
ok('a later phase\'s topics prompt lists the earlier sections too', gammaBatch.includes('SECTIONS EARLIER PHASES ALREADY TEACH') && gammaBatch.includes('Alpha section 1'));

const sharedCount = sections.filter(s => /shared ideas/i.test(s.title)).length;
ok('a section every phase wrote again is written once', sharedCount === 1, `${sharedCount} copies`);
ok('a topic every section wrote again is written once', topics.filter(t => t === 'Practising the repeated idea').length === 1);
const multi = tree.filter(p => p.sections.length > 1);
ok('a short label ("Review") stays in every phase that has it', multi.length >= 3 && multi.every(p => p.sections.some(s => s.title === 'Review')),
    tree.map(p => p.sections.map(s => s.title).join('|')).join(' / '));
const batchedSections = tree.filter(p => p.title !== 'Beta').flatMap(p => p.sections);
ok('…and a short topic label ("Worked examples") in every section that has it',
    batchedSections.every(s => s.topics.includes('Worked examples')), batchedSections.map(s => s.topics.length).join(','));
ok('the per-section topics prompt lists the earlier phases\' sections too',
    one.some(b => phaseOf(b.user) === 'Beta' && b.user.includes('SECTIONS EARLIER PHASES ALREADY TEACH') && tree[0].sections.every(s => b.user.includes(s.title))),
    one[0]?.user.slice(0, 900));
ok('the plan\'s format shows no size as the example\'s answer', !/"size": "(short|standard|full)"/.test(cats?.system || ''));

// ---- 4. a plan that names no size -----------------------------------------------
console.log('\n=== the plan names no size ===');
sizeAnswer = null;
r = await stream('/api/ai/create-project', { ...PAYLOAD, name: 'No size named' });
tree = outlineOf(r.id);
ok('a plan with no size is a standard course: up to six phases', tree.length === 5, `${tree.length} phases`);
ok('…sections asked for 3 to 5', r.bodies.filter(b => b.stage === 'elements').every(b => b.system.includes('Write 3 to 5 elements')));
ok('…and at most five a phase', tree.every(p => p.sections.length <= 5), tree.map(p => p.sections.length).join(','));

// ---- 5. a continued creation ----------------------------------------------------
console.log('\n=== a creation stopped at a phase, then continued ===');
sizeAnswer = 'short';
brokenPhase = 'Gamma';
r = await stream('/api/ai/create-project', { ...PAYLOAD, name: 'Continued' });
ok('the first run ends with a phase left empty', r.frames.some(f => f.phase === 'error') && outlineOf(r.id).find(p => p.title === 'Gamma')?.sections.length === 0,
    JSON.stringify(r.frames.at(-1)));
brokenPhase = null;
const before = outlineOf(r.id);
const c = await stream('/api/ai/continue-creation', { projectId: r.id });
ok('the continued run completes', c.frames.some(f => f.phase === 'complete'), JSON.stringify(c.frames.at(-1)));
const cg = c.bodies.find(b => b.stage === 'elements' && phaseOf(b.user) === 'Gamma');
ok('it asks the phase it writes for the size its phases imply (four phases: 2 to 4)', !!cg && cg.system.includes('Write 2 to 4 elements'), cg?.system.slice(0, 300));
ok('…and shows it the sections the earlier phases already have',
    !!cg && before[0].sections.every(s => cg.user.includes(s.title)) && cg.user.includes('Beta only'), cg?.user.slice(0, 900));
const after = outlineOf(r.id);
const gammaAfter = after.find(p => p.title === 'Gamma');
ok('the section the course already has is not written again',
    gammaAfter.sections.length > 0 && !gammaAfter.sections.some(s => /shared/i.test(s.title)), JSON.stringify(gammaAfter.sections.map(s => s.title)));
ok('…nor a topic it already has',
    gammaAfter.sections.every(s => s.topics.length > 0 && !s.topics.includes('Practising the repeated idea')),
    JSON.stringify(gammaAfter.sections.map(s => s.topics)));

// ---- 6. titles in any script ----------------------------------------------------
console.log('\n=== a repeat is judged on letters of any script ===');
let keepNew = null, sizeForPhaseCount = null;
try { ({ keepNew, sizeForPhaseCount } = await import(`${B}courseSize.js`)); } catch { /* the old tree has no such module */ }
const kept = (titles, seen = []) => (keepNew ? keepNew(titles.map(title => ({ title })), new Set(seen), 9).map(t => t.title) : null);
ok('two different Cyrillic titles are both kept', kept(['Ряды Тейлора', 'Радиус сходимости'])?.length === 2);
ok('the same Cyrillic title, cased and punctuated differently, is kept once', kept(['Ряды Тейлора', 'ряды тейлора!'])?.length === 1);
ok('a sign is part of a title: C#, C++ and C are three', kept(['Introduction to C#', 'Introduction to C++', 'Introduction to C'])?.length === 3);
ok('…and Na+ is not Na, nor e^-x e^x', kept(['Na+', 'Na', 'Derivative of e^x', 'Derivative of e^-x'])?.length === 4);
ok('a mark is part of a word: कि and का are two', kept(['कि', 'का'])?.length === 2);
ok('a list whose every title the course already has is kept whole, not emptied',
    kept(['Working with series again', 'Bounding the remainder term'], ['working with series again', 'bounding the remainder term'])?.length === 2);
ok('…but keeps one of each sibling title in it',
    kept(['Working with series again', 'working with series again!', 'Bounding the remainder term'], ['working with series again', 'bounding the remainder term'])?.length === 2);
ok('a specific title the course has is dropped, a fresh one beside it kept',
    JSON.stringify(kept(['Working with series again', 'Something new here'], ['working with series again'])) === '["Something new here"]');
ok('a continued course of 5 phases is standard, of 7 full',
    sizeForPhaseCount?.(4) === 'short' && sizeForPhaseCount?.(5) === 'standard' && sizeForPhaseCount?.(7) === 'full');

// With files: an item the cut leaves out keeps its parts on a kept one.
let keepFiled = null;
try { ({ keepFiled } = await import(`${B}creationStages.js`)); } catch { /* old tree */ }
const fakeSrc = { docs: [{}] };
const all = [{ title: 'a', sections: [1] }, { title: 'b', sections: '2, 3' }, { title: 'c', sections: ['§4'] }];
const folded = keepFiled?.(fakeSrc, all, all.slice(0, 1));
ok('with files, a section cut by the range hands its parts to the last kept one',
    JSON.stringify(folded?.[0]?.sections) === JSON.stringify([1, '2', '3', '§4']), JSON.stringify(folded));
const twin = [{ title: 'Seed depth', sections: [1] }, { title: 'Watering', sections: [2] }, { title: 'seed depth', sections: [3] }];
const toTwin = keepFiled?.(fakeSrc, twin, twin.slice(0, 2));
ok('…and a dropped repeat hands its parts to the kept item of the same title, not the last',
    JSON.stringify(toTwin?.map(t => t.sections)) === JSON.stringify([[1, 3], [2]]), JSON.stringify(toTwin));
ok('…and without files nothing is added', keepFiled?.(null, all.map(x => ({ ...x })), [{ title: 'a', sections: [1] }])?.[0]?.sections.length === 1);

await new Promise(r2 => server.close(r2));
await new Promise(r2 => stub.close(r2));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
