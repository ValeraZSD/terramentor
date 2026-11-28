// tools/chat-search-gates.mjs — searching old conversations.
//
// Run:  node tools/chat-search-gates.mjs
//
// `GET /api/ai/conversations?q=` finds the conversations whose title or
// messages hold the words asked for, one row per conversation, with a snippet
// of the best message and where in it the words are. This asserts, against the
// REAL routes on a scratch library and a stub model on loopback (nothing
// billed, nothing leaves the machine):
//
//   1. messages written before the index existed are found (a library that
//      predates this build is backfilled, not left blind);
//   2. matching ignores case and accents in Dutch, Russian and French, and a
//      word is found by its start;
//   3. the index follows every write: a real turn, a plain insert, an edit
//      through the repair route, the delete of one message and of a whole
//      conversation; a deleted message's words leave the index AT ONCE, not at
//      the next search;
//   4. what is indexed is what the learner reads: app markers (`[[src:1]]`,
//      `[[open:p:n]]`) and chart specs are not, a card's two sides are, and a
//      snippet shows the matched words without markers or fences;
//   5. a title matches on its own and ranks first, a deleted topic's
//      conversation is still found, results are capped, a conversation full
//      of matches cannot crowd the others out, a search indexes a bounded
//      batch, a one-letter word is itself, and a query of punctuation or FTS
//      syntax is an answer, never a 500;
//   6. a search writes nothing to the activity log;
//   7. the drawer finds a message under its saved id, spends a jump once the
//      conversation is drawn, and never shows the server's words on failure;
//   8. without the index (no FTS5) a search answers from the titles.
//
// Each expected conversation is named by the literal title the fixture gave
// it, never by asking the index which rows hold a word.

import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const scratch = mkdtempSync(join(tmpdir(), 'chat-search-gates-'));
const DB_FILE = join(scratch, 'test.db');
process.env.DB_PATH = DB_FILE;
process.env.VAULT_ROOT = join(scratch, 'vault');
process.env.DATA_DIR = scratch;
mkdirSync(process.env.VAULT_ROOT, { recursive: true });

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${String(extra).slice(0, 400)}` : ''}`); }
};

// ---- a library from before the index ------------------------------------------------
// The chat tables as a build without search left them, with rows in them. The
// app then opens this file and must index what is already there.
{
    const old = new Database(DB_FILE);
    old.pragma('foreign_keys = OFF');
    old.exec(`
        CREATE TABLE chat_conversations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL DEFAULT '',
            node_id INTEGER,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE chat_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            node_id INTEGER,
            project_id INTEGER,
            role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
            content TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            conversation_id INTEGER DEFAULT NULL
        );
    `);
    const conv = old.prepare('INSERT INTO chat_conversations (title, created_at, updated_at) VALUES (?, ?, ?)');
    const msg = old.prepare('INSERT INTO chat_messages (conversation_id, role, content) VALUES (?, ?, ?)');
    const thread = (title, at, ...turns) => {
        const id = Number(conv.run(title, at, at).lastInsertRowid);
        turns.forEach(([role, content]) => msg.run(id, role, content));
        return id;
    };
    thread('Wat betekent dat woord?', '2026-10-01T09:00:00.000Z',
        ['user', 'Wat betekent dat woord?'],
        ['assistant', 'Mijn grootouders zijn in 1956 **geëmigreerd** naar Canada: het voltooid deelwoord van emigreren. [[src:1]]']);
    thread('Объясни конденсатор', '2026-10-02T09:00:00.000Z',
        ['user', 'Объясни конденсатор'],
        ['assistant', 'Ёмкость конденсатора показывает, какой заряд он накапливает при данном напряжении.']);
    thread('Un dessert français', '2026-10-03T09:00:00.000Z',
        ['user', 'Un dessert français'],
        ['assistant', 'La crème brûlée se sert froide, avec un café.']);
    thread('Waves and a card', '2026-10-04T09:00:00.000Z',
        ['user', 'Make me a card about waves'],
        ['assistant', [
            'Here is one for your deck. [[open:3:41]]',
            '',
            '```card',
            'topic: 3:41',
            'front: What forms a standing wave?',
            'back: Two equal waves travelling in opposite directions.',
            '```',
            '',
            '```vega-lite',
            '{"mark":"line","encoding":{"x":{"field":"zeppelin","type":"quantitative"}}}',
            '```',
            '',
            'And a loop in Python:',
            '',
            '```python',
            'for harmonic in range(1, 4):',
            '    print(harmonic)',
            '```',
        ].join('\n')]);
    old.close();
}

