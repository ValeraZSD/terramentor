/* Saved AI connections: every way this library has connected a model, one of
 * them in use.
 *
 * WHY A KEYRING AND NOT A NEW SOURCE OF TRUTH. Every model call reads the
 * `ai_*` settings rows through `getAISettings()` (server/ai.js), and so do the
 * welcome screen and some fifteen gates that point the app at a stub. Those
 * rows stay the ACTIVE configuration. A row in `ai_connections` is a saved
 * connection; using one writes its fields into the active rows in one
 * transaction, and `reconcile()` makes the keyring follow anything that wrote
 * the active rows directly (the welcome screen, OpenRouter's sign-in, a gate),
 * so the two never disagree about which connection is in use.
 *
 * ONE IN USE AT A TIME, for everything — lessons, questions, checks, the
 * assistant. A later per-job choice is a settings object per job, not a new
 * transport: `settingsForConnection(id, { model })` builds exactly what
 * `getAISettings()` returns, for any saved connection, and every model call
 * already takes one.
 *
 * Keys never leave the server: the list answers whether a key is saved and its
 * last four characters. A key is bound to the ORIGIN it was typed for, as the
 * active row's key is (`apiKeyOriginOf`), so editing an address cannot carry a
 * key to another host.
 *
 * Keys and sign-ins are not in this table: they are in the credentials file
 * beside the library (server/secrets.js), under the row's random `secret_ref`.
 * The row keeps `key_origin`, the half that is not secret, and a key is used
 * only when the file's copy of the origin agrees with it. A row whose origin
 * names a key the file does not hold `keyMissing`: the library was moved or
 * restored without its credentials, and the connection asks for its key again.
 */
import db from './database.js';
import {
    DEFAULT_OLLAMA_URL, DEFAULT_OPENAI_BASE_URL, activeKey, apiKeyOriginOf, getAISettings,
    listModelsFor, normalizeOpenAIBaseUrl, saveActiveKey, tinyReplyFor,
} from './ai.js';
import { connectionSecret, deleteSecrets, getSecret, newSecretRef, setSecret, setSecrets } from './secrets.js';
import { warmOpenRouterCatalogue, openRouterEffortsFor, wireOf } from './aiWire.js';
import { anthropicModelEfforts } from './anthropicWire.js';
import { safeFetch } from './netSafety.js';

/** Every kind of connection, and what it fixes. `baseUrl` is fixed for a
 *  hosted service and only a default for one the learner addresses. */
export const CONNECTION_KINDS = {
    openrouter: { baseUrl: 'https://openrouter.ai/api/v1', key: 'required', keyUrl: 'https://openrouter.ai/settings/keys' },
    anthropic: { baseUrl: 'https://api.anthropic.com/v1', key: 'required', format: 'anthropic', keyUrl: 'https://console.anthropic.com/settings/keys' },
    openai: { baseUrl: 'https://api.openai.com/v1', key: 'required', keyUrl: 'https://platform.openai.com/api-keys' },
    gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', key: 'required', keyUrl: 'https://aistudio.google.com/apikey' },
    chatgpt: { baseUrl: 'https://api.openai.com/v1', key: 'none', format: 'chatgpt' },
    ollama: { baseUrl: DEFAULT_OLLAMA_URL, key: 'none', editable: true },
    custom: { baseUrl: 'http://127.0.0.1:1234/v1', key: 'optional', editable: true },
};
const HOST_KINDS = {
    'openrouter.ai': 'openrouter', 'api.anthropic.com': 'anthropic',
    'api.openai.com': 'openai', 'generativelanguage.googleapis.com': 'gemini',
};

const now = () => new Date().toISOString();
const put = (key, value) => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
const drop = (...keys) => db.prepare(`DELETE FROM settings WHERE key IN (${keys.map(() => '?').join(',')})`).run(...keys);

/** The stored rows themselves — never the env overrides getAISettings applies,
 *  which belong to a batch tool's process and must not be written back. */
function activeRows() {
    const out = {};
    for (const r of db.prepare("SELECT key, value FROM settings WHERE key LIKE 'ai\\_%' ESCAPE '\\'").all()) out[r.key] = r.value ?? '';
    return out;
}

