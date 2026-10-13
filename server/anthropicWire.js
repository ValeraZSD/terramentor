/* Anthropic's own API, spoken behind the OpenAI-compatible wire.
 *
 * Every model call in this app is written in the OpenAI chat-completions shape
 * (server/ai.js): one retry layer, one stream parser, one empty-reply
 * diagnosis, one tool loop. Anthropic offers an OpenAI-compatible endpoint of
 * its own, and its documentation says plainly what it is: a beta "for testing",
 * not production, which DROPS prompt caching and extended thinking. Caching is
 * most of the reason to connect Anthropic directly, so this module speaks the
 * native Messages API instead and translates at the transport: a request in
 * the OpenAI shape goes in, `/v1/messages` is called, and the answer comes back
 * as an OpenAI-shaped Response — JSON or SSE — so nothing above the transport
 * learns there is a second protocol.
 *
 * What the translation decides, and why:
 *   - SYSTEM. Leading system messages become the top-level `system` blocks; a
 *     system message later in the conversation becomes a user turn, because
 *     only a leading one may sit before the cached prefix. A system text that
 *     carries chat's clock and running-work block (chatContext.js
 *     `NOW_BLOCK_HEADING`, rebuilt every turn and always last) is cut there
 *     into two blocks, and the cache breakpoint goes before the cut.
 *   - CACHING. One explicit breakpoint on the last STABLE system block, so
 *     the next request of the same kind within five minutes reads the prefix
 *     at a tenth of the price. Automatic caching of the conversation tail only
 *     on a request that carries tools — the assistant's lookup rounds resend
 *     the whole turn up to six times — because on a one-shot call it writes a
 *     prefix nobody will read back, at 1.25x.
 *   - SAMPLING. `temperature` and `top_p` are never sent: the current models
 *     refuse non-default values with a 400.
 *   - THINKING. Asked for (adaptive, summarised so chat's reasoning panel has
 *     words to show) only on a model whose own catalogue entry says it takes
 *     adaptive thinking; effort only where the catalogue lists that level.
 *     A model the catalogue does not describe gets neither — never a guess.
 *   - TOOL ROUNDS. A round that ends in tool calls must be sent back with its
 *     thinking blocks exactly as they came (signature included), or the next
 *     round is refused. The OpenAI shape has nowhere to keep them, so the
 *     blocks of each such reply are held here, keyed by the reply's first
 *     tool-call id, and put back verbatim when that assistant message returns.
 */

import { NOW_BLOCK_HEADING } from './chatContext.js';

const ANTHROPIC_VERSION = '2023-06-01';
/* `max_tokens` caps the thinking AND the answer together, so a level that
 * thinks longer needs a larger cap or it spends the whole budget thinking and
 * returns nothing (OpenRouter documents the same trap; the app's empty-reply
 * diagnosis would then name it). The request always STREAMS upstream, even
 * for a caller that wants one JSON answer, so a large cap never meets an HTTP
 * timeout; the model's own ceiling still bounds it. */
export const MAX_TOKENS_BY_EFFORT = { none: 16000, minimal: 16000, low: 16000, medium: 32000, high: 64000, xhigh: 128000, max: 128000 };
const DEFAULT_MAX_TOKENS = 32000;
const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];
const CAPS_TTL_MS = 60 * 60 * 1000;
const ROUND_CACHE_MAX = 200;

/** Status codes the app's retry layer acts on. Anthropic's "overloaded" is
 *  529, which no other endpoint sends; it is a 503 in every way that matters. */
const statusForApp = (status) => (status === 529 ? 503 : status);

const capsCache = new Map();          // `${origin}|${model}` → { caps, at }
const roundBlocks = new Map();        // first tool_use id → content blocks, insertion-ordered

function rememberRound(blocks) {
    const first = blocks.find(b => b.type === 'tool_use');
    if (!first) return;
    roundBlocks.set(first.id, blocks);
    while (roundBlocks.size > ROUND_CACHE_MAX) roundBlocks.delete(roundBlocks.keys().next().value);
}

/** For the gate: forget every remembered round and model entry. */
export function resetAnthropicWireState() { capsCache.clear(); roundBlocks.clear(); }

// ── request ───────────────────────────────────────────────────────────────

/** A system text cut where the per-turn tail begins (chatContext.js), so the
 *  breakpoint can sit on the part that is the same every turn. */
