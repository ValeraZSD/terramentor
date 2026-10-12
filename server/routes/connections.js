// Saved AI connections: list, add (tested first), test, use, change, remove,
// the thinking levels a model offers, and "Continue with ChatGPT".
// Keys and tokens go in and never come back out (server/aiConnections.js).
import {
    CONNECTION_KINDS, addConnection, effortChoices, listConnections, markPlanNoticeSeen, modelsForConnection,
    removeConnection, settingsForConnection, testConnection, testSettings, updateConnection, useConnection,
} from '../aiConnections.js';
import { getAISettings, normalizeOpenAIBaseUrl, DEFAULT_OLLAMA_URL } from '../ai.js';
import { isLocalBrowser, startSignIn } from '../chatgptAuth.js';
import { wrap } from './request.js';
import { routeTable } from './routeTable.js';

const app = routeTable('connections');

const idOf = (req) => Number(req.params.id) || 0;
const fail = (res, err) => res.status(err?.status || 500).json({ error: err?.message || String(err) });

app.get('/api/ai/connections', (req, res) => {
    // What each kind fixes, so the client draws its forms from one table.
    const kinds = Object.fromEntries(Object.entries(CONNECTION_KINDS).map(([k, v]) => [k, {
        baseUrl: v.baseUrl, key: v.key, editable: !!v.editable, keyUrl: v.keyUrl || '',
    }]));
    res.json({ ...listConnections(), kinds });
});

/* Add one. With `test` (the dialog's only button) nothing is saved unless the
 * test passes — except a local server, which may be saved while it is off,
 * because "start it later" is a normal answer for a machine in the room. */
app.post('/api/ai/connections', wrap(async (req, res) => {
    const { kind, apiKey = '', baseUrl, model = '', test = true, use = false, saveAnyway = false } = req.body || {};
    const k = CONNECTION_KINDS[kind];
    if (!k || kind === 'chatgpt') return res.status(400).json({ error: 'Unknown kind of connection' });
    if (typeof apiKey !== 'string' || (baseUrl != null && typeof baseUrl !== 'string') || typeof model !== 'string') {
        return res.status(400).json({ error: 'apiKey, baseUrl and model must be strings' });
    }
    if (k.key === 'required' && !apiKey.trim()) return res.status(400).json({ error: 'This connection needs an API key' });
    let result = null;
    if (test) {
        const isOllama = kind === 'ollama';
        const base = k.editable && baseUrl ? (isOllama ? baseUrl.trim().replace(/\/+$/, '') : normalizeOpenAIBaseUrl(baseUrl)) : k.baseUrl;
        const settings = {
            ...getAISettings(),
            provider: isOllama ? 'ollama' : 'openai',
            ollamaUrl: isOllama ? (base || DEFAULT_OLLAMA_URL) : undefined,
            baseUrl: isOllama ? undefined : base,
            apiKey: apiKey.trim(),
            model,
            apiFormat: k.format || '',
            connectionId: null,
            providerOrder: [], providerSort: '',
        };
        result = await testSettings(settings);
        // `testOnly`: a replacement key or address is tried before it is saved
        // over the one that works.
        if (req.body?.testOnly) return res.status(result.ok ? 200 : 422).json({ test: result });
        if (!result.ok && !(saveAnyway && k.editable)) return res.status(422).json({ test: result });
    }
    let id;
    try { id = addConnection({ kind, baseUrl, apiKey, model }); } catch (err) { return fail(res, err); }
    if (use || listConnections().activeId === null) useConnection(id);
    res.json({ id, test: result, ...listConnections() });
}));

app.post('/api/ai/connections/:id/test', wrap(async (req, res) => {
    try { res.json(await testConnection(idOf(req))); } catch (err) { fail(res, err); }
}));

app.post('/api/ai/connections/:id/use', (req, res) => {
    try { useConnection(idOf(req)); res.json(listConnections()); } catch (err) { fail(res, err); }
});

app.patch('/api/ai/connections/:id', (req, res) => {
    const { model, apiKey, baseUrl } = req.body || {};
    for (const v of [model, apiKey, baseUrl]) {
        if (v !== undefined && typeof v !== 'string') return res.status(400).json({ error: 'Fields must be strings' });
    }
    try { updateConnection(idOf(req), { model, apiKey, baseUrl }); res.json(listConnections()); } catch (err) { fail(res, err); }
});

app.delete('/api/ai/connections/:id', wrap(async (req, res) => {
    try {
        const { revoked } = await removeConnection(idOf(req));
        res.json({ revoked, ...listConnections() });
    } catch (err) { fail(res, err); }
}));

app.get('/api/ai/connections/:id/models', wrap(async (req, res) => {
    try { res.json({ success: true, models: await modelsForConnection(idOf(req)) }); }
    catch (err) { res.json({ success: false, models: [], error: err?.message || String(err) }); }
}));

app.post('/api/ai/connections/:id/plan-notice', (req, res) => {
    markPlanNoticeSeen(idOf(req));
    res.json({ success: true });
});

/* The thinking levels the control may offer: the model's own list, or null
 * when its provider publishes none (the control is then not drawn). */
app.get('/api/ai/efforts', wrap(async (req, res) => {
    const id = Number(req.query.connection) || null;
    const settings = id ? settingsForConnection(id) : getAISettings();
    if (!settings) return res.status(404).json({ error: 'No such connection' });
    const model = typeof req.query.model === 'string' && req.query.model ? req.query.model : settings.model;
    try { res.json(await effortChoices(settings, model)); } catch { res.json({ levels: null }); }
}));

/* "Continue with ChatGPT". The callback is OpenAI's rule, not ours:
 * http://127.0.0.1:<port>/auth/callback on THIS machine, so a browser anywhere
 * else is told so instead of being sent to its own 127.0.0.1. */
app.post('/api/ai/chatgpt/start', wrap(async (req, res) => {
    const origin = req.get('origin') || `${req.protocol}://${req.get('host')}`;
    if (!isLocalBrowser(origin)) return res.status(409).json({ error: 'not-local' });
    const { returnPath = '/settings#ai', connectionId = null } = req.body || {};
    if (typeof returnPath !== 'string' || returnPath.length > 200) return res.status(400).json({ error: 'returnPath must be a short path' });
    try { res.json(await startSignIn({ appOrigin: origin, returnPath, connectionId: Number(connectionId) || null })); }
    catch (err) { fail(res, err); }
}));

export const routes = app.takeRoutes();
