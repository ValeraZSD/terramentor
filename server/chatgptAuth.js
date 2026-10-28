/* "Continue with ChatGPT": a learner's own ChatGPT plan, used by this app.
 *
 * OpenAI's open-source flow (developers.openai.com/siwc/token-sharing-open-
 * source): OpenID Connect with PKCE and DYNAMIC registration —
 * no client secret, no partner key. The first sign-in sends
 * `client_id=dynamic_agent_client` with the app's name and this machine's host
 * id, and the callback hands back an issued client id that every later sign-in
 * to that account reuses. The tokens it returns spend the learner's plan on the
 * Responses API only (chatgptWire.js).
 *
 * Three of its terms shape this file:
 *   - The callback must be `http://127.0.0.1:<port>/auth/callback` — never
 *     `localhost`, and the app's own server may be HTTPS on another port — so a
 *     small listener is opened for the one attempt and closed after it. It
 *     follows that the sign-in works in a browser ON this computer: a phone
 *     reaching the app over the network would be sent to its own 127.0.0.1.
 *   - The ID token is checked against OpenAI's published keys (issuer,
 *     audience = the issued client id, expiry, nonce) before anything is
 *     saved, and plan usage is on only if the GRANTED scopes include
 *     `chatgpt.tokens.use.direct` — a valid sign-in alone does not allow it.
 *   - Access tokens last an hour and the refresh token rotates, so refreshes
 *     for one connection are serialised: two at once would race a token that
 *     can be used only once.
 *
 * Tokens live in the credentials file beside the library (server/secrets.js),
 * with the API keys, under the connection's `secret_ref`; the library keeps
 * only the connection and the account's email. They never leave the server:
 * no route returns them, no log line carries them, no URL holds one.
 */
import { createServer } from 'node:http';
import { createHash, createPublicKey, randomBytes, randomUUID, verify as verifySignature } from 'node:crypto';
import db from './database.js';
import { credentialsOf, reconcile, saveCredentials } from './aiConnections.js';
import { safeFetch } from './netSafety.js';
import { readCappedJson } from './httpBody.js';

// A discovery document, a key set and a token answer are each a few kilobytes;
// none has a reason to weigh a megabyte (httpBody.js).
const AUTH_BODY_BYTES = 1024 * 1024;

const AUTH_BASE = () => (process.env.CHATGPT_AUTH_BASE || 'https://auth.openai.com').replace(/\/+$/, '');
const API_RESOURCE = 'https://api.openai.com/v1';
const CALLBACK_PATH = '/auth/callback';
const DEFAULT_CALLBACK_PORT = 1455;
const ATTEMPT_TTL_MS = 10 * 60 * 1000;
const REFRESH_MARGIN_MS = 2 * 60 * 1000;
export const AGENT_NAME = 'Terramentor';
export const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';

const now = () => new Date().toISOString();
const b64url = (buf) => Buffer.from(buf).toString('base64url');

/** This installation's host id: made once, kept, never a user identifier. */
export function hostId() {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'chatgpt_host_id'").get();
    if (row?.value) return row.value;
    const id = `urn:uuid:${randomUUID()}`;
    db.prepare("INSERT INTO settings (key, value) VALUES ('chatgpt_host_id', ?)").run(id);
    return id;
}

// ── discovery and keys ────────────────────────────────────────────────────

/**
 * May an address named by the discovery document be fetched? Only on the sign-in
 * host itself, or over https on openai.com: the document decides where the
 * signing keys come from and where a refresh token is sent to be revoked, and
 * a document that named another host would collect that token.
 */
export function trustedAuthUrl(raw) {
    let u;
    try { u = new URL(String(raw)); } catch { return false; }
    if (u.origin === new URL(AUTH_BASE()).origin) return true;
    return u.protocol === 'https:' && (u.hostname === 'openai.com' || u.hostname.endsWith('.openai.com'));
}

