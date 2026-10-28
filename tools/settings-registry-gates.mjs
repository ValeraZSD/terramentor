#!/usr/bin/env node
// tools/settings-registry-gates.mjs — every settings row is decided on once,
// and the generic writer takes only what that decision allows.
//
// Run:  node tools/settings-registry-gates.mjs
//
// `PUT /api/settings/:key` used to store any key a short list did not refuse,
// so a row the server added later was client-writable until someone noticed:
// the update check's answer (what the desktop updater acts on), the fitted
// scheduler parameters, the desktop switches that have their own guarded
// routes, and the addresses the app sends prompts and documents to.
// server/settingsSchema.js is now the one table, and this suite holds both
// sides of the app to it:
//
//   1. every row the SERVER names (found statically, tools/lib/settingKeysInSource.mjs)
//      is in the table or is a credential `isSecretSettingKey` owns — so a new
//      row cannot be forgotten into being writable; the extractor itself must
//      still find a fixed list, or it fails rather than passing on nothing;
//   2. the CLIENT's list (src/settingKeys.ts, which types `api.setSetting`) is
//      the table's `client` rows, and every literal key a screen writes is on it;
//   3. the assistant's `[[set]]` keys are all `ui` rows (it may change how the
//      app looks and nothing else);
//   4. each validator takes what the screens really send and refuses the rest;
//   5. the real route, on a scratch library: unknown → 400, the app's own rows
//      → 403, a malformed value → 400, and none of them is stored.
//
// The phone half (a device in without the password may not move the
// addresses) is in device-access-gates.mjs beside the other "only on the
// computer" cases.

import { mkdtempSync, readFileSync, rmSync, globSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { settingKeysInServer } from './lib/settingKeysInSource.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(join(tmpdir(), 'settings-registry-gates-'));
process.env.DB_PATH = join(scratch, 'test.db');
process.env.VAULT_ROOT = join(scratch, 'vault');
process.env.PORT = String(await new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
}));
process.env.HOST = '127.0.0.1';
delete process.env.AI_API_KEY; delete process.env.OPENAI_API_KEY; delete process.env.AI_BASE_URL;

const B = new URL('../server/', import.meta.url).href;
const { default: db } = await import(B + 'database.js');
const { SETTINGS, SETTING_FAMILIES, CLIENT_SETTING_KEYS, settingSpec } = await import(B + 'settingsSchema.js');
const { isSecretSettingKey } = await import(B + 'auth.js');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

console.log('\n--- 1. every row the server names is in the table ---');
const named = settingKeysInServer(ROOT);
// Rows the server reads in every shape the extractor knows, as of this suite.
// If a refactor makes the extractor blind to one of them, this fails first.
const MUST_FIND = ['theme', 'ui_scale', 'user_profile', 'ai_provider', 'ai_openai_base_url', 'ai_ollama_url',
    'searxng_url', 'visual_tier', 'mastery_gate_mode', 'decay_days', 'feed_focus_total', 'app_icon_style',
    'activity_log_enabled', 'inbox_project_id', 'first_lesson_read_at', 'desktop_keep_running',
    'embedding_provider', 'update_latest', 'bkt_params', 'fsrs_params_meta', 'pdf_recovery_vision_model',
    'atlas_naming_model', 'deck_new_per_day_*', 'teach_topics_*', 'auth_tailscale_trust',
    // named by a constant inside a statement, and by a statement kept in a variable
    'openai_address_migration_done', 'study_time_since',
    // read only through getAISettings' `s.key === '…'` loop
    'ai_reasoning_effort', 'ai_provider_sort', 'ai_provider_order'];
const blind = MUST_FIND.filter(k => !named.has(k));
check(`the extractor still finds the ${MUST_FIND.length} rows it is checked against (${named.size} named in all)`, blind.length === 0, blind.join(', '));
const unknown = [];
for (const [key, files] of named) {
    if (key.endsWith('*')) {
        const prefix = key.slice(0, -1);
        if (!SETTING_FAMILIES.some(f => f.prefix === prefix)) unknown.push(`${key} (${files.join(', ')})`);
    } else if (!settingSpec(key) && !isSecretSettingKey(key)) unknown.push(`${key} (${files.join(', ')})`);
}
check('every row the server names is in server/settingsSchema.js (or is a credential)', unknown.length === 0,
    `add an entry, decide who writes it: ${unknown.join('; ')}`);
