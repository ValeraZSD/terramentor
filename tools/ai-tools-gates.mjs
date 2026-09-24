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
 *   2. THE GATE ON THE WEB IS A PROMISE IN SECURITY.md. Only the literal `on`
 *      opens a socket; `off`, anything unrecognised and an unreadable setting
 *      all fail closed. The migration carries `auto` to `on` and the old `ask`
 *      and checkbox `true` to `off` — an install that never granted a turn its
 *      permission does not get it granted wholesale by an upgrade.
 *   3. AN ANSWER MUST SAY WHAT LEFT THE MACHINE. Every lookup is a row in the
 *      conversation — announced before it runs, filled in when it lands, stored
 *      with the message — so the record survives the reload that a status line
 *      does not. Nothing may be left mid-flight in it, and a paste still carries
 *      the web queries (and only the web queries: a library search opened no
 *      socket).
 *   4. THE ANSWER ITSELF CAN ASK. The pass before the answer decides from the
 *      question alone, so a reply that discovers mid-flight that it needs a
 *      figure may END in lookup lines (server/aiTools.js extractToolTail): the
 *      app strips them, runs them once against the same turn cap, renumbers the
 *      sources so every marker already written stays true, and gives the model
 *      exactly one pass to finish. The lines are a request, never content — not
 *      on the screen (the stream guard holds them back), not in the stored text,
 *      and never twice over. An engine that REFUSED reads as "the search
 *      failed", never as "no results".
 *
 * Deterministic: a scratch database, no model, no network.
 */