let discovery = null;   // { at, doc, jwks }
async function openidConfig() {
    if (discovery && Date.now() - discovery.at < 60 * 60 * 1000) return discovery;
    const res = await safeFetch(`${AUTH_BASE()}/.well-known/openid-configuration`, { allowRedirect: trustedAuthUrl, signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`OpenAI's sign-in configuration did not load (${res.status})`);
    const doc = await readCappedJson(res, AUTH_BODY_BYTES);
    if (!trustedAuthUrl(doc.jwks_uri)) throw new Error('OpenAI\'s sign-in configuration names its keys on another host');
    const keys = await safeFetch(doc.jwks_uri, { allowRedirect: trustedAuthUrl, signal: AbortSignal.timeout(10000) });
    if (!keys.ok) throw new Error(`OpenAI's signing keys did not load (${keys.status})`);
    discovery = { at: Date.now(), doc, jwks: await readCappedJson(keys, AUTH_BODY_BYTES) };
    return discovery;
}

/** For the gate: forget the cached discovery document and keys. */
export function resetChatgptAuthState() { discovery = null; pending = null; }

/**
 * Verify an ID token: signature against the published keys, issuer, audience,
 * expiry and nonce. Returns its claims, or throws saying which check failed.
 * Pure apart from the keys handed in.
 */
export function verifyIdToken(idToken, { jwks, issuer, clientId, nonce, nowSec = Math.floor(Date.now() / 1000) }) {
    const parts = String(idToken || '').split('.');
    if (parts.length !== 3) throw new Error('The ID token is not a JWT');
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const jwk = (jwks?.keys || []).find(k => k.kid === header.kid) || (jwks?.keys?.length === 1 ? jwks.keys[0] : null);
    if (!jwk) throw new Error('The ID token was signed with a key OpenAI does not publish');
    // The algorithm named in the token's header is the token's own claim, so it
    // is held against the KEY: an RS256 token is checked only with an RSA key
    // and an ES256 one only with a P-256 key, a key the publisher pinned to an
    // algorithm (`alg`) is used for that algorithm only, and an encryption key
    // (`use: "enc"`) never verifies a signature. Without this the header picks
    // how a published key is used, which is the mix-up these checks exist to
    // stop.
    const algs = {
        RS256: { digest: 'RSA-SHA256', opts: {}, kty: 'RSA' },
        ES256: { digest: 'SHA256', opts: { dsaEncoding: 'ieee-p1363' }, kty: 'EC', crv: 'P-256' },
    };
    const alg = algs[header.alg];
    if (!alg) throw new Error(`Unsupported ID token algorithm ${header.alg}`);
    if (jwk.kty !== alg.kty || (alg.crv && jwk.crv !== alg.crv)) throw new Error('The ID token names an algorithm its signing key is not for');
    if (jwk.alg !== undefined && jwk.alg !== header.alg) throw new Error('The ID token names an algorithm its signing key is not for');
    if (jwk.use !== undefined && jwk.use !== 'sig') throw new Error('The ID token was signed with a key that is not for signatures');
    const key = createPublicKey({ key: jwk, format: 'jwk' });
    const ok = verifySignature(alg.digest, Buffer.from(`${parts[0]}.${parts[1]}`), { key, ...alg.opts }, Buffer.from(parts[2], 'base64url'));
    if (!ok) throw new Error('The ID token signature does not verify');
    if (claims.iss !== issuer) throw new Error('The ID token is from another issuer');
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(clientId)) throw new Error('The ID token was issued to another client');
    // OpenID Connect Core 3.1.3.7: a token with more than one audience, or one
    // that names its authorized party, must name THIS client as that party —
    // otherwise a token issued to another client that merely lists us too
    // would pass.
    if ((aud.length > 1 || claims.azp !== undefined) && claims.azp !== clientId) throw new Error('The ID token was issued to another client');
    if (!(Number(claims.exp) > nowSec)) throw new Error('The ID token has expired');
    // Issued in the future means a wrong clock or a forged token; five minutes
    // of slack covers an ordinary clock drift between here and OpenAI.
    if (claims.iat !== undefined && !(Number(claims.iat) <= nowSec + 300)) throw new Error('The ID token was issued in the future');
    if (nonce && claims.nonce !== nonce) throw new Error('The ID token answers another sign-in attempt');
    return claims;
}

// ── one sign-in attempt ───────────────────────────────────────────────────

let pending = null;   // { state, nonce, verifier, redirectUri, clientId, connectionId, returnUrl, at, server }

function closePending() {
    try { pending?.server?.close(); } catch { /* already closed */ }
    pending = null;
}

async function listen(port) {
    const server = createServer((req, res) => { handleCallback(req, res).catch(() => { try { res.end(); } catch { } }); });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
    });
    return server;
}

