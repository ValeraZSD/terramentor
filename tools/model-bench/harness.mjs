/**
 * What the benchmark's live worker (worker.mjs) and its scorer check
 * (mutate.mjs) share: a scratch library, a fetch wrapper that measures every
 * model request, and one case run.
 *
 * Order matters. `startLibrary()` and `installFetch()` must run before any
 * server module is imported: the library path is resolved once, and the app
 * builds its model fetch from the global fetch when server/aiWire.js loads.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';

export const OPENROUTER = 'https://openrouter.ai/api/v1';
export const ANTHROPIC = 'https://api.anthropic.com/v1';

/** A model named `anthropic:<id>` is called on Anthropic's own API, through
 *  the app's direct Anthropic connection (server/anthropicWire.js), the way a
 *  learner who connects an Anthropic key gets it. Any other id goes to OpenRouter. */
const DIRECT_PREFIX = 'anthropic:';
export const isDirect = (model) => String(model).startsWith(DIRECT_PREFIX);
export const apiModel = (model) => (isDirect(model) ? String(model).slice(DIRECT_PREFIX.length) : String(model));

/** Anthropic's list prices in $ per million tokens, from
 *  platform.claude.com/docs/en/about-claude/pricing (read 19 Nov 2026).
 *  Anthropic's reply carries tokens, not cost, so the benchmark prices them
 *  itself. A 5-minute cache write is 1.25x input on all three. Haiku 5.5 bills
 *  a request whose prompt (cache reads and writes included) is over 100,000
 *  tokens at its long-context prices. */
const ANTHROPIC_PRICES = {
    'claude-haiku-5-5': { in: 0.10, out: 0.50, cacheRead: 0.01, long: { over: 100_000, in: 0.50, out: 2.50, cacheRead: 0.05 } },
    'claude-sonnet-5-5': { in: 2, out: 10, cacheRead: 0.10 },
    'claude-opus-5-5': { in: 4, out: 20, cacheRead: 0.20 },
};
export const hasAnthropicPrice = (id) => Object.hasOwn(ANTHROPIC_PRICES, id);

/** Anthropic's usage block in the OpenRouter shape the rows are summed from. */
export function anthropicUsage(u, model) {
    const fresh = u.input_tokens || 0, write = u.cache_creation_input_tokens || 0, read = u.cache_read_input_tokens || 0;
    const prompt = fresh + write + read, out = u.output_tokens || 0;
    const base = ANTHROPIC_PRICES[model];
    const p = base?.long && prompt > base.long.over ? base.long : base;
    return {
        prompt_tokens: prompt, completion_tokens: out, cache_read_tokens: read, cache_write_tokens: write,
        cost: p ? (fresh * p.in + write * p.in * 1.25 + read * p.cacheRead + out * p.out) / 1e6 : undefined,
    };
}

/** A fresh empty library and the env overrides getAISettings() reads. */
export function startLibrary(model, key) {
    if (isDirect(model) && !hasAnthropicPrice(apiModel(model))) {
        throw new Error(`no Anthropic price for ${apiModel(model)}: add it to ANTHROPIC_PRICES in harness.mjs`);
    }
    const scratch = mkdtempSync(path.join(tmpdir(), 'model-bench-'));
    process.env.DB_PATH = path.join(scratch, 'bench.db');
    process.env.VAULT_ROOT = path.join(scratch, 'vault');
    mkdirSync(process.env.VAULT_ROOT, { recursive: true });
    process.env.AI_PROVIDER = 'openai';
    process.env.AI_BASE_URL = isDirect(model) ? ANTHROPIC : OPENROUTER;
    process.env.AI_MODEL = apiModel(model);
    process.env.AI_API_KEY = key;
    delete process.env.OPENAI_API_KEY;
    delete process.env.AI_EXTRA_BODY;
    return scratch;
}

/** Close the scratch library and delete it. */
export function endLibrary(scratch, app) {
    try { app?.db?.close(); } catch { /* already closed */ }
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* a file still held; the temp folder is the OS's to clear */ }
}

const isAnthropicCall = (u) => u.startsWith('https://api.anthropic.com/') && /\/v1\/messages$/.test(u.split('?')[0]);
const isChat = (u) => (u.startsWith('https://openrouter.ai/') && /\/chat\/completions$/.test(u.split('?')[0])) || isAnthropicCall(u);