const overlap = Object.keys(SETTINGS).filter(k => isSecretSettingKey(k));
check('no credential is listed as an ordinary setting', overlap.length === 0, overlap.join(', '));
const shapeless = Object.entries(SETTINGS).filter(([, s]) => !['client', 'server'].includes(s.writable)
    || !['ui', 'learning', 'ai', 'network', 'desktop', 'internal'].includes(s.sensitivity)
    || (s.writable === 'client') !== (typeof s.validate === 'function'));
check('every entry says who writes it and what it touches; exactly the client rows validate', shapeless.length === 0, shapeless.map(([k]) => k).join(', '));
const serverOnly = ['update_latest', 'update_last_check', 'update_last_error', 'update_answer_channel', 'update_channel',
    'update_check', 'update_check_asked', 'bkt_params', 'bkt_params_meta', 'fsrs_params', 'fsrs_params_meta',
    'desktop_keep_running', 'desktop_window_mode', 'desktop_autostart_window',
    'embedding_provider', 'embedding_model', 'embedding_enabled', 'embedding_dim', 'embedding_space',
    'inbox_project_id', 'node_roles_backfilled', 'first_lesson_read_at', 'onboarding_dismissed'];
const leaked = serverOnly.filter(k => settingSpec(k)?.writable !== 'server');
check('the update answer, the fitted parameters, the desktop switches and the embedding rows are the server\'s', leaked.length === 0, leaked.join(', '));
const networkRows = ['ai_provider', 'ai_openai_base_url', 'ai_ollama_url', 'searxng_url'];
check('the addresses and the provider are network rows', networkRows.every(k => SETTINGS[k]?.sensitivity === 'network'));

console.log('\n--- 2. the client writes only client rows ---');
const clientSrc = read('src/settingKeys.ts');
const listBody = clientSrc.slice(clientSrc.indexOf('CLIENT_SETTING_KEYS = ['), clientSrc.indexOf('] as const'));
const clientList = [...listBody.matchAll(/'([A-Za-z0-9_]+)'/g)].map(m => m[1]);
const expected = CLIENT_SETTING_KEYS.filter(k => !SETTINGS[k].apiOnly);
const missingInClient = expected.filter(k => !clientList.includes(k));
const extraInClient = clientList.filter(k => !expected.includes(k));
check(`src/settingKeys.ts lists exactly the server's client rows (${expected.length})`, !missingInClient.length && !extraInClient.length,
    `missing ${missingInClient.join(', ') || '—'}; not client-writable ${extraInClient.join(', ') || '—'}`);