// ---- stub model ----------------------------------------------------------------------
let answer = 'A stub answer.';
const stub = createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
        if (req.url.endsWith('/models')) {
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ data: [{ id: 'stub-model' }] }));
        }
        const body = JSON.parse(raw || '{}');
        if (body.stream) {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\n`);
            res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
            res.write('data: [DONE]\n\n');
            return res.end();
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: answer }, finish_reason: 'stop' }], usage: { completion_tokens: 3 } }));
    });
});
await new Promise(r => stub.listen(0, '127.0.0.1', r));
process.env.AI_PROVIDER = 'openai';
process.env.AI_BASE_URL = `http://127.0.0.1:${stub.address().port}/v1`;
process.env.AI_MODEL = 'stub-model';
process.env.AI_API_KEY = 'stub-key';

// ---- the real app on the scratch library ---------------------------------------------
const { default: db } = await import('../server/database.js');
if (!/chat-search-gates-/.test(process.env.DB_PATH)) throw new Error('refusing to run against a library that is not the scratch one');
const setSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
setSetting.run('ai_enabled', 'true');
setSetting.run('embedding_enabled', 'false');
setSetting.run('ai_web_search', 'off');
setSetting.run('ui_language', 'en');

const { createApp } = await import('../server/app.js');
const server = createServer(createApp());
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

let search;
try { search = await import('../server/chatSearch.js'); } catch (e) { search = null; console.log(`  (server/chatSearch.js did not load: ${e.message})`); }
const LIMIT = search?.CHAT_SEARCH_LIMIT ?? 50;

async function find(q) {
    const res = await fetch(`${base}/api/ai/conversations?q=${encodeURIComponent(q)}`);
    const body = await res.json().catch(() => null);
    return { status: res.status, rows: Array.isArray(body) ? body : [], body };
}
const titles = (r) => r.rows.map(c => c.title);
const only = (r, title) => r.status === 200 && r.rows.length === 1 && r.rows[0].title === title;
const shown = (r) => JSON.stringify(r.rows.map(c => ({ title: c.title, match: c.match })) ?? r.body).slice(0, 400);
const indexRows = (id) => {
    try { return db.prepare('SELECT COUNT(*) AS n FROM chat_messages_fts WHERE rowid = ?').get(id).n; } catch { return -1; }
};

/** One assistant turn, read to its end. */
async function ask(message, conversationId) {
    const res = await fetch(`${base}/api/ai/assistant/stream`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message, conversationId, timeZone: 'UTC' }),
    });
    const text = await res.text();
    const frames = text.split('\n').filter(l => l.startsWith('data: ')).map(l => { try { return JSON.parse(l.slice(6)); } catch { return {}; } });
    return frames.find(f => typeof f.conversationId === 'number')?.conversationId ?? null;
}

// ---- 1. backfill ----------------------------------------------------------------------
console.log('\n1. a library from before the index is searchable');
const staleCount = () => { try { return db.prepare('SELECT COUNT(*) AS n FROM chat_search_stale').get().n; } catch { return -1; } };
const queuedAtStart = staleCount();
// The pass starts a second after load and runs in small steps: wait for it
// with a deadline, never a fixed sleep a slow machine could outlast.
for (const until = Date.now() + 10_000; staleCount() > 0 && Date.now() < until;) await new Promise(r => setTimeout(r, 50));
ok('the start queues the older messages, and a background pass indexes them before any search',
    queuedAtStart > 0 && staleCount() === 0, `queued ${queuedAtStart}, left ${staleCount()}`);
