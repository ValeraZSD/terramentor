// tools/verifier-source-gates.mjs — the answer check reads the text the
// question was written from.
//
// Run:  node tools/verifier-source-gates.mjs [--server <dir>]
//
// Every model-written question is answered by a second pass before it is
// served (verifyQuestion, server/feedQuality.js). That pass used to get the
// topic's TITLE and nothing else, while the writer had the topic's whole
// material: its Overview, the learner's text in the notes, the lesson part.
// A question about that material ("which day can the writer of this mail
// come?") cannot be answered from a title, so the verifier called it broken
// and it was deleted. On a topic built around one text, the mastery check
// then had nothing left to ask.
//
// Asserted here, with a stub model on loopback (nothing billed):
//   1. the verify prompt carries a source when one is given, in every mode
//      (closed, open, ordering, assembly, code), keeps the key out of it, caps
//      it, and tells the verifier to answer a question about the text from the
//      text; with no source the prompt is exactly what it was;
//   2. each caller that gave its writer a text hands the verifier that text:
//      the mastery check and practice quiz (vetQuiz), the placement probe and
//      the paper exercise, measured on the prompt the stub received;
//   3. every verifyQuestion call in server/ passes a source (the feed's two
//      calls are reached only through the burst, so they are read in the
//      source).
//
// `--server <dir>` runs the same assertions against another copy of server/
// (the pre-fix code) to prove they fail there.

import { mkdtempSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

const argv = process.argv.slice(2);
const si = argv.indexOf('--server');
const serverDir = si >= 0 ? resolve(argv[si + 1]) : fileURLToPath(new URL('../server/', import.meta.url));
const B = pathToFileURL(serverDir + '/').href;

const scratch = mkdtempSync(join(tmpdir(), 'verifier-source-gates-'));
process.env.DB_PATH = join(scratch, 'test.db');
process.env.VAULT_ROOT = join(scratch, 'vault');
process.env.DATA_DIR = scratch;

// A made-up text with facts no title gives away.
const LETTER = [
    'Dear Ms Larsen,',
    'Last week we agreed to meet on Thursday at two to go over the shop accounts.',
    'I cannot come that day, because the delivery van is booked for the morning and the afternoon.',
    'Tuesday and Wednesday suit me all day; on Friday I am free only before noon.',
    'Kind regards, Tomas Brink',
].join('\n');
const MARK = 'free only before noon';

// ---- the stub model: loopback only, set BEFORE any module can call out ------
const verifyPrompts = [];
const VERIFIER = /checking a question before it is shown|checking an ORDERING question|checking a BUILD-THE-ANSWER question|audit the MODEL ANSWER|audit the REFERENCE SOLUTION/;
const stub = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
        const msgs = (() => { try { return JSON.parse(body).messages || []; } catch { return []; } })();
        const system = msgs.find(m => m.role === 'system')?.content || '';
        const user = msgs.find(m => m.role === 'user')?.content || '';
        let content;
        if (VERIFIER.test(system)) {
            verifyPrompts.push({ system, user });
            content = JSON.stringify({ verdict: 'ok', answer: 'Friday morning', reason: 'the text says so', eliminable: 0 });
        } else if (/diagnostic question/.test(system)) {
            content = JSON.stringify({
                question: 'PROBE: when can the writer meet on Friday?', type: 'multiple_choice',
                options: ['Friday morning', 'Friday afternoon', 'Friday evening', 'Not on Friday'],
                correct_answer: 'Friday morning', explanation: 'He is free only before noon on Friday.',
            });
        } else if (/BY HAND on paper/.test(system)) {
            content = JSON.stringify({
                mode: 'document',
                brief: 'PAPER: write a short reply to the letter that proposes a new day the writer can come.',
                materials: '',
                rubric: [
                    { id: 'r1', point: 'the reply names a day the writer said suits him', weight: 2 },
                    { id: 'r2', point: 'the reply gives a time on that day', weight: 1 },
                    { id: 'r3', point: 'the reply opens with a greeting', weight: 1 },
                    { id: 'r4', point: 'the reply closes with a name', weight: 1 },
                ],
                reference_solution: 'Dear Mr Brink, shall we meet on Tuesday at ten? Kind regards, Ms Larsen',
            });
        } else {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end('{"error":{"message":"stub: not part of this gate"}}');
            return;
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

const { default: db } = await import(B + 'database.js');
const { AI_PROMPTS } = await import(B + 'ai.js');
const { finalizeQuiz, vetQuiz } = await import(B + 'studyMaterial.js');
const { authorProbeQuestion } = await import(B + 'placement.js');
const { generatePaperExercise } = await import(B + 'paper.js');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
    ok ? pass++ : fail++;
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok || !detail ? '' : `  (${detail})`}`);
};
db.prepare("INSERT INTO settings (key, value) VALUES ('ai_enabled', 'true') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
// A learner profile is about the learner, never about an answer: it stays out.
db.prepare("INSERT INTO settings (key, value) VALUES ('user_profile', 'PROFILE-LINE runs a bakery') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();

const pid = db.prepare("INSERT INTO projects (name, status) VALUES ('Business letters', 'archived')").run().lastInsertRowid;
const mkNode = (title) => db.prepare('INSERT INTO nodes (project_id, title, description, notes, position) VALUES (?, ?, ?, ?, 0)')
    .run(pid, title, 'Read a short business letter: who writes, why, and what they ask.', LETTER).lastInsertRowid;

// ---------------------------------------------------------------------------
// 1. the prompt
// ---------------------------------------------------------------------------
console.log('\n--- 1. the verify prompt carries the source ---');
const mc = { type: 'multiple_choice', question: 'When can the writer meet on Friday?', options: ['Friday morning', 'Friday afternoon', 'Friday evening', 'Not on Friday'], correct_answer: 'Friday afternoon', explanation: 'x' };
const shapes = {
    'multiple choice': mc,
    'true/false': { type: 'true_false', question: 'The writer can meet on Thursday.', correct_answer: 'False', explanation: 'x' },
    'open answer': { type: 'short_answer', question: 'Why can the writer not come on Thursday?', correct_answer: 'The van is booked.', explanation: 'x' },
    ordering: { type: 'sequence', question: 'Order the days the writer names, earliest in the week first.', items: ['Friday', 'Tuesday', 'Thursday'], correct_answer: JSON.stringify(['Tuesday', 'Thursday', 'Friday']), explanation: 'x' },
    assembly: { type: 'assemble', question: 'Build the sentence.', template: 'I am free ___ noon.', tokens: ['before', 'after'], correct_answer: JSON.stringify(['before']), explanation: 'x' },
    code: { type: 'code', language: 'python', question: 'Return the days the writer is free all day.', correct_answer: 'def days():\n    return ["Tuesday", "Wednesday"]', explanation: 'x' },
};
for (const [name, q] of Object.entries(shapes)) {
    let withSource = null;
    try { withSource = AI_PROMPTS.feed_question_verify('Business letters', q, { source: LETTER }); } catch { /* reported below */ }
    check(`${name}: the source reaches the verifier`, !!withSource && withSource.user.includes(MARK));
    const bare = AI_PROMPTS.feed_question_verify('Business letters', q);
    const legacy = AI_PROMPTS.feed_question_verify('Business letters', q, {});
    check(`${name}: with no source the prompt is unchanged and names no source`,
        bare.user === legacy.user && bare.system === legacy.system && !/SOURCE TEXT/.test(bare.user + bare.system));
    check(`${name}: told to answer a question about the text from the text, and one about the subject from the subject`,
        !!withSource && /SOURCE TEXT/.test(withSource.system) && /from the text/i.test(withSource.system)
        && /subject itself[^.]*never by the text/i.test(withSource.system) && /may itself contain mistakes/.test(withSource.system));
}
// The key is not an input: a different key, the same prompt. Not for the two
// audit modes (open answer, code), which show the model answer by design.
const otherKey = {
    'multiple choice': { ...mc, correct_answer: 'Friday morning' },
    'true/false': { ...shapes['true/false'], correct_answer: 'True' },
    ordering: { ...shapes.ordering, correct_answer: JSON.stringify(['Friday', 'Thursday', 'Tuesday']) },
    assembly: { ...shapes.assembly, correct_answer: JSON.stringify(['after']) },
};
for (const [name, q] of Object.entries(otherKey)) {
    let a = null, b = null;
    try {
        a = AI_PROMPTS.feed_question_verify('Business letters', shapes[name], { source: LETTER });
        b = AI_PROMPTS.feed_question_verify('Business letters', q, { source: LETTER });
    } catch { /* reported below */ }
    check(`${name}: the key stays hidden with a source beside it (another key, the same prompt)`,
        !!a && !!b && a.user === b.user && a.system === b.system);
}
const closed = (() => { try { return AI_PROMPTS.feed_question_verify('Business letters', mc, { source: LETTER }); } catch { return null; } })();
check('"eliminable" counts what a learner throws away without reading the text', !!closed && /without (having )?read(ing)? the (source )?text/i.test(closed.system));
const huge = (() => { try { return AI_PROMPTS.feed_question_verify('Business letters', mc, { source: 'word '.repeat(10000) + 'TAIL-MARK' }); } catch { return null; } })();
check('a long source is capped, not sent whole', !!huge && huge.user.length < 20000 && !huge.user.includes('TAIL-MARK'), String(huge?.user.length));
check('...and a question the cut text does not settle is judged by the subject, not called broken for that',
    !!huge && /cut short/.test(huge.user) && /cut short[^.]*judge it by the subject/i.test(huge.system));

// ---------------------------------------------------------------------------
// 2. the callers
// ---------------------------------------------------------------------------
console.log('\n--- 2. each caller hands the verifier the text its writer had ---');
const lastFor = (re) => verifyPrompts.filter(p => re.test(p.user)).at(-1);

const quizNode = mkNode('A letter that moves a meeting');
const raw = JSON.stringify([{ ...mc, question: 'QUIZ: when can the writer meet on Friday?', correct_answer: 'Friday morning', explanation: 'Only before noon.' }]);
try { await vetQuiz(quizNode, finalizeQuiz(quizNode, raw, false)); } catch (err) { console.log(`  (vetQuiz threw: ${err.message})`); }
const quizPrompt = lastFor(/QUIZ: when can/);
check('mastery check / practice quiz (vetQuiz): the verifier sees the notes', !!quizPrompt && quizPrompt.user.includes(MARK));
check('...and the Overview', !!quizPrompt && quizPrompt.user.includes('who writes, why, and what they ask'));
check('...but not the learner profile', !!quizPrompt && !quizPrompt.user.includes('PROFILE-LINE'));

const probeNode = mkNode('Letters: probe');
try { await authorProbeQuestion({ node_id: probeNode, title: 'Letters: probe', phase_title: 'Reading' }); } catch (err) { console.log(`  (probe threw: ${err.message})`); }
const probePrompt = lastFor(/PROBE: when can/);
check('placement probe: the verifier sees the topic text', !!probePrompt && probePrompt.user.includes(MARK));

const paperNode = mkNode('Letters: paper');
try { await generatePaperExercise(paperNode, 'Letters: paper'); } catch (err) { console.log(`  (paper threw: ${err.message})`); }
const paperPrompt = lastFor(/PAPER: write a short reply/);
check('paper exercise: the auditor sees the topic text', !!paperPrompt && paperPrompt.user.includes(MARK));

// ---------------------------------------------------------------------------
// 3. no call site forgets
// ---------------------------------------------------------------------------
console.log('\n--- 3. every verifyQuestion call in server/ passes a source ---');
const files = [];
const walk = (dir, prefix = '') => {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
            if (!['vault', 'logs', 'browser-profile', 'node_modules'].includes(name)) walk(p, `${prefix}${name}/`);
        } else if (name.endsWith('.js')) files.push([`${prefix}${name}`, p]);
    }
};
walk(serverDir);
// The offline re-check of stored banks reads the same verifier.
files.push(['../tools/quiz-audit.mjs', fileURLToPath(new URL('./quiz-audit.mjs', import.meta.url))]);
/** A call's whole argument list, found by counting parentheses, so a call with no options object is seen too. */
const argsAt = (text, open) => {
    let depth = 0;
    for (let i = open; i < text.length; i++) {
        if (text[i] === '(') depth++;
        else if (text[i] === ')' && --depth === 0) return text.slice(open + 1, i);
    }
    return '';
};
let calls = 0;
for (const [rel, p] of files) {
    const text = readFileSync(p, 'utf8');
    for (const m of text.matchAll(/(?<!function )\bverifyQuestion\(/g)) {
        const args = argsAt(text, m.index + m[0].length - 1);
        calls++;
        const line = text.slice(0, m.index).split('\n').length;
        check(`${rel}:${line} passes a source`, /\{[^{}]*\bsource\b[^{}]*\}\s*$/.test(args), `verifyQuestion(${args.slice(0, 100)})`);
    }
}
// Eight in server/ (vetQuiz 2, feed 3, paper 1, placement 2) and three in the
// audit tool: a caller that vanished from the scan is a caller nobody checks.
check('the scan found every caller (8 in server/, 3 in quiz-audit)', calls >= 11, String(calls));

stub.close();
db.close?.();
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* Windows holds the WAL a moment */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
