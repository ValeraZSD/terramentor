/**
 * What the benchmark's live worker (worker.mjs) and its scorer check
 * (mutate.mjs) share: a scratch library, a fetch wrapper that measures every
 * model request, and one case run.
 *
 * Order matters. `startLibrary()` and `installFetch()` must run before any
 * server module is imported: the library path is resolved once, and the app
 * builds its model fetch from the global fetch when server/aiWire.js loads.
 */
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const OPENROUTER = 'https://openrouter.ai/api/v1';

/** A fresh empty library and the env overrides getAISettings() reads. */
export function startLibrary(model, key) {
    const scratch = mkdtempSync(path.join(tmpdir(), 'model-bench-'));
    process.env.DB_PATH = path.join(scratch, 'bench.db');
    process.env.VAULT_ROOT = path.join(scratch, 'vault');
    mkdirSync(process.env.VAULT_ROOT, { recursive: true });
    process.env.AI_PROVIDER = 'openai';
    process.env.AI_BASE_URL = OPENROUTER;
    process.env.AI_MODEL = model;
    process.env.AI_API_KEY = key;
    delete process.env.OPENAI_API_KEY;
    delete process.env.AI_EXTRA_BODY;
    return scratch;
}

const isChat = (u) => u.startsWith('https://openrouter.ai/') && /\/chat\/completions$/.test(u.split('?')[0]);

/** The calls of the case being run; the wrapper appends to it. */
export const tape = { calls: [] };

/**
 * Wrap the global fetch. `slot()` is awaited before each model request and
 * may refuse it ({ok:false, why}). `mock`, when given, answers model requests
 * and the catalogue itself, so nothing leaves the machine.
 */
export function installFetch({ slot = async () => ({ ok: true }), mock = null, onDailyLimit = () => {} } = {}) {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
        const u = String(url instanceof URL ? url.href : url?.url ?? url);
        if (mock && u.startsWith('https://openrouter.ai/') && !isChat(u)) return mock.catalogue(u);
        if (!isChat(u)) return realFetch(url, init);
        const s = await slot();
        if (!s.ok) throw new OutOfSlots(`no request slot: ${s.why}`);
        const body = JSON.parse(init.body);
        body.usage = { include: true };
        const rec = { t0: Date.now(), effort: body.reasoning?.effort ?? null, stream: !!body.stream };
        tape.calls.push(rec);
        let res;
        try {
            res = mock ? mock.reply(body) : await realFetch(url, { ...init, body: JSON.stringify(body) });
        } catch (e) {
            rec.error = `network: ${String(e?.message || e).slice(0, 200)}`; rec.ms = Date.now() - rec.t0;
            throw e;
        }
        rec.status = res.status;
        if (!res.ok) {
            rec.error = (await res.clone().text()).slice(0, 400); rec.ms = Date.now() - rec.t0;
            if (/free-models-per-day/i.test(rec.error)) onDailyLimit();
            return res;
        }
        const isStream = (res.headers.get('content-type') || '').includes('text/event-stream');
        if (!isStream) {
            rec.done = res.clone().text().then((t) => {
                rec.ms = Date.now() - rec.t0;
                try {
                    const j = JSON.parse(t);
                    if (j.provider) rec.provider = j.provider;
                    if (j.usage) rec.usage = j.usage;
                    if (j.error) rec.streamError = JSON.stringify(j.error).slice(0, 300);
                    rec.firstAny = rec.firstContent = rec.ms;
                } catch { rec.streamError = `unparseable body: ${t.slice(0, 120)}`; }
            }, (e) => {
                // The app's own timeout aborts the body: recorded, never thrown,
                // or it would surface as an unhandled rejection and end the run.
                rec.ms = Date.now() - rec.t0;
                rec.streamError = `body: ${String(e?.message || e).slice(0, 200)}`;
            });
            return res;
        }
        const [a, b] = res.body.tee();
        rec.done = (async () => {
            const reader = b.getReader(); const dec = new TextDecoder(); let buf = '';
            try {
                for (;;) {
                    const { done, value } = await reader.read(); if (done) break;
                    buf += dec.decode(value, { stream: true });
                    let i;
                    while ((i = buf.indexOf('\n')) >= 0) {
                        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
                        if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
                        try {
                            const j = JSON.parse(line.slice(5));
                            const d = j.choices?.[0]?.delta || {};
                            if (!rec.firstAny && (d.content || d.reasoning || d.reasoning_content)) rec.firstAny = Date.now() - rec.t0;
                            if (!rec.firstContent && d.content) rec.firstContent = Date.now() - rec.t0;
                            if (j.provider) rec.provider = j.provider;
                            // An upstream refusal can arrive as HTTP 200 plus an error event.
                            if (j.error) rec.streamError = JSON.stringify(j.error).slice(0, 300);
                            if (j.usage) rec.usage = j.usage;
                        } catch { /* keep-alive comment */ }
                    }
                }
            } catch (e) { rec.streamError ||= `stream: ${String(e?.message || e).slice(0, 200)}`; }
            rec.ms = Date.now() - rec.t0;
        })();
        return new Response(a, { status: res.status, statusText: res.statusText, headers: res.headers });
    };
}