const dutch = await find('geëmigreerd');
ok('a word in a message written before the index existed is found', only(dutch, 'Wat betekent dat woord?'), shown(dutch));
ok('the row is the conversation, with its list fields', dutch.rows[0] && typeof dutch.rows[0].id === 'number'
    && typeof dutch.rows[0].updatedAt === 'string' && dutch.rows[0].messageCount === 2, shown(dutch));
const dm = dutch.rows[0]?.match;
const dutchMsg = db.prepare("SELECT id, conversation_id FROM chat_messages WHERE content LIKE '%Canada%'").get();
ok('its match names the message that holds the word, in that conversation', dm?.messageId === dutchMsg?.id && dutch.rows[0]?.id === dutchMsg?.conversation_id && dm?.role === 'assistant', JSON.stringify(dm));

// ---- 2. languages ---------------------------------------------------------------------
console.log('\n2. case, accents and the start of a word');
for (const [q, title, why] of [
    ['geemigreerd', 'Wat betekent dat woord?', 'Dutch without the diaeresis'],
    ['GEËMIGREERD', 'Wat betekent dat woord?', 'Dutch in capitals'],
    ['geëmig', 'Wat betekent dat woord?', 'the start of a Dutch word'],
    ['ёмкость', 'Объясни конденсатор', 'Russian with ё'],
    ['емкость', 'Объясни конденсатор', 'Russian with е for ё'],
    ['ЁМКОСТЬ', 'Объясни конденсатор', 'Russian in capitals'],
    ['конденсатор', 'Объясни конденсатор', 'a Russian word in another case (конденсатора)'],
    ['creme brulee', 'Un dessert français', 'French without accents, two words'],
    ['Brûlée', 'Un dessert français', 'French with accents'],
]) {
    const r = await find(q);
    ok(`${why}: “${q}”`, only(r, title), shown(r));
}
const ru = await find('емкость');
const ruSnip = ru.rows[0]?.match;
ok('the snippet shows the message as written, ё and all, with the word marked', /^Ёмкость конденсатора/.test(ruSnip?.snippet ?? '')
    && ruSnip?.ranges?.[0]?.[0] === 0 && ruSnip.snippet.slice(...ruSnip.ranges[0]) === 'Ёмкость', JSON.stringify(ruSnip));
const both = await find('crème canada');
ok('every word must match: two words from two conversations find neither', both.status === 200 && both.rows.length === 0, shown(both));

// ---- 3. the index follows every write -------------------------------------------------
console.log('\n3. the index follows every write');
answer = 'Fotosynthese zet licht om in suiker, in het bladgroen.';
const turnConv = await ask('Leg fotosynthese uit');
const afterTurn = await find('bladgroen');
ok("a real turn's answer is found", turnConv != null && afterTurn.rows.length === 1 && afterTurn.rows[0].id === turnConv, shown(afterTurn));
const asked = await find('fotosynthese');
ok("and the learner's own question in it", asked.rows.length === 1 && asked.rows[0].id === turnConv, shown(asked));

const waves = db.prepare("SELECT id FROM chat_conversations WHERE title = 'Waves and a card'").get().id;
const inserted = Number(db.prepare('INSERT INTO chat_messages (conversation_id, role, content) VALUES (?, ?, ?)')
    .run(waves, 'user', 'What about the xylophone bar?').lastInsertRowid);
const ins = await find('xylophone');
ok('a message inserted by any writer is found', only(ins, 'Waves and a card') && ins.rows[0].match?.messageId === inserted, shown(ins));

