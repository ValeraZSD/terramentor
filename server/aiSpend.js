// The counting half of the fuse (aiFuse.js): what this library spent on the
// model each month, the model a call may use now, and the operator's notice.
//
// Kept in the library's own database (`ai_spend`, one row per month). The
// library is the only process that sees its model calls, and the learner
// cannot write the table: no route reads or writes it, it is never exported,
// and a hosted copy has no file access. A library restored from a backup by
// the operator gets the month it was backed up with.
import db, { NOW_ISO } from './database.js';
import { costOf, fuseLimits, FUSE_STOPPED, monthOf, noticeText, stageOf } from './aiFuse.js';
import { learnerError } from './clientError.js';
import { localEndpointFetch } from './netSafety.js';

let stmts = null;
const q = () => stmts ||= {
    get: db.prepare('SELECT usd, calls, switched_at, stopped_at FROM ai_spend WHERE month = ?'),
    add: db.prepare(`INSERT INTO ai_spend (month, usd, calls, updated_at) VALUES (?, ?, 1, ${NOW_ISO})
        ON CONFLICT(month) DO UPDATE SET usd = usd + excluded.usd, calls = calls + 1, updated_at = excluded.updated_at`),
    switched: db.prepare(`UPDATE ai_spend SET switched_at = ${NOW_ISO} WHERE month = ? AND switched_at IS NULL`),
    stopped: db.prepare(`UPDATE ai_spend SET stopped_at = ${NOW_ISO} WHERE month = ? AND stopped_at IS NULL`),
};

let clock = () => Date.now();
/** Pin the instant the fuse counts in (a gate must not read the clock); no argument puts the real one back. */
export function setFuseClockForTest(fn) {
    clock = typeof fn === 'function' ? fn : () => Date.now();
}

/** This month's spend and stage, or null when this library has no fuse. */
export function fuseState(now = clock()) {
    const limits = fuseLimits();
    if (!limits) return null;
    const month = monthOf(now);
    const spentUsd = q().get.get(month)?.usd ?? 0;
    return { limits, month, spentUsd, stage: stageOf(spentUsd, limits) };
}

/** The refusal once the month's stop is passed. Never retried and never handed to a backup model. */
export function fuseStopError() {
    return Object.assign(learnerError(FUSE_STOPPED), { aiFuse: true, noRetry: true });
}

/** A local model (Ollama) costs the site nothing: neither counted nor switched. */
const paid = (settings) => settings?.provider !== 'ollama';

/**
 * The chain of settings a call tries (aiJobs.js chainFor), as the fuse allows
 * it now: unchanged below the switch, one entry on the small model past it, a
 * refusal past the stop. Switching here, before the call, means the model a
 * row is stamped with (aiProvenance) is the model that wrote it.
 */
export function fuseChain(chain) {
    const state = fuseState();
    if (!state || state.stage === 'main' || !chain.length || !paid(chain[0])) return chain;
    if (state.stage === 'stopped') throw fuseStopError();
    const out = [{ ...chain[0], model: state.limits.smallModel }];
    return Object.defineProperty(out, 'listsSet', { value: chain.listsSet, enumerable: false });
}

/** Add one call's cost to this month, and tell the operator about a line crossed. */
export function recordSpend(usd, now = clock()) {
    const limits = fuseLimits();
    if (!limits || !(usd > 0)) return;
    const month = monthOf(now);
    q().add.run(month, usd);
    const { usd: spentUsd } = q().get.get(month);
    // The UPDATE ... IS NULL is the once-a-month latch: two calls finishing
    // together both see the new total, only one of them sets the date.
    if (spentUsd >= limits.switchUsd && q().switched.run(month).changes) notice('switch', { spentUsd, limits, month, now });
    if (spentUsd >= limits.stopUsd && q().stopped.run(month).changes) notice('stop', { spentUsd, limits, month, now });
}

