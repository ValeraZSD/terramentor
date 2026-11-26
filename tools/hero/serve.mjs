#!/usr/bin/env node
/**
 * The app on a scratch library, for filming: every model call is answered from
 * recorded replies, so a take costs nothing and draws the same course each time.
 *
 *   node tools/hero/serve.mjs --library <dir> --port <n> --cassettes <dir> [options]
 *
 *   --library <dir>       the scratch library (created with the film's settings if empty)
 *   --port <n>            where the app listens (127.0.0.1)
 *   --cassettes <dir>     recorded model replies, one <hash>.json per call
 *   --fallback-log <file> a take's replay.jsonl: a call whose prompt changed since it was
 *                         recorded (a date, the screen it was asked from) is served the
 *                         reply the n-th call of the same kind got in that take
 *   --order-logs <a,b>    replay.jsonl files whose checker calls are served by position
 *                         (their prompts shuffle options, so their hash never repeats)
 *   --no-fallback <re>    calls whose system prompt matches are replayed only on an exact
 *                         hash or seat, never by kind (lessons and questions belong to
 *                         one topic; another topic's lesson is wrong content)
 *   --record              send calls with no recording to the model and keep the reply;
 *                         needs ANTHROPIC_API_KEY and a --max-usd above 0
 *   --max-usd <n>         spending cap for --record (default 0)
 *   --max-real <n>        cap on real calls for --record (default 0)
 *   --film-clock          pace replies by the film's clock instead of the wall clock: the
 *                         recorder posts it to /__film/clock?t=<seconds>&auto=<0|1>
 *
 * The library, its vault and its credentials file all live in --library; the
 * caller's AI_* and OPENAI_* variables are dropped. Without --record every call
 * that has no recording fails and nothing leaves the machine except to the
 * model host's messages endpoint, which is answered here.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MODEL_HOST = 'https://api.anthropic.com';
const MODEL = 'claude-opus-5-5';
// List prices per million tokens of MODEL, used only for the --max-usd cap.
const PRICE = { input: 4, cacheWrite: 5, cacheRead: 0.2, output: 20 };

function args(argv) {
    const a = { fallbackLog: process.env.HERO_FALLBACK_LOG, orderLogs: process.env.HERO_ORDER_LOGS, noFallback: process.env.HERO_NO_FALLBACK };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        const v = () => { const x = argv[++i]; if (x === undefined) throw new Error(`${k} needs a value`); return x; };
        if (k === '--library') a.library = resolve(v());
        else if (k === '--port') a.port = Number(v());
        else if (k === '--cassettes') a.cassettes = resolve(v());
        else if (k === '--fallback-log') a.fallbackLog = v();
        else if (k === '--order-logs') a.orderLogs = v();
        else if (k === '--no-fallback') a.noFallback = v();
        else if (k === '--record') a.record = true;
        else if (k === '--max-usd') a.maxUsd = Number(v());
        else if (k === '--max-real') a.maxReal = Number(v());
        else if (k === '--film-clock') a.filmClock = true;
        else throw new Error(`unknown option ${k}`);
    }
    if (!a.library || !a.port || !a.cassettes) throw new Error('usage: serve.mjs --library <dir> --port <n> --cassettes <dir> [options]');
    return a;
}
const opt = args(process.argv.slice(2));
const maxUsd = opt.record ? opt.maxUsd ?? 0 : 0;
const maxReal = opt.record ? opt.maxReal ?? 0 : 0;
if (opt.record && !(maxUsd > 0)) throw new Error('--record needs --max-usd above 0');
if (opt.record && !process.env.ANTHROPIC_API_KEY) throw new Error('--record needs ANTHROPIC_API_KEY');
if (!existsSync(opt.cassettes)) throw new Error(`no cassette folder at ${opt.cassettes}`);

// ---- the scratch library, named before any server module is imported --------------------
for (const key of Object.keys(process.env)) if (/^(AI_|OPENAI_)/.test(key)) delete process.env[key];
mkdirSync(join(opt.library, 'vault'), { recursive: true });
process.env.DATA_DIR = opt.library;
process.env.DB_PATH = join(opt.library, 'library.db');
process.env.VAULT_ROOT = join(opt.library, 'vault');
process.env.SECRETS_PATH = join(opt.library, 'library.secrets.json');
process.env.PORT = String(opt.port);
process.env.HOST = '127.0.0.1';
const { resolveDataPaths } = await import(pathToFileURL(join(ROOT, 'server', 'paths.js')).href);
const paths = resolveDataPaths();
if (!paths.dbPath.startsWith(opt.library) || !paths.vaultRoot.startsWith(opt.library)) {
    throw new Error(`refusing: the library resolved outside ${opt.library} (${paths.dbPath})`);
}

// The server shuffles questions and options; a seeded random draws them alike in every take.
let seed = 0x9e3779b9;
Math.random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// ---- the film clock ------------------------------------------------------------------------
// Real time unless --film-clock; then the recorder sets it, and while it says `auto` it runs
// with real time from the last value it was given.
const realNow = Date.now;
const clock = { auto: true, t: realNow() / 1000, real: realNow() };
const filmNow = () => (clock.auto ? clock.t + (realNow() - clock.real) / 1000 : clock.t);
if (opt.filmClock) {
    // The server's own clock follows the film too, so the durations it reports (a stage's
    // seconds, "Took 11 s") are the film's, not however long each frame took to capture.
    const RealDate = Date;
    globalThis.Date = class FilmDate extends RealDate {
        constructor(...a) { if (a.length) super(...a); else super(Math.round(filmNow() * 1000)); }
        static now() { return Math.round(filmNow() * 1000); }
    };
}
const waiters = new Set();
let ticker = null;
function wake() {
    const n = filmNow();
    for (const w of waiters) if (w.at <= n) { waiters.delete(w); w.done(); }
    if (waiters.size && clock.auto && !ticker) ticker = setInterval(wake, 5);
    if ((!waiters.size || !clock.auto) && ticker) { clearInterval(ticker); ticker = null; }
}
/** Resolve after `ms` of film time (wall time without --film-clock). */
function filmWait(ms, signal) {
    if (!opt.filmClock) return new Promise((res, rej) => { const h = setTimeout(res, ms); signal?.addEventListener('abort', () => { clearTimeout(h); rej(signal.reason || new Error('aborted')); }, { once: true }); });
    return new Promise((res, rej) => {
        const w = { at: filmNow() + ms / 1000, done: res };
        waiters.add(w);
        signal?.addEventListener('abort', () => { waiters.delete(w); rej(signal.reason || new Error('aborted')); }, { once: true });
        wake();
    });
}

