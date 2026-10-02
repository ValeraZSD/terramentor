// tools/content-check-gates.mjs — every model-written answer key and every
// lesson is read by a second pass before a learner meets it.
//
// Run:  node tools/content-check-gates.mjs
//
// WHY. On 2026-10-01 a Frisian alphabet lesson asked, in its drill, for "the
// letter after P" with R as the key. The learner answered Q and was told they
// were wrong. Nothing had read the drill: the lesson pipeline checked plots,
// charts, animations and diagrams against the prose, and the drill is none of
// those. The same lesson carried a sentence that retracts itself halfway
// ("вроде sûker… нет — точнее, …"), and nothing had read that either, because
// the lesson auditor ran only on parts that do arithmetic. Generated
// flashcards and paper-exercise reference solutions were in the same state.
//
// What this holds, each half against the shape that shipped:
//   1. drillCheck.js reads a fence exactly as the client player does (built
//      from src/components/drills/parseDrill.ts and compared item for item),
//      and takes items out without breaking what the player can read;
//   2. the CONTROL: the pre-fix pipeline's only lesson check leaves the wrong
//      key in place and never asks a model about it;
//   3. a new lesson: its drill's wrong item is removed, its retraction sends
//      the draft back, and a prose-only part is audited at all;
//   4. a STORED lesson (written before today) is re-checked: an unread one
//      with a false statement is sent back to be rewritten, a read one keeps
//      its text but loses the wrong drill item, and a checker that cannot
//      answer leaves the row waiting instead of retried every burst;
//   5. generated flashcards: a card whose back the verifier does not
//      reproduce is not saved; an unreachable verifier saves them all;
//   6. a paper exercise whose reference solution fails the audit is not kept.
//
// Scratch library, a stub model on loopback through the app's own
// AI_BASE_URL override; nothing reaches a real model or the real library.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