export class OutOfSlots extends Error {}

/** Send the app's own console output to `sink` (a function taking one line),
 *  so the benchmark's lines stay readable. Returns the benchmark's printer. */
export function muteAppLogs(sink = () => {}) {
    const print = console.log.bind(console);
    const to = (lvl) => (...a) => sink(`[${lvl}] ${a.map(x => typeof x === 'string' ? x : (x instanceof Error ? x.message : JSON.stringify(x))).join(' ')}`);
    console.log = to('log'); console.info = to('info'); console.warn = to('warn'); console.error = to('error'); console.debug = () => {};
    return print;
}

/** Import the app against the scratch library and check it is that library. */
export async function loadApp(model) {
    const B = new URL('../../server/', import.meta.url).href;
    const { dataPaths } = await import(B + 'paths.js');
    if (path.resolve(dataPaths().dbPath) !== path.resolve(process.env.DB_PATH)) {
        throw new Error(`guard: the library is ${dataPaths().dbPath}, not the scratch copy`);
    }
    const db = (await import(B + 'database.js')).default;
    const ai = await import(B + 'ai.js');
    const s = ai.getAISettings();
    if (s.model !== model || s.provider !== 'openai' || !s.apiKey) throw new Error('guard: the env overrides did not reach getAISettings');
    return { db, ai, server: (p) => import(B + p) };
}

// Refusals and dropped connections upstream, worth another attempt. The app's
// own timeout is not among them: a model too slow for the app fails the case,
// as it would fail the learner.
const TRANSIENT = /\b429\b|rate.?limit|temporarily|overloaded|\b50[234]\b|ECONNRESET|ETIMEDOUT|network:|fetch failed|no endpoints|provider returned error/i;
const sum = (xs, f) => xs.reduce((s, x) => s + (f(x) || 0), 0);

/**
 * Run one case once: its `run` through the app, then its `score`. Returns the
 * row (without retry bookkeeping). `capMs` bounds a case that never returns.
 */
export async function runOnce(c, app, { capMs = 6 * 60_000 } = {}) {
    tape.calls = [];
    const t0 = Date.now();
    let output, error = null, outOfSlots = false;
    let timer;
    try {
        output = await Promise.race([
            c.run(app),
            new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`case cap ${capMs / 1000}s`)), capMs); }),
        ]);
    } catch (e) {
        if (e instanceof OutOfSlots || /no request slot/.test(String(e?.message))) outOfSlots = true;
        error = String(e?.message || e).slice(0, 400);
    } finally { clearTimeout(timer); }
    const calls = tape.calls;
    await Promise.all(calls.map(x => x.done).filter(Boolean));
    if (calls.some(x => /no request slot/.test(x.error || ''))) outOfSlots = true;
    const callErrors = calls.map(x => x.error || x.streamError).filter(Boolean);
    let verdict = { pass: false, why: error || 'no output' };
    if (!error) {
        try { verdict = await c.score(output, app); } catch (e) { verdict = { pass: false, why: `scorer threw: ${String(e?.message || e).slice(0, 200)}` }; }
    }
    const transient = !verdict.pass && (TRANSIENT.test(error || '') || callErrors.some(e => TRANSIENT.test(e)));
    return {
        outOfSlots,
        row: {
            case: c.id, category: c.category, pass: !!verdict.pass, why: String(verdict.why || '').slice(0, 300),
            error, transient,
            wallMs: Date.now() - t0,
            calls: calls.length,
            firstTokenMs: calls[0]?.firstAny ?? null,
            modelMs: sum(calls, x => x.ms),
            promptTokens: sum(calls, x => x.usage?.prompt_tokens),
            completionTokens: sum(calls, x => x.usage?.completion_tokens),
            reasoningTokens: sum(calls, x => x.usage?.completion_tokens_details?.reasoning_tokens),
            cost: +sum(calls, x => x.usage?.cost).toFixed(6),
            providers: [...new Set(calls.map(x => x.provider).filter(Boolean))],
            callErrors: callErrors.map(e => e.slice(0, 200)),
            output: typeof output === 'string' ? output.slice(0, 4000) : JSON.stringify(output ?? null)?.slice(0, 4000) ?? null,
            at: new Date().toISOString(),
        },
    };
}