const edit = await fetch(`${base}/api/ai/chat/message/${inserted}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'What about the marimba bar?' }),
});
ok('the repair route takes the edit', edit.status === 200);
ok("an edit takes the old words out at once, before any search", indexRows(inserted) === 0, `rows: ${indexRows(inserted)}`);
const oldWord = await find('xylophone');
const newWord = await find('marimba');
ok('after an edit the old word is gone', oldWord.status === 200 && oldWord.rows.length === 0, shown(oldWord));
ok('and the new word is found', only(newWord, 'Waves and a card'), shown(newWord));

db.prepare('DELETE FROM chat_messages WHERE id = ?').run(inserted);
ok("a deleted message's words leave the index at once, before any search", indexRows(inserted) === 0, `rows: ${indexRows(inserted)}`);
const gone = await find('marimba');
ok('a deleted message is not found', gone.status === 200 && gone.rows.length === 0, shown(gone));

const turnMsgIds = db.prepare('SELECT id FROM chat_messages WHERE conversation_id = ?').all(turnConv).map(r => r.id);
const delConv = await fetch(`${base}/api/ai/conversations/${turnConv}`, { method: 'DELETE' });
ok('the conversation delete route takes it', delConv.status === 200);
ok("a deleted conversation's messages leave the index at once", turnMsgIds.length === 2 && turnMsgIds.every(id => indexRows(id) === 0), turnMsgIds.map(indexRows).join(','));
const afterDel = await find('bladgroen');
ok('and none of its words is found', afterDel.status === 200 && afterDel.rows.length === 0, shown(afterDel));

// ---- 4. what is indexed ---------------------------------------------------------------
console.log('\n4. the words the learner reads, never the markers');
for (const [q, why] of [
    ['src', 'a citation marker'],
    ['open', 'a topic-chip marker'],
    ['zeppelin', "a word only inside a chart's spec"],
    ['encoding', "a chart spec's key"],
]) {
    const r = await find(q);
    ok(`${why} is not indexed: “${q}”`, r.status === 200 && r.rows.length === 0, shown(r));
}
// Math is what the drawer draws as math, and only that: two prices on a line
// are not a formula, and `\(…\)` is one.
const sums = Number(db.prepare('INSERT INTO chat_conversations (title, created_at, updated_at) VALUES (?, ?, ?)')
    .run('Costs', '2026-10-04T09:00:00.000Z', '2026-10-04T09:00:00.000Z').lastInsertRowid);
const sumMsg = db.prepare('INSERT INTO chat_messages (conversation_id, role, content) VALUES (?, ?, ?)');
sumMsg.run(sums, 'user', String.raw`Paid $5 for notes\lambda\tides and $6 for the rest.`);
sumMsg.run(sums, 'assistant', String.raw`The phase is \(\omega t + \varphi\) and the display${'\n'}\[\nabla \cdot E\]`);
const prices = await find('tides');
ok('two prices on a line are not math: a path between them keeps its words', only(prices, 'Costs'), shown(prices));
for (const q of ['varphi', 'omega', 'nabla']) {
    const r = await find(q);
    ok(`a TeX command inside \\(…\\) or \\[…\\] is not a word: “${q}”`, r.status === 200 && r.rows.length === 0, shown(r));
}
const blank = Number(db.prepare('INSERT INTO chat_conversations (title, created_at, updated_at) VALUES (?, ?, ?)')
    .run('Two sums', '2026-10-04T10:00:00.000Z', '2026-10-04T10:00:00.000Z').lastInsertRowid);
sumMsg.run(blank, 'user', String.raw`Start with $$ in one paragraph.${'\n\n'}Then read notes\physics\pulleys and end with $$.`);
const crossed = await find('pulleys');
ok('display math never runs over a blank line', only(crossed, 'Two sums'), shown(crossed));
const front = await find('standing wave');
ok("a card's front is found", only(front, 'Waves and a card'), shown(front));
const back = await find('opposite directions');
ok("and its back", only(back, 'Waves and a card'), shown(back));
const code = await find('harmonic');
ok('code in an ordinary code block is found', only(code, 'Waves and a card'), shown(code));
const cardTopic = await find('topic');
ok("a card's field names are not words of the answer", cardTopic.rows.length === 0, shown(cardTopic));

const snip = dutch.rows[0]?.match;
ok('a snippet comes with the match', typeof snip?.snippet === 'string' && snip.snippet.length > 0 && snip.snippet.length <= 400, JSON.stringify(snip));
const fold = (s) => s.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
ok('its ranges mark the matched word in the snippet', Array.isArray(snip?.ranges) && snip.ranges.length >= 1
    && snip.ranges.every(([a, b]) => fold(snip.snippet.slice(a, b)).startsWith('geemigreerd')), JSON.stringify(snip));
ok('a snippet carries no marker, fence or emphasis', !/\[\[|```|\*\*/.test(snip?.snippet ?? '[['), snip?.snippet);
const cardSnip = front.rows[0]?.match?.snippet ?? '';
ok("a card's snippet reads as words, without its field names", /standing wave/i.test(cardSnip) && !/front:|topic:|```/.test(cardSnip), cardSnip);

// The server's list of drawn blocks is the client's: every visual alias but
// math (kept: its symbols are read), and every drill fence. Read from the
// client's source text, so a new alias there fails here until it is added.
{
    const registry = readFileSync(new URL('../src/components/visuals/registry.ts', import.meta.url), 'utf8');
    const aliasBody = registry.match(/const ALIASES[^{]*\{([\s\S]*?)\n\};/)?.[1] ?? '';
    const aliases = [...aliasBody.matchAll(/^\s*'?([a-z0-9-]+)'?\s*:\s*'([a-z0-9-]+)'/gm)].filter(m => m[2] !== 'math').map(m => m[1]);
    const drill = readFileSync(new URL('../src/components/drills/parseDrill.ts', import.meta.url), 'utf8');
    const drills = [...(drill.match(/DRILL_FENCE_LANGS = new Set\(\[([^\]]*)\]/)?.[1] ?? '').matchAll(/'([^']+)'/g)].map(m => m[1]);
    const drawn = search?.DRAWN_FENCES ?? new Set();
    const want = new Set([...aliases, ...drills]);
    ok('the blocks left out are exactly the ones the client draws (visual aliases but math, drills)',
        aliases.length > 10 && drills.length > 0 && want.size === drawn.size && [...want].every(l => drawn.has(l)),
        `client: ${[...want].join(',')} | server: ${[...drawn].join(',')}`);
}

if (search?.searchableText) {
    const t = search.searchableText('See [[src:2]] and [[open:3:41]].\n```smiles\nCCO\n```\n**Bold** `code`');
    ok('searchableText keeps the words and drops what the app draws', !/\[\[|src|CCO|\*\*|`/.test(t) && /See/.test(t) && /Bold/.test(t) && /code/.test(t), t);
    const path = search.searchableText(String.raw`Saved in notes\physics\waves.md, where $\lambda = 2L$ holds.`);
    ok('a Windows path in prose keeps its words; TeX commands go only inside $…$', /physics/.test(path) && /waves/.test(path) && /notes/.test(path) && !/lambda/.test(path) && /2L/.test(path), path);
    const crlf = search.searchableText('Here:\r\n```card\r\nfront: Ohm law\r\nback: V = IR\r\n```\r\nafter');
    ok("a message with Windows line ends still closes its fences (no field names indexed)", !/front|back/.test(crlf) && /Ohm law/.test(crlf) && /after/.test(crlf), crlf);
    const inCode = search.searchableText('```python\nrow = grid[[1]]\n```');
    ok('a marker-shaped text inside code is the code, and stays', /grid\[\[1\]\]/.test(inCode), inCode);
} else ok('server/chatSearch.js exports searchableText', false);

