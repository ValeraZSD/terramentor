// tools/ai-status-gates.mjs — what the app says about its AI connection.
//
// Run:  node tools/ai-status-gates.mjs
//
// WHY. A new install has no model connected, and its settings rows hold only
// defaults — provider `ollama`, no model. The status rule had no word for
// "nothing connected", so it fell through to those defaults: the assistant's
// header named Ollama and its notice said "No model selected — choose a model
// in Settings", beside a home card asking the learner to connect a model. Two
// outside reviewers on a fresh install read it as broken ("I never chose
// Ollama"). It is worst on a machine that happens to run Ollama, where the
// default address answers.
//
// So this boots the REAL app on a scratch library, with a stub Ollama and a
// stub OpenAI-compatible server on loopback (the default Ollama address
// answering is the case the reviewers hit), reads `/api/ai/status` as the
// browser does, and hands each answer to the client's ONE status rule
// (`src/utils/aiStatus.ts`, bundled with esbuild). Every state is walked: a
// fresh library, AI off, an Ollama connection in use with no model yet, a
// working connection, an unreachable one, and the last connection removed.
// Then a source scan: no surface decides the state for itself.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scratch = mkdtempSync(join(tmpdir(), 'ai-status-gates-'));
process.env.DB_PATH = join(scratch, 'scratch.db');
process.env.VAULT_ROOT = join(scratch, 'vault');
// The OpenAI-compatible model list goes through netSafety.js, which refuses
// loopback; the stub IS loopback. Read at module load, so set first.
process.env.ALLOW_PRIVATE_FETCH = '1';
for (const k of ['AI_EXTRA_BODY', 'AI_PROVIDER', 'AI_BASE_URL', 'AI_MODEL', 'AI_API_KEY', 'OPENAI_API_KEY', 'AI_OLLAMA_URL']) delete process.env[k];

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const listen = (srv) => new Promise(ok => srv.listen(0, '127.0.0.1', () => ok(srv.address().port)));