/** What the active rows describe: a kind, an address, and whether anyone chose it. */
export function identityOf(rows) {
    if (rows.ai_provider !== 'openai') {
        return { kind: 'ollama', base: rows.ai_ollama_url || DEFAULT_OLLAMA_URL, configured: !!rows.ai_model };
    }
    const base = normalizeOpenAIBaseUrl(rows.ai_openai_base_url || DEFAULT_OPENAI_BASE_URL);
    const format = rows.ai_api_format || '';
    let kind;
    if (format === 'chatgpt') kind = 'chatgpt';
    else if (format === 'anthropic') kind = 'anthropic';
    else { try { kind = HOST_KINDS[new URL(base).hostname.toLowerCase()] || 'custom'; } catch { kind = 'custom'; } }
    return { kind, base, configured: true };
}

const sameAddress = (a, b) => {
    if (a === b) return true;
    if (!a || !b) return false;
    return normalizeOpenAIBaseUrl(a) === normalizeOpenAIBaseUrl(b);
};
function matches(row, ident) {
    if (!row || row.kind !== ident.kind) return false;
    if (row.kind === 'chatgpt') return true;
    return row.kind === 'ollama' ? String(row.base_url).replace(/\/+$/, '') === String(ident.base).replace(/\/+$/, '') : sameAddress(row.base_url, ident.base);
}

const getRow = (id) => (id ? db.prepare('SELECT * FROM ai_connections WHERE id = ?').get(id) : undefined);
const allRows = () => db.prepare('SELECT * FROM ai_connections ORDER BY id').all();

// ── a connection's credentials, in the file beside the library ────────────

/** The row's key: handed out only when the file's copy of its origin agrees
 *  with the row's. `stored`: the file holds a key for this row at all. */
function keyOf(row) {
    if (!row?.secret_ref) return { key: '', stored: false };
    const key = getSecret(connectionSecret(row.secret_ref, 'api_key'));
    const bound = getSecret(connectionSecret(row.secret_ref, 'key_origin'));
    return { key: key && row.key_origin && bound === row.key_origin ? key : '', stored: !!key };
}

/** The row's `secret_ref`, made the first time it keeps a credential. */
function refOf(row) {
    if (row.secret_ref) return row.secret_ref;
    const ref = newSecretRef();
    db.prepare('UPDATE ai_connections SET secret_ref = ? WHERE id = ?').run(ref, row.id);
    row.secret_ref = ref;
    return ref;
}

/** Save a connection's key bound to `origin`, or clear it with ''. The file
 *  is written first when saving and last when clearing, so the row never
 *  names an origin for a key the file is still about to receive. */
function storeKey(row, key, origin) {
    const ref = refOf(row);
    const names = [connectionSecret(ref, 'api_key'), connectionSecret(ref, 'key_origin')];
    if (key) {
        setSecrets({ [names[0]]: key, [names[1]]: origin });
        db.prepare('UPDATE ai_connections SET key_origin = ? WHERE id = ?').run(origin, row.id);
    } else {
        db.prepare("UPDATE ai_connections SET key_origin = '' WHERE id = ?").run(row.id);
        deleteSecrets(...names);
    }
}

/** A ChatGPT connection's sign-in (tokens and the issued client id), or null. */
export function credentialsOf(row) {
    if (!row?.secret_ref) return null;
    try { return JSON.parse(getSecret(connectionSecret(row.secret_ref, 'credentials')) || 'null'); } catch { return null; }
}

export function saveCredentials(id, creds) {
    const row = getRow(id);
    if (!row) throw Object.assign(new Error('No such connection'), { status: 404 });
    setSecret(connectionSecret(refOf(row), 'credentials'), JSON.stringify(creds));
}

/** Everything the file holds for a row, gone with it. */
function forgetSecrets(row) {
    if (!row?.secret_ref) return;
    deleteSecrets(...['api_key', 'key_origin', 'credentials'].map(f => connectionSecret(row.secret_ref, f)));
}

/**
 * Make the keyring agree with the active rows, and return the id in use (or
 * null). The rows win: whatever wrote them last decided what answers.
 */