const scratch = mkdtempSync(join(tmpdir(), 'content-check-gates-'));
process.env.DB_PATH = join(scratch, 'test.db');
process.env.VAULT_ROOT = join(scratch, 'vault');

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
    if (ok) { pass++; console.log(`  ok    ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = (name) => console.log(`\n${name}`);

// The client's parser, built as the drill gate builds it.
const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const clientOut = join(scratch, 'parseDrill.mjs');
await esbuild.build({
    entryPoints: [fileURLToPath(new URL('../src/components/drills/parseDrill.ts', import.meta.url))],
    bundle: true, format: 'esm', platform: 'node', outfile: clientOut, logLevel: 'silent',
});
const { parseDrillSpec } = await import(pathToFileURL(clientOut).href);

const B = new URL('../server/', import.meta.url).href;
const { findDrills, parseDrillBody, drillDefects, answerPool, rewriteDrill, replaceDrill, MIN_DRILL_ITEMS } = await import(B + 'drillCheck.js');

// ---------------------------------------------------------------------------
// The fixture: the drill from the screenshot. Twelve "letter after X" items,
// one of them keyed wrong (after P comes Q, not R).
// ---------------------------------------------------------------------------
const LATIN = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const FROM = ['A', 'C', 'E', 'G', 'I', 'K', 'M', 'N', 'O', 'P', 'S', 'W'];
const FRISIAN_ITEMS = FROM.map(x => ({ prompt: `Буква после ${x}`, answer: x === 'P' ? 'R' : LATIN[LATIN.indexOf(x) + 1] }));
const fence = (items, extra = {}) => '```drill\n' + JSON.stringify({ title: '26 букв фризского алфавита', prompt_label: 'Какая это буква?', modes: ['choice', 'type'], items, ...extra }) + '\n```';
const FRISIAN_DRILL = fence(FRISIAN_ITEMS);
const RETRACTION = 'Буква остаётся в алфавите для недавних заимствований вроде sûker… нет — точнее, для слов типа sûs нет, z живёт в заимствованиях вроде zip.';
const PROSE = 'Фризский язык записывается латинским алфавитом из 26 букв. Ядро алфавита — это гласные a, e, i, o, u и согласные, на которых держится повседневная лексика: в простой фразе «Ik bin in man» нет ни одной редкой буквы. Буквы q, x и c встречаются в основном в заимствованиях и именах собственных, поэтому, встретив их в тексте, вы почти всегда смотрите на чужое слово.';

section('1. drillCheck.js reads a fence exactly as the player does');
{
    const lesson = `${PROSE}\n\n${FRISIAN_DRILL}\n\nText.\n\n\`\`\`practice\n{"items":[{"q":"1","a":"one"},{"q":"2","a":"two"}]}\n\`\`\`\n\n\`\`\`json\n{"items":[{"prompt":"x","answer":"y"}]}\n\`\`\``;
    const found = findDrills(lesson);
    check('every drill fence language is found, a json fence is not', found.length === 2 && found[0].lang === 'drill' && found[1].lang === 'practice', JSON.stringify(found.map(f => f.lang)));

    const shapes = [
        FRISIAN_DRILL.split('\n')[1],
        '{"cards":[{"front":"H","back":"hydrogen"},{"front":"He","back":"helium","distractors":["hydrogen","neon","helium"]},{"front":"","back":"x"}]}',
        "{items:[{term:'perro',definition:'dog'},{term:'gato',definition:'cat',},],}",
        '{"pairs":[{"left":"1066","right":"Hastings","wrong":["Agincourt"]},{"cue":"1815","response":"Waterloo"}]}',
    ];
    for (const body of shapes) {
        const server = parseDrillBody(body);
        const client = (await parseDrillSpec(body)).spec;
        const same = !!server && !!client && server.items.length === client.items.length
            && server.items.every((it, i) => it.prompt === client.items[i].prompt && it.answer === client.items[i].answer
                && JSON.stringify(it.distractors) === JSON.stringify(client.items[i].distractors || []));
        check(`server and client read the same items: ${body.slice(0, 40)}…`, same,
            JSON.stringify({ server: server?.items.map(i => [i.prompt, i.answer]), client: client?.items.map(i => [i.prompt, i.answer]) }));
    }

    const dupes = drillDefects([
        { prompt: 'Peru', answer: 'Lima' }, { prompt: 'peru ', answer: 'Cusco' }, { prompt: 'Chile', answer: 'Santiago' }, { prompt: 'Chile', answer: 'Santiago' },
    ]);
    check('one prompt with two answers is a defect on both items; an identical repeat is not', JSON.stringify(dupes.map(d => d.i)) === '[0,1]', JSON.stringify(dupes));
    // The shipped "short → long pair" drill: `maan → maan` beside `man → maan`.
    const selfAnswered = drillDefects([{ prompt: 'man', answer: 'maan' }, { prompt: 'maan', answer: 'maan' }, { prompt: 'zon', answer: 'zoon' }]);
    check('an item whose answer is its own prompt is a defect', JSON.stringify(selfAnswered.map(d => d.i)) === '[1]', JSON.stringify(selfAnswered));

    // An alphabet drill's answers SORTED stand in exactly its prompts' order
    // (B, D, F … beside after-A, after-C, after-E …), so a sorted pool lets a
    // verifier pair by position and agree with every key, the wrong one too.
    const fixedPoints = (items, pool) => items.filter((it, i) => pool[i] === it.answer).length;
    const pool = answerPool(FRISIAN_ITEMS);
    check('the pool holds every answer exactly once', pool.length === 12 && new Set(pool).size === 12 && FRISIAN_ITEMS.every(i => pool.includes(i.answer)), pool.join(','));
    check('CONTROL: a sorted pool would line up with every prompt', fixedPoints(FRISIAN_ITEMS, [...pool].sort()) === 12);
    check('no value in the pool stands beside its own prompt', fixedPoints(FRISIAN_ITEMS, pool) === 0, pool.join(','));
    let worst = 0;
    for (let n = 2; n <= 30; n++) {
        const items = Array.from({ length: n }, (_, i) => ({ prompt: `p${i}`, answer: `a${String(i).padStart(2, '0')}` }));
        worst = Math.max(worst, fixedPoints(items, answerPool(items)));
    }
    check('…for sorted banks of every size from 2 to 30 as well', worst === 0, `worst ${worst}`);

    const drill = findDrills(FRISIAN_DRILL)[0];
    const parsed = parseDrillBody(drill.body);
    const pAt = parsed.items.findIndex(i => i.prompt === 'Буква после P');
    const one = rewriteDrill(drill, parsed, [pAt]);
    const replayed = (await parseDrillSpec(findDrills(one)[0].body)).spec;
    check('one disputed item of twelve: the player reads eleven, and not that one',
        replayed?.items.length === 11 && !replayed.items.some(i => i.prompt === 'Буква после P'), JSON.stringify(replayed?.items.length));
    check('the rewrite keeps the drill\'s title and label', replayed?.title === '26 букв фризского алфавита' && replayed?.promptLabel === 'Какая это буква?');
    check('nothing disputed: the fence comes back byte for byte', rewriteDrill(drill, parsed, []) === drill.block);
    check('five of twelve disputed (over a third): the whole drill goes', rewriteDrill(drill, parsed, [0, 1, 2, 3, 4]) === null);
    const small = findDrills(fence(FRISIAN_ITEMS.slice(0, 5)))[0];
    check(`fewer than ${MIN_DRILL_ITEMS} left: the whole drill goes`, rewriteDrill(small, parseDrillBody(small.body), [0, 1]) === null);
    const removedAll = replaceDrill(`${PROSE}\n\n${FRISIAN_DRILL}\n\nДалее.`, FRISIAN_DRILL, null);
    check('a removed drill leaves no fence and no run of blank lines', !removedAll.includes('```') && !/\n{3,}/.test(removedAll));
}

// ---------------------------------------------------------------------------
// The stub model. Each checker is told apart by its system prompt.
// ---------------------------------------------------------------------------
const seen = [];
let drillCheckerUp = true;
// 'truth' answers correctly; 'agreeFirst' agrees with every key on the first
// call and answers correctly after (one pass of two misses, as GLM did);
// 'echo' repeats each prompt back.
let drillMode = 'truth';
let drillCalls = 0;
// When set, call k of the drill checker answers scripted[k] (one string per prompt).
let scripted = null;
const arbiterCalls = [];
let writerDrafts = [];
let paperAudit = 'broken';
let auditorUp = true;
const nextLetter = (x) => LATIN[LATIN.indexOf(x.toUpperCase()) + 1] || 'AMBIGUOUS';
const CARD_TRUTH = { 'H': 'hydrogen', 'He': 'helium', 'Li': 'lithium', 'Be': 'beryllium' };
const stub = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
        const msgs = (() => { try { return JSON.parse(body).messages || []; } catch { return []; } })();
        const system = msgs.find(m => m.role === 'system')?.content || '';
        const user = msgs.find(m => m.role === 'user')?.content || '';
        seen.push({ system, user });
        let content = null;
        if (system.includes('curriculum designer')) {
            content = JSON.stringify({ parts: [{ title: 'Состав алфавита', focus: 'Буквы фризского алфавита.' }, { title: 'Буквосочетания', focus: 'Сочетания букв.' }] });
        } else if (system.includes('writing ONE segment')) {
            content = writerDrafts.shift() ?? `${PROSE}\n\n${FRISIAN_DRILL}`;
        } else if (system.includes('checking a practice drill')) {
            if (drillCheckerUp) {
                drillCalls++;
                const prompts = [...user.split('PROMPTS:\n')[1].split('\n\nPOOL')[0].matchAll(/^(\d+)\. (.*)$/gm)];
                const answers = prompts.map(([, n, p]) => {
                    if (scripted) return { n: Number(n), answer: scripted[drillCalls - 1][Number(n) - 1] };
                    const letter = /после (\S)/.exec(p);
                    if (drillMode === 'echo') return { n: Number(n), answer: p };
                    if (drillMode === 'agreeFirst' && drillCalls === 1 && letter) return { n: Number(n), answer: letter[1] === 'P' ? 'R' : nextLetter(letter[1]) };
                    return { n: Number(n), answer: letter ? nextLetter(letter[1]) : (CARD_TRUTH[p] ?? 'AMBIGUOUS') };
                });
                content = JSON.stringify({ answers });
            }
        } else if (system.includes('settling disagreements')) {
            arbiterCalls.push(user);
            // The truth where the stub knows it; otherwise the two are the same
            // answer written differently (the notation case).
            const truthOf = (p) => { const l = /после (\S)/.exec(p); return l ? nextLetter(l[1]) : CARD_TRUTH[p] ?? null; };
            const rows = [...user.matchAll(/^(\d+)\. (.*)\n {3}A: (.*)\n {3}B: (.*)$/gm)];
            content = JSON.stringify({ verdicts: rows.map(([, n, p, a, b]) => {
                const t = truthOf(p);
                return { n: Number(n), correct: t == null ? 'both' : a === t ? 'A' : b === t ? 'B' : 'neither' };
            }) });
        } else if (system.includes('checking ONE segment of a lesson') && auditorUp) {
            content = JSON.stringify(user.includes('нет — точнее')
                ? { verdict: 'broken', quote: 'вроде sûker… нет — точнее', reason: 'the sentence retracts itself halfway' }
                : { verdict: 'ok', quote: '', reason: '' });
        } else if (system.includes('You set ONE exercise')) {
            content = JSON.stringify({
                mode: 'document', brief: 'Write the Frisian alphabet in order and mark the letters used mostly in loanwords.',
                materials: 'pen', reference_solution: 'A B C D E F G H I J K L M N O P R S T U V W X Y Z — q, x and c are loanword letters.',
                rubric: [1, 2, 3, 4].map(i => ({ id: `r${i}`, point: `Point ${i}`, weight: 1 })),
            });
        } else if (system.includes('You audit the MODEL ANSWER')) {
            content = JSON.stringify({ verdict: paperAudit, answer: '', reason: paperAudit === 'broken' ? 'the alphabet skips Q' : '' });
        }
        if (content == null) { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":{"message":"stub: not part of this gate"}}'); return; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { completion_tokens: 50 } }));
    });
});
await new Promise(r => stub.listen(0, '127.0.0.1', r));
process.env.AI_PROVIDER = 'openai';
process.env.AI_BASE_URL = `http://127.0.0.1:${stub.address().port}/v1`;
process.env.AI_MODEL = 'stub-model';
process.env.AI_API_KEY = 'stub-key';