import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
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
//
// Streaming requests (`stream: true` — the native loop's rounds) are answered
// in SSE from `streamReplies`, one entry per request: either an array of frame
// objects written one `data:` line each, or `{ status, body }` for a refusal.
// The frames are the REAL wire shapes — a tool call arrives as fragments whose
// `id` and `function.name` appear once and whose `function.arguments` is split
// across chunks — so the accumulation in openAIChatStream is tested against the
// thing it must parse, never against a hand-made call list.
let replies = [];
const streamReplies = [];
const requests = [];
const server = createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch { /* a probe is not json */ }
        if (parsed) requests.push(parsed);
        if (parsed?.stream === true) {
            const next = streamReplies.shift() ?? [{ choices: [{ delta: { content: 'NONE' } }] }];
            if (next?.status) {
                res.writeHead(next.status, { 'Content-Type': 'application/json' });
                res.end(next.body);
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            for (const frame of next) res.write(`data: ${JSON.stringify(frame)}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
            return;
        }
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
const {
    chatTools, parseToolCalls, runToolRounds, runToolCalls, webQueries, extractToolTail,
    createTailGuard, searchSummary, lateResultsBlock, toolTailRule, MAX_CALLS_PER_TURN,
    wireTools, parseToolArgs, nativeToolRule, runNativeAgentTurn, isToolRefusalError, NATIVE_MAX_ROUNDS,
    hasWebTool,
} = await import('../server/aiTools.js');
const { webSearchEnabled } = await import('../server/webContext.js');
const { resolveCitations, formatSourceContext } = await import('../server/citations.js');
const { AI_PROMPTS, streamResponse } = await import('../server/ai.js');

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

// ONE SWITCH AND ONE STORED SHAPE. It was three states plus a per-question
// switch beside the composer, from when the app wrote the query itself; the
// model decides mid-answer now, so `ask` and `auto` described the same wire and
// the composer asked the same permission twice. What is left is `on` | `off`,
// normalised once by the migration in server/database.js — so the read is a
// single comparison and every other value in the column fails closed.
section('the setting decides whether a socket may open at all');
db.prepare('DELETE FROM settings WHERE key = ?').run('ai_web_search');
check('absent is off', !webSearchEnabled());
setSetting('ai_web_search', 'on');
check('on is on', webSearchEnabled());
setSetting('ai_web_search', 'off');
check('off is off', !webSearchEnabled());
// Every legacy value, and every value nobody recognises, reads as off. The
// MIGRATION is what turns an install that chose `auto` back on; a read that
// guessed here would be a second opinion able to disagree with the column.
for (const legacy of ['auto', 'ask', 'true', 'false', 'yes please', '']) {
    setSetting('ai_web_search', legacy);
    check(`a value that is not "on" is off (${legacy || 'empty'})`, !webSearchEnabled());
}
setSetting('ai_web_search', 'off');

// The migration itself, on the five shapes the column can hold. Blanket
// permission carries over; a per-question permission that defaulted to NO does
// not, because no turn was ever granted it.
section('the three-state setting becomes one switch, and fails closed');
const migrate = () => db.prepare(`UPDATE settings SET value = CASE WHEN value = 'auto' THEN 'on' ELSE 'off' END
                                  WHERE key = 'ai_web_search' AND value NOT IN ('on', 'off')`).run();
for (const [before, after] of [['auto', 'on'], ['ask', 'off'], ['true', 'off'], ['false', 'off'], ['nonsense', 'off']]) {
    setSetting('ai_web_search', before);
    migrate();
    const got = db.prepare('SELECT value FROM settings WHERE key = ?').get('ai_web_search')?.value;
    check(`${before} migrates to ${after}`, got === after, String(got));
}
// And it is idempotent: a second boot must not move a learner's own answer.
setSetting('ai_web_search', 'on');
migrate();
check('a second boot changes nothing',
    db.prepare('SELECT value FROM settings WHERE key = ?').get('ai_web_search')?.value === 'on');
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

section('the decision pass judges a short follow-up in its exchange');
replies = ['NONE'];
await runToolRounds({
    question: 'Так уже включён',
    tools: chatTools({ web: true }),
    history: [
        { role: 'user', content: 'Can you look up current news on AI as of September 2026?' },
        { role: 'assistant', content: 'Web search is off in Settings.' },
    ],
});
check('the decision pass sees the exchange a follow-up belongs to', (() => {
    const body = requests.at(-1);
    return body.messages.some(m => m.content.includes('THE EXCHANGE SO FAR'))
        && body.messages.some(m => m.content.includes('Can you look up current news on AI as of September 2026?'))
        && body.messages.some(m => m.content.includes('Так уже включён'));
})(), JSON.stringify(requests.at(-1)?.messages?.map(m => m.content.slice(0, 80))));
replies = ['NONE'];
await runToolRounds({ question: 'what is kinetic energy?', tools: chatTools({ web: true }), history: [] });
check('no history writes no exchange block', !requests.at(-1).messages.some(m => m.content.includes('THE EXCHANGE SO FAR')));
check('the follow-up rule is on the system side',
    AI_PROMPTS.tool_use({ question: 'x', tools: chatTools({ web: true }) }).system.includes('SHORT FOLLOW-UP'));

// ---- 5. the answer that ends by asking for a lookup ------------------------

section('an answer may END in lookup lines, and they are a request, never content');
const tailTools = chatTools({ web: true, library: true });

const split = extractToolTail('Here is what I know.\n\nsearch_web: ai news september 2026', tailTools);
check('a reply ending in a lookup line is split off the end',
    split.head === 'Here is what I know.' && split.calls.length === 1
    && split.calls[0].arg === 'ai news september 2026', JSON.stringify(split));
const pairTail = extractToolTail('Answer.\nsearch_web: one\nfind_in_library: two', tailTools);
check('a run of lookup lines is taken whole', pairTail.calls.length === 2 && pairTail.head === 'Answer.', JSON.stringify(pairTail));
const midProse = extractToolTail('search_web: first\nThen the answer continues.', tailTools);
check('a lookup line in the MIDDLE of prose is content, not a request',
    midProse.calls.length === 0 && midProse.head === 'search_web: first\nThen the answer continues.', JSON.stringify(midProse));
const plain = extractToolTail('The answer is 42.', tailTools);
check('plain prose keeps every character', plain.calls.length === 0 && plain.head === 'The answer is 42.');
check('a line naming a tool the turn does not have stops the walk',
    extractToolTail('Answer.\nsend_email: hi', tailTools).calls.length === 0);
check('a colon line that is not a tool stops the walk',
    extractToolTail('Answer.\nNote: this matters.', tailTools).calls.length === 0);
check('a reply that ends INSIDE a code fence never ends in a request',
    extractToolTail('```js\nsearch_web: inside', tailTools).calls.length === 0);
check('a closed fence above the tail does not hide it',
    extractToolTail('```js\nlet x = 1;\n```\nsearch_web: after the fence', tailTools).calls.length === 1);
check('no tools means no tail', extractToolTail('search_web: x', []).calls.length === 0);
check('an empty reply has no tail', extractToolTail('', tailTools).calls.length === 0 && extractToolTail(null, tailTools).calls.length === 0);

check('the answer hint exists only when there is a tool to name',
    toolTailRule(tailTools).includes('search_web:') && toolTailRule([]) === '');
check('the answer hint offers the END-of-reply form',
    toolTailRule(tailTools).includes('END your reply') && toolTailRule(tailTools).includes('one more pass'));
check('the answer hint carries the turn cap', toolTailRule(tailTools).includes(String(MAX_CALLS_PER_TURN)));

section('a streaming reply never shows the request it ends with');
{
    let out = '';
    const guard = createTailGuard({ tools: tailTools, onChunk: t => { out += t; } });
    guard.feed('The answer so far.\n');
    guard.feed('search_web: ai news');
    check('a growing call-shaped last line is held', out === 'The answer so far.\n', JSON.stringify(out));
    guard.feed(' september 2026');
    check('it stays held while it grows', out === 'The answer so far.\n', JSON.stringify(out));
    const ended = guard.end();
    check('at stream end it is confirmed a request and never shown',
        ended.tailCalls.length === 1 && ended.tailCalls[0].arg === 'ai news september 2026'
        && out === 'The answer so far.\n', JSON.stringify({ ended, out }));
}
{
    let out = '';
    const guard = createTailGuard({ tools: tailTools, onChunk: t => { out += t; } });
    guard.feed('The answer so far.\n');
    guard.feed('search_web: maybe\n');
    guard.feed('More prose follows.');
    const ended = guard.end();
    check('a call-shaped line followed by prose is released as content',
        ended.tailCalls.length === 0 && out.includes('search_web: maybe') && out.includes('More prose follows.'),
        JSON.stringify({ ended, out }));
}
{
    let out = '';
    const guard = createTailGuard({ tools: tailTools, onChunk: t => { out += t; } });
    guard.feed('Just prose.\nNo tools here.\n');
    guard.end();
    check('ordinary prose streams with no held tail', out === 'Just prose.\nNo tools here.\n', JSON.stringify(out));
}
{
    let out = '';
    const guard = createTailGuard({ tools: [], onChunk: t => { out += t; } });
    guard.feed('search_web: with no tools this is just text\n');
    guard.end();
    check('no tools: the guard is a pass-through', out === 'search_web: with no tools this is just text\n', JSON.stringify(out));
}

// ---- 6. the three empties a search can return ------------------------------

section('a search says which of the three empties it was');
check('results are counted', searchSummary(4) === '4 pages');
check('one page is singular', searchSummary(1) === '1 page');
check('nothing found is an answer', searchSummary(0) === 'no results');
check('an engine that refused is NOT an answer', searchSummary(0, true) === 'the search failed');
const indexSrc = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
check('the gap line in index.js still recognises a refused search',
    /\(no results\|nothing\|the search failed\)/.test(indexSrc));

// ---- 7. late lookups continue the same numbered list -----------------------

section('late lookups continue the same numbered list');
const early = formatSourceContext([{ title: 'Early doc', content: 'a' }]);
check('the first block numbers from one', early.sources[0].n === 1);
const lateBlock = formatSourceContext(
    [{ title: 'Late page', url: 'https://late.example', content: 'b' }],
    { offset: early.sources.length });
check('a late block continues the same numbers', lateBlock.sources[0].n === 2);
check('the late block numbers its heading too', lateBlock.text.includes('[2] Late page — https://late.example'), lateBlock.text.slice(0, 120));
check('markers written before and after the lookup resolve together', (() => {
    const out = resolveCitations('One. [[src:1]] Two. [[src:2]]', [...early.sources, ...lateBlock.sources]);
    return out.text.includes('Early doc') && out.text.includes('[Late page](https://late.example)');
})());

section('the continuation is told what came back, honestly');
check('new sources arrive numbered on', lateResultsBlock({
    addedItems: [{ title: 'L', content: 'x', url: 'https://l.example' }], offset: 3,
}).includes('[4] L — https://l.example'));
check('library context rides as plain context', lateResultsBlock({ lateContext: ['your library said this'] }).includes('your library said this'));
check('nothing usable says so', lateResultsBlock({}).includes('found nothing usable'));
check('a refused engine is not reported as "no results"', lateResultsBlock({ failed: true }).includes('could not be completed'));

section('the late run is the same machinery the pass before the answer uses');
// index.js's runLateLookups composes exactly these pieces, so each piece is
// pinned here at its own contract; the wiring itself is pinned by source scan
// below (index.js cannot be imported — it binds a port).
replies = ['NONE'];
const turnCalls = [];
const turnItems = [{ title: 'Early doc', content: 'x' }];
let announced = 0;
const { added: addedNow, perCall: addedPerCall } = await runToolCalls({
    wanted: [{ tool: 'search_web', arg: 'current vat rate 2026' }],
    tools: [tool('search_web', async () => ({ items: [{ title: 'Late page', url: 'https://late.example', content: '21%' }], count: 1, summary: '1 page' }))],
    calls: turnCalls, items: turnItems, context: [],
    emit: e => { if (e.actions) announced++; },
});
check('the late call is announced before it runs and filled in after', announced === 2);
check('its results join the turn\'s own record', turnCalls.length === 1 && turnCalls[0].summary === '1 page' && turnItems.length === 2, JSON.stringify(turnCalls));
check('and what it added is returned for the continuation block', addedNow.length === 1 && addedNow[0].url === 'https://late.example');
check('the per-call split carries exactly this call\'s findings, for the native loop\'s per-id result',
    addedPerCall.length === 1 && addedPerCall[0].items.length === 1
    && addedPerCall[0].items[0].url === 'https://late.example' && addedPerCall[0].failed === false,
    JSON.stringify(addedPerCall));
const contPrompt = AI_PROMPTS.continue_answer({
    resultsBlock: lateResultsBlock({ addedItems: addedNow, offset: turnItems.length - addedNow.length }),
}).user;
check('the continuation sees the late page numbered on', contPrompt.includes(`[${turnItems.length}] Late page — https://late.example`), contPrompt.slice(0, 200));
check('the continuation is told to continue, not restart', contPrompt.includes('Continue the answer from where it stopped'));
check('the continuation may not ask for another round', contPrompt.includes('do not ask for further lookups'));
check('its own citation resolves against the renumbered list',
    resolveCitations('The rate is 21 percent. [[src:2]]', formatSourceContext(turnItems).sources).text.includes('https://late.example'));
const failCalls = [];
const { added: failAdded, perCall: failPerCall } = await runToolCalls({
    wanted: [{ tool: 'search_web', arg: 'throttled query' }],
    tools: [tool('search_web', async () => ({ items: [], count: 0, summary: 'the search failed' }))],
    calls: failCalls, items: [], context: [],
});
check('a refused search marks its row with the failed summary', failCalls[0].summary === 'the search failed');
check('and adds nothing to the citable list', failAdded.length === 0);
check('the per-call split carries the failure, so the native result says REFUSED not "no results"',
    failPerCall[0].failed === true && failPerCall[0].items.length === 0, JSON.stringify(failPerCall));
const failedBlock = AI_PROMPTS.continue_answer({ resultsBlock: lateResultsBlock({ failed: true }) }).user;
check('a continuation told of a refused engine is told to admit it', failedBlockSays(failedBlock));
function failedBlockSays(b) { return b.includes('could not verify'); }
check('the cite line names the range, never a literal N', lateResultsBlock({
    addedItems: [{ title: 'L', content: 'x', url: 'https://l.example' }], offset: 3,
}).includes('[[src:4]] through [[src:4]]'));

// ---- 8. the native agent loop ----------------------------------------------

section('the wire shape the native loop sends');
check('tools become OpenAI function schemas', (() => {
    const w = wireTools(chatTools({ web: true }));
    return w.length === 1 && w[0].type === 'function' && w[0].function.name === 'search_web'
        && w[0].function.parameters.properties.query.type === 'string'
        && w[0].function.parameters.required.includes('query');
})());
check('the schema describes itself for a model that has never seen the tool', wireTools(chatTools({ web: true }))[0].function.description.length > 10);
check('no tools is no schemas', wireTools([]).length === 0);
check('the system rule names the tools and the citation marker',
    nativeToolRule(BOTH).includes('search_web') && nativeToolRule(BOTH).includes('[[src:N]]'));
check('no tools writes no rule', nativeToolRule([]) === '');

section('a native call\'s arguments become the query, or nothing');
check('the object shape is read', parseToolArgs('{"query":"vat rates 2026"}') === 'vat rates 2026');
check('a bare JSON string is read', parseToolArgs('"ohm law"') === 'ohm law');
check('an alternate key is accepted', parseToolArgs('{"search":"ohm law"}') === 'ohm law');
check('truncated JSON is recovered from what the model clearly meant', parseToolArgs('{"query": "current ai ne') === 'current ai ne');
check('a bare non-JSON string IS the query', parseToolArgs('current ai news') === 'current ai news');
check('an empty object is nothing', parseToolArgs('{}') === '');
check('JSON-shaped but unparseable is nothing', parseToolArgs('{"query: broken') === '');
check('an essay is not a query', parseToolArgs(`{"query":"${'x'.repeat(500)}"}`).length === 400);
check('missing arguments are nothing', parseToolArgs(undefined) === '' && parseToolArgs(null) === '' && parseToolArgs('') === '');

section('a refusal is remembered, a 5xx is not');
check('a 400 blaming the tools field is a refusal', isToolRefusalError({ httpStatus: 400, responseBody: '{"error":"tools is not supported by this model"}' }));
check('a 404 blaming it too is one', isToolRefusalError({ httpStatus: 404, responseBody: 'tools not found here' }));
check('a 422 with a tool note is one', isToolRefusalError({ httpStatus: 422, responseBody: 'invalid tools parameter' }));
check('a plain 400 is not', !isToolRefusalError({ httpStatus: 400, responseBody: 'model not found' }));
check('a 5xx is never a verdict', !isToolRefusalError({ httpStatus: 500, responseBody: 'tools exploded' }));
check('an error with no status is not', !isToolRefusalError(new Error('network dropped')));

section('the native loop, driven through the real stream parser');
// The loop is the caller's stream bound to a growing message array, so the
// stub answers in SSE from `streamReplies` — the REAL wire shapes: fragments
// keyed by index, id and name on the first fragment only, arguments split
// across chunks, `finish_reason: "tool_calls"`. A hand-made call list would
// test the loop against itself.
const streamTool = tool('search_web', async q => ({
    items: [{ title: `Page for ${q}`, url: `https://late.example/${encodeURIComponent(q)}`, content: '21%' }],
    count: 1, summary: '1 page',
}));
const runNative = async ({ tools = [streamTool], preCalls = [], history = [] } = {}) => {
    const items = [], context = [], calls = [...preCalls];
    const emitted = [];
    const res = await runNativeAgentTurn({
        system: 'You are a tutor.',
        history,
        message: 'What is the current VAT rate?',
        tools, items, context, calls,
        startRound: (msgs, withTools) => streamResponse(msgs, '', [], {
            temperature: 0.35, think: true,
            tools: withTools ? wireTools(tools) : undefined,
        }),
        emit: frame => emitted.push(frame),
    });
    return { res, items, context, calls, emitted };
};
const toolCallFrame = (id, name, args, index = 0) => ({
    choices: [{ delta: { tool_calls: [{ index, id, type: 'function', function: { name, arguments: args } }] } }],
});

// a) a fragmented call in round one, a real lookup, a cited answer in round two
streamReplies.length = 0;
streamReplies.push(
    [
        { choices: [{ delta: { reasoning_content: 'need to check the rate' } }] },
        toolCallFrame('call_w1', 'search_web', '{"que'),
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ry":"late vat rates 2026"}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ],
    [
        { choices: [{ delta: { content: 'The rate is 21 percent. [[src:1]]' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ],
);
{
    const { res, items, calls, emitted } = await runNative();
    check('fragmented arguments were concatenated whole', calls[0]?.arg === 'late vat rates 2026', JSON.stringify(calls));
    check('the result went back as a wire-valid role:"tool" message', (() => {
        const msgs = requests.at(-1)?.messages || [];
        const asst = msgs[msgs.length - 2], toolMsg = msgs[msgs.length - 1];
        return requests.at(-1).tools?.length === 1
            && asst?.role === 'assistant'
            && asst?.tool_calls?.[0]?.id === 'call_w1'
            && asst?.tool_calls?.[0]?.function?.arguments === '{"query":"late vat rates 2026"}'
            && asst?.content === null
            && toolMsg?.role === 'tool' && toolMsg?.tool_call_id === 'call_w1'
            && toolMsg?.content.includes('[1] Page for late vat rates 2026');
    })(), JSON.stringify(requests.at(-1)?.messages));
    check('the result message names its citation range, never a literal N',
        requests.at(-1).messages.at(-1).content.includes('[[src:1]] through [[src:1]]'));
    check('tools ride on the answer round too', requests.at(-1).tools?.length === 1);
    check('the native rule reached the system prompt', requests.at(-2).messages[0].content.includes('LIVE LOOKUPS'));
    check('the answer streamed and no call text was ever content',
        emitted.some(f => f.chunk?.includes('21 percent'))
        && !emitted.some(f => f.chunk && /search_web|\{"query/.test(f.chunk)),
        JSON.stringify(emitted.filter(f => f.chunk)));
    check('the loop\'s answer is the full text', res.fullText === 'The rate is 21 percent. [[src:1]]');
    check('its citation resolves against the grown list', (() => {
        const out = resolveCitations(res.fullText, formatSourceContext(items).sources);
        return out.text.includes('https://late.example');
    })());
    check('the thinking channel still streamed', emitted.some(f => f.thinkingChunk === 'need to check the rate'));
}

// b) a malformed call and an unknown name: recovery notes, nothing runs
streamReplies.length = 0;
streamReplies.push(
    [
        toolCallFrame('call_bad', 'search_web', '{}'),
        toolCallFrame('call_ghost', 'browse_web', '{"query":"x"}', 1),
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ],
    [
        { choices: [{ delta: { content: 'Answered from what I have.' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ],
);
{
    const { res, items, calls } = await runNative();
    const notes = (requests.at(-1)?.messages || []).filter(m => m.role === 'tool').map(m => m.content).join(' | ');
    check('both emitted ids got a tool message, no gap',
        (requests.at(-1)?.messages || []).filter(m => m.role === 'tool').length === 2);
    check('a malformed call is told its arguments did not parse', notes.includes('malformed'), notes.slice(0, 160));
    check('a tool the turn was not given is named as absent', notes.includes('No tool named "browse_web"'));
    check('nothing ran and nothing was fabricated', calls.length === 0 && items.length === 0);
    check('the turn still ends in an answer', res.fullText === 'Answered from what I have.');
}

// c) the spent budget: one round, no tools, and the model is TOLD
{
    const pre = Array.from({ length: MAX_CALLS_PER_TURN }, (_, i) => ({
        tool: 'search_web', arg: `q ${i}`, state: 'done', summary: '1 page', count: 1,
    }));
    streamReplies.length = 0;
    streamReplies.push([
        { choices: [{ delta: { content: 'Final answer.' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]);
    const { res, calls } = await runNative({ preCalls: pre });
    const last = requests.at(-1);
    check('a spent budget runs no tool round', last.tools === undefined);
    check('the model is TOLD the budget is gone, not left guessing',
        last.messages.some(m => m.content?.includes('lookup budget for this turn is spent')));
    check('the forced final answer came back', res.fullText === 'Final answer.');
    check('the cap is exactly the shared one', calls.length === MAX_CALLS_PER_TURN);
}

// d) a duplicate of a call already run is pointed at its results, not re-run
{
    const pre = [{ tool: 'search_web', arg: 'late vat rates 2026', state: 'done', summary: '1 page', count: 1 }];
    streamReplies.length = 0;
    streamReplies.push(
        [toolCallFrame('call_dupe', 'search_web', '{"query":"LATE VAT RATES 2026"}'),
         { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }],
        [{ choices: [{ delta: { content: 'Used what was there.' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }],
    );
    const { res, calls, items } = await runNative({ preCalls: pre });
    check('a duplicate is pointed at the results in hand, not re-run',
        requests.at(-1).messages.find(m => m.role === 'tool')?.content.includes('already ran this turn')
        && calls.length === 1 && items.length === 0,
        JSON.stringify(requests.at(-1).messages.filter(m => m.role === 'tool')));
    check('the turn completed', res.fullText === 'Used what was there.');
}

// e) parallel calls in one round: per-call results, numbered as one list
streamReplies.length = 0;
streamReplies.push(
    [
        toolCallFrame('call_p1', 'search_web', '{"query":"first thing"}', 0),
        toolCallFrame('call_p2', 'search_web', '{"query":"second thing"}', 1),
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ],
    [{ choices: [{ delta: { content: 'Both checked.' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }],
);
{
    const { items, calls } = await runNative();
    const toolMsgs = (requests.at(-1)?.messages || []).filter(m => m.role === 'tool');
    check('parallel calls each get their own numbered result',
        toolMsgs.length === 2
        && toolMsgs[0].content.includes('[1] Page for first thing') && toolMsgs[0].tool_call_id === 'call_p1'
        && toolMsgs[1].content.includes('[2] Page for second thing') && toolMsgs[1].tool_call_id === 'call_p2'
        && calls.length === 2 && items.length === 2,
        JSON.stringify(toolMsgs));
}

// f) a refusal propagates for the caller's fallback decision
streamReplies.length = 0;
streamReplies.push({ status: 400, body: '{"error":"tools is not supported by this model"}' });
{
    let refusalErr = null;
    try { await runNative(); } catch (e) { refusalErr = e; }
    check('a refusal propagates — the caller decides the fallback',
        !!refusalErr && isToolRefusalError(refusalErr) && refusalErr.httpStatus === 400, refusalErr?.message);
}

// g) a model that keeps calling is stopped by the round budget, not left looping
streamReplies.length = 0;
for (let i = 0; i < NATIVE_MAX_ROUNDS; i++) {
    streamReplies.push([
        toolCallFrame(`call_r${i}`, 'search_web', `{"query":"question ${i}"}`),
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);
}
streamReplies.push([
    { choices: [{ delta: { content: 'Enough. Here is the answer.' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
]);
{
    const { res, calls } = await runNative();
    check(`a model that keeps calling is stopped after ${NATIVE_MAX_ROUNDS} rounds`, calls.length === NATIVE_MAX_ROUNDS, String(calls.length));
    check('the last round is forced to answer without tools', requests.at(-1).tools === undefined);
    check('the round cap is not the call cap — no budget note fired',
        !requests.at(-1).messages.some(m => m.content?.includes('lookup budget for this turn is spent')));
    check('the forced answer came back', res.fullText === 'Enough. Here is the answer.');
}

section('the wiring that joins them is pinned by source scan');
check('buildSourceContext appends the answer hint to the source block', indexSrc.includes('toolTailRule(tools)'));
check('the decision pass is handed the conversation', /runToolRounds\(\{[\s\S]{0,200}history,/.test(indexSrc));
check('the stream pass runs through the tail guard', indexSrc.includes('createTailGuard({ tools: ragTools'));
check('the stored text is stripped of a tail before the lookups run', indexSrc.includes('extractToolTail(fullResponse, ragTools)'));
check('the continuation sees the model\'s own partial answer', /role: 'assistant', content: tail\.head/.test(indexSrc));
check('late sources are re-derived so the markers stay true', indexSrc.includes('formatSourceContext(ragItems).sources'));
check('both routes run the same continuation helper', (indexSrc.match(/runLateLookups\(/g) || []).length >= 3);
check('a turn that spent its cap is told so, not silently ignored', indexSrc.includes('already spent its lookup budget'));

section('the native branch is wired where the text protocol was');
check('both buildSourceContext call sites ask for native mode when the endpoint may do tools',
    (indexSrc.match(/native: tryNativeTools/g) || []).length === 2, String((indexSrc.match(/native: tryNativeTools/g) || []).length));
check('the native decision is made on the provider, not on a new setting',
    /const tryNativeTools = aiSettings\.provider === 'openai' && !nativeToolsRefused\.has\(nativeKey\)/.test(indexSrc));
check('the loop runs inside the turn\'s abort envelope', indexSrc.includes('await runNativeAgentTurn({'));
check('the loop is bound to the real stream, schemas attached only while tools are allowed',
    indexSrc.includes('tools: withTools ? wireTools(ragTools) : undefined'));
check('a refusal is remembered for the process lifetime',
    indexSrc.includes('nativeToolsRefused.add(nativeKey)') && indexSrc.includes('const nativeToolsRefused = new Set()'));
check('the fallback fires only when nothing streamed yet', indexSrc.includes('isToolRefusalError(e) && !nativeSawOutput'));
check('a streamed-then-died native turn keeps its partial', indexSrc.includes('fullResponse = nativePartial'));
check('the native branch skips the answer-tail machinery', /if \(!nativeHandled && ragTools\.length/.test(indexSrc));
check('the native branch re-derives the source list after the loop',
    /ragSources = formatSourceContext\(ragItems\)\.sources;\s*\n\s*nativeHandled = true;/.test(indexSrc));

// ---- 5. the prompt must agree with the tools ------------------------------
//
// The whole mechanism above is worth nothing if the system prompt tells the
// model not to use it. It did: the identity card described the pass that used
// to do all the deciding — "you do not run the search yourself in this turn,
// the app decides beforehand what to look up" — and kept saying it after the
// model got search_web on the wire. Measured on the real app (2026-09-22,
// OpenRouter/glm-5.3-flash, composer switch ON): the reasoning panel weighed
// the tool against that sentence, obeyed the sentence, and told the learner to
// go and enable a setting that was already enabled. A stale system prompt is
// not a stale comment.
//
// So the card states THIS turn's web state, read off the turn's own tool list,
// and both halves are asserted — including the pre-fix sentences as controls,
// because the failure was a string nobody re-read, not a branch nobody took.

section('the prompt says whether THIS turn can search');
/**
 * The paragraph about the web alone. Scoped because the rest of the prompt
 * legitimately says "off" about the SETTING's shipped default, and a whole-
 * prompt search for it would pass while the turn's own state said the opposite.
 */
const webBlockOf = (prompt) => {
    const at = prompt.indexOf('THE WEB, THIS TURN:');
    if (at === -1) return '';
    const end = prompt.indexOf('\n\n', at);
    return end === -1 ? prompt.slice(at) : prompt.slice(at, end);
};
const webTools = chatTools({ web: true });
check('a turn with the web tool is recognised as one', hasWebTool(webTools));
check('a library-only turn is not', !hasWebTool(chatTools({ library: true })));
check('a turn with no tools is not', !hasWebTool([]) && !hasWebTool());

const tutorWeb = AI_PROMPTS.tutor('ctx', '', 'q', null, { web: true }).system;
const tutorNoWeb = AI_PROMPTS.tutor('ctx', '', 'q', null, { web: false }).system;
const plannerWeb = AI_PROMPTS.today_planner({}, 'q', '', '', null, { web: true }).system;
const plannerNoWeb = AI_PROMPTS.today_planner({}, 'q', '', '', null, { web: false }).system;

check('the two states are not the same prompt', tutorWeb !== tutorNoWeb && plannerWeb !== plannerNoWeb);
for (const [who, withWeb, without] of [['tutor', tutorWeb, tutorNoWeb], ['assistant', plannerWeb, plannerNoWeb]]) {
    check(`the ${who} is told the lookup is its own to use`,
        /you have a live web lookup and it is yours to use/i.test(withWeb));
    check(`the ${who} is told to look up what it cannot be sure of`,
        /look it up before answering instead of saying you cannot check/i.test(withWeb.replace(/\s+/g, ' ')));
    // The sentence the learner actually got: "turn it on in Settings", while it
    // was on. A turn that HAS the tool may never send them to the switch.
    check(`the ${who} may not send the learner to a switch that is already on`,
        /already on for this turn/i.test(withWeb) && !/switched off/i.test(webBlockOf(withWeb)));
    check(`the ${who} with no lookup says the web is switched OFF, and where`,
        /switched off/i.test(without) && /Settings/.test(without));
    check(`the ${who} with no lookup may not claim it has no internet at all`,
        /Never say you have no internet/i.test(without));
    check(`the ${who} with no lookup may not claim a search ran`,
        /never claim a search ran or came back empty/i.test(without));
    check(`the ${who} with no lookup is not told it holds one`,
        !/yours to use/i.test(without));
}
// Fail closed: a call site that forgets the flag must not promise a tool the
// turn has not got. The opposite default would have the model announce a
// search it cannot run.
check('an unflagged prompt is the no-web state, never the web one',
    !/yours to use/i.test(AI_PROMPTS.tutor('ctx', '', 'q').system)
    && /switched off/i.test(AI_PROMPTS.today_planner({}, 'q').system));

section('the pre-fix sentences are gone from every prompt');
const aiSrc = readFileSync(new URL('../server/ai.js', import.meta.url), 'utf8');
// Each of these was quoted back by the model in its own reasoning before it
// refused. They are matched against the prompt STRINGS the app builds, never
// against server/ai.js, because the comment that records why they were removed
// quotes them verbatim — a file scan would fail on its own explanation.
// Whitespace-normalised, or the control is vacuous: every one of these was
// WRAPPED in the source ("the\napp decides beforehand"), so a raw `includes`
// for it is false against the pre-fix prompt too and the gate passes on the
// bug it was written for. Checked against HEAD before this line was trusted.
const builtPrompts = [tutorWeb, tutorNoWeb, plannerWeb, plannerNoWeb,
    AI_PROMPTS.today_planner({}, 'q', '', 'chunks', null, { web: true }).system]
    .map(p => p.replace(/\s+/g, ' '));
for (const dead of [
    'you do not run the search yourself',
    'the app decides beforehand',
    'there is no second search',
]) {
    check(`no prompt still says "${dead}"`, builtPrompts.every(p => !p.includes(dead)));
}
check('a turn WITH retrieved text is told it may still look further',
    /not the limit of what may be/i.test(AI_PROMPTS.today_planner({}, 'q', '', 'chunks', null, { web: true }).system));
check('the identity card is built per turn, not pasted as a constant',
    /function appIdentity\(/.test(aiSrc) && !/system: `\$\{APP_IDENTITY\}/.test(aiSrc));

section('every chat call site passes the turn its own web state');
check('all three prompt call sites read the flag off the tools',
    (indexSrc.match(/\bweb: hasWebTool\(ragTools\)/g) || []).length === 3,
    String((indexSrc.match(/\bweb: hasWebTool\(ragTools\)/g) || []).length));
// The setting is read ONCE, where the tool list is built. A second reading
// beside the prompt is a second chance to disagree with the list — and the
// list is what the model actually holds.
check('the setting is read once, where the tools are chosen',
    (indexSrc.match(/webSearchEnabled\(/g) || []).length === 1
    && /chatTools\(\{ web: webSearchEnabled\(\)/.test(indexSrc));
// NOTHING THE CLIENT SENDS DECIDES THIS. A `useWeb` flag on the request body,
// combined server-side with the setting, is the shape this replaced; a
// leftover half of it is a permission a client can hand itself.
check('no chat route takes a web flag from the request',
    !/useWeb/.test(indexSrc), 'server/index.js still reads useWeb off a request body');

section('the settings the assistant may change are the ones that exist');
// `[[set:theme:warm]]` was on the list for two years and stopped doing
// anything the day a theme became a MODE and a TINT: validateSettingChange
// returns null for it, so the chip is never drawn and the model has told the
// learner it changed something it did not.
const setList = plannerWeb.slice(plannerWeb.indexOf('The keys you may set'), plannerWeb.indexOf('At most 3 per message'));
check('theme offers the two modes and nothing else', /- theme — light \| dark/.test(setList));
check('the tint is offered as its own key', /- theme_tint —/.test(setList));
check('warm and black are named as tints, not as themes',
    /"Warm"\/"sepia" is a cream page/.test(setList) && !/light \| warm \| dark \| black/.test(setList));

section('a query that is the schema\'s own word is not a search');
// Measured 2026-09-23 on OpenRouter/glm-5.3-flash: asked for "dark mode, OLED
// tint", the model called search_web with {"query":"placeholder"}, DuckDuckGo
// answered with four pages about the word, and the learner watched a row say
// the web had been searched for "placeholder". Its own reasoning then called
// the tool broken. The template word is refused like a malformed call.
const { isPlaceholderQuery } = await import('../server/aiTools.js');
check('the measured call is refused', isPlaceholderQuery('placeholder'));
check('the template words are refused, whatever their dress',
    ['query', 'Search Query', '<query>', '"string"', 'your query here', '...', 'example', 'undefined'].every(isPlaceholderQuery));
check('a real query that CONTAINS one of the words is kept',
    !isPlaceholderQuery('placeholder text in html forms') && !isPlaceholderQuery('sql query optimisation') && !isPlaceholderQuery('example of the doppler effect'));
check('the text protocol drops it too',
    parseToolCalls('search_web: placeholder\nsearch_web: ohm law', chatTools({ web: true })).map(c => c.arg).join('|') === 'ohm law');
check('the native rule says a setting change needs no lookup',
    /change a setting[^.]*needs? no lookup/i.test(nativeToolRule(chatTools({ web: true }))));

section('the assistant knows what the settings are, and what its own last change replaced');
// "undo" answered with "I don't have an undo control myself — tap the button"
// (2026-09-23): the model had never been told what any setting held, so it
// could not put one back. It is told now, read from the database each turn.
const { readSettable, settingKeysIn, settingsBefore, assistantSettingsBlock } = await import('../server/assistantSettings.js');
const fromRows = (rows) => (key, fallback) => (key in rows ? rows[key] : fallback);
const empty = readSettable(fromRows({}));
check('an empty library reads as the defaults, each a value the marker accepts',
    empty.theme === 'light' && empty.theme_tint === 'none' && empty.ui_scale === 100
    && empty.week_start_day === 'monday' && empty.ui_language === 'auto' && empty.number_format === 'auto'
    && /^#[0-9a-f]{6}$/i.test(empty.accent_color), JSON.stringify(empty));
const set = readSettable(fromRows({ theme: 'dark', theme_tint: '#000000', week_start_day: '0', ui_scale: '125' }));
check('stored values are read back', set.theme === 'dark' && set.theme_tint === '#000000' && set.week_start_day === 'sunday' && set.ui_scale === 125, JSON.stringify(set));
check('a legacy named theme reads as its mode', readSettable(fromRows({ theme: 'black' })).theme === 'dark' && readSettable(fromRows({ theme: 'warm' })).theme === 'light');
check('the keys a message set are found, aliases and all, once each',
    settingKeysIn('Done.\n[[set:theme:dark]]\n[[set:page colour:black]]\n[[set:theme:light]]').join(',') === 'theme,theme_tint');
check('a key off the whitelist is not recorded', settingKeysIn('[[set:mastery_gate_mode:off]]').length === 0);
check('a message with no marker records nothing', settingsBefore('just talk', fromRows({})) === null);
check('the before-values are what the setting held, not what was asked for',
    JSON.stringify(settingsBefore('[[set:theme:dark]] [[set:theme_tint:black]]', fromRows({ theme: 'light', theme_tint: '#f0e1d0' })))
    === JSON.stringify({ theme: 'light', theme_tint: '#f0e1d0' }));
const block = assistantSettingsBlock({ now: set, recent: [{ minutesAgo: 3, before: { theme: 'light', theme_tint: 'none' } }] });
check('the block states every settable value as it is now',
    /theme: dark/.test(block) && /theme_tint: #000000/.test(block) && /week_start_day: sunday/.test(block));
check('the block states what the last change replaced', /theme was light/.test(block) && /theme_tint was none/.test(block));
check('the block says how to undo with an ordinary marker', /undo/i.test(block) && /\[\[set:/.test(block));
check('with no recent change it says so rather than inventing one',
    /have not changed any setting recently/i.test(assistantSettingsBlock({ now: set, recent: [] })));
const withBlock = AI_PROMPTS.today_planner({}, 'q', '', '', null, { web: false, settingsBlock: block }).system;
check('the planner carries the block', withBlock.includes(block));
check('the planner no longer says the setting is out of reach',
    !/never learns what the setting was/.test(withBlock));

section('what a turn changed is stored with the turn');
const cols = db.prepare("SELECT name FROM pragma_table_info('chat_messages')").all().map(r => r.name);
check('chat_messages has a settings_before column', cols.includes('settings_before'), cols.join(','));
check('the turn that stores an answer writes it', /settings_before/.test(indexSrc) && /settingsBefore\(/.test(indexSrc));

section('project_state: one project in depth, read-only');
// The snapshot carries 6 projects and 3 topic titles per list, with no mastery
// and no test scores (BRIEFING_MAX_PROJECTS / BRIEFING_TASKS_PER_LIST). Asked
// what it needed "from day one", the assistant put a read of ONE project first,
// and it was right: every write it could be given acts on numbers it cannot see.
const today = new Date().toISOString().slice(0, 10);
const past = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
const psId = Number(db.prepare("INSERT INTO projects (name, color) VALUES ('Wave physics', '#0369a1')").run().lastInsertRowid);
const addNode = (title, parent, extra = {}) => Number(db.prepare(
    'INSERT INTO nodes (project_id, parent_id, title, status, is_note, position, scheduled_start, scheduled_end, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
).run(psId, parent, title, extra.status || 'not_started', extra.is_note || 0, extra.position || 0,
    extra.start || null, extra.end || null, extra.completed_at || null).lastInsertRowid);
const sec = addNode('Sound', null);
const doppler = addNode('Doppler effect', sec, { status: 'in_progress', position: 1, start: past, end: past });
const snell = addNode('Snell law', sec, { status: 'completed', position: 2, completed_at: new Date().toISOString() });
const refr = addNode('Refraction', sec, { position: 3, start: today, end: today });
addNode('A note under Doppler', doppler, { is_note: 1 });
db.prepare('INSERT INTO node_mastery (node_id, mastery_score) VALUES (?, 0.4)').run(doppler);
db.prepare("INSERT INTO flashcards (node_id, front, back, next_review) VALUES (?, 'f = ?', 'f0 (v+vr)/(v-vs)', ?)").run(doppler, new Date(Date.now() - 3600000).toISOString());
db.prepare("INSERT INTO flashcards (node_id, front, back) VALUES (?, 'unseen', 'card')").run(doppler);
db.prepare("INSERT INTO mastery_evidence (node_id, evidence_type, score, total) VALUES (?, 'mastery_check', 6, 10)").run(doppler);
setSetting(`deck_new_per_day_${psId}`, '15');

const stateTool = chatTools({ library: true }).find(t => t.name === 'project_state');
check('the global assistant holds project_state', !!stateTool);
check('the node tutor does not', !chatTools({ web: true }).some(t => t.name === 'project_state'));
const byId = await stateTool.run(String(psId));
const ctx = byId.context || '';
check('found by id, named on the row', byId.count === 1 && byId.label === 'Wave physics', JSON.stringify({ count: byId.count, label: byId.label }));
check('found by a word of its name', (await stateTool.run('wave')).label === 'Wave physics');
check('every open topic is listed with its real id', ctx.includes(`${doppler} · Doppler effect`) && ctx.includes(`${refr} · Refraction`), ctx);
const openPart = ctx.split('Closed topics')[0];
check('a closed topic is counted, not listed as open', !openPart.includes(`${snell} · Snell law`) && /1 of 3 topics closed/.test(ctx), ctx);
// Asked "test me on Snell's law", GLM-5.3-flash found the id only because the
// snapshot happened to carry it: a completed topic can still take a card, and
// its check is a retake, so its id must be readable.
check('...and listed with its id under the closed topics', /Closed topics[^]*\n- \d+ · Snell law/.test(ctx) && ctx.includes(`${snell} · Snell law (in Sound) · completed`), ctx);
// Asked for "a check on the whole Sound section", GLM read the flat list and
// said the project had no such section.
check('every topic names its section', ctx.includes(`${doppler} · Doppler effect (in Sound) · in_progress`), ctx);
check('a note is not a topic', !ctx.includes('A note under Doppler'));
check('mastery is stated where there is evidence, and absence where there is none',
    /Doppler effect[^\n]*mastery 40%/.test(ctx) && /Refraction[^\n]*no evidence yet/.test(ctx), ctx);
check('an overdue topic says so', /Doppler effect[^\n]*OVERDUE/.test(ctx), ctx);
check('cards: due now and never seen are different numbers', /1 due now/.test(ctx) && /1 never seen/.test(ctx), ctx);
check('the project\'s own new-card dial is read', /15 new cards a day/.test(ctx), ctx);
check('recent test results carry the score and the topic', /mastery check[^\n]*Doppler effect[^\n]*6\/10/.test(ctx), ctx);
const missing = await stateTool.run('astrophysics');
check('no such project is a real answer, and lists the ones that exist',
    missing.count === 0 && /no project/i.test(missing.context) && missing.context.includes(`(projectId ${psId}) Wave physics`), missing.context);
db.prepare("INSERT INTO projects (name) VALUES ('Dutch Driving License (Rijbewijs B)')").run();
check('a question that shares one whole word with a name finds it',
    (await stateTool.run('driving theory')).label === 'Dutch Driving License (Rijbewijs B)');
check('a word that only CONTAINS a name\'s word is not a match', (await stateTool.run('astrophysics')).count === 0);
// Measured in the browser walk: project 1 was asked for as "1", and the
// two-character floor every search query has refused it as a malformed call.
check('a one-character id is a usable argument for project_state',
    parseToolCalls('project_state: 1', chatTools({ library: true })).length === 1);
check('...and still not for a search', parseToolCalls('search_web: x', chatTools({ web: true })).length === 0);

section('a card the assistant proposes is added only through one door');
const { addAssistantCard } = await import('../server/assistantWrites.js');
const added = addAssistantCard({ nodeId: doppler, front: 'What shifts in the Doppler effect?', back: 'The observed frequency.' });
check('a card is added to a real topic', Number.isInteger(added.id) && added.existed === false);
const row = db.prepare('SELECT node_id, front, next_review, generated_by FROM flashcards WHERE id = ?').get(added.id);
check('...as a NEW card, never pre-scheduled', row.node_id === doppler && row.next_review === null);
check('...signed with the model that wrote it', typeof row.generated_by === 'string' && row.generated_by.length > 0, String(row.generated_by));
const again = addAssistantCard({ nodeId: doppler, front: '  what shifts in the doppler effect? ', back: 'x' });
check('pressing Add on the same card twice adds it once', again.existed === true && again.id === added.id);
const refuses = (label, input) => { let threw = false; try { addAssistantCard(input); } catch { threw = true; } check(label, threw); };
refuses('a topic that does not exist is refused', { nodeId: 999999, front: 'a', back: 'b' });
refuses('a note is not a place for a card', { nodeId: db.prepare('SELECT id FROM nodes WHERE is_note = 1').get().id, front: 'a', back: 'b' });
refuses('an empty side is refused', { nodeId: doppler, front: '  ', back: 'b' });
refuses('a side past the cap is refused', { nodeId: doppler, front: 'x'.repeat(2001), back: 'b' });
check('the route exists and goes through it', /app\.post\('\/api\/assistant\/cards'/.test(indexSrc) && /addAssistantCard\(/.test(indexSrc));

section('Undo on an added card never throws away what was studied');
// Undo is for "I did not mean to add that". Once the card has been reviewed it
// carries a history the scheduler and the topic's evidence are built on, so it
// is kept and the answer says why. The old Undo was the plain card delete.
const { undoAssistantCard } = await import('../server/assistantWrites.js');
const fresh = addAssistantCard({ nodeId: doppler, front: 'Undo me', back: 'fresh' });
check('an unstudied card is removed', undoAssistantCard(fresh.id).removed === true
    && !db.prepare('SELECT 1 FROM flashcards WHERE id = ?').get(fresh.id));
const studied = addAssistantCard({ nodeId: doppler, front: 'Keep me', back: 'studied' });
db.prepare('INSERT INTO review_log (card_id, reviewed_at, rating, state_before) VALUES (?, ?, 3, 0)').run(studied.id, new Date().toISOString());
const keptResult = undoAssistantCard(studied.id);
check('a reviewed card is KEPT, with its review count', keptResult.kept === true && keptResult.reviews === 1
    && !!db.prepare('SELECT 1 FROM flashcards WHERE id = ?').get(studied.id));
check('its history is untouched', db.prepare('SELECT COUNT(*) AS n FROM review_log WHERE card_id = ?').get(studied.id).n === 1);
check('a card deleted elsewhere is reported gone, not an error', undoAssistantCard(fresh.id).gone === true);
const proposalsSrc = readFileSync(new URL('../src/components/AssistantProposals.tsx', import.meta.url), 'utf8');
check('the preview undoes through that door, never the plain card delete',
    /api\.undoAssistantCard\(/.test(proposalsSrc) && !/api\.deleteFlashcard\(/.test(proposalsSrc)
    && /app\.delete\('\/api\/assistant\/cards\/:id'/.test(indexSrc));

section('every state a proposal can land on');
// Run against GLM-5.3-flash on a seeded library (temp/assistant-live/run.mjs):
// it offered a check on a COMPLETED topic ("a second run to confirm it
// stuck"), and on a deck it could add no card at all ("0 of 0 topics").
const { nodeLabels, masteryCheckTarget, COMPLETED_AT_ON_COMPLETE } = await import('../server/today.js');
const deckId = Number(db.prepare("INSERT INTO projects (name, kind) VALUES ('Dutch words', 'deck')").run().lastInsertRowid);
const stage = Number(db.prepare("INSERT INTO nodes (project_id, title, role) VALUES (?, 'Stage 1', 'pagination')").run(deckId).lastInsertRowid);
db.prepare("INSERT INTO flashcards (node_id, front, back) VALUES (?, 'de hond', 'the dog')").run(stage);
const noteId = db.prepare('SELECT id FROM nodes WHERE is_note = 1').get().id;
const kinds = Object.fromEntries(nodeLabels([doppler, snell, sec, noteId, stage, 999999]).map(r => [r.id, r]));
check('a label says what the id IS', kinds[doppler]?.kind === 'topic' && kinds[sec]?.kind === 'section'
    && kinds[noteId]?.kind === 'note' && kinds[stage]?.kind === 'stage', JSON.stringify(kinds));
check('...with its status, so a completed topic reads as a retake', kinds[snell]?.status === 'completed' && kinds[doppler]?.status === 'in_progress');
check('...and an id that does not exist is absent', !kinds[999999]);
check('the labels route answers through it', /app\.post\('\/api\/nodes\/labels'[^]{0,200}nodeLabels\(/.test(indexSrc));

check('a check may be drawn on an open topic', masteryCheckTarget(doppler).status === 'in_progress');
check('...and on a completed one, which says so', masteryCheckTarget(snell).status === 'completed');
for (const [label, id] of [['a section', sec], ['a note', noteId], ['a deck stage', stage]]) {
    check(`${label} takes no check`, masteryCheckTarget(id).code === 'not_a_topic');
}
check('a deleted topic is a 404, not a quiz generated for nothing', masteryCheckTarget(999999).httpStatus === 404);
check('the draw route asks it before drawing', /mastery-check\/draw'[^]{0,400}masteryCheckTarget\(/.test(indexSrc));

// Completing a completed topic again (a passed retake, a second "mark done")
// must not move the day it was finished.
const FINISHED = '2026-09-01T09:00:00.000Z';
const setDone = db.prepare(`UPDATE nodes SET status = 'completed', completed_at = ${COMPLETED_AT_ON_COMPLETE} WHERE id = ?`);
db.prepare('UPDATE nodes SET completed_at = ? WHERE id = ?').run(FINISHED, snell);
setDone.run(new Date().toISOString(), snell);
check('completing a completed topic keeps its finish date', db.prepare('SELECT completed_at FROM nodes WHERE id = ?').get(snell).completed_at === FINISHED);
const before = new Date(Date.now() - 1000).toISOString();
setDone.run(new Date().toISOString(), refr);
check('...while a first completion is stamped now', db.prepare('SELECT completed_at FROM nodes WHERE id = ?').get(refr).completed_at > before);
// Control: the pre-fix shape moves it — so the assertion above can fail.
db.prepare("UPDATE nodes SET status = 'completed', completed_at = ? WHERE id = ?").run(new Date().toISOString(), snell);
check('(control) the pre-fix shape moved the date', db.prepare('SELECT completed_at FROM nodes WHERE id = ?').get(snell).completed_at !== FINISHED);
db.prepare("UPDATE nodes SET status = 'not_started', completed_at = NULL WHERE id = ?").run(refr);
check('the node update route stamps through it', /completed_at = \$\{COMPLETED_AT_ON_COMPLETE\}/.test(indexSrc));

refuses('a section is not a place for a card', { nodeId: sec, front: 'a', back: 'b' });
check('a deck stage is', addAssistantCard({ nodeId: stage, front: 'het huis', back: 'the house' }).existed === false);
const deckState = (await stateTool.run(String(deckId))).context || '';
check('a deck with no topics lists its card sections with their ids', deckState.includes(`${stage} · Stage 1 · 2 cards`) && /LAST one/.test(deckState), deckState);
check('...and does not call itself "0 of 0 topics"', !/0 of 0 topics/.test(deckState), deckState);
db.prepare("UPDATE projects SET status = 'archived' WHERE id = ?").run(deckId);
check('an archived project says its cards do not come up', /Not active: its cards do not come up in reviews/.test((await stateTool.run(String(deckId))).context), '');

section('a prepared note is filed once, however often its Save is pressed');
const { createCapture, findCapturedText } = await import('../server/capture.js');
const firstNote = createCapture({ text: 'Ask why the signs flip.' });
check('a note that was saved is found by its exact text', findCapturedText('  Ask why the signs flip. ')?.nodeId === firstNote.nodeId);
check('different words are a different note', findCapturedText('Ask why the signs flip!') === null);
check('the capture route consults it only when asked', /once && !url && !hasFiles/.test(indexSrc) && /findCapturedText\(text\)/.test(indexSrc));

section('the prompt teaches the new controls');
const planner = AI_PROMPTS.today_planner({}, 'q', '', '', null, { web: false }).system;
check('the mastery check marker is described', /\[\[check:PROJECT_ID:NODE_ID\]\]/.test(planner));
check('a card is a fenced block with a topic line', /```card/.test(planner) && /topic: PROJECT_ID:NODE_ID/.test(planner));
check('a capture is a fenced block', /```capture/.test(planner));
check('all three are pressed by the learner, not applied', /the learner presses|they press/i.test(planner));
const flat = planner.replace(/\s+/g, ' ');
check('a check is on one topic, never a section', /taken on ONE topic — never a section heading/.test(flat));
check('a completed topic is a retake that stays completed', /retaken: say it is a retake, and that the topic stays completed/.test(flat));
check('a deck\'s card goes on its last card section', /LAST card section/.test(flat));

console.log(`\n${pass} passed, ${fail} failed`);
// Ended, not killed. `process.exit()` while the stub endpoint's handle is still
// open aborts node with a libuv assertion (`UV_HANDLE_CLOSING`, win/async.c) —
// which exits 127 and fails a suite in which every assertion passed. Setting the
// code and closing the server lets the loop drain on its own.
try { db.close(); } catch { /* best effort */ }
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* Windows file locks */ }
process.exitCode = fail ? 1 : 0;
server.close();