export function reconcile() {
    const rows = activeRows();
    const ident = identityOf(rows);
    const savedId = Number(rows.ai_active_connection) || null;
    let row = getRow(savedId);
    if (row && !matches(row, ident)) row = undefined;
    if (!row && ident.configured && ident.kind !== 'chatgpt') {
        row = allRows().find(r => matches(r, ident));
        if (!row) {
            const id = Number(db.prepare('INSERT INTO ai_connections (kind, base_url, created_at, used_at) VALUES (?, ?, ?, ?)')
                .run(ident.kind, ident.base, now(), now()).lastInsertRowid);
            row = getRow(id);
        }
    }
    if (!row) {
        if (savedId) drop('ai_active_connection');
        return null;
    }
    // The active rows' model and key are the newest values; the row follows.
    const model = ident.kind === 'ollama' ? (rows.ai_model || '') : (rows.ai_openai_model || '');
    if (model !== row.model) db.prepare('UPDATE ai_connections SET model = ? WHERE id = ?').run(model, row.id);
    if (CONNECTION_KINDS[row.kind]?.key !== 'none') {
        // Only a key the active rows can vouch for, or none at all, is news.
        // A key they name and the credentials file lacks is MISSING, not
        // cleared: copied over, it would turn "needs its key again" into "has
        // no key" and the connection would stop asking for it.
        const active = activeKey();
        if (!active.missing && (active.key || !active.stored)) {
            const key = active.key && active.origin === apiKeyOriginOf(row.base_url) ? active.key : '';
            const origin = key ? active.origin : '';
            if (key !== keyOf(row).key || origin !== row.key_origin) storeKey(row, key, origin);
        }
    }
    if (savedId !== row.id) put('ai_active_connection', String(row.id));
    return row.id;
}

/** Write one saved connection into the active rows: from now on it answers.
 *  `keepCurrent` first saves the connection in use's latest model and key into
 *  its row — off when the caller has just changed or removed that row itself,
 *  or the stale rows would be read back over the change (and a removed
 *  connection re-created from them). */
export function useConnection(id, { keepCurrent = true } = {}) {
    if (keepCurrent) reconcile();
    const row = getRow(id);
    if (!row) throw Object.assign(new Error('No such connection'), { status: 404 });
    const kind = CONNECTION_KINDS[row.kind] || {};
    db.transaction(() => {
        if (row.kind === 'ollama') {
            put('ai_provider', 'ollama');
            put('ai_ollama_url', row.base_url || DEFAULT_OLLAMA_URL);
            put('ai_model', row.model || '');
        } else {
            put('ai_provider', 'openai');
            put('ai_openai_base_url', row.base_url);
            put('ai_openai_model', row.model || '');
            // A key this row lost with its credentials file goes in use as
            // missing (its origin, no key), so it keeps asking for the key.
            saveActiveKey(keyOf(row).key, row.key_origin);
            if (kind.format) put('ai_api_format', kind.format);
            else drop('ai_api_format');
        }
        put('ai_active_connection', String(row.id));
        db.prepare('UPDATE ai_connections SET used_at = ? WHERE id = ?').run(now(), row.id);
    })();
    return row.id;
}

/** Back to a library with no model connected (the state a new install starts in). */
function clearActive() {
    saveActiveKey('', '');
    drop('ai_provider', 'ai_openai_base_url', 'ai_openai_model', 'ai_api_format', 'ai_active_connection', 'ai_model');
}

/** A new saved connection. Returns its id; using it is a separate decision. */
export function addConnection({ kind, baseUrl, apiKey = '', model = '' }) {
    const k = CONNECTION_KINDS[kind];
    if (!k || kind === 'chatgpt') throw Object.assign(new Error('Unknown kind of connection'), { status: 400 });
    const base = k.editable && baseUrl ? (kind === 'ollama' ? String(baseUrl).trim().replace(/\/+$/, '') : normalizeOpenAIBaseUrl(baseUrl)) : k.baseUrl;
    if (kind !== 'ollama' && !apiKeyOriginOf(base)) throw Object.assign(new Error('That address is not a valid http(s) URL'), { status: 400 });
    const key = String(apiKey || '').trim();
    if (k.key === 'required' && !key) throw Object.assign(new Error('This connection needs an API key'), { status: 400 });
    const id = Number(db.prepare(`INSERT INTO ai_connections (kind, base_url, model, created_at, secret_ref)
        VALUES (?, ?, ?, ?, ?)`).run(kind, base, String(model || ''), now(), newSecretRef()).lastInsertRowid);
    if (key) storeKey(getRow(id), key, apiKeyOriginOf(base));
    return id;
}

/** Change a saved connection's model, key or (for a local server) address. */
export function updateConnection(id, { model, apiKey, baseUrl } = {}) {
    const activeId = reconcile();
    const row = getRow(id);
    if (!row) throw Object.assign(new Error('No such connection'), { status: 404 });
    const k = CONNECTION_KINDS[row.kind] || {};
    let { base_url: base, model: chosen } = row;
    if (baseUrl !== undefined && k.editable) {
        base = row.kind === 'ollama' ? String(baseUrl).trim().replace(/\/+$/, '') : normalizeOpenAIBaseUrl(baseUrl);
        if (row.kind !== 'ollama' && !apiKeyOriginOf(base)) throw Object.assign(new Error('That address is not a valid http(s) URL'), { status: 400 });
    }
    if (model !== undefined) chosen = String(model || '');
    db.prepare('UPDATE ai_connections SET base_url = ?, model = ? WHERE id = ?').run(base, chosen, id);
    if (apiKey !== undefined && k.key !== 'none') {
        const key = String(apiKey || '').trim();
        storeKey(row, key, key ? apiKeyOriginOf(base) : '');
    }
    if (activeId === id) useConnection(id, { keepCurrent: false });
}