/**
 * Said to the operator: a line in this library's log, and a JSON POST to
 * AI_FUSE_NOTICE_URL when one is set (`text` is the sentence; Slack-style
 * webhooks show it as it is). Nothing the learner wrote is in it.
 */
function notice(event, { spentUsd, limits, month, now }) {
    const env = process.env;
    const text = noticeText(event, { libraryId: env.SITE_LIBRARY_ID, spentUsd, limits, month, createdAt: env.SITE_LIBRARY_CREATED, now });
    console.warn(`[ai-fuse] ${text}`);
    if (!limits.noticeUrl) return;
    const body = JSON.stringify({
        text, event, library: String(env.SITE_LIBRARY_ID || '').slice(0, 8), month,
        spentUsd: Math.round(spentUsd * 100) / 100, switchUsd: limits.switchUsd, stopUsd: limits.stopUsd,
    });
    // An address the operator typed, as an Ollama's is: a machine on their own
    // network may take it, a cloud metadata address may not, and a redirect is
    // not followed (it comes back as the 3xx it is).
    localEndpointFetch()(limits.noticeUrl, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body,
        signal: AbortSignal.timeout(10_000),
    }).then((res) => {
        if (!res.ok) console.warn(`[ai-fuse] AI_FUSE_NOTICE_URL answered ${res.status}; the notice is only in this log`);
        return res.body?.cancel();
    }).catch((e) => console.warn(`[ai-fuse] AI_FUSE_NOTICE_URL could not be reached (${e.cause?.code || e.code || e.message || e.name}); the notice is only in this log`));
}

const CHAT = /\/chat\/completions(?:\?|$)/;
const EMBEDDINGS = /\/embeddings(?:\?|$)/;
const ANSWER_CHARS_KEPT = 8 * 1024 * 1024;

/**
 * One model request through the fuse (aiWire.js wireFetch, site libraries
 * only). A chat call is refused past the stop and moved to the small model
 * past the switch (for a caller that chose its settings before the line was
 * crossed); an embedding is never refused, since searching what the library
 * already holds needs it, and costs a fraction of a cent. Every answered call
 * is counted when its body has been read to the end, or dropped.
 */
export async function meteredCall(send, settings, url, init = {}) {
    const path = String(url);
    const kind = String(init.method || 'GET').toUpperCase() !== 'POST' || !paid(settings) ? null
        : CHAT.test(path) ? 'chat' : EMBEDDINGS.test(path) ? 'embeddings' : null;
    if (!kind) return send(url, init);
    let body = init.body;
    if (kind === 'chat') {
        const state = fuseState();
        if (state.stage === 'stopped') throw fuseStopError();
        if (state.stage === 'small' && typeof body === 'string') body = onModel(body, state.limits.smallModel);
    }
    const res = await send(url, body === init.body ? init : { ...init, body });
    if (!res.ok || !res.body) return res;
    return counted(res, requestChars(body));
}

/** A request body naming `model`. Not JSON: unchanged (the fuse never breaks a request it cannot read). */
function onModel(body, model) {
    let parsed;
    try { parsed = JSON.parse(body); } catch { return body; }
    if (!parsed || typeof parsed !== 'object' || parsed.model === model) return body;
    console.warn(`[ai-fuse] a call for ${String(parsed.model).slice(0, 80)} was moved to ${model}: this month's switch was passed after its model was chosen`);
    return JSON.stringify({ ...parsed, model });
}