/** Is this request's browser on this computer? Only then can it reach the callback. */
export function isLocalBrowser(origin) {
    try { return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(new URL(origin).hostname); } catch { return false; }
}

/**
 * Start a sign-in. `appOrigin` is where the browser is to land afterwards;
 * `connectionId` re-signs an existing connection (its issued client id).
 * Returns the authorize URL for the browser to open.
 */
export async function startSignIn({ appOrigin, returnPath = '/settings#ai', connectionId = null }) {
    closePending();
    const existing = connectionId ? db.prepare("SELECT * FROM ai_connections WHERE id = ? AND kind = 'chatgpt'").get(connectionId) : null;
    const creds = credentialsOf(existing);
    const clientId = creds?.client_id || 'dynamic_agent_client';
    const preferred = Number(process.env.CHATGPT_CALLBACK_PORT) || DEFAULT_CALLBACK_PORT;
    let server;
    try { server = await listen(preferred); } catch { server = await listen(0); }   // only the port may vary
    const redirectUri = `http://127.0.0.1:${server.address().port}${CALLBACK_PATH}`;
    const verifier = b64url(randomBytes(32));
    const state = b64url(randomBytes(24));
    const nonce = b64url(randomBytes(24));
    const safePath = /^\/[^/\\]/.test(returnPath) || returnPath === '/' ? returnPath : '/settings#ai';
    pending = { state, nonce, verifier, redirectUri, clientId, connectionId: existing?.id ?? null, returnUrl: `${appOrigin}${safePath}`, at: Date.now(), server };
    setTimeout(() => { if (pending?.state === state) closePending(); }, ATTEMPT_TTL_MS).unref?.();

    const url = new URL(`${AUTH_BASE()}/api/accounts/authorize`);
    const q = url.searchParams;
    q.set('client_id', clientId);
    if (clientId === 'dynamic_agent_client') q.set('agent_name_hint', AGENT_NAME);
    q.set('ext_agent_host_id', hostId());
    if (creds?.id_token) q.set('id_token_hint', creds.id_token);
    if (existing?.account) q.set('login_hint', existing.account);
    q.set('response_type', 'code');
    q.set('redirect_uri', redirectUri);
    q.set('scope', SCOPES);
    q.set('resource', API_RESOURCE);
    q.set('state', state);
    q.set('nonce', nonce);
    q.set('code_challenge_method', 'S256');
    q.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
    return { url: url.toString() };
}

function redirect(res, to, outcome) {
    const u = new URL(to);
    u.searchParams.set('chatgpt', outcome);
    // Keep the hash (Settings' tab) after the query.
    const target = `${u.origin}${u.pathname}${u.search}${new URL(to).hash}`;
    res.writeHead(302, { Location: target, 'Cache-Control': 'no-store' });
    res.end();
}

async function tokenRequest(form) {
    // The body carries the code verifier or the refresh token, and a 307/308
    // would carry it to wherever it pointed.
    const res = await safeFetch(`${AUTH_BASE()}/api/accounts/oauth/token`, {
        allowRedirect: trustedAuthUrl,
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form).toString(),
        signal: AbortSignal.timeout(15000),
    });
    const json = await readCappedJson(res, AUTH_BODY_BYTES).catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(json?.error_description || json?.error || `Token request failed (${res.status})`), { code: json?.error, httpStatus: res.status });
    return json;
}

async function handleCallback(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== CALLBACK_PATH) { res.writeHead(404); res.end(); return; }
    const attempt = pending;
    const q = url.searchParams;
    if (!attempt || q.get('state') !== attempt.state || Date.now() - attempt.at > ATTEMPT_TTL_MS) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('This sign-in attempt is not the one Terramentor is waiting for. Start it again from Settings.');
        return;
    }
    closePending();   // one callback per attempt, whatever it says
    if (q.get('error')) { redirect(res, attempt.returnUrl, q.get('error') === 'access_denied' ? 'declined' : 'failed'); return; }
    const issued = q.get('client_id');
    let clientId = attempt.clientId;
    if (clientId === 'dynamic_agent_client') {
        if (!issued) { redirect(res, attempt.returnUrl, 'failed'); return; }
        clientId = issued;
    } else if (issued && issued !== clientId) { redirect(res, attempt.returnUrl, 'failed'); return; }
    try {
        const tokens = await tokenRequest({
            grant_type: 'authorization_code', client_id: clientId, code: q.get('code') || '',
            code_verifier: attempt.verifier, redirect_uri: attempt.redirectUri, resource: API_RESOURCE,
        });
        const { doc, jwks } = await openidConfig();
        const claims = verifyIdToken(tokens.id_token, { jwks, issuer: doc.issuer || AUTH_BASE(), clientId, nonce: attempt.nonce });
        const scopes = String(tokens.scope || '').split(/\s+/).filter(Boolean);
        const id = saveSignIn({ claims, tokens, scopes, clientId, connectionId: attempt.connectionId });
        redirect(res, attempt.returnUrl, scopes.includes(PLAN_SCOPE) ? `connected-${id}` : 'noplan');
    } catch (err) {
        console.log(`[chatgpt] sign-in failed: ${err?.code || err?.message || err}`);
        redirect(res, attempt.returnUrl, 'failed');
    }
}