export function splitAtVolatileTail(text) {
    if (!text) return [];
    const at = text.lastIndexOf(NOW_BLOCK_HEADING);
    if (at <= 0) return [text];
    return [text.slice(0, at), text.slice(at)];
}

function textOf(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map(p => (typeof p === 'string' ? p : p?.text || '')).join('');
    return '';
}

/** An OpenAI content part → an Anthropic block, or null for one it cannot carry. */
function partToBlock(part) {
    if (typeof part === 'string') return part ? { type: 'text', text: part } : null;
    if (part?.type === 'text') return part.text ? { type: 'text', text: part.text } : null;
    if (part?.type === 'image_url') {
        const url = String(part.image_url?.url || '');
        const data = /^data:([^;,]+);base64,(.*)$/s.exec(url);
        if (data) return { type: 'image', source: { type: 'base64', media_type: data[1], data: data[2] } };
        if (/^https:\/\//i.test(url)) return { type: 'image', source: { type: 'url', url } };
    }
    return null;
}

function userBlocks(content) {
    if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
    return (Array.isArray(content) ? content : []).map(partToBlock).filter(Boolean);
}

function assistantBlocks(m) {
    const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
    if (calls.length) {
        const kept = roundBlocks.get(calls[0]?.id);
        if (kept) return kept;
    }
    const blocks = [];
    const text = textOf(m.content);
    if (text) blocks.push({ type: 'text', text });
    for (const c of calls) {
        let input = {};
        try { input = JSON.parse(c.function?.arguments || '{}') || {}; } catch { input = {}; }
        blocks.push({ type: 'tool_use', id: c.id, name: c.function?.name || '', input });
    }
    return blocks;
}

/**
 * The OpenAI-shaped body as an Anthropic Messages body. Pure apart from the
 * remembered tool rounds; `caps` is the model's catalogue entry or null.
 */
export function toAnthropicRequest(body, { caps = null } = {}) {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const system = [];
    let stableSystemEnd = -1;     // index of the block that carries the breakpoint
    let i = 0;
    for (; i < messages.length && messages[i]?.role === 'system'; i++) {
        const c = messages[i].content;
        const parts = Array.isArray(c) && c.length > 1
            ? c.map(p => (typeof p === 'string' ? p : p?.text || '')).filter(Boolean)
            : splitAtVolatileTail(textOf(c));
        parts.forEach((text, k) => {
            system.push({ type: 'text', text });
            if (parts.length === 1 || k < parts.length - 1) stableSystemEnd = system.length - 1;
        });
    }

    const out = [];
    const push = (role, blocks) => {
        if (!blocks.length) return;
        const last = out[out.length - 1];
        // Consecutive turns of one role are merged here rather than left to the
        // API, so the tool results of one round always share ONE user message.
        if (last && last.role === role) last.content.push(...blocks);
        else out.push({ role, content: [...blocks] });
    };
    for (; i < messages.length; i++) {
        const m = messages[i] || {};
        if (m.role === 'system') push('user', [{ type: 'text', text: textOf(m.content) }].filter(b => b.text));
        else if (m.role === 'user') push('user', userBlocks(m.content));
        else if (m.role === 'assistant') push('assistant', assistantBlocks(m));
        else if (m.role === 'tool') {
            push('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: textOf(m.content) || '(no result)' }]);
        }
    }
    // The API wants a conversation to open with the learner.
    if (out[0]?.role === 'assistant') out.unshift({ role: 'user', content: [{ type: 'text', text: '(continue)' }] });

    // The level actually sent (below) decides the cap, so it is settled first.
    const effort = anthropicEffort(body.reasoning?.effort || body.reasoning_effort, caps);
    const ceiling = Number(caps?.max_tokens) || DEFAULT_MAX_TOKENS;
    const req = {
        model: body.model,
        max_tokens: Math.min(ceiling, MAX_TOKENS_BY_EFFORT[effort] || DEFAULT_MAX_TOKENS),
        messages: out,
        stream: true,
    };
    if (system.length) {
        if (stableSystemEnd >= 0) system[stableSystemEnd] = { ...system[stableSystemEnd], cache_control: { type: 'ephemeral' } };
        req.system = system;
    }

    const tools = Array.isArray(body.tools) ? body.tools : [];
    if (tools.length) {
        req.tools = tools.map(t => ({
            name: t.function?.name || t.name,
            description: t.function?.description || t.description || '',
            input_schema: t.function?.parameters || t.parameters || { type: 'object', properties: {} },
        }));
        req.tool_choice = { type: 'auto' };
        // The lookup rounds resend the turn; the tail is worth caching there.
        req.cache_control = { type: 'ephemeral' };
    }

    const thinking = caps?.capabilities?.thinking;
    if (thinking?.supported && thinking?.types?.adaptive?.supported) {
        req.thinking = { type: 'adaptive', display: 'summarized' };
    }
    if (effort) req.output_config = { effort };
    return req;
}

/** The levels this model's catalogue entry lists, weakest first; `[]` when it
 *  takes none or the entry is unknown. */
export function anthropicEffortLevels(caps) {
    const e = caps?.capabilities?.effort;
    if (!e?.supported) return [];
    return EFFORT_ORDER.filter(l => e[l]?.supported);
}

/** The level to send: the asked one if listed, else the nearest one above,
 *  else the strongest listed; nothing for a model that lists none. */
export function anthropicEffort(desired, caps) {
    if (!desired) return '';
    const levels = anthropicEffortLevels(caps);
    if (!levels.length) return '';
    if (levels.includes(desired)) return desired;
    const want = EFFORT_ORDER.indexOf(desired);
    return levels.find(l => EFFORT_ORDER.indexOf(l) >= want) || levels[levels.length - 1];
}

/** For Settings: what the thinking control may offer for one model. */
export async function anthropicModelEfforts(baseUrl, key, model, { fetchImpl = fetch } = {}) {
    const caps = await modelCaps(new URL(baseUrl).origin, key, model, fetchImpl);
    return { levels: anthropicEffortLevels(caps), known: !!caps };
}

// ── response ──────────────────────────────────────────────────────────────

const FINISH = { end_turn: 'stop', stop_sequence: 'stop', pause_turn: 'stop', max_tokens: 'length', tool_use: 'tool_calls', refusal: 'content_filter' };
export const finishReasonOf = (stop) => FINISH[stop] || (stop ? 'stop' : null);

/** Anthropic usage → the OpenAI usage block, plus the raw figures kept beside. */
export function usageOf(u = {}) {
    const read = Number(u.cache_read_input_tokens) || 0;
    const wrote = Number(u.cache_creation_input_tokens) || 0;
    const fresh = Number(u.input_tokens) || 0;
    return {
        prompt_tokens: fresh + read + wrote,
        completion_tokens: Number(u.output_tokens) || 0,
        total_tokens: fresh + read + wrote + (Number(u.output_tokens) || 0),
        prompt_tokens_details: { cached_tokens: read },
        cache_read_input_tokens: read,
        cache_creation_input_tokens: wrote,
        input_tokens: fresh,
    };
}

/** A whole Messages reply as a chat.completion. */
export function fromAnthropicMessage(msg) {
    const blocks = Array.isArray(msg?.content) ? msg.content : [];
    rememberRound(blocks);
    const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('');
    const reasoning = blocks.filter(b => b.type === 'thinking').map(b => b.thinking || '').join('');
    const calls = blocks.filter(b => b.type === 'tool_use').map(b => ({
        id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
    }));
    const message = { role: 'assistant', content: text };
    if (reasoning) message.reasoning_content = reasoning;
    if (calls.length) message.tool_calls = calls;
    return {
        id: msg?.id || '',
        object: 'chat.completion',
        model: msg?.model || '',
        choices: [{ index: 0, message, finish_reason: finishReasonOf(msg?.stop_reason) }],
        usage: usageOf(msg?.usage),
    };
}

/**
 * Translate one Anthropic SSE stream into OpenAI SSE lines. A generator over
 * already-split `{event, data}` frames, so the gate can feed it recorded ones.
 */
export function createStreamTranslator() {
    const blocks = [];           // the reply as it is assembled, for tool rounds
    const toolOrdinal = new Map(); // content index → tool_calls index
    let usage = {};
    let stop = null;
    let head = {};               // id + model from message_start
    let failure = null;          // { status, message } from an error event
    const chunk = (delta, finish = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    return {
        /** One parsed event → zero or more SSE lines to emit. */
        push(ev) {
            const out = [];
            switch (ev?.type) {
                case 'message_start':
                    usage = { ...(ev.message?.usage || {}) };
                    head = { id: ev.message?.id || '', model: ev.message?.model || '' };
                    break;
                case 'content_block_start': {
                    const b = ev.content_block || {};
                    blocks[ev.index] = b.type === 'tool_use' ? { ...b, input: undefined, _json: '' }
                        : b.type === 'thinking' ? { type: 'thinking', thinking: b.thinking || '', signature: b.signature || '' }
                        : b.type === 'redacted_thinking' ? { ...b }
                        : { type: 'text', text: b.text || '' };
                    if (b.type === 'tool_use') {
                        const k = toolOrdinal.size;
                        toolOrdinal.set(ev.index, k);
                        out.push(chunk({ tool_calls: [{ index: k, id: b.id, type: 'function', function: { name: b.name, arguments: '' } }] }));
                    }
                    break;
                }
                case 'content_block_delta': {
                    const d = ev.delta || {};
                    const b = blocks[ev.index];
                    if (d.type === 'text_delta' && d.text) { if (b) b.text += d.text; out.push(chunk({ content: d.text })); }
                    else if (d.type === 'thinking_delta' && d.thinking) { if (b) b.thinking += d.thinking; out.push(chunk({ reasoning_content: d.thinking })); }
                    else if (d.type === 'signature_delta') { if (b) b.signature = (b.signature || '') + (d.signature || ''); }
                    else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
                        if (b) b._json += d.partial_json;
                        if (d.partial_json) out.push(chunk({ tool_calls: [{ index: toolOrdinal.get(ev.index) ?? 0, function: { arguments: d.partial_json } }] }));
                    }
                    break;
                }
                case 'content_block_stop': {
                    const b = blocks[ev.index];
                    if (b?.type === 'tool_use') {
                        try { b.input = JSON.parse(b._json || '{}'); } catch { b.input = {}; }
                        delete b._json;
                    }
                    break;
                }
                case 'message_delta':
                    if (ev.delta?.stop_reason) stop = ev.delta.stop_reason;
                    usage = { ...usage, ...(ev.usage || {}) };
                    break;
                case 'message_stop': {
                    rememberRound(blocks.filter(Boolean));
                    out.push(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finishReasonOf(stop) || 'stop' }], usage: usageOf(usage) })}\n\n`);
                    out.push('data: [DONE]\n\n');
                    break;
                }
                case 'error': {
                    const type = ev.error?.type || '';
                    const code = type === 'overloaded_error' ? 503 : type === 'rate_limit_error' ? 429
                        : type === 'api_error' ? 500 : type === 'billing_error' ? 402 : 400;
                    failure = { status: code, message: ev.error?.message || type || 'Anthropic stream error', type };
                    out.push(`data: ${JSON.stringify({ error: { code, message: failure.message } })}\n\n`);
                    break;
                }
                default: break; // ping and anything newer
            }
            return out;
        },
        get usage() { return usageOf(usage); },
        get failure() { return failure; },
        /** The whole reply, as a non-streamed Messages response would have carried it. */
        message() {
            return { ...head, content: blocks.filter(Boolean), stop_reason: stop, usage };
        },
    };
}

// ── transport ─────────────────────────────────────────────────────────────

function anthropicHeaders(key) {
    return { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION };
}

function jsonResponse(status, body) {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** The model's catalogue entry, or null when it cannot be had. Cached an hour. */
async function modelCaps(origin, key, model, fetchImpl, signal) {
    const ck = `${origin}|${model}`;
    const hit = capsCache.get(ck);
    if (hit && Date.now() - hit.at < CAPS_TTL_MS) return hit.caps;
    try {
        const res = await fetchImpl(`${origin}/v1/models/${encodeURIComponent(model)}`, {
            headers: anthropicHeaders(key), signal: signal ?? AbortSignal.timeout(8000),
        });
        if (res.status === 404) { capsCache.set(ck, { caps: null, at: Date.now() }); return null; }
        if (!res.ok) return hit?.caps ?? null;
        const caps = await res.json();
        capsCache.set(ck, { caps, at: Date.now() });
        return caps;
    } catch { return hit?.caps ?? null; }
}

function keyOf(init) {
    const h = init?.headers || {};
    const auth = h.Authorization || h.authorization || '';
    return String(auth).replace(/^Bearer\s+/i, '');
}

async function listModels(origin, key, fetchImpl, signal) {
    const data = [];
    let after = '';
    for (let page = 0; page < 5; page++) {
        const url = new URL(`${origin}/v1/models`);
        url.searchParams.set('limit', '1000');
        if (after) url.searchParams.set('after_id', after);
        const res = await fetchImpl(url.toString(), { headers: anthropicHeaders(key), signal });
        if (!res.ok) return new Response(await res.text().catch(() => ''), { status: statusForApp(res.status), headers: { 'content-type': 'application/json' } });
        const json = await res.json().catch(() => ({}));
        for (const m of Array.isArray(json.data) ? json.data : []) {
            data.push({ id: m.id, object: 'model', display_name: m.display_name || m.id,
                created: m.created_at ? Math.floor(Date.parse(m.created_at) / 1000) : 0 });
        }
        if (!json.has_more || !json.last_id) break;
        after = json.last_id;
    }
    return jsonResponse(200, { object: 'list', data });
}

/**
 * A `fetch` for an OpenAI-shaped base URL that is really Anthropic. `base` is
 * the normalised base URL (`https://api.anthropic.com/v1`); every path the app
 * asks for is answered: chat completions (JSON or SSE), the model list, one
 * model's catalogue entry in the shape `catalogueVision` reads, and the
 * embedding routes, which Anthropic does not have.
 */
export function createAnthropicFetch({ fetchImpl = fetch } = {}) {
    return async function anthropicFetch(url, init = {}) {
        const u = new URL(url);
        const origin = u.origin;
        const path = u.pathname.replace(/^\/v1/, '');
        const key = keyOf(init);
        const signal = init.signal;

        if (path === '/models' && (!init.method || init.method === 'GET')) return listModels(origin, key, fetchImpl, signal);
        const ep = /^\/models\/(.+)\/endpoints$/.exec(path);
        if (ep) {
            const caps = await modelCaps(origin, key, decodeURIComponent(ep[1]), fetchImpl, signal);
            if (!caps) return jsonResponse(404, { error: { message: 'Not in the catalogue' } });
            const image = !!caps.capabilities?.image_input?.supported;
            return jsonResponse(200, { data: { id: caps.id, architecture: { input_modalities: image ? ['text', 'image'] : ['text'] } } });
        }
        if (path.startsWith('/embeddings')) {
            return jsonResponse(404, { error: { message: 'Anthropic offers no embedding models. Choose another embedding provider under Model jobs.' } });
        }
        if (path !== '/chat/completions') return jsonResponse(404, { error: { message: `No such route: ${path}` } });

        let body;
        try { body = JSON.parse(init.body || '{}'); } catch { return jsonResponse(400, { error: { message: 'Request body is not JSON' } }); }
        const caps = await modelCaps(origin, key, String(body.model || ''), fetchImpl, signal);
        const req = toAnthropicRequest(body, { caps });
        const res = await fetchImpl(`${origin}/v1/messages`, {
            method: 'POST', headers: anthropicHeaders(key), body: JSON.stringify(req), signal,
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            return new Response(text, { status: statusForApp(res.status), headers: { 'content-type': 'application/json', ...(res.headers.get('retry-after') ? { 'retry-after': res.headers.get('retry-after') } : {}) } });
        }
        const translator = createStreamTranslator();
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        const events = async function* () {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) return;
                buffer += decoder.decode(value, { stream: true });
                const frames = buffer.split(/\r?\n\r?\n/);
                buffer = frames.pop() || '';
                for (const frame of frames) {
                    const data = frame.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('');
                    if (!data) continue;
                    try { yield JSON.parse(data); } catch { /* a malformed frame is skipped */ }
                }
            }
        };

        if (body.stream !== true) {
            // The caller wants one answer; the upstream still streamed it.
            try { for await (const ev of events()) translator.push(ev); } finally { reader.cancel().catch(() => { }); }
            const failed = translator.failure;
            if (failed) return jsonResponse(failed.status, { type: 'error', error: { type: failed.type, message: failed.message } });
            return jsonResponse(200, fromAnthropicMessage(translator.message()));
        }

        const encoder = new TextEncoder();
        const it = events();
        const stream = new ReadableStream({
            async pull(controller) {
                for (;;) {
                    const { done, value } = await it.next();
                    if (done) { controller.close(); return; }
                    const lines = translator.push(value);
                    if (lines.length) { for (const l of lines) controller.enqueue(encoder.encode(l)); return; }
                }
            },
            cancel(reason) { try { reader.cancel(reason).catch(() => { }); } catch { } },
        });
        return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
}