/** Forget a saved connection. The one in use hands over to the most recently
 *  used of the rest, or leaves the library with no model connected. */
export async function removeConnection(id) {
    const activeId = reconcile();
    const row = getRow(id);
    if (!row) throw Object.assign(new Error('No such connection'), { status: 404 });
    let revoked = null;
    if (row.kind === 'chatgpt') revoked = await (await import('./chatgptAuth.js')).signOut({ credentials: JSON.stringify(credentialsOf(row) || {}) }).catch(() => false);
    db.prepare('DELETE FROM ai_connections WHERE id = ?').run(id);
    forgetSecrets(row);
    if (activeId === id) {
        const next = db.prepare('SELECT id FROM ai_connections ORDER BY COALESCE(used_at, created_at) DESC, id DESC LIMIT 1').get();
        if (next) useConnection(next.id, { keepCurrent: false }); else clearActive();
    }
    return { revoked };
}

/** What `getAISettings()` would return if this connection were the one in use. */
export function settingsForConnection(id, { model } = {}) {
    const row = getRow(id);
    if (!row) return null;
    const base = getAISettings();
    const k = CONNECTION_KINDS[row.kind] || {};
    const isOllama = row.kind === 'ollama';
    const baseUrl = isOllama ? base.baseUrl : row.base_url;
    return {
        ...base,
        provider: isOllama ? 'ollama' : 'openai',
        ollamaUrl: isOllama ? (row.base_url || DEFAULT_OLLAMA_URL) : base.ollamaUrl,
        baseUrl,
        apiKey: !isOllama && row.key_origin === apiKeyOriginOf(baseUrl) ? keyOf(row).key : '',
        model: model ?? row.model,
        apiFormat: k.format || '',
        connectionId: row.id,
        providerOrder: row.kind === 'openrouter' ? base.providerOrder : [],
        providerSort: row.kind === 'openrouter' ? base.providerSort : '',
    };
}

/** The keyring as the client may see it: no key, no token, ever. */
export function listConnections() {
    const activeId = reconcile();
    return {
        activeId,
        connections: allRows().map(r => {
            const creds = r.kind === 'chatgpt' ? credentialsOf(r) : null;
            const { key } = keyOf(r);
            return {
                id: r.id,
                kind: r.kind,
                baseUrl: r.base_url,
                model: r.model,
                hasKey: !!key,
                keyHint: key ? `…${key.slice(-4)}` : '',
                // Saved once, and not in the credentials file beside this
                // library: it was moved or restored without it.
                keyMissing: r.kind === 'chatgpt' ? !creds : !!r.key_origin && !key,
                account: r.account || '',
                signedIn: r.kind === 'chatgpt' ? !!creds?.refresh_token : undefined,
                planEnabled: r.kind === 'chatgpt' ? !!creds?.scopes?.includes?.('chatgpt.tokens.use.direct') : undefined,
                needsPlanNotice: r.kind === 'chatgpt' && !!creds?.refresh_token && !r.plan_notice_seen,
                active: r.id === activeId,
                test: r.tested_at ? { at: r.tested_at, ok: !!r.test_ok, reason: r.test_note } : null,
                createdAt: r.created_at,
            };
        }),
    };
}

export function markPlanNoticeSeen(id) {
    db.prepare('UPDATE ai_connections SET plan_notice_seen = 1 WHERE id = ?').run(id);
}

// ── testing a connection ──────────────────────────────────────────────────

/**
 * Why a test failed, as a reason code the client words in the learner's
 * language, plus what the sentence needs. Pure: the gate walks it through the
 * shapes each provider sends.
 */
