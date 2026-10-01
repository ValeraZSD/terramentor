// The AI provider and search backends: status, keys, OpenRouter sign-in, models.
import { createHash, randomBytes } from 'node:crypto';
import db from '../database.js';
import {
    API_KEY_ORIGIN_SETTING, apiKeyOriginOf, checkOllamaHealth, deleteModel, getAISettings,
    getInstalledModels, modelEndpointPath, normalizeOpenAIBaseUrl, pullModel, servingEndpointRows,
} from '../ai.js';
import {
    SEARCH_BACKENDS, searchKeysStatus, setSearchBackendKey, testSearchBackend,
} from '../searchBackends.js';
import { MAX_URL_LENGTH, SAFE_URL_PROTOCOLS } from '../urlSafety.js';
import { wrap } from './request.js';
import { routeTable } from './routeTable.js';

const app = routeTable('providers');

// A SearXNG instance is deliberately exempt from `netSafety` — a private or
// loopback address is the normal case for one, so this is the one endpoint that
// fetches a private host on purpose. What it must NOT be is a general prober:
// the reply distinguishes reachable from refused from timed out, so without a
// scheme check and `redirect: 'manual'` it answers "is there something on this
// address" for any protocol the runtime speaks and any address a redirect
// points at. Both are cheap, and neither costs a real instance anything.
app.post('/api/searxng/test', async (req, res) => {
    const { url } = req.body;
    if (!url || typeof url !== 'string' || url.length > MAX_URL_LENGTH) {
        return res.status(400).json({ ok: false, error: 'URL is required' });
    }
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return res.status(400).json({ ok: false, error: 'Not a valid URL' });
    }
    if (!SAFE_URL_PROTOCOLS.includes(parsed.protocol)) {
        return res.status(400).json({ ok: false, error: 'Only http:// and https:// are supported' });
    }
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const cleanUrl = url.replace(/\/+$/, '') + '/healthz';
        const response = await fetch(cleanUrl, {
            method: 'GET',
            redirect: 'manual',
            signal: controller.signal,
        });
        clearTimeout(timeout);
        if (response.ok) {
            res.json({ ok: true });
        } else {
            res.json({ ok: false, error: `SearXNG responded with status ${response.status}` });
        }
    } catch (e) {
        res.json({ ok: false, error: e.name === 'AbortError' ? 'Connection timed out' : e.message || 'Cannot reach SearXNG' });
    }
});

// AI / OLLAMA

app.get('/api/ai/status', wrap(async (req, res) => {
    // Never echo the API key (it may come from .env, not just the settings the
    // client already knows) — expose only whether one is configured.
    const { apiKey, ...settings } = getAISettings();
    const health = await checkOllamaHealth();
    res.json({ ...settings, hasApiKey: !!apiKey, ...health });
}));

// The provider key's own write route, beside the status endpoint that reports
// whether one exists. Write-only from the client's side: the panel types a
// replacement and never reads the old value back, and the generic settings
// dump stopped carrying the key for the same reason (isSecretSettingKey).
// An empty PUT and the DELETE both mean "no key" — the Clear button's word.
//
// A saved key is BOUND to the origin it was entered for (getAISettings sends it
// nowhere else). The panel passes the base URL it is showing, because the URL
// field autosaves on a debounce and can still be in flight when the key field
// blurs; an env AI_BASE_URL wins, since that is where calls will go.
app.put('/api/ai/key', (req, res) => {
    const { apiKey, baseUrl } = req.body || {};
    if (typeof apiKey !== 'string') return res.status(400).json({ error: 'apiKey must be a string' });
    if (baseUrl != null && typeof baseUrl !== 'string') return res.status(400).json({ error: 'baseUrl must be a string' });
    if (apiKey) {
        const origin = apiKeyOriginOf(process.env.AI_BASE_URL || baseUrl || getAISettings().baseUrl);
        if (!origin) return res.status(400).json({ error: 'Set a valid base URL before saving a key' });
        db.transaction(() => {
            db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('ai_openai_api_key', apiKey);
            db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(API_KEY_ORIGIN_SETTING, origin);
        })();
        return res.json({ success: true, hasApiKey: true, apiKeyOrigin: origin });
    }
    clearAIKey();
    res.json({ success: true, hasApiKey: false });
});
app.delete('/api/ai/key', (req, res) => {
    clearAIKey();
    res.json({ success: true, hasApiKey: false });
});
function clearAIKey() {
    db.prepare('DELETE FROM settings WHERE key IN (?, ?)').run('ai_openai_api_key', API_KEY_ORIGIN_SETTING);
}