// ---- model replies ---------------------------------------------------------------------------
const logFile = join(opt.library, 'replay.jsonl');
const log = (entry) => appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
const usd = (u) => (u.input * PRICE.input + u.cacheWrite * PRICE.cacheWrite + u.cacheRead * PRICE.cacheRead + u.output * PRICE.output) / 1e6;
let realCalls = 0;
let spent = 0;

const splitEvents = (text) => text.split(/\n\n/).filter((s) => s.trim()).map((s) => s + '\n\n');
/** A recorded stream spread over the time the real call took: the first event after a fifth of it. */
function paced(events, ms, signal) {
    const enc = new TextEncoder();
    return new ReadableStream({
        async start(ctl) {
            try {
                await filmWait(ms * 0.2, signal);
                const step = (ms * 0.8) / Math.max(1, events.length - 1);
                for (let i = 0; i < events.length; i++) { if (i) await filmWait(step, signal); ctl.enqueue(enc.encode(events[i])); }
                ctl.close();
            } catch (err) { ctl.error(err); }
        },
    });
}
const replay = async (c, signal) => {
    if (c.stream === false) { await filmWait(c.ms, signal); return new Response(c.sse, { status: 200, headers: { 'content-type': 'application/json' } }); }
    return new Response(paced(splitEvents(c.sse), c.ms, signal), { status: 200, headers: { 'content-type': 'text/event-stream' } });
};
const num = (v) => (Number.isFinite(v) ? v : 0);
function usageOf(text) {
    const u = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
    const take = (x) => {
        if (!x) return;
        if (x.input_tokens != null) u.input = num(x.input_tokens);
        if (x.output_tokens != null) u.output = Math.max(u.output, num(x.output_tokens));
        if (x.cache_creation_input_tokens != null) u.cacheWrite = num(x.cache_creation_input_tokens);
        if (x.cache_read_input_tokens != null) u.cacheRead = num(x.cache_read_input_tokens);
    };
    try { take(JSON.parse(text).usage); return u; } catch { /* a stream */ }
    for (const line of text.split('\n')) {
        if (!line.startsWith('data:')) continue;
        try { const ev = JSON.parse(line.slice(5)); take(ev.message?.usage); take(ev.usage); } catch { /* partial line */ }
    }
    return u;
}
const readLog = (file) => (file ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

// Checker prompts shuffle their options, so their hash never repeats: they are served by seat.
const ORDERED = ['You are a subject expert checking a question before', 'You audit the MODEL ANSWER to an open question'];
const order = {};
const orderSeen = {};
for (const e of String(opt.orderLogs || '').split(',').filter(Boolean).flatMap(readLog)) {
    if (e.how !== 'real' || !Number.isInteger(e.seq)) continue;
    const k = ORDERED.find((p) => (e.label || '').startsWith(p));
    if (k) (order[k] ||= [])[e.seq] = e.key;
}
const fallback = {};
const fallbackSeen = {};
for (const e of readLog(opt.fallbackLog)) {
    if (e.key && e.label && ['hit', 'real', 'order-hit'].includes(e.how)) (fallback[e.label] ||= []).push(e.how === 'order-hit' ? e.as : e.key);
}
const noFallback = opt.noFallback ? new RegExp(opt.noFallback) : null;
const cassette = (key) => join(opt.cassettes, `${key}.json`);
const load = (key) => (key && existsSync(cassette(key)) ? JSON.parse(readFileSync(cassette(key), 'utf8')) : null);

const realFetch = globalThis.fetch;
globalThis.fetch = async function replayFetch(input, init = {}) {
    const url = typeof input === 'string' ? input : input?.url || String(input);
    if (!url.startsWith(MODEL_HOST)) return realFetch(input, init);
    if (!url.startsWith(`${MODEL_HOST}/v1/messages`) || typeof init.body !== 'string') {
        if (!opt.record) throw new Error(`replay only: ${url} is not answered`);
        return realFetch(input, init);
    }
    const body = JSON.parse(init.body);
    const sys = Array.isArray(body.system) ? body.system.map((b) => b.text || '').join('\n') : String(body.system || '');
    const label = sys.replace(/\s+/g, ' ').slice(0, 90);
    const key = createHash('sha256').update(JSON.stringify({ model: body.model, system: body.system, messages: body.messages, tools: body.tools || null })).digest('hex').slice(0, 24);
    const seqKind = ORDERED.find((p) => label.startsWith(p));
    const seq = seqKind ? (orderSeen[seqKind] = (orderSeen[seqKind] ?? -1) + 1) : -1;
    const hit = load(key);
    if (hit) { log({ how: 'hit', key, ms: hit.ms, label, ...(seq >= 0 ? { seq } : {}) }); return replay(hit, init.signal); }
    if (seqKind) {
        const as = (order[seqKind] || [])[seq];
        const c = load(as);
        if (c) { log({ how: 'order-hit', key, as, ms: c.ms, label, seq }); return replay(c, init.signal); }
    }
    if (!noFallback?.test(label)) {
        const n = (fallbackSeen[label] = (fallbackSeen[label] ?? -1) + 1);
        const as = (fallback[label] || [])[n] || (fallback[label] || []).at(-1);
        const c = load(as);
        if (c) { log({ how: 'label-hit', key, as, ms: c.ms, label, n }); return replay(c, init.signal); }
    }
    if (!opt.record) {
        // The request is kept beside the log, so a miss can be compared with the call the
        // recording take made at that point (a changed prompt, or a call it never made).
        const dir = join(opt.library, 'refused');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${key}.json`), JSON.stringify({ model: body.model, system: body.system, messages: body.messages, tools: body.tools || null }, null, 1));
        log({ how: 'refused', key, label });
        throw new Error(`replay only: no recording for "${label}"`);
    }
    realCalls++;
    if (realCalls > maxReal || spent > maxUsd) { log({ how: 'capped', key, label, realCalls, spent }); throw new Error(`cap reached (${realCalls} calls, USD ${spent.toFixed(2)})`); }
    const t0 = realNow();
    const res = await realFetch(input, init);
    if (!res.ok || !res.body) { log({ how: 'real-fail', status: res.status, label }); return res; }
    const [mine, theirs] = res.body.tee();
    (async () => {
        const text = await new Response(theirs).text();
        const ms = realNow() - t0;
        const u = usageOf(text);
        spent += usd(u);
        const stream = body.stream !== false && /event: /.test(text);
        if (stream ? /event: message_stop/.test(text) : /"stop_reason"/.test(text)) writeFileSync(cassette(key), JSON.stringify({ ms, label, stream, sse: text }));
        log({ how: 'real', key, ms, label, ...(seq >= 0 ? { seq } : {}), ...u, spent: +spent.toFixed(4) });
    })().catch((err) => log({ how: 'real-read-fail', label, err: String(err?.message || err) }));
    return new Response(mine, { status: res.status, headers: res.headers });
};

// ---- the film's settings, on a new library ---------------------------------------------------
const fresh = !existsSync(paths.dbPath);
const { default: db } = await import(pathToFileURL(join(ROOT, 'server', 'database.js')).href);
if (fresh) {
    const put = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    const pairs = [
        ['ai_enabled', 'true'], ['ai_provider', 'openai'], ['ai_api_format', 'anthropic'],
        ['ai_openai_base_url', `${MODEL_HOST}/v1`], ['ai_openai_api_key_origin', MODEL_HOST], ['ai_openai_model', MODEL],
        // Replay only: a placeholder the replay never sends anywhere.
        ['ai_openai_api_key', opt.record ? process.env.ANTHROPIC_API_KEY : 'sk-ant-replay-only'],
        ['ai_reasoning_effort', 'medium'], ['ai_web_search', 'off'], ['ai_setup_dismissed', 'true'],
        ['creation_find_resources', 'false'], ['embedding_enabled', 'false'],
        // Background writing kept to the topic on screen.
        ['feed_focus_total', '1'], ['feed_focus_per_project', '1'], ['feed_max_parts', '2'], ['feed_practice', 'false'],
        ['feed_widgets', 'false'], ['feed_prepare_check', 'false'], ['feed_prepare_cards', 'false'],
        ['theme', 'light'], ['ui_language', 'en'], ['detailPanelWidth', '600'], ['welcome_done', 'true'],
        ['update_check_asked', '1'], ['update_check', 'off'],
    ];
    for (const [k, v] of pairs) put.run(k, v);
}

if (opt.filmClock) {
    const { Server } = await import('node:net');
    const emit = Server.prototype.emit;
    Server.prototype.emit = function (event, req, res, ...rest) {
        if (event === 'request' && req?.url?.startsWith('/__film/clock')) {
            const q = new URL(req.url, 'http://x').searchParams;
            clock.auto = q.get('auto') === '1';
            clock.t = Number(q.get('t'));
            clock.real = realNow();
            wake();
            // Answered after the replies now due have been handed to the app.
            setImmediate(() => { res.writeHead(204); res.end(); });
            return true;
        }
        return emit.call(this, event, req, res, ...rest);
    };
}

await import(pathToFileURL(join(ROOT, 'server', 'index.js')).href);
process.stdout.write(`HERO-SERVER-READY ${JSON.stringify({ dbPath: paths.dbPath, fresh, filmClock: !!opt.filmClock })}\n`);
