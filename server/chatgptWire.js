/* A ChatGPT plan, spoken behind the OpenAI-compatible wire.
 *
 * "Continue with ChatGPT" (server/chatgptAuth.js) gives the app an access
 * token that spends the learner's own ChatGPT plan — but only through the
 * public Responses API, and only on its terms (developers.openai.com/siwc,
 * "Preview limitations", read 2026-10-12): every request `store: false` and
 * `stream: true`, no `temperature`/`top_p`/`max_output_tokens`, no
 * system-role items (`instructions` and developer messages instead), the
 * history sent whole each time. Like anthropicWire.js this translates at the
 * transport, so the rest of the app keeps its one chat-completions shape.
 *
 * Native tool calls are refused here with a 400 that names tools: the route
 * wants function tools grouped in namespaces, which is a format of its own,
 * and the assistant already has a proven text protocol it falls back to on
 * exactly that answer (`isToolRefusalError`). One protocol fewer to keep
 * working, at the price of the lookups being the text kind on this connection.
 *
 * A usage limit is NOT retried. OpenAI's guidance is to pause and send the
 * learner to ChatGPT → Settings → Usage; the app's retry layer would otherwise
 * try twice more on a 429 that will not change for hours. So it arrives as a
 * 402 with a sentence saying where the limit is managed.
 */

const NO_TOOLS = 'This connection (a ChatGPT plan) does not take native tool calls; the lookups use the text protocol instead.';
export const USAGE_LIMIT_MESSAGE = "Your ChatGPT plan's limit for this app is used up for now. Review it in ChatGPT → Settings → Usage, or switch connection in Terramentor's Settings.";

/** A plan error code → the status the app's retry layer should see, and a sentence. */
export function planErrorOf(code, message = '') {
    switch (code) {
        case 'subscription_sharing_usage_limit_exceeded': return { status: 402, message: USAGE_LIMIT_MESSAGE };
        case 'subscription_sharing_usage_unavailable':
        case 'subscription_sharing_user_unavailable': return { status: 503, message: message || 'ChatGPT could not check your plan just now.' };
        case 'subscription_sharing_user_not_eligible': return { status: 403, message: 'This ChatGPT account or workspace cannot use its plan in other apps (ChatGPT Plus or Pro is needed, and a workspace may forbid it).' };
        case 'subscription_sharing_invalid_user': return { status: 401, message: 'ChatGPT no longer accepts this sign-in. Sign in again under Settings → AI & Models.' };
        case 'subscription_sharing_unsupported_capability': return { status: 400, message: message || 'ChatGPT plan usage does not support part of this request.' };
        default: return null;
    }
}

function textOf(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map(p => (typeof p === 'string' ? p : p?.text || '')).join('');
    return '';
}

function userParts(content) {
    if (typeof content === 'string') return content ? [{ type: 'input_text', text: content }] : [];
    const parts = [];
    for (const p of Array.isArray(content) ? content : []) {
        if (typeof p === 'string' && p) parts.push({ type: 'input_text', text: p });
        else if (p?.type === 'text' && p.text) parts.push({ type: 'input_text', text: p.text });
        else if (p?.type === 'image_url' && p.image_url?.url) parts.push({ type: 'input_image', image_url: p.image_url.url });
    }
    return parts;
}

/** The OpenAI-shaped body as a Responses body, or `{ refuse }` with a reason. */
export function toResponsesRequest(body) {
    if (Array.isArray(body.tools) && body.tools.length) return { refuse: NO_TOOLS };
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const instructions = [];
    let i = 0;
    for (; i < messages.length && messages[i]?.role === 'system'; i++) {
        const t = textOf(messages[i].content);
        if (t) instructions.push(t);
    }
    const input = [];
    for (; i < messages.length; i++) {
        const m = messages[i] || {};
        if (m.role === 'system') {
            const t = textOf(m.content);
            if (t) input.push({ type: 'message', role: 'developer', content: [{ type: 'input_text', text: t }] });
        } else if (m.role === 'user') {
            const parts = userParts(m.content);
            if (parts.length) input.push({ type: 'message', role: 'user', content: parts });
        } else if (m.role === 'assistant') {
            const t = textOf(m.content);
            if (t) input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: t }] });
        }
    }
    const req = { model: body.model, input, store: false, stream: true };
    if (instructions.length) req.instructions = instructions.join('\n\n');
    const effort = body.reasoning?.effort || body.reasoning_effort;
    if (effort) req.reasoning = { effort };
    return { req };
}

/** Responses usage → the OpenAI usage block. */
export function usageOf(u = {}) {
    const input = Number(u.input_tokens) || 0;
    const output = Number(u.output_tokens) || 0;
    return {
        prompt_tokens: input,
        completion_tokens: output,
        total_tokens: input + output,
        prompt_tokens_details: { cached_tokens: Number(u.input_tokens_details?.cached_tokens) || 0 },
        completion_tokens_details: { reasoning_tokens: Number(u.output_tokens_details?.reasoning_tokens) || 0 },
    };
}

