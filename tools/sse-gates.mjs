// tools/sse-gates.mjs — every server-sent-event stream the page reads goes
// through one reader, and each caller keeps the contract it had.
//
// Run:  node tools/sse-gates.mjs [--root DIR]
//       (--root reads DIR/src instead of this checkout's, to run the gate
//        against another version of the client)
//
// Two halves, both in Node with no server, no model and no network:
//
//   1. The reader (src/utils/sse.ts `readSse`) fed byte streams by hand: one
//      fixture holding `\r\n`, `\n` and `\r` line ends, a comment, a field with
//      no space after the colon, a multi-line `data:`, frames that are not
//      JSON objects, a Cyrillic word and an emoji, and a last frame with no blank line
//      after it, cut at every byte position (and every pair of positions),
//      inside the `\r\n` pairs and the multi-byte characters included. The
//      frames it must give back are written out below by hand, not computed by
//      any parser. Then: an abort mid-stream (the reader is cancelled, the
//      stream answers with an AbortError or ends quietly as asked, and no
//      promise is left rejected with nobody listening), the caller leaving
//      early or throwing (the reader is cancelled), a failed read, and a quiet
//      socket (the stale deadline).
//
//   2. The callers in src/api.ts, bundled from the real source with `fetch`
//      stubbed. Each is fed its own server's frames, cut at every byte
//      position, and must report the same callbacks, yields, result or error
//      as before the reader existed: the assistant turn, course creation and
//      the quiz stream are pinned case by case (server error frame, refused
//      request, abort, a stream that ends early, a quiet socket); the other
//      nine are pinned on their usual run and their error frame.
//
// The stub answers an abort the way a browser's fetch does: the body stream is
// errored with the signal's reason.

import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const here = dirname(fileURLToPath(import.meta.url));
const rootArg = process.argv.indexOf('--root');
const root = rootArg > 0 ? resolve(process.argv[rootArg + 1]) : resolve(here, '..');

