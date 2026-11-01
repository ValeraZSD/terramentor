/**
 * Reading an HTTP body without trusting its size.
 *
 * `response.text()` and `response.json()` read until the server stops sending,
 * and nothing here gets to assume a server stops: a model endpoint is whatever
 * address was typed into Settings, a search engine answers with whatever it
 * likes, and a proxy in between can stall or stream forever. Every body the
 * server reads from somewhere else goes through one of these, with a limit that
 * names what a sane answer of that kind weighs.
 *
 * Two shapes of limit, because there are two shapes of body:
 *
 *   - a whole body (JSON, a page, an error) is bounded in BYTES. Text that only
 *     needs its head (a page, an error) is cut off at the limit; JSON is refused
 *     past it, since a truncated document is not a smaller answer, it is a
 *     broken one.
 *   - a stream (server-sent events) is bounded per LINE. A streamed answer is
 *     long by design and is consumed as it arrives, so its total is not the
 *     risk; a line that never ends is, because every reader above splits on
 *     newlines and keeps the unfinished tail in memory until one arrives.
 *
 * And one thing that is not a limit: what an upstream's ERROR says is reduced to
 * the fields that explain it (`errorSummary`), so a failed call reports the
 * endpoint's own reason without carrying whatever else its body held into a
 * message the page shows.
 */

/** A body a model endpoint sends in one piece: a reply, a model list (OpenRouter's
 *  whole catalogue is under 1 MB), an error. Sixteen times the largest seen. */
export const MODEL_BODY_BYTES = 16 * 1024 * 1024;
/** One line of a streamed reply. A single event carries one delta of a few
 *  hundred bytes; a megabyte with no newline is not an event, it is a fault. */
export const STREAM_LINE_BYTES = 1024 * 1024;
/** How much of an error body is read to explain the error. */
export const ERROR_BODY_BYTES = 64 * 1024;

const hasStream = (res) => !!res?.body && typeof res.body.getReader === 'function';

/**
 * Read at most `limit` bytes of a body, then stop pulling and cancel the rest.
 * `{ refuse: true }` throws instead of returning the head when the body is
 * longer than the limit.
 *
 * Decoded as UTF-8 at the end rather than per chunk, so a multi-byte character
 * split across a chunk boundary still decodes; the last one may be replaced,
 * which costs a character of a body that was already being cut.
 *
 * A body with no stream (a stub's plain object) falls back to `.text()`: there
 * is nothing to read incrementally and nothing to bound.
 */
export async function readCappedText(res, limit, { refuse = false } = {}) {
    if (!hasStream(res)) return typeof res?.text === 'function' ? res.text() : '';
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    let over = false;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            total += value.length;
            if (total > limit) { over = true; break; }
        }
    } finally {
        // Stops the transfer: without this the socket keeps draining a body
        // nobody is reading, which is the cost this function exists to avoid.
        await reader.cancel().catch(() => {});
    }
    if (over && refuse) throw new Error(`the response was larger than ${limit} bytes; refusing it`);
    return new TextDecoder('utf-8').decode(Buffer.concat(chunks, Math.min(total, limit)));
}

/** `res.json()`, refused past `limit` bytes. */
export async function readCappedJson(res, limit) {
    if (!hasStream(res)) return res.json();
    return JSON.parse(await readCappedText(res, limit, { refuse: true }));
}

/** A byte stream that errors once more than `limit` bytes have passed. */
function byteLimit(limit) {
    let total = 0;
    return new TransformStream({
        transform(chunk, controller) {
            total += chunk.byteLength;
            if (total > limit) controller.error(new Error(`the response was larger than ${limit} bytes; stopped reading it`));
            else controller.enqueue(chunk);
        },
    });
}

/** A byte stream that errors once a line runs past `limit` bytes without a newline. */
function lineLimit(limit) {
    // Bytes of the line still open, carried over from earlier chunks: a line
    // can span any number of them, and it is the line that is bounded.
    let open = 0;
    const fault = () => new Error(`a streamed line ran past ${limit} bytes; stopped reading it`);
    return new TransformStream({
        transform(chunk, controller) {
            let start = 0;
            for (let i = chunk.indexOf(0x0a); i !== -1; i = chunk.indexOf(0x0a, start)) {
                if (open + i - start > limit) return controller.error(fault());
                open = 0;
                start = i + 1;
            }
            open += chunk.byteLength - start;
            if (open > limit) return controller.error(fault());
            controller.enqueue(chunk);
        },
    });
}