// ── stubs: an Ollama and an OpenAI-compatible server, each with one model ──
const json = (res, body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const ollamaStub = createServer((req, res) => {
    if (req.url.startsWith('/api/tags')) return json(res, { models: [{ name: 'stub:9b', model: 'stub:9b' }] });
    res.writeHead(404); res.end();
});
const openaiStub = createServer((req, res) => {
    if (req.url.startsWith('/v1/models')) return json(res, { object: 'list', data: [{ id: 'stub-model', object: 'model' }] });
    res.writeHead(404); res.end();
});
const OLLAMA = `http://127.0.0.1:${await listen(ollamaStub)}`;
const OPENAI = `http://127.0.0.1:${await listen(openaiStub)}/v1`;
// The default Ollama address, answering: a fresh library on a machine that runs
// Ollama. Env, because the library itself must stay untouched (no rows at all).
process.env.AI_OLLAMA_URL = OLLAMA;

// ── the client's status rule, bundled; i18n replaced by an English echo ────
const stub = join(scratch, 'i18n-stub.js');
writeFileSync(stub, "export default { t: (k, o) => k.replace(/\\{\\{(\\w+)\\}\\}/g, (_, n) => (o && o[n] != null ? String(o[n]) : '')) };\n");
const outfile = join(scratch, 'aiStatus.mjs');
await esbuild.build({
    entryPoints: [join(repoRoot, 'src/utils/aiStatus.ts')],
    bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent',
    plugins: [{ name: 'stub-i18n', setup(build) { build.onResolve({ filter: /(^|\/)i18n$/ }, () => ({ path: stub })); } }],
});
const S = await import(pathToFileURL(outfile).href);

// ── the real app, in-process ───────────────────────────────────────────────
const { default: db } = await import('../server/database.js');
const { createApp } = await import('../server/app.js');
const appServer = createServer(createApp());
const APP_PORT = await listen(appServer);
const api = (path, init = {}) => fetch(`http://127.0.0.1:${APP_PORT}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init.headers || {}) } });
const status = async () => (await api('/api/ai/status')).json();
const put = (key, value) => db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);

/** Everything a surface shows about a status: the badge, the dot, the notice. */
const shown = (s) => {
    const health = S.aiHealth(s);
    const info = S.describeAIUnavailable(s);
    return { badge: S.providerLabel(s), dot: health.level, dotLabel: health.label, tooltip: health.detail, headline: info.headline, detail: info.detail, connect: !!info.connect, usable: S.isAIUsable(s) };
};
const CONNECT_HEADLINE = 'Connect an AI model to start learning';

console.log('\n--- a fresh library, nothing connected ---');
let s = await status();
check('the scratch library has no AI rows at all', db.prepare("SELECT COUNT(*) n FROM settings WHERE key LIKE 'ai\\_%' ESCAPE '\\'").get().n === 0);
check('…and the default Ollama address answers (the reviewers\' machine)', s.available === true, JSON.stringify({ available: s.available, error: s.error }));
let v = shown(s);
check('the server says nothing is connected', s.connected === false, `connected = ${JSON.stringify(s.connected)}`);
check('the notice says to connect a model, not to choose one', v.headline === CONNECT_HEADLINE, `headline = "${v.headline}"`);
check('…and offers the home card\'s way in (Connect OpenRouter / Other ways)', v.connect === true);
check('…in the home card\'s words', /OpenRouter takes one press to connect/.test(v.detail), v.detail);
check('no provider is named anywhere a surface shows', !/ollama/i.test(JSON.stringify(v)), JSON.stringify(v));
check('the badge says it is not connected', v.badge === 'Not connected' && v.dotLabel === 'Not connected', JSON.stringify(v));
check('the dot is a warning (a next step), not an error', v.dot === 'warning');

console.log('\n--- AI switched off ---');
put('ai_enabled', 'false');
v = shown(await status());
check('off outranks not connected: the off message, a grey dot', v.headline === 'AI features are turned off' && v.dot === 'offline', JSON.stringify(v));
check('…and no connect buttons for a decision the learner made', v.connect === false);
put('ai_enabled', 'true');

console.log('\n--- an Ollama connection in use, no model yet ---');
let r = await api('/api/ai/connections', { method: 'POST', body: JSON.stringify({ kind: 'ollama', baseUrl: OLLAMA }) });
const ollamaConn = await r.json();
check('adding it puts it in use', r.ok && ollamaConn.activeId === ollamaConn.id, JSON.stringify(ollamaConn));
s = await status();
v = shown(s);
check('the server says it is connected', s.connected === true);
check('now it IS "choose a model", and it names the server chosen', v.headline === 'No model selected' && v.badge === 'Ollama', JSON.stringify(v));
check('…with no connect buttons', v.connect === false);

console.log('\n--- …with a model, working ---');
put('ai_model', 'stub:9b');
v = shown(await status());
check('usable, green, provider and model', v.usable && v.dot === 'online' && v.badge === 'Ollama' && /stub:9b/.test(v.tooltip), JSON.stringify(v));

console.log('\n--- an OpenAI-compatible connection in use, working ---');
r = await api('/api/ai/connections', { method: 'POST', body: JSON.stringify({ kind: 'custom', baseUrl: OPENAI }) });
const customConn = await r.json();
r = await api(`/api/ai/connections/${customConn.id}/use`, { method: 'POST' });
put('ai_openai_model', 'stub-model');
s = await status();
v = shown(s);
check('usable and green, named by its address', s.provider === 'openai' && v.usable && v.dot === 'online' && v.badge === 'Local', JSON.stringify({ provider: s.provider, ...v }));

console.log('\n--- a connection in use that does not answer ---');
r = await api('/api/ai/connections', { method: 'POST', body: JSON.stringify({ kind: 'custom', baseUrl: 'http://127.0.0.1:9/v1', saveAnyway: true }) });
const deadConn = await r.json();
await api(`/api/ai/connections/${deadConn.id}/use`, { method: 'POST' });
put('ai_openai_model', 'stub-model');
s = await status();
v = shown(s);
check('red, "can\'t reach", the server\'s own reason', s.connected === true && v.dot === 'error' && /^Can.t reach Local$/.test(v.headline) && /Nothing is listening/.test(v.detail), JSON.stringify(v));
check('…and no connect buttons: it is connected, it is down', v.connect === false);

console.log('\n--- every connection removed ---');
for (const c of [deadConn, customConn, ollamaConn]) await api(`/api/ai/connections/${c.id}`, { method: 'DELETE' });
s = await status();
v = shown(s);
check('back to nothing connected, said the same way as a fresh library', s.connected === false && v.headline === CONNECT_HEADLINE && v.connect && !/ollama/i.test(JSON.stringify(v)), JSON.stringify({ connected: s.connected, ...v }));

console.log('\n--- one rule, not one per surface ---');
const SURFACES = ['src/components/AiModelBadge.tsx', 'src/components/AIUnavailableNotice.tsx', 'src/components/feed/AiSetupCard.tsx', 'src/components/AssistantDrawer.tsx'];
for (const f of SURFACES) {
    const text = readFileSync(join(repoRoot, f), 'utf8');
    check(`${f} decides nothing from the provider or the model itself`, !/status\.provider\s*===|neverChosen|!status\.model\b/.test(text));
}
const card = readFileSync(join(repoRoot, 'src/components/feed/AiSetupCard.tsx'), 'utf8');
const notice = readFileSync(join(repoRoot, 'src/components/AIUnavailableNotice.tsx'), 'utf8');
check('the home card and the assistant\'s notice draw the same connect buttons', /<ConnectAIActions\b/.test(card) && /<ConnectAIActions\b/.test(notice));

for (const srv of [ollamaStub, openaiStub, appServer]) srv.close();
db.close();
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* Windows may hold the WAL a moment */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