let pass = 0;
const failures = [];
const ok = (name, cond, detail = '') => {
    if (cond) pass++;
    else failures.push(detail ? `${name} — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : name);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const eq = (name, got, want) => ok(name, same(got, want), { got, want });

// Promises rejected with no handler, collected per case.
const unhandled = [];
process.on('unhandledRejection', (reason) => { unhandled.push(reason); });
const settle = () => new Promise(r => setTimeout(r, 15));

// The stale deadline is 50 s on the page; here it is 40 ms.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, ms === 50_000 ? 40 : ms, ...rest);
globalThis.window = globalThis;

const enc = new TextEncoder();

// A reader that never notices an abort or a cancel hangs instead of failing.
realSetTimeout(() => {
    console.log('  ✗ the gate did not finish in 60 s: a stream never ended');
    process.exit(1);
}, 60_000).unref();

/**
 * A body stream under the test's hand: `parts` are handed out one per read,
 * then it closes, hangs (`hang`) or fails (`failWith`). `cancelled` records a
 * cancel reaching the source.
 */
function source(parts, { hang = false, failWith = null } = {}) {
    const state = { cancelled: false, controller: null, reads: 0 };
    let i = 0;
    state.stream = new ReadableStream({
        start(c) { state.controller = c; },
        pull(c) {
            state.reads++;
            if (i < parts.length) { c.enqueue(parts[i++]); return; }
            if (failWith) { c.error(failWith); return; }
            if (hang) return new Promise(() => {});
            c.close();
        },
        cancel() { state.cancelled = true; },
    }, { highWaterMark: 0 });
    return state;
}

/** Every way to cut `bytes` once, plus one byte at a time. */
function cuts(bytes) {
    const out = [[bytes]];
    for (let p = 1; p < bytes.length; p++) out.push([bytes.slice(0, p), bytes.slice(p)]);
    out.push(Array.from(bytes, b => Uint8Array.of(b)));
    return out;
}

const tmp = mkdtempSync(join(tmpdir(), 'sse-gates-'));
process.on('exit', () => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

async function bundle(entry, name) {
    const out = join(tmp, name);
    const stub = join(tmp, 'i18n-stub.js');
    writeFileSync(stub, 'export const k = (s) => s;\nexport default {};\n');
    await esbuild.build({
        entryPoints: [entry],
        bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent',
        plugins: [{ name: 'stub-i18n', setup(b) { b.onResolve({ filter: /(^|\/)(i18n|locale)$/ }, () => ({ path: stub })); } }],
    });
    return import(pathToFileURL(out).href);
}

// ─── 1. the reader ──────────────────────────────────────────────────────────

const helperPath = join(root, 'src', 'utils', 'sse.ts');
const sse = existsSync(helperPath) ? await bundle(helperPath, 'sse.mjs') : null;
ok('src/utils/sse.ts exports readSse', typeof sse?.readSse === 'function');

if (sse?.readSse) {
    const { readSse } = sse;
    const collect = async (body, opts) => {
        const got = [];
        for await (const f of readSse(body, opts)) got.push(f);
        return got;
    };

    const FIXTURE = [
        ': keepalive\r\n\r\n',
        'data: {"a":1}\r\n\r\n',
        'data:{"b":"Привет"}\n\n',
        'event: progress\rdata: {"c":"🌍 ок"}\r\r',
        'id: 5\r\nretry: 10\ndata: {"d":\r\ndata: 2}\n\n',
        'data: [DONE]\n\n',
        'data\n\n',
        'data: null\n\ndata: 5\n\ndata: []\n\ndata: "text"\n\n',
        'data: {"e":true}',
    ].join('');
    const WANT = [{ a: 1 }, { b: 'Привет' }, { c: '🌍 ок' }, { d: 2 }, { e: true }];
    const bytes = enc.encode(FIXTURE);

    let wrong = null, runs = 0;
    for (const parts of cuts(bytes)) {
        runs++;
        const got = await collect(source(parts).stream);
        if (!same(got, WANT)) { wrong = { cut: parts.map(p => p.length), got }; break; }
    }
    ok(`the fixture reads the same cut at every byte position (${runs} ways)`, !wrong, wrong);

    wrong = null; runs = 0;
    for (let p = 1; p < bytes.length - 1 && !wrong; p++) {
        for (let q = p + 1; q < bytes.length; q++) {
            runs++;
            const got = await collect(source([bytes.slice(0, p), bytes.slice(p, q), bytes.slice(q)]).stream);
            if (!same(got, WANT)) { wrong = { cut: [p, q], got }; break; }
        }
    }
    ok(`…and at every pair of positions (${runs} ways)`, !wrong, wrong);

    // A cut inside `\r\n` must not read as two line ends: a lone `\r` then `\n`
    // would end the frame early and split it into an empty line and nothing.
    {
        const t = enc.encode('data: {"x":1}\r\n\r\ndata: {"y":2}\r\n\r\n');
        const at = [...t].findIndex((b, i) => b === 13 && t[i + 1] === 10) + 1;
        eq('a cut between \\r and \\n reads one line end', await collect(source([t.slice(0, at), t.slice(at)]).stream), [{ x: 1 }, { y: 2 }]);
    }
    // A cut inside a four-byte emoji.
    {
        const t = enc.encode('data: {"z":"🌍"}\n\n');
        const at = t.indexOf(0xf0) + 2;
        eq('a cut inside a four-byte character reads it whole', await collect(source([t.slice(0, at), t.slice(at)]).stream), [{ z: '🌍' }]);
    }
    eq('a stream ending with no blank line still gives its last frame',
        await collect(source([enc.encode('data: {"done":true}\n')]).stream), [{ done: true }]);
    eq('…with no line end at all', await collect(source([enc.encode('data: {"done":true}')]).stream), [{ done: true }]);
    eq('a server error frame comes through as it was sent',
        await collect(source([enc.encode('data: {"error":"The model stopped.","messageKey":"x"}\n\n')]).stream),
        [{ error: 'The model stopped.', messageKey: 'x' }]);

    // Abort mid-stream, the reader not wired to the signal (only readSse sees it).
    for (const endOnAbort of [false, true]) {
        unhandled.length = 0;
        const s = source([enc.encode('data: {"n":1}\n\n')], { hang: true });
        const ctl = new AbortController();
        const got = [];
        let thrown = null;
        try {
            for await (const f of readSse(s.stream, { signal: ctl.signal, endOnAbort })) {
                got.push(f);
                realSetTimeout(() => ctl.abort(), 5);
            }
        } catch (e) { thrown = e; }
        await settle();
        const how = endOnAbort ? 'ends quietly' : 'throws AbortError';
        eq(`abort mid-stream (${how}): the frames before it arrive`, got, [{ n: 1 }]);
        ok(`abort mid-stream (${how}): ${how}`, endOnAbort ? thrown === null : thrown?.name === 'AbortError', String(thrown));
        ok(`abort mid-stream (${how}): the reader is cancelled`, s.cancelled);
        ok(`abort mid-stream (${how}): no rejection is left unhandled`, unhandled.length === 0, unhandled.map(String));
    }
    // Abort the way fetch does it: the stream itself errors with the reason.
    {
        unhandled.length = 0;
        const s = source([enc.encode('data: {"n":1}\n\n')], { hang: true });
        const ctl = new AbortController();
        ctl.signal.addEventListener('abort', () => s.controller.error(ctl.signal.reason));
        let thrown = null;
        try {
            for await (const _ of readSse(s.stream, { signal: ctl.signal })) realSetTimeout(() => ctl.abort(), 5);
        } catch (e) { thrown = e; }
        await settle();
        ok('a fetch-style abort throws the AbortError', thrown?.name === 'AbortError', String(thrown));
        ok('…and leaves no rejection unhandled', unhandled.length === 0, unhandled.map(String));
    }
    // An already-aborted signal reads nothing.
    {
        const s = source([enc.encode('data: {"n":1}\n\n')]);
        const ctl = new AbortController();
        ctl.abort();
        let thrown = null;
        const got = [];
        try { for await (const f of readSse(s.stream, { signal: ctl.signal })) got.push(f); } catch (e) { thrown = e; }
        ok('a signal aborted before the first read reads nothing and throws AbortError', got.length === 0 && thrown?.name === 'AbortError', { got, thrown: String(thrown) });
        ok('…and cancels the reader', s.cancelled);
    }
    // A frame read in the same turn the abort came in is still given out, as
    // the loops before the reader did; the next read then ends on the abort.
    {
        const ctl = new AbortController();
        let sent = false;
        const stream = new ReadableStream({
            pull(c) {
                if (sent) return new Promise(() => {});
                sent = true;
                c.enqueue(enc.encode('data: {"done":true}\n\n'));
                ctl.abort();
            },
        }, { highWaterMark: 0 });
        const got = [];
        let thrown = null;
        try { for await (const f of readSse(stream, { signal: ctl.signal })) got.push(f); } catch (e) { thrown = e; }
        ok('a frame that arrives with the abort is still given out, then the abort throws',
            same(got, [{ done: true }]) && thrown?.name === 'AbortError', { got, thrown: String(thrown) });
    }
    // The abort listener goes when the stream does.
    {
        const ctl = new AbortController();
        let live = 0;
        const add = ctl.signal.addEventListener.bind(ctl.signal), remove = ctl.signal.removeEventListener.bind(ctl.signal);
        ctl.signal.addEventListener = (...a) => { live++; add(...a); };
        ctl.signal.removeEventListener = (...a) => { live--; remove(...a); };
        await collect(source([enc.encode('data: {"n":1}\n\n')]).stream, { signal: ctl.signal, staleMs: 30 });
        ok('a finished stream leaves no abort listener behind', live === 0, `live listeners: ${live}`);
        const pending = new Set();
        const [set, clear] = [globalThis.setTimeout, globalThis.clearTimeout];
        globalThis.setTimeout = (fn, ms, ...r) => { const id = set(() => { pending.delete(id); fn(); }, ms, ...r); if (ms === 30) pending.add(id); return id; };
        globalThis.clearTimeout = (id) => { pending.delete(id); clear(id); };
        try { await collect(source([enc.encode('data: {"n":1}\n\n'), enc.encode('data: {"n":2}\n\n')]).stream, { staleMs: 30 }); }
        finally { globalThis.setTimeout = set; globalThis.clearTimeout = clear; }
        ok('…and no stale timer still running', pending.size === 0, `timers left: ${pending.size}`);
    }
    // The caller leaves early, or throws.
    {
        const s = source([enc.encode('data: {"n":1}\n\ndata: {"n":2}\n\n')], { hang: true });
        for await (const _ of readSse(s.stream)) break;
        ok('a caller that stops after its first frame cancels the reader', s.cancelled);
        const s2 = source([enc.encode('data: {"n":1}\n\n')], { hang: true });
        let thrown = null;
        try { for await (const _ of readSse(s2.stream)) throw new Error('caller failed'); } catch (e) { thrown = e; }
        ok('a caller that throws gets its own error back', thrown?.message === 'caller failed', String(thrown));
        ok('…and the reader is cancelled', s2.cancelled);
    }
    // A read that fails.
    {
        unhandled.length = 0;
        const s = source([enc.encode('data: {"n":1}\n\n')], { failWith: new Error('socket hang up') });
        const got = [];
        let thrown = null;
        try { for await (const f of readSse(s.stream)) got.push(f); } catch (e) { thrown = e; }
        await settle();
        ok('a failed read throws its own error after the frames before it', same(got, [{ n: 1 }]) && thrown?.message === 'socket hang up', { got, thrown: String(thrown) });
        ok('…and leaves no rejection unhandled', unhandled.length === 0, unhandled.map(String));
    }
    // A quiet socket.
    {
        unhandled.length = 0;
        const s = source([enc.encode('data: {"n":1}\n\n')], { hang: true });
        let thrown = null;
        const got = [];
        try { for await (const f of readSse(s.stream, { staleMs: 30 })) got.push(f); } catch (e) { thrown = e; }
        await settle();
        ok('a quiet socket past the deadline ends like a closed stream, after the frames before it', thrown === null && same(got, [{ n: 1 }]), { got, thrown: String(thrown) });
        ok('…and cancels the reader', s.cancelled);
        ok('…and leaves no rejection unhandled', unhandled.length === 0, unhandled.map(String));
        const s2 = source([enc.encode(': keepalive\n\n'), enc.encode('data: {"n":2}\n\n')]);
        eq('no deadline unless one is asked for', await collect(s2.stream), [{ n: 2 }]);
    }
}

// ─── 2. the callers ─────────────────────────────────────────────────────────

let api = null;
try { ({ api } = await bundle(join(root, 'src', 'api.ts'), 'api.mjs')); } catch (e) { failures.push(`bundling src/api.ts failed: ${e.message}`); }

/** What the stubbed fetch answers next. */
let reply = null;
let lastSource = null;
globalThis.fetch = async (url, init = {}) => {
    const r = reply;
    if (init.signal?.aborted) throw init.signal.reason;
    const s = source(r.parts ?? [], { hang: r.hang, failWith: r.failWith });
    lastSource = s;
    init.signal?.addEventListener('abort', () => { try { s.controller.error(init.signal.reason); } catch { /* closed */ } }, { once: true });
    const headers = new Headers({ 'Content-Type': r.type ?? 'text/event-stream', ...(r.headers || {}) });
    return {
        ok: (r.status ?? 200) < 300, status: r.status ?? 200, statusText: r.statusText ?? '', headers,
        body: s.stream,
        json: async () => JSON.parse(r.json),
    };
};

const frames = (...objs) => objs.map(o => typeof o === 'string' ? o : `data: ${JSON.stringify(o)}\n\n`).join('');
const errorText = (e) => {
    if (!e) return null;
    const extra = {};
    for (const k of ['status', 'data', 'rawResponse', 'cancelled', 'stale']) if (k in e) extra[k] = e[k];
    return { message: e.message, ...extra };
};

/**
 * Run one caller over one reply and write down everything it did, in order:
 * every callback, every yield, then how it ended.
 */
async function transcript(run, r) {
    reply = r;
    const log = [];
    const note = (...x) => log.push(x);
    try {
        const out = await run(note);
        log.push(['end', out === undefined ? null : out]);
    } catch (e) {
        log.push(['threw', errorText(e)]);
    }
    return log;
}
/** The same caller and reply cut at every byte position must write the same transcript. */
async function pinned(name, run, text, want) {
    const bytes = enc.encode(text);
    let wrong = null;
    for (const parts of cuts(bytes)) {
        const got = await transcript(run, { parts });
        if (!same(got, want)) { wrong = { cut: parts.map(p => p.length), got, want }; break; }
    }
    ok(`${name}, cut at every byte position`, !wrong, wrong);
}
const drain = async (gen, note) => { for await (const x of gen) note('yield', x); };

if (api) {
    // ── the assistant turn ──
    const chatHandlers = (note, extra = {}) => ({
        onTask: (id) => note('task', id),
        onConversation: (id) => note('conversation', id),
        onThinking: (n) => note('thinking', n),
        onThinkingChunk: (s) => note('thinkingChunk', s),
        onNote: (s) => note('note', s),
        onActions: (a) => note('actions', a),
        onDone: (d) => note('done', d),
        ...extra,
    });
    const chat = (note, extra) => drain(api.streamAssistant('hi', { conversationId: null, context: {} }, chatHandlers(note, extra)), note);
    const CHAT = frames(
        { taskId: 't1' }, { conversationId: 7 }, ': keepalive\n\n', { note: 'Searching the web…' },
        { thinking: 12 }, { thinkingChunk: 'Hmm' }, { chunk: 'Привет ' },
        { actions: [{ kind: 'search', query: 'q' }] }, { chunk: 'мир 🌍' },
        { done: true, assistantMessageId: 42, content: 'Привет мир 🌍', actions: [] },
        { chunk: 'after the end' },
    );
    await pinned('assistant: a whole turn', chat, CHAT, [
        ['task', 't1'], ['conversation', 7], ['note', 'Searching the web…'], ['thinking', 12], ['thinkingChunk', 'Hmm'],
        ['yield', 'Привет '], ['actions', [{ kind: 'search', query: 'q' }]], ['yield', 'мир 🌍'],
        ['done', { assistantMessageId: 42, cancelled: false, content: 'Привет мир 🌍', actions: [] }],
        ['end', null],
    ]);
    await pinned('assistant: a stopped turn', chat, frames({ chunk: 'Part' }, { cancelled: true, assistantMessageId: 9 }), [
        ['yield', 'Part'], ['done', { assistantMessageId: 9, cancelled: true, content: null, actions: null }], ['end', null],
    ]);
    await pinned('assistant: a server error frame', chat, frames({ chunk: 'Part' }, { error: 'The model stopped answering.' }), [
        ['yield', 'Part'], ['threw', { message: 'The model stopped answering.' }],
    ]);
    await pinned('assistant: a stream that ends before done', chat, frames({ chunk: 'Part' }), [['yield', 'Part'], ['end', null]]);
    eq('assistant: a refused request throws the server\'s sentence with its status and body',
        await transcript(chat, { status: 409, type: 'application/json', json: '{"error":"Still answering.","missing":[3]}' }),
        [['threw', { message: 'Still answering.', status: 409, data: { error: 'Still answering.', missing: [3] } }]]);
    // The stale deadline cancels the reader, and a cancel settles the pending
    // read as a closed stream: the turn ends with no `done`, which the drawer
    // reads as a dropped socket and re-attaches to the task.
    eq('assistant: a quiet socket ends the turn as a closed stream',
        await transcript(chat, { parts: [enc.encode(frames({ chunk: 'Part' }))], hang: true }),
        [['yield', 'Part'], ['end', null]]);
    ok('…and cancels the reader', lastSource?.cancelled);
    eq('task list: a quiet socket ends the feed (the store reconnects)',
        await transcript((note) => api.streamTaskList((t) => note('list', t)), { parts: [enc.encode(frames({ tasks: [] }))], hang: true }),
        [['list', []], ['end', null]]);
    // Pinned as it is, not as it should be: VisualBlock reads an empty fix as
    // an unusable repair, while its connection-failure check looks for a
    // `stale` error this outcome never carried.
    eq('repair: a quiet socket ends with an empty fix',
        await transcript((note) => api.repairVisual('mermaid', 'graph', 'bad'), { parts: [], hang: true }),
        [['end', { code: '', redrawn: false }]]);
    {
        unhandled.length = 0;
        const ctl = new AbortController();
        const got = await transcript(async (note) => {
            for await (const x of api.streamAssistant('hi', { conversationId: null, context: {} }, { ...chatHandlers(note), signal: ctl.signal })) {
                note('yield', x);
                realSetTimeout(() => ctl.abort(), 5);
            }
        }, { parts: [enc.encode(frames({ chunk: 'Part' }))], hang: true });
        await settle();
        eq('assistant: Stop mid-turn ends the turn quietly, keeping what arrived', got, [['yield', 'Part'], ['end', null]]);
        ok('assistant: Stop mid-turn leaves no rejection unhandled', unhandled.length === 0, unhandled.map(String));
    }

    // ── course creation ──
    const create = (note, signal) => drain(api.createProjectWithAI('Physics', 'desc', '#000', 'book', signal), note);
    await pinned('creation: a whole run', create, frames(
        { phase: 'structure', message: 'Planning', progress: 10 }, ': keepalive\n\n',
        { phase: 'topics', message: 'Тема 🌍', progress: 60 },
        { phase: 'done', done: true, projectId: 5 }, { phase: 'late' },
    ), [
        ['yield', { phase: 'structure', message: 'Planning', progress: 10 }],
        ['yield', { phase: 'topics', message: 'Тема 🌍', progress: 60 }],
        ['yield', { phase: 'done', done: true, projectId: 5 }],
        ['end', null],
    ]);
    await pinned('creation: a server error frame is yielded and ends the run', create, frames(
        { phase: 'structure', progress: 10 }, { phase: 'error', error: 'No model', message: 'No model' }, { phase: 'late' },
    ), [
        ['yield', { phase: 'structure', progress: 10 }],
        ['yield', { phase: 'error', error: 'No model', message: 'No model' }],
        ['end', null],
    ]);
    eq('creation: a refused request comes out as an error frame',
        await transcript(create, { status: 503, statusText: 'Service Unavailable', type: 'application/json', json: '{"error":"Model down"}' }),
        [['yield', { phase: 'error', message: 'Model down', task: 'AI project creation failed', error: 'Model down' }], ['end', null]]);
    eq('creation: a failed read comes out as the interrupted-connection frame',
        await transcript(create, { parts: [enc.encode(frames({ phase: 'structure' }))], failWith: new Error('socket hang up') }),
        [['yield', { phase: 'structure' }],
            ['yield', { phase: 'error', message: 'Failed to read server response: socket hang up', task: 'Connection to the server was interrupted', error: 'socket hang up' }],
            ['end', null]]);
    {
        const ctl = new AbortController();
        ctl.abort();
        eq('creation: cancelled before the answer throws "Request cancelled."',
            await transcript((note) => create(note, ctl.signal), { parts: [] }),
            [['threw', { message: 'Request cancelled.' }]]);
    }
    {
        unhandled.length = 0;
        const ctl = new AbortController();
        const got = await transcript(async (note) => {
            for await (const x of api.createProjectWithAI('P', '', '', '', ctl.signal)) { note('yield', x); realSetTimeout(() => ctl.abort(), 5); }
        }, { parts: [enc.encode(frames({ phase: 'structure' }))], hang: true });
        await settle();
        eq('creation: cancelled mid-run ends quietly', got, [['yield', { phase: 'structure' }], ['end', null]]);
        ok('creation: cancelled mid-run leaves no rejection unhandled', unhandled.length === 0, unhandled.map(String));
    }

    // ── the quiz stream ──
    const quiz = (note, signal) => api.streamGenerateQuiz(
        3, 5, 'both', false, (n) => note('progress', n), signal, (n) => note('thinking', n),
        (phase, waited, detail) => note('phase', phase, waited, detail), { onTask: (id) => note('task', id) },
    );
    await pinned('quiz: a whole run, the result frame with no line end after it', quiz,
        frames({ taskId: 'q1' }, { phase: 'loading', waitedMs: 1200 }, { thinking: 40 }, { progress: 300 },
            { phase: 'verify', verified: 1, verifyTotal: 3 }) + 'data: {"done":true,"id":11,"questions":[{"q":"Что?"}]}',
        [['task', 'q1'], ['phase', 'loading', 1200, {}], ['thinking', 40], ['progress', 300],
            ['phase', 'verify', 0, { verified: 1, verifyTotal: 3 }], ['end', { id: 11, questions: [{ q: 'Что?' }] }]]);
    await pinned('quiz: a server error frame throws with the raw answer', quiz,
        frames({ progress: 5 }, { error: 'Bad JSON from the model', rawResponse: 'garbage' }),
        [['progress', 5], ['threw', { message: 'Bad JSON from the model', rawResponse: 'garbage' }]]);
    await pinned('quiz: a cancelled task throws cancelled', quiz, frames({ cancelled: true }),
        [['threw', { message: 'Generation was cancelled.', cancelled: true }]]);
    await pinned('quiz: a stream that ends early says the connection closed', quiz, frames({ progress: 5 }),
        [['progress', 5], ['threw', { message: 'The connection to the AI server closed before the quiz finished generating. Check that your model server is running and try again.' }]]);
    eq('quiz: a refused request throws the server\'s sentence and raw answer',
        await transcript(quiz, { status: 422, type: 'application/json', json: '{"error":"Topic has no text","raw_response":"r"}' }),
        [['threw', { message: 'Topic has no text', rawResponse: 'r' }]]);
    {
        unhandled.length = 0;
        const ctl = new AbortController();
        const got = await transcript((note) => {
            const p = quiz(note, ctl.signal);
            realSetTimeout(() => ctl.abort(), 5);
            return p;
        }, { parts: [enc.encode(frames({ progress: 5 }))], hang: true });
        await settle();
        eq('quiz: closed mid-run throws the AbortError', got.map(([k, v]) => k === 'threw' ? [k, v.message] : [k, v]), [['progress', 5], ['threw', 'This operation was aborted']]);
        ok('quiz: closed mid-run leaves no rejection unhandled', unhandled.length === 0, unhandled.map(String));
    }

    // ── the other nine, on their usual run and their error frame ──
    await pinned('insights: a whole run', (note) => api.streamGetInsights(1, (n) => note('progress', n), (n) => note('thinking', n)),
        frames({ thinking: 3 }, { progress: 9 }, { done: true, stats: { a: 1 }, insights: ['ок'] }),
        [['thinking', 3], ['progress', 9], ['end', { stats: { a: 1 }, insights: ['ок'] }]]);
    await pinned('insights: an error frame', (note) => api.streamGetInsights(1),
        frames({ error: 'No model', rawResponse: 'x' }), [['threw', { message: 'No model', rawResponse: 'x' }]]);
    await pinned('insights: ends early', () => api.streamGetInsights(1), frames({ progress: 1 }),
        [['threw', { message: 'Insights stream ended without a result' }]]);

    await pinned('flashcards: a whole run', (note) => api.streamGenerateFlashcards(1, 5, (n) => note('progress', n), (n) => note('thinking', n)),
        frames({ progress: 9 }, { done: true, count: 2, ids: [4, 5] }), [['progress', 9], ['end', { count: 2, ids: [4, 5] }]]);
    await pinned('flashcards: a cancelled task', () => api.streamGenerateFlashcards(1, 5), frames({ cancelled: true }),
        [['threw', { message: 'Generation was cancelled.', cancelled: true }]]);

    const repair = (note) => api.repairVisual('mermaid', 'graph', 'bad', undefined, (p) => note('progress', p), undefined, (id) => note('task', id));
    await pinned('repair: a whole run', repair,
        frames({ taskId: 'r1' }, { phase: 'brief', chars: 10, thinking: 2, est: 100 }, { progress: 20 }, { done: true, code: 'graph TD', redrawn: true }),
        [['task', 'r1'], ['progress', { phase: 'brief', chars: 10, thinking: 2, est: 100 }],
            ['progress', { chars: 20, thinking: 0, est: 0 }], ['end', { code: 'graph TD', redrawn: true }]]);
    await pinned('repair: ends early with an empty fix', repair, frames({ taskId: 'r1' }), [['task', 'r1'], ['end', { code: '', redrawn: false }]]);
    await pinned('repair: an error frame', repair, frames({ error: 'No model' }), [['threw', { message: 'No model' }]]);

    const widget = (note) => api.compileWidget('spec', {}, (e) => note('event', e));
    await pinned('widget: a whole run', widget,
        frames({ status: 'queued', queuePosition: 2 }, { thinking: 4 }, { progress: 8 }, { done: true, html: '<p>ок</p>', cached: false }),
        [['event', { status: 'queued', queuePosition: 2 }], ['event', { thinking: 4 }], ['event', { progress: 8 }], ['end', { html: '<p>ок</p>', cached: false }]]);
    await pinned('widget: a cache miss', widget, frames({ miss: true, declined: 'off' }), [['end', { html: '', cached: false, declined: 'off' }]]);
    await pinned('widget: an error frame', widget, frames({ error: 'Build failed' }), [['threw', { message: 'Build failed' }]]);

    const author = (note) => api.authorVisual('p5', 'brief', {}, (e) => note('event', e));
    await pinned('author: a whole run', author,
        frames({ status: 'running' }, { done: true, spec: 'draw()', cached: true }),
        [['event', { status: 'running', queuePosition: null }], ['end', { spec: 'draw()', cached: true }]]);
    await pinned('author: an error frame', author, frames({ error: 'No model' }), [['threw', { message: 'No model' }]]);

    const placement = (note) => api.startPlacement(1, (w, t) => note('progress', w, t));
    await pinned('placement: a whole run', placement,
        frames({ written: 1, total: 4 }, { done: true, id: 3, questions: [] }),
        [['progress', 1, 4], ['end', { done: true, id: 3, questions: [] }]]);
    await pinned('placement: an error frame', placement, frames({ error: 'No model' }), [['threw', { message: 'No model' }]]);
    eq('placement: a probe already written comes back as plain JSON',
        await transcript(placement, { type: 'application/json', json: '{"probe":{"id":3}}' }), [['end', { id: 3 }]]);

    await pinned('task list: snapshots and chat changes, a listener that throws does not end the feed',
        (note) => api.streamTaskList((tasks) => { note('list', tasks); if (tasks.length === 1) throw new Error('listener bug'); }, undefined, (c) => note('chat', c)),
        frames({ tasks: [] }, { tasks: [{ id: 'a' }] }, { chatChanged: { conversationId: 4, from: 'another-window' } }, { tasks: [{ id: 'a' }, { id: 'b' }] }),
        [['list', []], ['list', [{ id: 'a' }]], ['chat', { conversationId: 4 }], ['list', [{ id: 'a' }, { id: 'b' }]], ['end', null]]);

    await pinned('attach: replays until the terminal frame', (note) => drain(api.attachTask('t1'), note),
        frames({ chunk: 'a' }, { thinking: 3 }, { done: true }, { chunk: 'late' }),
        [['yield', { chunk: 'a' }], ['yield', { thinking: 3 }], ['yield', { done: true }], ['end', null]]);
    eq('attach: an error status is not a stream',
        await transcript((note) => drain(api.attachTask('t1'), note), { status: 401, type: 'application/json', json: '{}' }),
        [['threw', { message: 'Task stream failed (401)' }]]);
    {
        unhandled.length = 0;
        const ctl = new AbortController();
        const got = await transcript(async (note) => {
            for await (const x of api.attachTask('t1', ctl.signal)) { note('yield', x); realSetTimeout(() => ctl.abort(), 5); }
        }, { parts: [enc.encode(frames({ chunk: 'a' }))], hang: true });
        await settle();
        eq('attach: detached mid-run ends quietly', got, [['yield', { chunk: 'a' }], ['end', null]]);
        ok('attach: detached mid-run leaves no rejection unhandled', unhandled.length === 0, unhandled.map(String));
    }

    // Every other caller that takes a signal: closed mid-run, it throws the
    // AbortError the browser gives, and leaves nothing unhandled.
    const ABORTABLE = {
        insights: (s) => api.streamGetInsights(1, undefined, undefined, s),
        flashcards: (s) => api.streamGenerateFlashcards(1, 5, undefined, undefined, s),
        repair: (s) => api.repairVisual('mermaid', 'graph', 'bad', s),
        widget: (s) => api.compileWidget('spec', {}, undefined, s),
        author: (s) => api.authorVisual('p5', 'brief', {}, undefined, s),
        placement: (s) => api.startPlacement(1, undefined, s),
        'task list': (s) => api.streamTaskList(() => {}, s),
    };
    for (const [name, call] of Object.entries(ABORTABLE)) {
        unhandled.length = 0;
        const ctl = new AbortController();
        const got = await transcript(() => { const p = call(ctl.signal); realSetTimeout(() => ctl.abort(), 5); return p; },
            { parts: [enc.encode(frames({ progress: 1 }))], hang: true });
        await settle();
        eq(`${name}: closed mid-run throws the AbortError`, got, [['threw', { message: 'This operation was aborted' }]]);
        ok(`${name}: closed mid-run leaves no rejection unhandled`, unhandled.length === 0, unhandled.map(String));
    }

    // The model download: the server sends `data:` frames like every other
    // stream (server/routes/providers.js), so progress, the end and a failure
    // all reach the settings screen.
    await pinned('model download: progress, then the end', (note) => drain(api.pullModel('llama3'), note),
        frames({ status: 'pulling manifest' }, { status: 'downloading', completed: 5, total: 10 }, { done: true }),
        [['yield', { status: 'pulling manifest' }], ['yield', { status: 'downloading', completed: 5, total: 10 }], ['yield', { done: true }], ['end', null]]);
    await pinned('model download: a failure reaches the screen', (note) => drain(api.pullModel('nope'), note),
        frames({ error: 'model "nope" not found' }), [['yield', { error: 'model "nope" not found' }], ['end', null]]);
}

for (const f of failures) console.log(`  ✗ ${f}`);
console.log(`\nsse-gates: ${pass} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