/** The characters a request asks the model to read: its text, without the pictures it carries as data: addresses. */
export const requestChars = (body) => (typeof body === 'string' ? body.replace(/"data:[^"]*"/g, '""').length : 0);

// After a stream's answer has finished, how long and how far the fuse reads on
// for the chunk that carries `usage`. OpenRouter sends it as an extra chunk
// AFTER the one with the finish_reason ("every stream ends with an extra chunk
// that carries the `usage` object", openrouter.ai/docs/api-reference/streaming),
// and the app's stream reader (ai.js) stops at the first finish_reason.
const DRAIN_MS = 5000;
const DRAIN_BYTES = 64 * 1024;

/**
 * The response, with its body read through on the way to the caller. The cost
 * is taken from the last `usage` block (a stream's usage chunk, or the JSON
 * body) once the body ends or errors. A caller that stops reading after the
 * answer finished leaves the rest to the fuse, which reads on to the usage
 * chunk; one that stops mid-answer is counted at once from what came (the
 * provider stops generating when the connection closes).
 */
function counted(res, inChars) {
    const source = res.body.getReader();
    const decoder = new TextDecoder();
    const isStream = /text\/event-stream/i.test(res.headers.get('content-type') || '');
    let line = '';
    let whole = '';
    let rawChars = 0;
    let textChars = 0;
    let sawData = false;
    let finished = false;
    let usage = null;
    let settled = false;
    const readLine = (l) => {
        const s = l.trim();
        if (!s.startsWith('data:')) return;
        const data = s.slice(5).trim();
        if (!data || data === '[DONE]') return;
        sawData = true;
        let json;
        try { json = JSON.parse(data); } catch { return; }
        if (json?.usage && typeof json.usage === 'object') usage = json.usage;
        const choice = json?.choices?.[0];
        const delta = choice?.delta;
        if (delta && typeof delta === 'object') {
            for (const t of [delta.content, delta.reasoning_content ?? delta.reasoning]) if (typeof t === 'string') textChars += t.length;
            if (Array.isArray(delta.tool_calls)) {
                for (const tc of delta.tool_calls) if (typeof tc?.function?.arguments === 'string') textChars += tc.function.arguments.length;
            }
        }
        if (choice?.finish_reason) finished = true;
    };
    const settle = () => {
        if (settled) return;
        settled = true;
        if (line) readLine(line);
        if (!usage && whole) {
            try { usage = JSON.parse(whole)?.usage ?? null; } catch { /* cut short */ }
        }
        // Without a usage block: the answer's text for a stream (not the
        // framing around it), the body for anything else.
        const outChars = sawData ? textChars : rawChars;
        try {
            recordSpend(costOf(usage, { inChars, outChars }).usd);
        } catch (e) {
            console.error(`[ai-fuse] could not count a call: ${e.message}`);
        }
    };
    const take = (text) => {
        rawChars += text.length;
        if (!isStream && whole.length < ANSWER_CHARS_KEPT) whole += text;
        const parts = (line + text).split('\n');
        line = parts.pop();
        for (const p of parts) readLine(p);
    };
    const readOnForUsage = async (reason) => {
        const timer = setTimeout(() => { source.cancel(reason).catch(() => { }); }, DRAIN_MS);
        timer.unref?.();
        let read = 0;
        try {
            while (!usage && read < DRAIN_BYTES) {
                const step = await source.read();
                if (step.done) break;
                read += step.value.byteLength;
                take(decoder.decode(step.value, { stream: true }));
            }
        } catch { /* cut short: counted from what came */ } finally {
            clearTimeout(timer);
            settle();
            source.cancel(reason).catch(() => { });
        }
    };
    const stream = new ReadableStream({
        async pull(ctrl) {
            let step;
            try {
                step = await source.read();
            } catch (e) {
                settle();
                throw e;
            }
            if (step.done) {
                take(decoder.decode());
                settle();
                ctrl.close();
                return;
            }
            take(decoder.decode(step.value, { stream: true }));
            ctrl.enqueue(step.value);
        },
        cancel(reason) {
            // Not awaited by the caller's reader: the usage chunk is the
            // fuse's business, not the answer's.
            if (finished && !usage && !settled) {
                readOnForUsage(reason);
                return undefined;
            }
            settle();
            return source.cancel(reason);
        },
    });
    const out = new Response(stream, { status: res.status, statusText: res.statusText, headers: res.headers });
    // Whatever a wire layer hung on the response rides on.
    for (const key of Object.keys(res)) out[key] = res[key];
    return out;
}