/** One Responses stream event → OpenAI SSE lines (and the running state). */
export function createResponsesTranslator() {
    const state = { text: '', reasoning: '', usage: null, finish: null, error: null };
    const chunk = (delta, finish = null, extra = {}) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
    const fail = (code, message) => {
        const known = planErrorOf(code, message);
        const status = known?.status ?? 500;
        state.error = { status, message: known?.message || message || code || 'ChatGPT request failed', code };
        return [`data: ${JSON.stringify({ error: { code: status, message: state.error.message } })}\n\n`];
    };
    return {
        state,
        push(ev) {
            switch (ev?.type) {
                case 'response.output_text.delta':
                    if (!ev.delta) return [];
                    state.text += ev.delta;
                    return [chunk({ content: ev.delta })];
                case 'response.reasoning_summary_text.delta':
                case 'response.reasoning_text.delta':
                    if (!ev.delta) return [];
                    state.reasoning += ev.delta;
                    return [chunk({ reasoning_content: ev.delta })];
                case 'response.completed':
                case 'response.incomplete': {
                    const r = ev.response || {};
                    state.usage = usageOf(r.usage);
                    const why = r.incomplete_details?.reason;
                    state.finish = ev.type === 'response.completed' ? 'stop' : why === 'content_filter' ? 'content_filter' : 'length';
                    return [chunk({}, state.finish, { usage: state.usage }), 'data: [DONE]\n\n'];
                }
                case 'response.failed':
                    return fail(ev.response?.error?.code, ev.response?.error?.message);
                case 'error':
                    return fail(ev.code || ev.error?.code, ev.message || ev.error?.message);
                default: return [];
            }
        },
    };
}

function jsonResponse(status, body) {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A failed answer before the stream opened, with a plan code made readable. */
async function failedResponse(res) {
    const text = await res.text().catch(() => '');
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* {"detail": …} or plain text */ }
    const code = parsed?.error?.code;
    const known = code ? planErrorOf(code, parsed?.error?.message) : null;
    if (known) return jsonResponse(known.status, { error: { code, message: known.message } });
    return new Response(text, { status: res.status, headers: { 'content-type': 'application/json' } });
}

/**
 * A `fetch` for the OpenAI-shaped paths, answered by the Responses API with
 * the plan's access token. `accessToken` is called per request so a token is
 * refreshed before it lapses (chatgptAuth serialises that).
 */
export function createChatgptFetch({ accessToken, fetchImpl = fetch, apiBase = 'https://api.openai.com/v1' }) {
    return async function chatgptFetch(url, init = {}) {
        const path = new URL(url).pathname.replace(/^.*?\/v1/, '');
        const signal = init.signal;
        if (path.startsWith('/embeddings')) {
            return jsonResponse(404, { error: { message: 'A ChatGPT plan covers chat, not embeddings. Choose another embedding provider under Model jobs.' } });
        }
        if (/^\/models\/.+\/endpoints$/.test(path)) return jsonResponse(404, { error: { message: 'No catalogue route on this connection' } });

        let token;
        try { token = await accessToken(); } catch (e) {
            return jsonResponse(401, { error: { message: e?.message || 'Not signed in to ChatGPT. Sign in again under Settings → AI & Models.' } });
        }
        const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

        if (path === '/models') {
            const res = await fetchImpl(`${apiBase}/models`, { headers, signal });
            if (!res.ok) return failedResponse(res);
            const json = await res.json().catch(() => ({}));
            const list = Array.isArray(json.models) ? json.models : Array.isArray(json.data) ? json.data : [];
            const data = list
                .filter(m => !m.visibility || m.visibility === 'list')
                .map(m => ({ id: m.slug || m.id, object: 'model', display_name: m.display_name || m.slug || m.id }))
                .filter(m => m.id);
            return jsonResponse(200, { object: 'list', data });
        }
        if (path !== '/chat/completions') return jsonResponse(404, { error: { message: `No such route: ${path}` } });

        let body;
        try { body = JSON.parse(init.body || '{}'); } catch { return jsonResponse(400, { error: { message: 'Request body is not JSON' } }); }
        const { req, refuse } = toResponsesRequest(body);
        if (refuse) return jsonResponse(400, { error: { message: refuse } });
        const res = await fetchImpl(`${apiBase}/responses`, { method: 'POST', headers, body: JSON.stringify(req), signal });
        if (!res.ok) return failedResponse(res);

        const translator = createResponsesTranslator();
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        const frames = async function* () {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) return;
                buffer += decoder.decode(value, { stream: true });
                const parts = buffer.split(/\r?\n\r?\n/);
                buffer = parts.pop() || '';
                for (const frame of parts) {
                    const data = frame.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('');
                    if (!data || data === '[DONE]') continue;
                    try { yield JSON.parse(data); } catch { /* a malformed frame is skipped, as the app's own parser does */ }
                }
            }
        };

        if (body.stream !== true) {
            // The route only streams; a one-shot caller gets the whole answer.
            try { for await (const ev of frames()) translator.push(ev); } finally { reader.cancel().catch(() => { }); }
            const s = translator.state;
            if (s.error) return jsonResponse(s.error.status, { error: { code: s.error.code, message: s.error.message } });
            const message = { role: 'assistant', content: s.text };
            if (s.reasoning) message.reasoning_content = s.reasoning;
            return jsonResponse(200, {
                object: 'chat.completion', model: body.model,
                choices: [{ index: 0, message, finish_reason: s.finish || 'stop' }],
                usage: s.usage || usageOf({}),
            });
        }

        const encoder = new TextEncoder();
        const it = frames();
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