const { default: db } = await import(B + 'database.js');
if (!String(db.name).startsWith(scratch)) { console.error(`refusing to run: the database is ${db.name}, not the scratch library`); process.exit(2); }
db.prepare(`INSERT INTO settings (key, value) VALUES ('ai_enabled', 'true') ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run();
const { vetLessonVisuals, vetLessonDrills, ITEM_CHECK_PASSES } = await import(B + 'feedQuality.js');
const { generateForNode, pendingLessonCheck, recheckStoredLessons } = await import(B + 'feedGen.js');
const { finalizeFlashcards } = await import(B + 'studyMaterial.js');
const { generatePaperExercise } = await import(B + 'paper.js');

const project = Number(db.prepare(`INSERT INTO projects (name, content_language) VALUES ('фризский язык', 'ru')`).run().lastInsertRowid);
const mkNode = (title) => Number(db.prepare('INSERT INTO nodes (project_id, title, description) VALUES (?, ?, ?)').run(project, title, 'Фризский алфавит и его буквы.').lastInsertRowid);
const lessons = (nodeId) => db.prepare(`SELECT id, seq, status, content, meta FROM feed_items WHERE node_id = ? AND kind = 'lesson' ORDER BY seq`).all(nodeId);
const runToPartOne = async (nodeId) => {
    const ac = new AbortController();
    try {
        await generateForNode(nodeId, { signal: ac.signal, onStep: (l) => { if (l !== 'outline' && l !== 'lesson 1') ac.abort(); } });
    } catch { /* the abort, by design */ }
};

section('2. CONTROL — the pre-fix lesson check never reads a drill');
{
    seen.length = 0;
    const before = await vetLessonVisuals(`${PROSE}\n\n${FRISIAN_DRILL}`, 'Состав алфавита');
    check('the visual check leaves the wrong key in the lesson', before.markdown.includes('"answer":"R"') && before.removed.length === 0);
    check('…and asks no model about it', seen.length === 0, `${seen.length} calls`);
}

section('3. a NEW lesson goes through the fact audit and the drill check');
{
    const node = mkNode('Состав фризского алфавита');
    writerDrafts = [`${PROSE} ${RETRACTION}\n\n${FRISIAN_DRILL}`, `${PROSE}\n\n${FRISIAN_DRILL}`];
    seen.length = 0;
    await runToPartOne(node);
    const [row] = lessons(node);
    const meta = JSON.parse(row?.meta || '{}');
    const writes = seen.filter(s => s.system.includes('writing ONE segment'));
    check('the draft that retracts itself was sent back and rewritten', writes.length === 2 && /нет — точнее/.test(writes[1].user + writes[1].system) && !row.content.includes('нет — точнее'),
        `${writes.length} writes`);
    const audits = seen.filter(s => s.system.includes('checking ONE segment of a lesson'));
    check('a prose part with no arithmetic is audited (it was not, before)', audits.length === 2);
    check('…and the auditor is not handed the arithmetic rule for it', audits.every(a => !/Recompute every calculation/.test(a.system) && /claim the segment makes about the SUBJECT/.test(a.system)));
    const served = (await parseDrillSpec(findDrills(row.content)[0]?.body || '')).spec;
    check('the drill is served without "after P → R" and keeps the other eleven', served?.items.length === 11 && !served.items.some(i => i.answer === 'R' && i.prompt.endsWith('P')),
        JSON.stringify(served?.items.map(i => `${i.prompt}=${i.answer}`)));
    check('the drill check never saw which answer belongs to which prompt', seen.filter(s => s.system.includes('checking a practice drill')).every(s => !/Буква после P.*R/.test(s.user)));
    check('the row records what was removed and that both checks ran', meta.drillItemsRemoved?.length === 1 && meta.drillItemsRemoved[0].key === 'R' && meta.factChecked === true && meta.drillsChecked === true && meta.audited === true,
        JSON.stringify(meta));
}

section('3a. two passes, and an echo is not a verdict');
{
    drillMode = 'agreeFirst';
    drillCalls = 0;
    const flaky = await vetLessonDrills(`${PROSE}\n\n${FRISIAN_DRILL}`, 'Состав фризского алфавита');
    check(`a key one of ${ITEM_CHECK_PASSES} passes agreed with is still removed`, drillCalls === ITEM_CHECK_PASSES && flaky.removed.some(r => r.key === 'R'),
        JSON.stringify({ drillCalls, removed: flaky.removed }));
    drillMode = 'echo';
    const echoed = await vetLessonDrills(`${PROSE}\n\n${FRISIAN_DRILL}`, 'Состав фризского алфавита');
    check('a checker that only repeats each prompt removes nothing…', echoed.removed.length === 0 && echoed.markdown.includes('"answer":"R"'), JSON.stringify(echoed.removed));
    check('…and is not reported as an outage to retry every day', echoed.unchecked.length === 0, JSON.stringify(echoed.unchecked));
    drillMode = 'truth';

    // The second pass is FREE: no pool, because a pool without the right
    // value pulled GLM to the wrong key in half its runs.
    seen.length = 0;
    await vetLessonDrills(`${PROSE}\n\n${FRISIAN_DRILL}`, 'Состав фризского алфавита');
    const asks = seen.filter(s => s.system.includes('checking a practice drill'));
    check('the first pass is shown the pool and the second is not', asks.length === 2 && asks[0].user.includes('POOL') && !asks[1].user.includes('POOL'));

    // A mixed-direction drill (shape → kana beside kana → romaji): answering a
    // key's partner in the same drill is a direction mix-up, not a dispute.
    const KANA = fence([
        { prompt: 'Short marks on the left, long stroke along the bottom', answer: 'シ' },
        { prompt: 'Three wave crests, short marks on top', answer: 'ツ' },
        { prompt: 'シ', answer: 'shi' }, { prompt: 'ツ', answer: 'tsu' }, { prompt: 'ソ', answer: 'so' },
    ], { title: 'Katakana Twins', prompt_label: 'Which katakana is this?' });
    drillCalls = 0;
    arbiterCalls.length = 0;
    scripted = [['shi', 'tsu', 'シ', 'ツ', 'ソ'], ['shi', 'tsu', 'shi', 'tsu', 'so']];
    const mixed = await vetLessonDrills(KANA, 'Katakana');
    scripted = null;
    check('answering a key\'s partner (shi for シ) or the prompt itself removes nothing', mixed.removed.length === 0, JSON.stringify(mixed.removed));
    check('…and is not even a disagreement to settle', arbiterCalls.length === 0, `${arbiterCalls.length} second looks`);

    // A free answer is compared with a SHORT key only: a definition reworded
    // is not a wrong definition.
    const LONG = fence([
        { prompt: 'Osmosis', answer: 'The movement of water across a semi-permeable membrane toward the higher solute concentration' },
        { prompt: 'Diffusion', answer: 'The spreading of particles from a region of higher to lower concentration' },
        { prompt: 'Mitosis', answer: 'Cell division that produces two genetically identical daughter cells' },
        { prompt: 'Meiosis', answer: 'Cell division that halves the chromosome number to make gametes' },
        { prompt: '47,500 in scientific notation', answer: '4.75 x 10^4' },
        { prompt: '0.0027 in scientific notation', answer: '2.7 x 10^-3' },
        { prompt: 'He', answer: 'hydrogen' },
    ], { title: 'Science terms' });
    const longParsed = parseDrillBody(findDrills(LONG)[0].body);
    drillCalls = 0;
    arbiterCalls.length = 0;
    // Pass 1 (pool) agrees with every key, the wrong one included; pass 2
    // (free) rewords the long keys, writes × for x, and names helium.
    scripted = [longParsed.items.map(i => i.answer), ['water moving through a membrane', 'particles spreading out', 'cell division into two', 'division making gametes', '4.75 × 10^4', '2.7 × 10^-3', 'helium']];
    const long = await vetLessonDrills(LONG, 'Science');
    scripted = null;
    check('a reworded free answer is not even put to a second look against a long key', arbiterCalls.length === 1 && !/membrane|gametes/.test(arbiterCalls[0]), arbiterCalls[0]);
    check('the same value in other notation survives the second look; the wrong key does not',
        long.removed.length === 1 && long.removed[0].key === 'hydrogen' && long.markdown.includes('4.75 x 10^4'), JSON.stringify(long.removed));
    check('the second look is never told which answer is the key', !/\bkey\b|correct answer is|stored/i.test(arbiterCalls[0] || ''));
    check('…and the key is not always in the same place (A, then B)',
        /A: 4\.75 x 10\^4\n {3}B: 4\.75 × 10\^4/.test(arbiterCalls[0] || '') && /A: 2\.7 × 10\^-3\n {3}B: 2\.7 x 10\^-3/.test(arbiterCalls[0] || ''), arbiterCalls[0]);
}

section('3b. a lesson the auditor could not read is not stamped as read');
{
    const node = mkNode('Гласные фризского языка');
    auditorUp = false;
    writerDrafts = [`${PROSE}\n\n${FRISIAN_DRILL}`];
    await runToPartOne(node);
    auditorUp = true;
    const [row] = lessons(node);
    const meta = JSON.parse(row?.meta || '{}');
    check('no `factChecked`, no `audited`, and the reason is on the row', !!row && !meta.factChecked && !meta.audited && /auditor unavailable/.test(meta.unaudited || ''), JSON.stringify(meta));
    check('…so the background re-check reaches it', pendingLessonCheck(node)?.facts === true);
}

section('4. a STORED lesson, written before these checks, is re-checked');
{
    const node = mkNode('Буквы фризского алфавита');
    db.prepare(`INSERT INTO feed_items (node_id, kind, seq, content, meta, status) VALUES (?, 'plan', 0, ?, '{}', 'ready')`)
        .run(node, JSON.stringify({ parts: [{ title: 'Состав алфавита' }, { title: 'Буквосочетания' }] }));
    const insert = (seq, content, status, meta = { partIndex: (seq + 1) / 2, audited: true }) => Number(db.prepare(
        `INSERT INTO feed_items (node_id, kind, seq, content, meta, status) VALUES (?, 'lesson', ?, ?, ?, ?)`,
    ).run(node, seq, content, JSON.stringify(meta), status).lastInsertRowid);
    const readId = insert(1, `${PROSE} ${RETRACTION}\n\n${FRISIAN_DRILL}`, 'consumed');
    insert(3, `${PROSE} ${RETRACTION}\n\n${FRISIAN_DRILL}`, 'ready');
    db.prepare(`INSERT INTO feed_items (node_id, kind, seq, content, meta, status) VALUES (?, 'question', 4, '{}', '{}', 'ready')`).run(node);

    const first = pendingLessonCheck(node);
    check('a read lesson with an unchecked drill is due — its drill is replayed from the card', first?.row.id === readId && first.drills === true && first.facts === false, JSON.stringify(first && { id: first.row.id, d: first.drills, f: first.facts }));

    drillCheckerUp = false;
    seen.length = 0;
    await recheckStoredLessons(node);
    const waiting = JSON.parse(lessons(node)[0].meta);
    check('a drill checker that cannot answer leaves the row waiting, text untouched', !!waiting.recheckNext && waiting.recheckTries === 1 && lessons(node)[0].content.includes('"answer":"R"'), JSON.stringify(waiting));
    check('…and it is not due again until its wait is over', pendingLessonCheck(node, { now: Date.now() })?.row.id !== readId
        && pendingLessonCheck(node, { now: Date.parse(waiting.recheckNext) + 1 })?.row.id === readId);

    drillCheckerUp = true;
    db.prepare(`UPDATE feed_items SET meta = ? WHERE id = ?`).run(JSON.stringify({ partIndex: 1, audited: true }), readId);
    seen.length = 0;
    await recheckStoredLessons(node);
    const after = lessons(node);
    const read = after.find(r => r.id === readId);
    check('the READ lesson keeps its text (a part already read is not rewritten)…', read?.content.includes('нет — точнее'));
    check('…but loses the wrong drill item, in place', read && !read.content.includes('"answer":"R"') && (JSON.parse(read.meta).drillsChecked === true));
    check('the UNREAD lesson with a false statement is gone, with its unread question, to be written again',
        !after.some(r => r.seq === 3) && !db.prepare(`SELECT 1 FROM feed_items WHERE node_id = ? AND kind = 'question' AND seq = 4`).get(node));
    check('nothing is left due on the topic', pendingLessonCheck(node) === null);
}

section('5. generated flashcards are checked before they are saved');
{
    const node = mkNode('Химические элементы');
    const raw = JSON.stringify([
        { front: 'H', back: 'hydrogen' }, { front: 'He', back: 'helium' }, { front: 'Li', back: 'beryllium' }, { front: 'Be', back: 'lithium' },
        // The stub knows no single answer for this one and says AMBIGUOUS.
        { front: 'A noble gas', back: 'helium' },
    ]);
    const out = await finalizeFlashcards(node, raw);
    const fronts = db.prepare('SELECT front, back FROM flashcards WHERE node_id = ? ORDER BY id').all(node).map(r => `${r.front}=${r.back}`);
    check('the two cards with swapped backs are not saved; the two right ones are', out.count === 2 && out.rejected === 3 && fronts.join() === 'H=hydrogen,He=helium', JSON.stringify({ out, fronts }));
    check('a card the verifier calls AMBIGUOUS is not saved either', !fronts.some(f => f.startsWith('A noble gas')));

    drillCheckerUp = false;
    const node2 = mkNode('Химические элементы 2');
    const out2 = await finalizeFlashcards(node2, raw);
    check('a verifier that cannot answer is not evidence against a card: all five saved', out2.count === 5 && out2.rejected === 0, JSON.stringify(out2));
    drillCheckerUp = true;
}

section('6. a paper exercise is kept only if its reference solution passes the audit');
{
    const node = mkNode('Алфавит на бумаге');
    paperAudit = 'broken';
    check('a disputed reference solution: no exercise', (await generatePaperExercise(node, 'Алфавит на бумаге')) === null);
    paperAudit = 'ok';
    check('a confirmed one: the exercise is kept', !!(await generatePaperExercise(node, 'Алфавит на бумаге'))?.reference_solution);
}

stub.close();
db.close();
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* Windows may still hold the WAL */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