check('api.setSetting is typed with that list', /setSetting: \(key: ClientSettingKey,/.test(read('src/api.ts')));
// The literal keys screens pass, by the three ways they write. tsc refuses a
// key off the list already; this names the file when it does not run.
const writes = new Map();
for (const file of globSync('src/**/*.{ts,tsx}', { cwd: ROOT })) {
    const src = readFileSync(join(ROOT, file), 'utf8');
    for (const m of src.matchAll(/\b(?:setSetting|writeSetting|saveSetting\(get,)\s*\(?\s*'([A-Za-z0-9_]+)'/g)) writes.set(m[1], file.replace(/\\/g, '/'));
}
const offList = [...writes].filter(([k]) => !clientList.includes(k)).map(([k, f]) => `${k} (${f})`);
check(`every literal key a screen writes (${writes.size}) is a client row`, writes.size >= 30 && offList.length === 0, offList.join(', ') || `only ${writes.size} found`);

console.log('\n--- 3. the assistant changes how the app looks, nothing else ---');
const assistantSrc = read('src/utils/assistantSettings.ts');
const assistantKeys = [...(/export type SettingKey = ([^;]+);/.exec(assistantSrc)?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map(m => m[1]);
const notUi = assistantKeys.filter(k => SETTINGS[k]?.writable !== 'client' || SETTINGS[k]?.sensitivity !== 'ui');
check(`the assistant's [[set]] keys (${assistantKeys.length}) are all client ui rows`, assistantKeys.length >= 5 && notUi.length === 0, notUi.join(', '));

console.log('\n--- 4. each validator takes what the screens send and refuses the rest ---');
const takes = (key, value, stored = String(value)) => {
    let got;
    try { got = SETTINGS[key].validate(value); } catch (e) { got = `refused: ${e.message}`; }
    check(`${key} takes ${JSON.stringify(value)}`, got === stored, got);
};
const refuses = (key, value) => {
    let got;
    try { got = SETTINGS[key].validate(value); } catch { got = null; }
    check(`${key} refuses ${JSON.stringify(value)}`, got === null, `stored ${JSON.stringify(got)}`);
};
takes('theme', 'dark'); refuses('theme', 'purple');
takes('theme_tint', '#1e293b'); refuses('theme_tint', 'red; background: url(x)');
takes('theme_surfaces', JSON.stringify({ mode: 'dark', tint: '#000000', background: '#0f172a', theme: '#0f172a' }));
refuses('theme_surfaces', '[1,2]'); refuses('theme_surfaces', '{nope');
takes('app_icon_style', 'simple'); takes('app_icon_radius', '23'); refuses('app_icon_radius', '51');
takes('ui_scale', 120, '120'); refuses('ui_scale', '999'); refuses('ui_scale', '1e2');
takes('ui_language', 'pt-BR'); takes('ui_language', ''); refuses('ui_language', '../../etc');
takes('number_format', '1\u00a0234,5'); takes('number_format', 'auto');
takes('week_start_day', '1'); takes('week_start_day', '0'); refuses('week_start_day', '7');
refuses('accent_color', '#abc');
takes('sidebarWidth', '320'); refuses('sidebarWidth', '100'); takes('detailPanelWidth', '600'); refuses('detailPanelWidth', '4000');
takes('atlas_viewer', JSON.stringify({ speed: 1, dwell: 2 })); refuses('atlas_viewer', 'null');
takes('library_notice_dismissed', 'C:\\Users\\me\\Terramentor'); takes('library_notice_dismissed', '');
takes('user_profile', 'I teach physics.\nI read Dutch slowly.'); refuses('user_profile', 'x'.repeat(20001)); refuses('user_profile', 'a\u0000b');
takes('user_profile', 'Pasted from Word\u000bnext line', 'Pasted from Word\nnext line');
takes('mastery_threshold', '0.85'); refuses('mastery_threshold', '1.5'); refuses('mastery_threshold', '');
takes('mastery_check_size', '10'); takes('decay_days', '14'); takes('feed_due_per_day', '60'); refuses('feed_max_parts', '6');
takes('feed_practice', 'true'); takes('feed_practice', false, 'false'); refuses('feed_practice', 'yes');
takes('visual_kinds_off', 'p5,widget,vega-lite'); takes('visual_kinds_off', ''); refuses('visual_kinds_off', '<svg>');
takes('visual_tier', 'auto'); takes('pdf_recovery_vision', 'never');
takes('ai_model', 'qwen3:8b'); takes('ai_openai_model', 'anthropic/claude-sonnet-4.5'); takes('ai_openai_model', '');
takes('ai_provider_sort', ''); takes('ai_provider_order', '["groq","together"]'); refuses('ai_provider_order', '{"a":1}');
takes('ai_web_search', 'on'); refuses('ai_web_search', 'true');
takes('ai_provider', 'openai'); refuses('ai_provider', 'anthropic');
takes('ai_openai_base_url', 'https://openrouter.ai/api/v1'); takes('ai_openai_base_url', 'http://127.0.0.1:8080/v1');
takes('ai_openai_base_url', '  http://localhost:1234/v1 ', 'http://localhost:1234/v1');
refuses('ai_openai_base_url', 'file:///etc/passwd'); refuses('ai_openai_base_url', 'javascript:alert(1)');
refuses('ai_openai_base_url', 'https://user:pass@example.com/v1'); refuses('ai_openai_base_url', 'localhost:11434');
refuses('ai_openai_base_url', '');
takes('ai_ollama_url', 'http://127.0.0.1:11434');
takes('searxng_url', ''); takes('searxng_url', 'https://searx.example.org'); refuses('searxng_url', 'ftp://searx.example.org');
refuses('theme', { toString: () => 'dark' }); refuses('theme', null); refuses('theme', undefined); refuses('theme', ['dark']);

console.log('\n--- 5. the real route ---');
const { serverReady } = await import(B + 'index.js');
const ready = await serverReady;
const { request } = await import(ready.proto === 'https' ? 'node:https' : 'node:http');
const put = (key, body) => new Promise((resolve, reject) => {
    const req = request({
        host: '127.0.0.1', port: ready.port, path: `/api/settings/${encodeURIComponent(key)}`, method: 'PUT',
        headers: { 'Content-Type': 'application/json' }, rejectUnauthorized: false, timeout: 10_000,
    }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { text += c; });
        res.on('end', () => { let b = null; try { b = JSON.parse(text); } catch { /* not JSON */ } resolve({ status: res.statusCode, body: b }); });
    });
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
});
const stored = (key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value;
// The writer must be serving THIS library before anything is written through it.
db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('ai_setup_dismissed', 'fixture')`).run();
let r = await put('ai_setup_dismissed', { value: 'true' });
check('the route writes into the scratch library', r.status === 200 && stored('ai_setup_dismissed') === 'true', `${r.status} ${stored('ai_setup_dismissed')}`);
if (stored('ai_setup_dismissed') !== 'true') { console.log('not the fixture — stopping'); process.exit(1); }

r = await put('no_such_setting', { value: 'x' });
check('an unknown key is refused with 400 and not stored', r.status === 400 && stored('no_such_setting') === undefined, `${r.status} ${stored('no_such_setting')}`);
r = await put('__proto__', { value: 'x' });
check('…including one named like an object\'s own property', r.status === 400, r.status);
for (const key of ['update_latest', 'desktop_keep_running', 'embedding_provider', 'inbox_project_id', 'deck_new_per_day_1', 'teach_topics_1']) {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, 'server-written');
    r = await put(key, { value: 'client-written' });
    check(`${key} is the app's own: 403, row untouched`, r.status === 403 && stored(key) === 'server-written', `${r.status} ${stored(key)}`);
}
r = await put('auth_password_hash', { value: 'x' });
check('a credential is still refused by its own check', r.status === 403 && stored('auth_password_hash') === undefined, r.status);
r = await put('theme', { value: 'dark' });
check('a preference saves', r.status === 200 && stored('theme') === 'dark');
r = await put('theme', { value: 'purple' });
check('a malformed one is refused with 400 and a reason, and the old value stays', r.status === 400 && typeof r.body?.error === 'string' && stored('theme') === 'dark', `${r.status} ${JSON.stringify(r.body)} ${stored('theme')}`);
r = await put('theme', {});
check('a body with no value is refused, not stored as NULL', r.status === 400 && stored('theme') === 'dark', `${r.status} ${stored('theme')}`);
r = await put('ui_scale', { value: 120 });
check('a number is stored as the text every reader expects', r.status === 200 && stored('ui_scale') === '120', `${r.status} ${stored('ui_scale')}`);
r = await put('ai_openai_base_url', { value: 'file:///etc/passwd' });
check('an address that is not http(s) is refused', r.status === 400 && stored('ai_openai_base_url') === undefined, `${r.status} ${stored('ai_openai_base_url')}`);
db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('ai_api_format', 'chatgpt')`).run();
r = await put('ai_openai_base_url', { value: 'http://127.0.0.1:9/v1' });
check('this computer moves the address, and a forced protocol ends with it', r.status === 200 && stored('ai_openai_base_url') === 'http://127.0.0.1:9/v1' && stored('ai_api_format') === undefined,
    `${r.status} ${stored('ai_openai_base_url')} ${stored('ai_api_format')}`);

console.log(`\n${pass} passed, ${fail} failed`);
try { db.close(); rmSync(scratch, { recursive: true, force: true }); } catch { /* swept by the OS */ }
process.exit(fail ? 1 : 0);