export function describeConnectionFailure({ status, body = '', message = '', causeCode = '', name = '' } = {}) {
    const text = `${body} ${message}`;
    if (!status) {
        if (name === 'TimeoutError' || name === 'AbortError' || /timed? ?out/i.test(message)) return { reason: 'timeout' };
        if (causeCode || /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|not running|Nothing is listening/i.test(text)) return { reason: 'unreachable' };
    }
    if (/subscription_sharing_usage_limit_exceeded|limit for this app is used up/i.test(text)) return { reason: 'plan_limit' };
    if (/subscription_sharing_user_not_eligible|cannot use its plan/i.test(text)) return { reason: 'plan_not_eligible' };
    if (status === 402 || /credit balance|insufficient_quota|billing|out of credits|payment required/i.test(text)) return { reason: 'credit' };
    if (status === 401 || status === 403 || /invalid.{0,20}(api.?key|x-api-key)|authentication_error|unauthori[sz]ed|incorrect api key/i.test(text)) return { reason: 'key' };
    if (status === 429) return { reason: 'rate' };
    if (status === 404 || /model.{0,40}(not.?found|does not exist|not available)|not_found_error/i.test(text)) return { reason: 'model' };
    if (/returned no answer/i.test(message)) return { reason: 'empty', detail: message.slice(0, 300) };
    return { reason: 'other', status: status || null, detail: (message || body).slice(0, 300) };
}

function failureOf(err) {
    return describeConnectionFailure({
        status: err?.httpStatus ?? (Number(/\((\d{3})\)/.exec(err?.message || '')?.[1]) || undefined),
        body: err?.responseBody || '',
        message: err?.message || '',
        causeCode: err?.cause?.code || '',
        name: err?.name || '',
    });
}

/** OpenRouter's model list is public, so it proves nothing about a key; its
 *  key route does, without spending anything. */
async function checkOpenRouterKey(settings) {
    const base = normalizeOpenAIBaseUrl(settings.baseUrl);
    const res = await safeFetch(`${base}/key`, { headers: { Authorization: `Bearer ${settings.apiKey}` }, signal: AbortSignal.timeout(10000) });
    if (res.ok) return;
    const body = await res.text().catch(() => '');
    throw Object.assign(new Error(`Key check failed (${res.status})`), { httpStatus: res.status, responseBody: body });
}

/**
 * Test what a settings object reaches: the model list (the key may look), and
 * with a model chosen, one short reply (the key may SPEND — the only way to
 * learn there is no credit). Returns `{ ok, step, models?, reason?, … }`.
 */
export async function testSettings(settings) {
    let models = [];
    try {
        if (wireOf(settings) === 'openrouter') await checkOpenRouterKey(settings);
        models = await listModelsFor(settings);
    } catch (err) {
        return { ok: false, step: 'list', ...failureOf(err) };
    }
    if (!settings.model) return { ok: true, step: 'list', models: models.length };
    try {
        const reply = await tinyReplyFor(settings);
        if (!reply) return { ok: false, step: 'reply', reason: 'empty', models: models.length };
    } catch (err) {
        return { ok: false, step: 'reply', models: models.length, model: settings.model, ...failureOf(err) };
    }
    return { ok: true, step: 'reply', models: models.length, model: settings.model };
}

/** Test a saved connection and keep the verdict on it. */
export async function testConnection(id) {
    const settings = settingsForConnection(id);
    if (!settings) throw Object.assign(new Error('No such connection'), { status: 404 });
    const result = await testSettings(settings);
    db.prepare('UPDATE ai_connections SET tested_at = ?, test_ok = ?, test_note = ? WHERE id = ?')
        .run(now(), result.ok ? 1 : 0, result.ok ? '' : String(result.reason || 'other'), id);
    return result;
}

/** The models a saved connection lists, for its picker. */
export async function modelsForConnection(id) {
    const settings = settingsForConnection(id);
    if (!settings) throw Object.assign(new Error('No such connection'), { status: 404 });
    return listModelsFor(settings);
}

/**
 * Which thinking levels the control may offer for one model on one settings
 * object: a list (weakest first), or `null` when the provider publishes none
 * — then the control is not drawn and the automatic level is sent, clamped by
 * the transport where the provider says how.
 */
export async function effortChoices(settings, model = settings.model) {
    const wire = wireOf(settings);
    if (!model) return { levels: null };
    if (wire === 'openrouter') {
        const base = normalizeOpenAIBaseUrl(settings.baseUrl);
        await warmOpenRouterCatalogue(base);
        const entry = openRouterEffortsFor(base, model);
        if (!entry) return { levels: null };
        return { levels: entry.levels === undefined ? null : entry.levels, defaultEffort: entry.defaultEffort || '' };
    }
    if (wire === 'anthropic') {
        const { levels } = await anthropicModelEfforts(normalizeOpenAIBaseUrl(settings.baseUrl), settings.apiKey, model);
        return { levels: levels.length ? levels : null };
    }
    return { levels: null };
}