/**
 * The case being run. Each `runOnce` gets its own record, carried through the
 * app's async calls, so a case abandoned at its time cap cannot add requests,
 * tokens or cost to the case after it.
 */
const caseContext = new AsyncLocalStorage();
let currentCase = null;

/** Replies that say the run itself cannot go on for this model (not the model's fault). */
const RUN_FATAL = (status, text) => status === 401 || status === 402 || status === 403
    || (status === 404 && /privacy|data policy|guardrail|\bZDR\b|not_found_error/i.test(text))
    || (status === 400 && /credit balance|usage limits?/i.test(text));

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
        const cs = caseContext.getStore();
        if (cs && cs !== currentCase) throw new Error('case abandoned at its time cap');
        const rec = { t0: Date.now() };
        cs?.calls.push(rec);
        const s = await slot();
        rec.waitMs = Date.now() - rec.t0;
        if (!s.ok) {
            rec.error = `no request slot: ${s.why}`;
            if (cs) cs.outOfSlots = true;
            throw new OutOfSlots(rec.error);
        }
        if (init.signal?.aborted) {
            // The app's own timer ran out while this request queued for a slot.
            rec.error = `limiter: the app's timeout ran out after ${Math.round(rec.waitMs / 1000)} s waiting for a request slot`;
            throw init.signal.reason ?? new Error(rec.error);
        }
        const body = JSON.parse(init.body);
        const direct = isAnthropicCall(u);
        // OpenRouter reports cost only when asked; Anthropic refuses a field it does not know.
        if (!direct) body.usage = { include: true };
        rec.t0 = Date.now();
        rec.effort = (direct ? body.output_config?.effort : body.reasoning?.effort) ?? null;
        // The direct wire turns thinking on only when the model catalogue says it can.
        rec.thinking = direct ? body.thinking?.type ?? null : null;
        rec.stream = !!body.stream;
        if (direct) rec.provider = 'Anthropic';
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
            if (/free-models-per-day/i.test(rec.error)) { onDailyLimit(); if (cs) cs.outOfSlots = true; }
            if (cs && RUN_FATAL(res.status, rec.error)) cs.fatal ||= `HTTP ${res.status}: ${rec.error.slice(0, 200)}`;
            return res;
        }
        const isStream = (res.headers.get('content-type') || '').includes('text/event-stream');
        if (!isStream) {
            rec.done = res.clone().text().then((t) => {
                rec.ms = Date.now() - rec.t0;
                try {
                    const j = JSON.parse(t);
                    if (j.provider) rec.provider = j.provider;
                    if (j.usage) rec.usage = direct ? anthropicUsage(j.usage, body.model) : j.usage;
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
        const reader = b.getReader();
        rec.cancel = () => reader.cancel().catch(() => {});
        rec.done = (async () => {
            const dec = new TextDecoder(); let buf = '';
            // Anthropic's stream gives input tokens at message_start and the
            // running output count at message_delta; later non-null fields win.
            let raw = null;
            const anthropicEvent = (j) => {
                const t = j.delta?.type;
                if (j.type === 'message_start') raw = { ...j.message?.usage };
                else if (j.type === 'message_delta' && j.usage) {
                    raw = { ...raw, ...Object.fromEntries(Object.entries(j.usage).filter(([, v]) => v != null)) };
                } else if (j.type === 'content_block_delta') {
                    if (!rec.firstAny && (t === 'text_delta' || t === 'thinking_delta')) rec.firstAny = Date.now() - rec.t0;
                    if (!rec.firstContent && t === 'text_delta') rec.firstContent = Date.now() - rec.t0;
                } else if (j.type === 'error') rec.streamError = JSON.stringify(j.error).slice(0, 300);
                if (raw) rec.usage = anthropicUsage(raw, body.model);
            };
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
                            if (direct) { anthropicEvent(j); continue; }
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
    const paths = dataPaths();
    if (path.resolve(paths.dbPath) !== path.resolve(process.env.DB_PATH)) {
        throw new Error(`guard: the library is ${paths.dbPath}, not the scratch copy`);
    }
    if (paths.vaultRoot && path.resolve(paths.vaultRoot) !== path.resolve(process.env.VAULT_ROOT)) {
        throw new Error(`guard: the vault is ${paths.vaultRoot}, not the scratch copy`);
    }
    const db = (await import(B + 'database.js')).default;
    const ai = await import(B + 'ai.js');
    const s = ai.getAISettings();
    if (s.model !== apiModel(model) || s.provider !== 'openai' || !s.apiKey) throw new Error('guard: the env overrides did not reach getAISettings');
    return { db, ai, server: (p) => import(B + p) };
}

// Refusals and dropped connections upstream, worth another attempt. The app's
// own timeout is not among them: a model too slow for the app fails the case,
// as it would fail the learner. A timeout the benchmark's own request queue
// caused is (see `runOnce`).
const TRANSIENT = /\b429\b|rate.?limit|temporarily|overloaded|\b50[0234]\b|api_error|internal server error|ECONNRESET|ETIMEDOUT|socket hang up|terminated|network:|limiter:|fetch failed|provider returned error/i;
const APP_TIMEOUT = /Request timeout after|timed? ?out/i;
const sum = (xs, f) => xs.reduce((s, x) => s + (f(x) || 0), 0);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Run one case once: its `run` through the app, then its `score`. Returns
 * `{ row }`, or `{ outOfSlots }` / `{ fatal }` when the run must stop for this
 * model and the case must not be recorded. `capMs` bounds a case that never
 * returns.
 */
export async function runOnce(c, app, { capMs = 6 * 60_000 } = {}) {
    const cs = { calls: [], outOfSlots: false, fatal: '' };
    currentCase = cs;
    const t0 = Date.now();
    let output, error = null;
    let timer;
    try {
        output = await caseContext.run(cs, () => Promise.race([
            c.run(app),
            new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`case cap ${capMs / 1000}s`)), capMs); }),
        ]));
    } catch (e) {
        if (e instanceof OutOfSlots) cs.outOfSlots = true;
        error = String(e?.message || e).slice(0, 400);
    } finally { clearTimeout(timer); }
    currentCase = null;
    const calls = cs.calls;
    // A stream the app gave up on without aborting must not hold the worker.
    const settled = Promise.all(calls.map(x => x.done).filter(Boolean));
    if (await Promise.race([settled.then(() => true), sleep(30_000).then(() => false)]) === false) {
        for (const x of calls) { x.cancel?.(); x.streamError ||= 'stream: still open 30 s after the case ended'; }
    }
    if (cs.outOfSlots) return { outOfSlots: true };
    if (cs.fatal) return { fatal: cs.fatal };
    const callErrors = calls.map(x => x.error || x.streamError).filter(Boolean);
    let verdict = { pass: false, why: error || 'no output' };
    if (!error) {
        try { verdict = await c.score(output, app); } catch (e) { verdict = { pass: false, why: `scorer threw: ${String(e?.message || e).slice(0, 200)}` }; }
    }
    const waitMs = sum(calls, x => x.waitMs);
    const timedOut = APP_TIMEOUT.test(error || '') || callErrors.some(e => APP_TIMEOUT.test(e));
    const transient = !verdict.pass && (TRANSIENT.test(error || '') || callErrors.some(e => TRANSIENT.test(e))
        // The request queue ate part of the app's timeout: not the model's fault.
        || (timedOut && waitMs >= 5000));
    return {
        row: {
            case: c.id, category: c.category, pass: !!verdict.pass, why: String(verdict.why || '').slice(0, 300),
            error, transient,
            wallMs: Date.now() - t0,
            waitMs,
            calls: calls.length,
            firstTokenMs: calls[0]?.firstAny ?? null,
            modelMs: sum(calls, x => x.ms),
            promptTokens: sum(calls, x => x.usage?.prompt_tokens),
            completionTokens: sum(calls, x => x.usage?.completion_tokens),
            reasoningTokens: sum(calls, x => x.usage?.completion_tokens_details?.reasoning_tokens),
            cacheReadTokens: sum(calls, x => x.usage?.cache_read_tokens),
            cacheWriteTokens: sum(calls, x => x.usage?.cache_write_tokens),
            efforts: [...new Set(calls.map(x => x.effort ?? null))],
            thinking: [...new Set(calls.map(x => x.thinking ?? null))],
            cost: +sum(calls, x => x.usage?.cost).toFixed(6),
            providers: [...new Set(calls.map(x => x.provider).filter(Boolean))],
            callErrors: callErrors.map(e => e.slice(0, 200)),
            output: typeof output === 'string' ? output.slice(0, 4000) : JSON.stringify(output ?? null)?.slice(0, 4000) ?? null,
            at: new Date().toISOString(),
        },
    };
}
