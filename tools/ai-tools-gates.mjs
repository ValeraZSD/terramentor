#!/usr/bin/env node
/**
 * tools/ai-tools-gates.mjs — the lookups a chat turn may run before it answers.
 *
 * Run:  node tools/ai-tools-gates.mjs
 *
 * The model now decides whether a question needs looking up, and writes the
 * query itself (server/aiTools.js). Three things about that are worth a gate,
 * and they are the three that would fail silently:
 *
 *   1. THE PARSER IS THE WHOLE SAFETY BOUNDARY. There is no schema and no
 *      constrained decoding here — a tool call is a line of text a model wrote.
 *      A tool this turn was not given, a name it invented, an empty argument or
 *      an essay instead of a list must all produce NOTHING, the same contract
 *      an invented node id has. The forgiving half matters as much: a small
 *      model writes `- search_web: …` and `1. search_web("…")` as often as the
 *      bare form, and dropping those is a lookup silently not run.
 *   2. THE GATE ON THE WEB IS A PROMISE IN SECURITY.md. `off` must mean no
 *      socket for any input, `ask` must mean the switch decides and default to
 *      closed, and an unreadable setting must fail closed rather than open. The
 *      old checkbox's `true` must keep meaning `ask` — an install that ticked
 *      it never agreed to the looser reading.
 *   3. AN ANSWER MUST SAY WHAT LEFT THE MACHINE. Every lookup is a row in the
 *      conversation — announced before it runs, filled in when it lands, stored
 *      with the message — so the record survives the reload that a status line
 *      does not. Nothing may be left mid-flight in it, and a paste still carries
 *      the web queries (and only the web queries: a library search opened no
 *      socket).
 *
 * Deterministic: a scratch database, no model, no network.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

const scratch = mkdtempSync(join(tmpdir(), 'ai-tools-gates-'));
// In-process, before any import reaches database.js: a shell `DB_PATH=` prefix
// has silently failed to apply here before, and a write-capable harness then
// found the real library.
process.env.DB_PATH = join(scratch, 'gate.db');
process.env.VAULT_ROOT = join(scratch, 'vault');

// A stub OpenAI-compatible endpoint standing in for the decision pass. The loop
// asks a model what to look up, so nothing after that question can be asserted
// without an endpoint answering it — and the answer has to come from the real
// code path (`generateResponse`), not from a hand-made call list, or the parser
// and the caps are being tested against themselves.
let replies = [];
const server = createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
        const content = replies.shift() ?? 'NONE';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
// Unreffed rather than closed at the end: closing it in the same tick as the
// database handle and process.exit trips a libuv assertion on Windows, and an
// unreffed listener never holds the process open in the first place.
server.unref();
process.env.AI_PROVIDER = 'openai';
process.env.AI_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
process.env.AI_MODEL = 'stub-model';

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const section = (name) => console.log(`\n${name}`);

const db = (await import('../server/database.js')).default;
const { chatTools, parseToolCalls, runToolRounds, webQueries } = await import('../server/aiTools.js');
const { webSearchMode, webAllowedForTurn } = await import('../server/webContext.js');
const { resolveCitations, formatSourceContext } = await import('../server/citations.js');
const { AI_PROMPTS } = await import('../server/ai.js');

const setSetting = (key, value) =>
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(key, value);

// ---- 1. the parser ---------------------------------------------------------

const BOTH = chatTools({ web: true, library: true });
const names = BOTH.map(t => t.name);

section('the tools a turn is given');
check('web off and library off is no tools at all', chatTools().length === 0);
check('the tutor gets the web alone', chatTools({ web: true }).map(t => t.name).join() === 'search_web');
check('the assistant also gets its own library', names.includes('find_in_library'));
check('every tool describes itself for the prompt',
    BOTH.every(t => t.name && t.arg && t.why && typeof t.note === 'function' && typeof t.run === 'function'));
check('every tool says out loud what it is doing',
    BOTH.every(t => t.note('kinematics').includes('kinematics')));

section('a line the model wrote becomes a call, or nothing');
const one = parseToolCalls('search_web: dutch priority road signs 2026', BOTH);
check('the plain form parses', one.length === 1 && one[0].tool === 'search_web'
    && one[0].arg === 'dutch priority road signs 2026', JSON.stringify(one));
check('a bulleted line parses', parseToolCalls('- search_web: ohm law', BOTH).length === 1);
check('a numbered line parses', parseToolCalls('1. search_web: ohm law', BOTH).length === 1);
check('a function-call shape parses',
    parseToolCalls('search_web("ohm law")', BOTH)[0]?.arg === 'ohm law');
check('quotes around the argument are not searched for',
    parseToolCalls('search_web: “ohm law”', BOTH)[0]?.arg === 'ohm law');
check('a trailing full stop is not searched for',
    parseToolCalls('search_web: ohm law.', BOTH)[0]?.arg === 'ohm law');
check('NONE is no calls', parseToolCalls('NONE', BOTH).length === 0);
check('none, lower case and with prose after it, is still no calls',
    parseToolCalls('none — this is general knowledge', BOTH).length === 0);
check('a tool that does not exist is dropped',
    parseToolCalls('delete_project: 3\nsearch_web: ohm law', BOTH).length === 1);
check('a tool this turn was NOT given is dropped',
    parseToolCalls('find_in_library: physics', chatTools({ web: true })).length === 0);
check('an empty argument is dropped', parseToolCalls('search_web:', BOTH).length === 0);
check('a one-character argument is dropped', parseToolCalls('search_web: a', BOTH).length === 0);
check('an argument longer than a query is dropped',
    parseToolCalls(`search_web: ${'x'.repeat(240)}`, BOTH).length === 0);
check('prose instead of a list is nothing',
    parseToolCalls('I think I should probably look this up somewhere, but I am not sure where.', BOTH).length === 0);
check('an empty answer is nothing', parseToolCalls('', BOTH).length === 0 && parseToolCalls(null, BOTH).length === 0);
check('the same query twice in one answer runs once',
    parseToolCalls('search_web: ohm law\nsearch_web: Ohm Law', BOTH).length === 1);
check('at most three lookups a round',
    parseToolCalls(['a', 'b', 'c', 'd', 'e'].map(q => `search_web: query ${q}`).join('\n'), BOTH).length === 3);
check('two different tools in one answer both run',
    parseToolCalls('search_web: ohm law\nfind_in_library: electronics', BOTH).length === 2);

section('a search of the learner own library is context, never a citation');
const library = chatTools({ library: true })[0];
db.prepare("INSERT INTO projects (id, name) VALUES (?, ?)").run(4242, 'Driving License (Category B)');
db.prepare("INSERT INTO nodes (id, project_id, title, position) VALUES (?, ?, ?, 0)")
    .run(9449, 4242, 'Theory exam format');

const hit = await library.run('driving');
check('a real project is found', hit.count > 0 && hit.context.includes('Driving License'));
// The case that started this: the project's title carries "Driving" and not
// "theory", so scoring the whole phrase ranked a saved link above it and the
// assistant answered "you have no such project".
const twoWords = await library.run('driving theory');
check('a two-word lookup still finds the project whose title has only one of them',
    twoWords.context.includes('Driving License'), twoWords.context.slice(0, 120));
check('a one-word lookup is NOT widened', (await library.run('driving')).context.split('\n').length
    <= (await library.run('driving theory')).context.split('\n').length + 2);
check('the ids the open marker needs come with it', /projectId 4242/.test(hit.context));
check('a hit is CONTEXT, never a citable source', !!hit.context && !hit.items);
const miss = await library.run('astrophysics');
check('a miss is an answer, not an empty result', miss.count === 0 && /found NO match/i.test(miss.context));
check('...and it is context too, so nothing can cite it', !!miss.context && !miss.items);
check('so the citable list stays empty for a library-only turn',
    formatSourceContext([]).sources.length === 0 && formatSourceContext([]).text === '');
db.prepare('DELETE FROM nodes WHERE id = ?').run(9449);
db.prepare('DELETE FROM projects WHERE id = ?').run(4242);

// ---- 2. the gate on the web ------------------------------------------------

section('the setting decides whether a socket may open at all');
db.prepare('DELETE FROM settings WHERE key = ?').run('ai_web_search');
check('absent is off', webSearchMode() === 'off');
check('and no answer to the composer changes that',
    !webAllowedForTurn(true) && !webAllowedForTurn(false) && !webAllowedForTurn(undefined));
setSetting('ai_web_search', 'false');
check('the old unticked checkbox is off', webSearchMode() === 'off');
setSetting('ai_web_search', 'true');
check('the old TICKED checkbox is ask, never auto', webSearchMode() === 'ask');
setSetting('ai_web_search', 'ask');
check('ask needs the switch on for this question', webAllowedForTurn(true));
check('ask with the switch off searches nothing', !webAllowedForTurn(false));
check('ask with no answer at all fails closed', !webAllowedForTurn(undefined));
setSetting('ai_web_search', 'auto');
check('auto searches without being asked each time', webAllowedForTurn(undefined) && webAllowedForTurn(true));
check('auto still honours one question kept to yourself', !webAllowedForTurn(false));
setSetting('ai_web_search', 'yes please');
check('a value nobody recognises is off', webSearchMode() === 'off');
setSetting('ai_web_search', 'off');

check('no tool means no model call at all',
    (await runToolRounds({ question: 'what is kinetic energy?', tools: [] })).calls.length === 0);
check('an empty question means no model call at all',
    (await runToolRounds({ question: '   ', tools: BOTH })).calls.length === 0);

// ---- 3. what the answer says afterwards ------------------------------------

section('what the turn did is a record, not a status line');
const calls = [
    { tool: 'search_web', arg: 'dutch priority road signs 2026', summary: '4 pages', count: 4, state: 'done' },
    { tool: 'find_in_library', arg: 'traffic', summary: '3 matches', count: 3, state: 'done' },
];
check('only the web query is named in a paste', webQueries(calls).join('|') === 'dutch priority road signs 2026');
check('the answer text itself carries no trailer any more',
    !resolveCitations('A claim. [[src:1]]', [{ n: 1, title: 'CBR', url: 'https://example.org' }]).text.includes('Searched the web'));
check('...but the sources line is still written',
    resolveCitations('A claim. [[src:1]]', [{ n: 1, title: 'CBR', url: 'https://example.org' }]).text.includes('[CBR](https://example.org)'));

section('the loop, driven end to end by a stub endpoint');
const tool = (name, run) => ({ name, arg: 'a thing', why: 'a reason', note: q => `Looking up ${q}`, run });

replies = ['search_web: dutch road signs', 'NONE'];
const seen = [];
const ran = await runToolRounds({
    question: 'what changed?',
    tools: [tool('search_web', async () => ({ items: [{ title: 'A page', url: 'https://example.org', content: 'x' }], count: 1, summary: '1 page' }))],
    emit: e => { if (e.actions) seen.push(e.actions.map(a => `${a.state}:${a.summary ?? ''}`).join('|')); },
});
check('the model\'s line became a real call', ran.calls.length === 1 && ran.calls[0].arg === 'dutch road signs');
check('what it found is handed back as a source', ran.items.length === 1 && ran.items[0].url === 'https://example.org');
check('the row is announced BEFORE it runs', seen[0] === 'running:');
check('...and filled in when it lands', seen[1] === 'done:1 page');
check('every row ends done', ran.calls.every(c => c.state === 'done'));
check('a second round that says NONE stops the loop', ran.calls.length === 1);

replies = ['search_web: something', 'NONE'];
const broke = await runToolRounds({
    question: 'what changed?',
    tools: [tool('search_web', async () => { throw new Error('the endpoint went away'); })],
});
check('a tool that throws does not fail the turn', Array.isArray(broke.items) && broke.items.length === 0);
check('...and its row is still finished, not left spinning',
    broke.calls.length === 1 && broke.calls[0].state === 'done' && !!broke.calls[0].summary);

replies = ['search_web: one\nsearch_web: two\nsearch_web: three\nsearch_web: four', 'search_web: five\nsearch_web: six\nsearch_web: seven'];
const capped = await runToolRounds({
    question: 'what changed?',
    tools: [tool('search_web', async () => ({ items: [], count: 0, summary: 'no results' }))],
});
check('a turn runs at most six lookups', capped.calls.length <= 6 && capped.calls.length === 6, String(capped.calls.length));
check('and at most two rounds of them',
    capped.calls.map(c => c.arg).join() === 'one,two,three,five,six,seven', capped.calls.map(c => c.arg).join());

replies = ['NONE'];
const none = await runToolRounds({ question: 'what is 2 + 2?', tools: [tool('search_web', async () => ({ items: [], count: 0 }))] });
check('NONE means the question is answered from what the model knows', none.calls.length === 0);

// ---- 4. the prompt that asks for the lookups -------------------------------

section('the pass that decides is shown only the tools it has');
const asked = AI_PROMPTS.tool_use({ question: 'is that still the rule?', tools: chatTools({ web: true }) });
check('it lists the tool it was given', asked.system.includes('search_web:'));
check('it does not mention a tool it was not given', !asked.system.includes('find_in_library'));
check('NONE is offered before anything else is', asked.system.indexOf('NONE') < asked.system.indexOf('At most 3'));
check('the learner\'s question is the user turn, not the system prompt',
    asked.user.includes('is that still the rule?') && !asked.system.includes('is that still the rule?'));
const second = AI_PROMPTS.tool_use({
    question: 'is that still the rule?', tools: BOTH, round: 1,
    done: [{ tool: 'search_web', arg: 'dutch priority rules', summary: '4 pages' }],
    found: [{ title: 'CBR — priority' }],
});
check('a second round is told what it already ran', second.system.includes('dutch priority rules'));
check('a second round is told what came back', second.system.includes('CBR — priority'));
check('a second round is pushed towards NONE', /Answer NONE unless/.test(second.system));

console.log(`\n${pass} passed, ${fail} failed`);
// Ended, not killed. `process.exit()` while the stub endpoint's handle is still
// open aborts node with a libuv assertion (`UV_HANDLE_CLOSING`, win/async.c) —
// which exits 127 and fails a suite in which every assertion passed. Setting the
// code and closing the server lets the loop drain on its own.
try { db.close(); } catch { /* best effort */ }
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* Windows file locks */ }
process.exitCode = fail ? 1 : 0;
server.close();
