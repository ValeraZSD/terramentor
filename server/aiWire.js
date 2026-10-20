/* Which protocol an OpenAI-compatible base URL really speaks, and the `fetch`
 * that speaks it.
 *
 * Every model call in server/ai.js is written once, in the chat-completions
 * shape. Five kinds of endpoint sit behind that shape and each has its own
 * terms, so the difference lives here, at the transport, and nowhere above it:
 *
 *   openrouter  the router. Takes `reasoning.effort` and `provider` routing;
 *               which effort levels a model has is in its public catalogue.
 *   openai      api.openai.com. Refuses fields it does not know, and a
 *               non-default `temperature` on its reasoning models. Sent no
 *               thinking budget: a non-reasoning model refuses one outright,
 *               and the endpoint publishes no list to check it against.
 *   gemini      Google's OpenAI-compatible endpoint, on the same terms.
 *   anthropic   the native Messages API through anthropicWire.js.
 *   chatgpt     a ChatGPT plan through the Responses API (chatgptWire.js).
 *   deepseek    DeepSeek, Z.ai (zai), Alibaba's Model Studio (qwen) and
 *   zai         Moonshot's Kimi (kimi): the labs' own OpenAI-compatible
 *   qwen        endpoints, each with its own thinking field and quirks
 *   kimi        (LAB_RULES below).
 *   generic     anything else — llama.cpp, llama-swap, LM Studio, a proxy. Sent
 *               the plain chat-completions body.
 *
 * Decided by the base URL's HOST, so a key saved for one never travels to
 * another (that binding stays in ai.js), with `ai_api_format` forcing the
 * protocol for the two that cannot be told by host: a ChatGPT plan shares
 * api.openai.com with an API key, and a gate's stub Anthropic is loopback.
 */
import { createAnthropicFetch } from './anthropicWire.js';
import { createChatgptFetch } from './chatgptWire.js';

const HOST_WIRES = {
    'openrouter.ai': 'openrouter',
    'api.anthropic.com': 'anthropic',
    'api.openai.com': 'openai',
    'generativelanguage.googleapis.com': 'gemini',
    'api.deepseek.com': 'deepseek',
    'api.z.ai': 'zai',
    'open.bigmodel.cn': 'zai',
    'api.moonshot.ai': 'kimi',
    'api.moonshot.cn': 'kimi',
};
/** The labs, and what each takes. `efforts`: the levels its `reasoning_effort`
 *  accepts, weakest first, or none, and then no thinking field is sent at all.
 *  Z.ai's and Kimi's own default is MAX, so leaving the field out is the most
 *  expensive choice there; Qwen's `enable_thinking` makes some models refuse a
 *  call that is not streamed, so it is left to each model's default. */
export const LAB_RULES = {
    deepseek: { efforts: ['low', 'high', 'max'], thinkingBack: true },
    zai: { efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], maxTemperature: 1 },
    qwen: { efforts: [] },
    kimi: { efforts: ['low', 'high', 'max'], thinkingBack: true, noTemperature: true },
};
/** Protocols a settings row may force: two the host cannot tell, and the labs,
 *  so a gate can point a lab's wire at a stub on loopback. */
export const API_FORMATS = ['anthropic', 'chatgpt', ...Object.keys(LAB_RULES)];

/** The wire a base URL's host speaks, before any forcing. Alibaba serves Model
 *  Studio from a host per region and now per workspace, all under aliyuncs.com. */
export function hostWire(baseUrl) {
    let host;
    try { host = new URL(String(baseUrl)).hostname.toLowerCase(); } catch { return 'generic'; }
    if (HOST_WIRES[host]) return HOST_WIRES[host];
    if (host.endsWith('.aliyuncs.com')) return 'qwen';
    return 'generic';
}

/** The protocol behind one settings object (getAISettings / settingsForConnection). */
export function wireOf(settings) {
    if (settings?.provider !== 'openai') return 'ollama';
    if (API_FORMATS.includes(settings.apiFormat)) return settings.apiFormat;
    return hostWire(settings.baseUrl);
}

/** Wires that take a `provider` routing object (a router, or something that may be one). */
export const routesProviders = (wire) => wire === 'openrouter' || wire === 'generic';

// ── effort levels ─────────────────────────────────────────────────────────

/** Every level any provider names, weakest first. */
export const EFFORT_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * The level to send for `desired` on a model that offers `supported`:
 * `undefined` = not known, send as asked; `[]` = the model takes no level,
 * send nothing; a list = the asked level if it is there, else the nearest one
 * ABOVE it (an automatic medium on a model offering only low/high/max becomes
 * high — never quietly less thinking than was asked for), else the strongest
 * the model has.
 */
export function pickEffort(desired, supported) {
    if (!desired) return '';
    if (supported === undefined || supported === null) return desired;
    if (!supported.length) return '';
    if (supported.includes(desired)) return desired;
    const want = EFFORT_LEVELS.indexOf(desired);
    const ranked = supported.filter(l => EFFORT_LEVELS.includes(l)).sort((a, b) => EFFORT_LEVELS.indexOf(a) - EFFORT_LEVELS.indexOf(b));
    return ranked.find(l => EFFORT_LEVELS.indexOf(l) >= want) || ranked[ranked.length - 1] || '';
}