// CONNECT OPENROUTER — a key without copying one.
//
// A stranger's first problem with a hosted model is not choosing one, it is the
// key: make an account, find the keys page, create one, copy it, paste it into
// a field they have never seen. OpenRouter's OAuth PKCE flow does that in one
// press: the browser goes to openrouter.ai, the learner signs in and approves,
// and openrouter.ai sends it back here with a one-time code, which this server
// trades for a key the learner owns (and can revoke, or cap, on their site).
//
// The verifier never leaves this process: `start` makes it and hands out only
// its hash; `finish` spends it. ONE attempt is pending at a time — a single-user
// app has one person connecting — and it lapses with OpenRouter's own code, ten
// minutes after it was made. Nothing is fetched until `finish`, and then only
// the fixed exchange URL below, so the inventory in SECURITY.md gains one host
// that is only ever reached when the learner presses the button.
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const OPENROUTER_CONNECT_TTL_MS = 10 * 60 * 1000;
let openRouterPending = null;   // { verifier, at }

app.post('/api/ai/openrouter/start', (req, res) => {
    const { callbackUrl } = req.body || {};
    let callback;
    try { callback = new URL(String(callbackUrl || '')); } catch { callback = null; }
    if (!callback || !/^https?:$/.test(callback.protocol)) {
        return res.status(400).json({ error: 'callbackUrl must be an http(s) URL' });
    }
    const verifier = randomBytes(32).toString('base64url');
    openRouterPending = { verifier, at: Date.now() };
    const url = new URL('https://openrouter.ai/auth');
    url.searchParams.set('callback_url', callback.toString());
    url.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
    url.searchParams.set('code_challenge_method', 'S256');
    res.json({ url: url.toString() });
});

app.post('/api/ai/openrouter/finish', wrap(async (req, res) => {
    const { code } = req.body || {};
    if (typeof code !== 'string' || !code.trim() || code.length > 512) {
        return res.status(400).json({ error: 'code must be a string' });
    }
    const pending = openRouterPending;
    openRouterPending = null;   // single use, whatever happens next
    if (!pending || Date.now() - pending.at > OPENROUTER_CONNECT_TTL_MS) {
        return res.status(400).json({ error: 'This connection attempt has expired. Press Connect again.' });
    }
    let key = '';
    try {
        const upstream = await fetch(`${OPENROUTER_BASE_URL}/auth/keys`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: code.trim(), code_verifier: pending.verifier, code_challenge_method: 'S256' }),
            signal: AbortSignal.timeout(15000),
        });
        const json = await upstream.json().catch(() => ({}));
        if (!upstream.ok) {
            const why = typeof json?.error?.message === 'string' ? json.error.message : `HTTP ${upstream.status}`;
            return res.status(502).json({ error: `OpenRouter did not issue a key: ${why}` });
        }
        key = typeof json?.key === 'string' ? json.key : '';
    } catch (e) {
        return res.status(502).json({ error: `Could not reach OpenRouter: ${e?.message || e}` });
    }
    if (!key) return res.status(502).json({ error: 'OpenRouter answered without a key' });

    // The key is bound to OpenRouter's origin like any key saved by hand, and
    // the provider and base URL move with it, so the next model call uses it.
    const put = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    db.transaction(() => {
        put.run('ai_provider', 'openai');
        put.run('ai_openai_base_url', OPENROUTER_BASE_URL);
        put.run('ai_openai_api_key', key);
        put.run(API_KEY_ORIGIN_SETTING, apiKeyOriginOf(OPENROUTER_BASE_URL));
        put.run('ai_enabled', 'true');
    })();
    res.json({ success: true, hasApiKey: true, baseUrl: OPENROUTER_BASE_URL });
}));