// ---- 5. titles, topics, caps, odd queries ---------------------------------------------
console.log('\n5. titles, deleted topics, the cap and odd queries');
const filesOnly = Number(db.prepare('INSERT INTO chat_conversations (title, created_at, updated_at) VALUES (?, ?, ?)')
    .run('leaf-cross-section.png', '2026-10-05T09:00:00.000Z', '2026-10-05T09:00:00.000Z').lastInsertRowid);
db.prepare('INSERT INTO chat_messages (conversation_id, role, content) VALUES (?, ?, ?)').run(filesOnly, 'user', '');
const byTitle = await find('cross-section');
ok('a title matches on its own (a message of files alone)', only(byTitle, 'leaf-cross-section.png') && byTitle.rows[0].match == null, shown(byTitle));

const project = Number(db.prepare("INSERT INTO projects (name) VALUES ('Optics')").run().lastInsertRowid);
const topic = (title) => Number(db.prepare('INSERT INTO nodes (project_id, parent_id, title, position, status) VALUES (?, NULL, ?, 0, ?)')
    .run(project, title, 'not_started').lastInsertRowid);
const lensTopic = topic('Thin lenses');
const lensConv = Number(db.prepare('INSERT INTO chat_conversations (title, node_id, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run('Why does a lens focus?', lensTopic, '2026-10-06T09:00:00.000Z', '2026-10-06T09:00:00.000Z').lastInsertRowid);
db.prepare('INSERT INTO chat_messages (conversation_id, role, content) VALUES (?, ?, ?)').run(lensConv, 'assistant', 'Refraction bends parallel rays to one focal point.');
const withTopic = await find('refraction');
ok('a conversation that began on a topic names it', only(withTopic, 'Why does a lens focus?') && withTopic.rows[0].nodeTitle === 'Thin lenses', shown(withTopic));
db.prepare('UPDATE nodes SET deleted_at = ? WHERE id = ?').run('2026-10-06T12:00:00.000Z', lensTopic);
const softGone = await find('refraction');
ok('after its topic is deleted the conversation is still found, the topic unnamed', only(softGone, 'Why does a lens focus?') && softGone.rows[0].nodeTitle == null, shown(softGone));
db.prepare('DELETE FROM nodes WHERE id = ?').run(lensTopic);
const hardGone = await find('refraction');
ok('and after the topic row itself is gone', only(hardGone, 'Why does a lens focus?'), shown(hardGone));

const many = db.prepare('INSERT INTO chat_conversations (title, created_at, updated_at) VALUES (?, ?, ?)');
const manyMsg = db.prepare('INSERT INTO chat_messages (conversation_id, role, content) VALUES (?, ?, ?)');
db.transaction(() => {
    for (let i = 0; i < LIMIT + 15; i++) {
        const at = new Date(Date.UTC(2026, 9, 7, 0, i)).toISOString();
        const id = Number(many.run(`Question ${i}`, at, at).lastInsertRowid);
        manyMsg.run(id, 'assistant', `The quokka lives on Rottnest island (note ${i}).`);
    }
})();
const capped = await find('quokka');
ok(`results are capped at ${LIMIT} conversations, one row each`, capped.status === 200 && capped.rows.length === LIMIT
    && new Set(capped.rows.map(c => c.id)).size === LIMIT, `${capped.rows.length} rows`);

// Its only message says the word once among many, so bm25 alone ranks it
// below every short "quokka" message: only the title puts it first.
const titled = Number(many.run('Quokka facts', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z').lastInsertRowid);
manyMsg.run(titled, 'user', `Tell me about the small marsupial, the quokka, ${'and the island it lives on, its diet, its habits and its size, '.repeat(6)}please.`);
const ranked = await find('quokka');
ok('a conversation whose title holds the words comes first, ahead of better-ranked messages', ranked.rows[0]?.id === titled, titles(ranked).slice(0, 3).join(' | '));

// One conversation with far more matching messages than the others, each of
// them short (bm25's favourite): every conversation still gets its row.
const lecture = Number(many.run('Ocelot lecture', '2026-09-02T00:00:00.000Z', '2026-09-02T00:00:00.000Z').lastInsertRowid);
db.transaction(() => { for (let i = 0; i < 1200; i++) manyMsg.run(lecture, 'assistant', `Ocelot ${i}.`); })();
const quiet = ['At the zoo', 'A drawing', 'Wild cats'].map((title, i) => {
    const id = Number(many.run(title, `2026-09-0${3 + i}T00:00:00.000Z`, `2026-09-0${3 + i}T00:00:00.000Z`).lastInsertRowid);
    manyMsg.run(id, 'user', `${'We talked for a long while about cats, their habits, their range and their prey, '.repeat(5)}and then the ocelot came up (${i}).`);
    return id;
});
const crowd = await find('ocelot');
const crowdIds = new Set(crowd.rows.map(c => c.id));
ok('a conversation full of matches cannot crowd the others out', crowdIds.has(lecture) && quiet.every(id => crowdIds.has(id)), titles(crowd).join(' | '));

// A search indexes at most 2000 queued messages, so a big backlog never
// stalls the server; the next search takes the rest.
const bulk = Number(many.run('Bulk', '2026-09-05T12:00:00.000Z', '2026-09-05T12:00:00.000Z').lastInsertRowid);
db.transaction(() => { for (let i = 0; i < 2600; i++) manyMsg.run(bulk, 'assistant', `Filler line ${i}.`); })();
await find('nothingsaidthis');
const leftAfterOne = staleCount();
await find('nothingsaidthis');
ok('one search indexes a bounded batch (2000), the next takes the rest', leftAfterOne === 600 && staleCount() === 0, `left ${leftAfterOne}, then ${staleCount()}`);

// A one-letter word is that word, never the start of every word.
const cpp = Number(many.run('Languages at work', '2026-09-06T00:00:00.000Z', '2026-09-06T00:00:00.000Z').lastInsertRowid);
manyMsg.run(cpp, 'user', 'At work I write C++ every day, and my cats sleep on the desk.');
const cats = Number(many.run('Pets', '2026-09-07T00:00:00.000Z', '2026-09-07T00:00:00.000Z').lastInsertRowid);
manyMsg.run(cats, 'user', 'Cats purr when content.');
const cq = await find('C++');
ok('“C++” finds the word c, not every word that starts with c', cq.rows.some(c => c.id === cpp) && !cq.rows.some(c => c.id === cats), titles(cq).join(' | '));
const cppSnip = cq.rows.find(c => c.id === cpp)?.match;
const cppMarked = (cppSnip?.ranges ?? []).map(([a, b]) => cppSnip.snippet.slice(a, b));
ok('and its snippet marks the word c, not “cats”', cppMarked.length > 0 && cppMarked.every(w => w === 'C'), JSON.stringify(cppMarked));
// A script written without spaces is one word to the tokenizer, so one
// character of it is the start of that word.
const zh = Number(many.run('中文练习', '2026-09-06T06:00:00.000Z', '2026-09-06T06:00:00.000Z').lastInsertRowid);
manyMsg.run(zh, 'user', '他们是学生。');
const han = await find('他');
ok('one Chinese character finds the message that starts a word with it', han.rows.some(c => c.id === zh && c.match != null), shown(han));
const hanTitle = await find('中');
ok('and the title that does', hanTitle.rows.some(c => c.id === zh), shown(hanTitle));

for (const q of ['"', '*', '()', 'NEAR(', 'AND', 'a OR', '-', '"unbalanced', 'col:word', '^start']) {
    const r = await find(q);
    ok(`an odd query is an answer, never an error: ${JSON.stringify(q)}`, r.status === 200 && Array.isArray(r.body), `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
}
// FTS keywords asked for are words, found where they were said.
const jazz = Number(many.run('Music', '2026-09-08T00:00:00.000Z', '2026-09-08T00:00:00.000Z').lastInsertRowid);
manyMsg.run(jazz, 'user', 'Rock AND roll, or a jazz band NEAR the river?');
for (const q of ['AND', 'a OR', 'NEAR']) {
    const r = await find(q);
    ok(`an FTS keyword is a word: ${JSON.stringify(q)} finds the message that says it`, r.rows.some(c => c.id === jazz), titles(r).slice(0, 5).join(' | '));
}
const empty = await find('   ');
const plain = await (await fetch(`${base}/api/ai/conversations`)).json();
ok('a blank query is the plain list, newest first', empty.status === 200 && empty.rows.length === plain.length && empty.rows[0]?.id === plain[0]?.id);
const long = await find('quokka '.repeat(400));
ok('a very long query is cut, not refused', long.status === 200 && long.rows.length > 0, `${long.status}`);

// ---- 6. nothing logged ----------------------------------------------------------------
console.log('\n6. a search is a read');
const logged = () => db.prepare('SELECT COUNT(*) AS n FROM activity_log').get().n;
const beforeLog = logged();
await find('quokka');
await find('geëmigreerd');
ok('a search writes nothing to the activity log', logged() === beforeLog, `${beforeLog} → ${logged()}`);

// ---- 7. the drawer --------------------------------------------------------------------
// Read from the source: the drawer has no DOM harness here. The states
// themselves are walked in a browser (empty, results, no match, failed).
console.log('\n7. the drawer');
{
    const drawer = readFileSync(new URL('../src/components/AssistantDrawer.tsx', import.meta.url), 'utf8');
    ok('a message is found under its SAVED id (one sent this session is drawn under a stand-in id)',
        /data-message-id=\{savedId\}/.test(drawer) && /const savedId = dbIdRef\.current\.get\(m\.id\) \?\? m\.id/.test(drawer) && /foundMessageId === savedId/.test(drawer));
    ok('a failed search never shows the server\'s words, and offers Try again',
        !/search\.error|Could not search the conversations/.test(drawer) && /search\.failed[\s\S]{0,900}search\.retry/.test(drawer));
    ok('a pending jump is spent once the conversation is drawn, found or not',
        /jumpToRef\.current = null;\s*const el = box\.querySelector/.test(drawer));
}

// A library busy for a moment (another writer holds it) is a failed request
// the drawer asks again, never a quiet answer from the titles alone.
{
    manyMsg.run(lecture, 'user', 'One more ocelot to index.');
    const other = new Database(DB_FILE);
    const oldTimeout = db.pragma('busy_timeout', { simple: true });
    db.pragma('busy_timeout = 50');
    other.exec('BEGIN IMMEDIATE');
    const quiet = console.error;
    console.error = () => {};
    const busy = await find('ocelot');
    console.error = quiet;
    other.exec('ROLLBACK');
    other.close();
    db.pragma(`busy_timeout = ${oldTimeout}`);
    ok('a busy library fails the request, so the drawer retries', busy.status >= 500, `${busy.status} ${shown(busy)}`);
    const after = await find('ocelot');
    ok('and the next search answers in full', after.status === 200 && after.rows.some(c => c.id === lecture && c.match != null), shown(after));
}

// ---- 8. no index ----------------------------------------------------------------------
// A SQLite without FTS5 has no index table and no triggers: a search still
// answers from the titles, and the reason stays in the server's log.
console.log('\n8. without the index');
db.exec(`
    DROP TRIGGER chat_messages_search_ai;
    DROP TRIGGER chat_messages_search_au;
    DROP TRIGGER chat_messages_search_ad;
    DROP TABLE chat_messages_fts;
`);
const quietErr = console.error;
const errs = [];
console.error = (...a) => { errs.push(a.join(' ')); };
const noIndex = await find('quokka facts');
const noIndexBody = await find('refraction');
await find('ocelot');
console.error = quietErr;
ok('a search with no index answers from the titles, never a 500', noIndex.status === 200 && noIndex.rows[0]?.title === 'Quokka facts' && noIndex.rows[0]?.match == null, shown(noIndex));
ok('and finds nothing it cannot read, without an error to the learner', noIndexBody.status === 200 && noIndexBody.rows.length === 0, shown(noIndexBody));
ok('the reason goes to the server log, once, not on every search', errs.filter(e => /chat search/.test(e)).length === 1, errs.join(' | ').slice(0, 200));

server.close();
stub.close();
try { db.close(); } catch { /* closed */ }
rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