function credentialRecord({ claims, tokens, scopes, clientId }, previous = {}) {
    return {
        email: claims?.email || previous.email || '',
        issuer: claims?.iss || previous.issuer || '',
        subject: claims?.sub || previous.subject || '',
        client_id: clientId,
        ext_agent_host_id: hostId(),
        id_token: tokens.id_token || previous.id_token || '',
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token || previous.refresh_token || '',
        token_type: tokens.token_type || 'Bearer',
        expires_at: Date.now() + (Number(tokens.expires_in) || 3600) * 1000,
        scopes: scopes.length ? scopes : (previous.scopes || []),
        saved_at: now(),
    };
}

/** Save a validated sign-in on its connection (or a new one) and use it when nothing else is. */
export function saveSignIn({ claims, tokens, scopes, clientId, connectionId = null }) {
    let row = connectionId ? db.prepare("SELECT * FROM ai_connections WHERE id = ? AND kind = 'chatgpt'").get(connectionId) : null;
    if (!row) {
        // The same account signing in again on this machine is the same connection.
        row = db.prepare("SELECT * FROM ai_connections WHERE kind = 'chatgpt'").all()
            .find(r => { const c = credentialsOf(r); return c?.subject === claims.sub && c?.client_id === clientId; });
    }
    if (row) {
        const prev = credentialsOf(row) || {};
        if (prev.subject && prev.subject !== claims.sub) throw new Error('A different ChatGPT account answered this sign-in');
        saveCredentials(row.id, credentialRecord({ claims, tokens, scopes, clientId }, prev));
        unsaved.delete(row.id);
        db.prepare('UPDATE ai_connections SET account = ? WHERE id = ?').run(claims.email || row.account, row.id);
    } else {
        const id = Number(db.prepare(`INSERT INTO ai_connections (kind, base_url, account, created_at)
            VALUES ('chatgpt', ?, ?, ?)`).run(API_RESOURCE, claims.email || '', now()).lastInsertRowid);
        saveCredentials(id, credentialRecord({ claims, tokens, scopes, clientId }));
        row = { id };
    }
    // Not put in use yet: a connection with no model cannot answer, and an
    // "In use" beside "no model chosen" reads as broken. The page lands on the
    // model step for it, and choosing the model is what puts it in use.
    reconcile();
    return row.id;
}

// ── tokens for requests ───────────────────────────────────────────────────

/** Does this connection hold a sign-in that may spend the plan? */
export function hasPlanSignIn(connectionId) {
    const row = connectionId ? db.prepare("SELECT * FROM ai_connections WHERE id = ? AND kind = 'chatgpt'").get(connectionId) : null;
    const c = credentialsOf(row);
    return !!c?.refresh_token && Array.isArray(c.scopes) && c.scopes.includes(PLAN_SCOPE);
}

const refreshing = new Map();   // connection id → Promise<token>
// A renewal OpenAI granted that could not be saved: its refresh token is the
// only valid one now (the old one is spent), so it is kept for this run and
// saved on the next call that can.
const unsaved = new Map();      // connection id → credential record

/** A removed connection, or one signed in again, has no renewal left to save. */
export function forgetUnsaved(connectionId) {
    const pending = unsaved.get(Number(connectionId)) || null;
    unsaved.delete(Number(connectionId));
    return pending;
}

// Connections being removed: no refresh starts for them, so the token a
// removal revokes is the last one OpenAI will have issued.
const closing = new Set();