/** A level list in display order (weakest first), unknown names dropped. */
export const orderedLevels = (levels) => [...new Set(levels)].filter(l => EFFORT_LEVELS.includes(l))
    .sort((a, b) => EFFORT_LEVELS.indexOf(a) - EFFORT_LEVELS.indexOf(b));

// OpenRouter publishes, per model, the levels it takes (`reasoning.
// supported_efforts`) and its own default. Read from the public catalogue the
// configured base URL serves, an hour at a time; until it has been read once a
// level is sent as asked.
const CATALOGUE_TTL_MS = 60 * 60 * 1000;
const catalogues = new Map();   // base → { at, models: Map(id → { levels, defaultEffort }) }

/** `{ levels, defaultEffort }` for one catalogue entry — `levels` as pickEffort reads it. */
export function openRouterEffortsOf(entry) {
    const r = entry?.reasoning;
    if (!r) return { levels: [], defaultEffort: '' };
    if (!('supported_efforts' in r)) return { levels: [], defaultEffort: '' };
    if (r.supported_efforts === null) return { levels: undefined, defaultEffort: r.default_effort || '' };
    return { levels: orderedLevels(Array.isArray(r.supported_efforts) ? r.supported_efforts : []), defaultEffort: r.default_effort || '' };
}

export function openRouterEffortsFor(base, model) {
    return catalogues.get(base)?.models.get(model);
}

export async function warmOpenRouterCatalogue(base, { fetchImpl = fetch } = {}) {
    const have = catalogues.get(base);
    if (have && Date.now() - have.at < CATALOGUE_TTL_MS) return have;
    try {
        const res = await fetchImpl(`${base}/models`, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) return have;
        const json = await res.json();
        const models = new Map();
        for (const m of Array.isArray(json?.data) ? json.data : []) if (m?.id) models.set(m.id, openRouterEffortsOf(m));
        const entry = { at: Date.now(), models };
        catalogues.set(base, entry);
        return entry;
    } catch { return have; }
}

/** For the gate. */
export function resetWireState() { catalogues.clear(); }

// ── the fetch per wire ────────────────────────────────────────────────────

/** A fetch that rewrites the JSON body of a chat request with `fix`; anything
 *  else (the model list, a body that is not JSON) goes as it was. */
function bodyFetch(fetchImpl, fix) {
    return (url, init = {}) => {
        if (init.method === 'POST' && /\/chat\/completions$/.test(new URL(url).pathname) && typeof init.body === 'string') {
            let body;
            try { body = JSON.parse(init.body); } catch { return fetchImpl(url, init); }
            fix(body);
            return fetchImpl(url, { ...init, body: JSON.stringify(body) });
        }
        return fetchImpl(url, init);
    };
}

// The assistant's tool loop keeps each round's thinking on the assistant
// message it sends back (aiTools.js runNativeAgentTurn), because DeepSeek and
// Kimi refuse a tool conversation without it. No other endpoint asked for the
// field and a strict one refuses unknown ones, so it goes no further.
function dropThinkingBack(body) {
    for (const m of Array.isArray(body.messages) ? body.messages : []) if (m && typeof m === 'object') delete m.reasoning_content;
}

// DeepSeek: "the reasoning_content of all previous turns should be passed back"
// once tools are in play, and a tool-call message without it is a 400. Answers
// stored without it have none; LiteLLM sends a space for those.
function giveThinkingBack(body) {
    const tools = Array.isArray(body.tools) && body.tools.length > 0;
    for (const m of Array.isArray(body.messages) ? body.messages : []) {
        if (m?.role !== 'assistant') continue;
        if ((tools || m.tool_calls) && !(typeof m.reasoning_content === 'string' && m.reasoning_content)) m.reasoning_content = ' ';
    }
}

// api.openai.com's reasoning models refuse any temperature but the default;
// the app's graders ask for low ones. Dropped at the transport, so the call
// sites keep the values every other endpoint honours.
const openAIFetch = (fetchImpl) => bodyFetch(fetchImpl, (body) => {
    delete body.temperature;
    delete body.top_p;
    dropThinkingBack(body);
});

function labFetch(fetchImpl, rules) {
    return bodyFetch(fetchImpl, (body) => {
        if (rules.noTemperature) delete body.temperature;
        if (rules.maxTemperature != null && typeof body.temperature === 'number') body.temperature = Math.min(body.temperature, rules.maxTemperature);
        if (rules.thinkingBack) giveThinkingBack(body);
        else dropThinkingBack(body);
    });
}

const anthropicFetch = createAnthropicFetch();

/** The fetch an OpenAI-shaped request to this settings object's endpoint goes through. */
export function wireFetch(settings, { fetchImpl = fetch } = {}) {
    switch (wireOf(settings)) {
        case 'anthropic': return fetchImpl === fetch ? anthropicFetch : createAnthropicFetch({ fetchImpl });
        case 'chatgpt': return createChatgptFetch({
            fetchImpl,
            apiBase: process.env.CHATGPT_API_BASE || 'https://api.openai.com/v1',
            accessToken: async () => (await import('./chatgptAuth.js')).accessTokenFor(settings.connectionId),
        });
        case 'openai': return openAIFetch(fetchImpl);
        default: {
            const rules = LAB_RULES[wireOf(settings)];
            return rules ? labFetch(fetchImpl, rules) : bodyFetch(fetchImpl, dropThinkingBack);
        }
    }
}