/** The same response, its body bounded: per line for an event stream, in total
 *  for anything else. A response with no body (204, a stub) is returned as is. */
export function boundedResponse(res, { bodyBytes = MODEL_BODY_BYTES, lineBytes = STREAM_LINE_BYTES } = {}) {
    if (!hasStream(res) || typeof res.body.pipeThrough !== 'function') return res;
    const streaming = /text\/event-stream/i.test(res.headers?.get?.('content-type') || '');
    const body = res.body.pipeThrough(streaming ? lineLimit(lineBytes) : byteLimit(bodyBytes));
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

const clip = (v, n = 500) => (typeof v === 'string' ? v.slice(0, n) : typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/**
 * What an upstream's error body says, and nothing else it held.
 *
 * Endpoints explain a refusal in a few well-known places: OpenAI's and every
 * compatible server's `{"error":{"message","code","type"}}`, a bare
 * `{"error":"…"}` (Ollama, llama.cpp), `{"detail":"…"}` or a list of
 * `{"msg"}` under it (FastAPI proxies, the ChatGPT backend), `{"message":"…"}`,
 * OAuth's `error_description`, Gemini's one-element array around the OpenAI
 * shape, and OpenRouter's `error.metadata.raw` (kept as `raw`). Those fields
 * are kept, each clipped; the code and type stay because the app reads them (a
 * plan limit, an exhausted balance, a missing model). A body that is not JSON
 * keeps its first line only when that line reads as a sentence (a proxy's
 * "upstream command exited prematurely"), never a page of markup.
 *
 * Returns the replacement body as a string: JSON `{"error":{…}}`, a short line,
 * or '' when nothing in it explained anything.
 */
export function errorSummary(text) {
    const raw = String(text || '').trim();
    if (!raw) return '';
    let json = null;
    try { json = JSON.parse(raw); } catch { /* not JSON */ }
    // Gemini's OpenAI-compatible endpoint sends its error as a one-element
    // array, `[{"error":{…}}]`; anything longer is not an error shape.
    if (Array.isArray(json)) json = json.length === 1 && json[0] && typeof json[0] === 'object' ? json[0] : null;
    if (json && typeof json === 'object') {
        const e = json.error;
        const out = {};
        if (typeof e === 'string') {
            // OAuth's shape names the code in `error` and explains it beside it.
            if (typeof json.error_description === 'string') { out.code = clip(e, 120); out.message = clip(json.error_description); }
            else out.message = clip(e);
        } else {
            // FastAPI's validation errors are a list under `detail`, each with
            // its own `msg`; the first says what was wrong.
            const detail = Array.isArray(json.detail) ? json.detail[0] : json.detail;
            const message = clip(e?.message) ?? clip(e?.msg) ?? clip(json.message) ?? clip(detail)
                ?? clip(detail?.msg) ?? clip(detail?.message) ?? clip(json.error_description) ?? clip(json.msg);
            if (message !== undefined) out.message = message;
            for (const [key, value] of [['code', e?.code ?? json.code], ['type', e?.type ?? json.type], ['param', e?.param]]) {
                const v = clip(value, 120);
                if (v !== undefined && v !== '') out[key] = v;
            }
            // OpenRouter's own message is often just "Provider returned error";
            // the serving provider's answer, the actual reason, rides in
            // `metadata.raw` (a string, sometimes an object). Kept, clipped.
            const upstream = e?.metadata?.raw;
            const upstreamText = typeof upstream === 'string' ? upstream
                : upstream && typeof upstream === 'object' ? JSON.stringify(upstream) : '';
            if (upstreamText.trim()) out.raw = clip(upstreamText.trim());
        }
        return Object.keys(out).length ? JSON.stringify({ error: out }) : '';
    }
    const line = raw.split(/\r?\n/, 1)[0].trim();
    return line.length <= 300 && !/[<>{}]/.test(line) ? line : '';
}