/**
 * Before a connection is removed: stop new refreshes, let one already in
 * flight finish, and hand back the newest record the removal must revoke
 * (a renewal held in memory, else the stored one, read again now).
 */
export async function closeForRemoval(connectionId) {
    const id = Number(connectionId);
    closing.add(id);
    try { await refreshing.get(id); } catch { /* a refresh that failed issued nothing newer */ }
    const row = db.prepare("SELECT * FROM ai_connections WHERE id = ? AND kind = 'chatgpt'").get(id);
    return forgetUnsaved(id) || credentialsOf(row);
}

/** The removal is over (done or refused): later refreshes may run again. */
export function openAfterRemoval(connectionId) {
    closing.delete(Number(connectionId));
}

const UNUSABLE_REFRESH = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']);

/** A current access token for a ChatGPT connection, refreshed when it is about to lapse. */
export async function accessTokenFor(connectionId) {
    const row = connectionId ? db.prepare("SELECT * FROM ai_connections WHERE id = ? AND kind = 'chatgpt'").get(connectionId) : null;
    if (row && closing.has(row.id)) throw new Error('This ChatGPT connection is being removed.');
    const stored = credentialsOf(row);
    const pending = row ? unsaved.get(row.id) : null;
    // The renewal in memory only while it is the newest: a sign-in saved
    // since (here or by another process) is newer and wins.
    const creds = pending && !(stored && String(stored.saved_at || '') > String(pending.saved_at || '')) ? pending : stored;
    if (!creds) throw new Error('Not signed in to ChatGPT. Sign in under Settings → AI & Models.');
    if (pending) {
        if (creds !== pending) unsaved.delete(row.id);
        else { try { saveCredentials(row.id, creds); unsaved.delete(row.id); } catch { /* still kept in memory */ } }
    }
    if (!creds.scopes?.includes(PLAN_SCOPE)) throw new Error('This ChatGPT sign-in did not allow plan usage. Sign in again and allow it.');
    if (creds.access_token && creds.expires_at - Date.now() > REFRESH_MARGIN_MS) return creds.access_token;
    if (!creds.refresh_token) throw new Error('The ChatGPT sign-in has ended. Sign in again under Settings → AI & Models.');
    if (refreshing.has(row.id)) return refreshing.get(row.id);
    const run = (async () => {
        try {
            const tokens = await tokenRequest({
                grant_type: 'refresh_token', client_id: creds.client_id, refresh_token: creds.refresh_token, resource: API_RESOURCE,
            });
            const scopes = String(tokens.scope || '').split(/\s+/).filter(Boolean);
            const next = credentialRecord({ claims: null, tokens, scopes, clientId: creds.client_id }, creds);
            try {
                saveCredentials(row.id, next);
            } catch (saveErr) {
                unsaved.set(row.id, next);
                console.error(`[chatgpt] The renewed sign-in could not be saved (${saveErr?.code || saveErr?.message}); it is kept for this run and saved as soon as it can be.`);
            }
            return next.access_token;
        } catch (err) {
            if (UNUSABLE_REFRESH.has(err?.code)) {
                // Signed out on OpenAI's side: stop using the tokens, keep the
                // account and client id for the next sign-in.
                const kept = { ...creds, access_token: '', refresh_token: '', expires_at: 0 };
                saveCredentials(row.id, kept);
                throw new Error('The ChatGPT sign-in has ended. Sign in again under Settings → AI & Models.');
            }
            throw err;
        } finally { refreshing.delete(row.id); }
    })();
    refreshing.set(row.id, run);
    return run;
}

/** End the renewable session on OpenAI's side. true = confirmed, false = not. */
export async function signOut(row) {
    let creds = {};
    try { creds = JSON.parse(row?.credentials || '{}'); } catch { creds = {}; }
    if (!creds.refresh_token) return true;
    try {
        const { doc } = await openidConfig();
        if (!doc.revocation_endpoint || !trustedAuthUrl(doc.revocation_endpoint)) return false;
        const res = await safeFetch(doc.revocation_endpoint, {
            allowRedirect: trustedAuthUrl,
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token: creds.refresh_token, token_type_hint: 'refresh_token', client_id: creds.client_id }).toString(),
            signal: AbortSignal.timeout(10000),
        });
        return res.ok;
    } catch { return false; }
}