// The hosted search backends' keys, on the same pattern as /api/ai/key:
// write-only, one route family, the status endpoint answers only WHETHER a key
// is saved. Saving one adds that engine's host to the outbound set (the model
// will send it search terms) — that trade is named in SECURITY.md, which is
// why the generic settings dump and the generic writer refuse these rows
// (isSecretSettingKey covers them).
app.get('/api/search/keys', (req, res) => {
    res.json(searchKeysStatus());
});
app.put('/api/search/keys/:provider', (req, res) => {
    if (!SEARCH_BACKENDS[req.params.provider]) {
        return res.status(400).json({ error: 'Unknown search backend' });
    }
    const { key } = req.body || {};
    if (typeof key !== 'string') return res.status(400).json({ error: 'key must be a string' });
    const saved = setSearchBackendKey(req.params.provider, key);
    res.json({ success: true, hasKey: saved });
});
app.delete('/api/search/keys/:provider', (req, res) => {
    if (!SEARCH_BACKENDS[req.params.provider]) {
        return res.status(400).json({ error: 'Unknown search backend' });
    }
    setSearchBackendKey(req.params.provider, '');
    res.json({ success: true, hasKey: false });
});
// Whether the saved key WORKS, which "a key is saved" does not answer — a
// mistyped key looks identical until an answer quietly arrives with no sources.
// POST, not GET: it spends one search against the learner's own quota, so it
// happens when they ask for it and never on a page load.
app.post('/api/search/keys/:provider/test', wrap(async (req, res) => {
    if (!SEARCH_BACKENDS[req.params.provider]) {
        return res.status(400).json({ error: 'Unknown search backend' });
    }
    res.json(await testSearchBackend(req.params.provider));
}));

app.get('/api/ai/models', wrap(async (req, res) => {
    const result = await getInstalledModels();
    res.json(result);
}));

/* Who can actually serve the chosen model.
 *
 * A model id on a router is a list of machines, not one: the id configured here
 * had 27 of them, differing by a factor of five in speed, by two steps in
 * quantisation, and in how much the model thinks before it answers. This is
 * what fills the provider list in Settings so the choice is made from what the
 * endpoint reports rather than from a table in a document that went stale.
 *
 * It asks THE ENDPOINT THE LEARNER CONFIGURED and nowhere else — the path is
 * built from their own base URL — so this adds no outbound host to the
 * inventory in SECURITY.md. An endpoint that does not publish the route (every
 * local engine, OpenAI itself) says so with `available:false`, which is an
 * answer: the panel hides the control rather than showing an empty list.
 * The path is built by `modelEndpointPath` (ai.js), which the vision probe
 * shares.
 */

app.get('/api/ai/endpoints', wrap(async (req, res) => {
    const settings = getAISettings();
    const model = typeof req.query.model === 'string' && req.query.model ? req.query.model : settings.model;
    if (settings.provider !== 'openai' || !model) return res.json({ available: false, endpoints: [] });

    const base = normalizeOpenAIBaseUrl(settings.baseUrl);
    const path = modelEndpointPath(model);
    // The same answer an endpoint that does not publish the route gets: the
    // panel hides the control. Nothing is fetched.
    if (path === null) return res.json({ available: false, endpoints: [] });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
        const upstream = await fetch(`${base}/models/${path}/endpoints`, {
            headers: settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {},
            signal: controller.signal,
        });
        if (!upstream.ok) return res.json({ available: false, endpoints: [] });
        const json = await upstream.json();
        const raw = Array.isArray(json?.data?.endpoints) ? json.data.endpoints : [];
        if (!raw.length) return res.json({ available: false, endpoints: [] });
        // Only the fields the panel draws, one row per slug it can send back.
        res.json({ available: true, model, endpoints: servingEndpointRows(raw) });
    } catch {
        res.json({ available: false, endpoints: [] });
    } finally {
        clearTimeout(timer);
    }
}));

app.post('/api/ai/models/pull', async (req, res) => {
    const { name } = req.body;
    if (!name || typeof name !== 'string') {
        return res.status(400).json({ error: 'Model name is required' });
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    try {
        for await (const progress of pullModel(name.trim())) {
            res.write(`data: ${JSON.stringify(progress)}\n\n`);
        }
        res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        res.end();
    } catch (error) {
        console.error('Model pull error:', error);
        res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
        res.end();
    }
});

app.delete('/api/ai/models/:name', wrap(async (req, res) => {
    const result = await deleteModel(req.params.name);
    if (result.success) {
        res.json({ success: true });
    } else {
        res.status(500).json({ error: result.error });
    }
}));

export const routes = app.takeRoutes();
