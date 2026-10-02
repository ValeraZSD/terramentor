// tools/openai-default-gates.mjs — the OpenAI-compatible provider's default
// address is OpenAI's, and a library that relied on the old one keeps it.
//
// Run:  node tools/openai-default-gates.mjs [--server <dir>]
//
// With no address saved, the OpenAI-compatible provider talked to
// http://127.0.0.1:8888/v1, which is one machine's model server, not a
// convention (llama-swap's own default is :8080). The default is now OpenAI's
// endpoint (DEFAULT_OPENAI_BASE_URL in server/ai.js), and a migration in
// server/database.js writes the old address as the library's own setting when
// the library had used that path without saving one. This boots REAL processes
// against scratch libraries in each shape and asserts:
//
//   * a new library gets the new default and no row;
//   * a library that used the path (provider, model or key saved for it, no
//     address, or an empty one) gets the old address written and keeps talking
//     to it; a key saved before keys were bound to an origin is bound to it;
//   * a library with its own address, or one that never used the path, is not
//     touched;
//   * a second start changes nothing, in any shape;
//   * the migration is ONE-SHOT, for a library that existed before the default
//     changed. A library created by this build and then set up for OpenAI in
//     Settings (provider, model and key saved, the address left on the default
//     and so never written) is in exactly the state the migration looks for; it
//     must keep OpenAI's endpoint, and its key, across restarts. So must a
//     learner who deliberately cleared the address field, on a new library and
//     on an upgraded one: `''` is not re-filled with the old address on every
//     start.
//
// An "old library" here is one seeded without the migration's marker row,
// which is what a library last opened by a build before this change looks like.
//
// `--server <dir>` runs the same assertions against another copy of server/
// (the pre-fix code) to prove they fail there. No model, no network.

import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const si = argv.indexOf('--server');
const SERVER = si >= 0 ? resolve(argv[si + 1]) : fileURLToPath(new URL('../server/', import.meta.url));
const B = pathToFileURL(SERVER + '/').href;

// The row server/database.js writes the first time its migration block runs. A
// library without it was last opened by a build from before the default
// changed (the pre-fix tree never writes it, so deleting it there is a no-op).
const MIGRATION_MARKER = 'openai_address_migration_done';

// ---- child modes: each boot is its own process, env set in-process ---------
if (argv[0] === '--seed' || argv[0] === '--configure' || argv[0] === '--boot') {
    const dir = argv[1];
    process.env.DB_PATH = join(dir, 'lib.db');
    process.env.VAULT_ROOT = join(dir, 'vault');
    process.env.DATA_DIR = dir;
    const { default: db } = await import(B + 'database.js');
    const put = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    if (argv[0] === '--seed') {
        // An OLD library: written AFTER this boot's migrations ran and with the
        // marker taken away, so the next start is the first one under the code
        // being tested, on a library in this shape from before the change.
        const rows = JSON.parse(argv[2]);
        const clear = db.prepare('DELETE FROM settings WHERE key = ?');
        for (const k of ['ai_openai_base_url', 'ai_openai_api_key_origin', MIGRATION_MARKER]) clear.run(k);
        for (const [k, v] of Object.entries(rows)) put.run(k, v);
        console.log(JSON.stringify({ ok: true }));
    } else if (argv[0] === '--configure') {
        // What Settings writes on a library the code being tested created (this
        // boot, if the directory is new) or has already opened: the rows and
        // nothing else, marker untouched.
        for (const [k, v] of Object.entries(JSON.parse(argv[2]))) put.run(k, v);
        console.log(JSON.stringify({ ok: true }));
    } else {
        const { getAISettings } = await import(B + 'ai.js');
        const dump = Object.fromEntries(db.prepare("SELECT key, value FROM settings WHERE key LIKE 'ai_%' ORDER BY key").all().map(r => [r.key, r.value]));
        const ai = getAISettings();
        console.log(JSON.stringify({ dump, baseUrl: ai.baseUrl, keySent: !!ai.apiKey }));
    }
    process.exit(0);
}

const scratch = mkdtempSync(join(tmpdir(), 'openai-default-gates-'));
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
    ok ? pass++ : fail++;
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok || !detail ? '' : `  (${detail})`}`);
};
const clean = { ...process.env };
for (const k of Object.keys(clean)) if (/^(AI_|OPENAI_|DB_PATH$|VAULT_ROOT$|DATA_DIR$)/.test(k)) delete clean[k];
const child = (...args) => {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...args, ...(si >= 0 ? ['--server', SERVER] : [])],
        { env: clean, encoding: 'utf8', timeout: 60_000 });
    const last = String(r.stdout || '').trim().split('\n').pop();
    try { return JSON.parse(last); } catch { return { error: `${r.status}: ${String(r.stderr || r.stdout).slice(-300)}` }; }
};
/** A library in `rows`' shape, then its first start under the code being tested. */
const library = (name, rows) => {
    const dir = join(scratch, name);
    mkdirSync(dir, { recursive: true });
    child('--seed', dir, JSON.stringify(rows));
    return { dir, first: child('--boot', dir) };
};

const LEGACY = 'http://127.0.0.1:8888/v1';
const OPENAI = 'https://api.openai.com/v1';
const OPENROUTER = 'https://openrouter.ai/api/v1';

console.log('--- the default ---');
const fresh = library('fresh', {});
check('a new library with no AI settings saves no address', fresh.first.dump && !('ai_openai_base_url' in fresh.first.dump), JSON.stringify(fresh.first));
check('...and the provider\'s default address is OpenAI\'s endpoint, not a loopback port', fresh.first.baseUrl === OPENAI, fresh.first.baseUrl);

console.log('--- a library that relied on the old default keeps it ---');
const shapes = {
    'provider-and-model': { ai_provider: 'openai', ai_openai_model: 'some-local-model' },
    'provider-only': { ai_provider: 'openai' },
    'empty-address-row': { ai_provider: 'openai', ai_openai_model: 'm', ai_openai_base_url: '' },
    'model-only-provider-ollama': { ai_provider: 'ollama', ai_model: 'qwen3:8b', ai_openai_model: 'some-local-model' },
};
const libs = {};
for (const [name, rows] of Object.entries(shapes)) {
    libs[name] = library(name, rows);
    const { dump, baseUrl } = libs[name].first;
    check(`${name}: the old address is written as the library's own setting`, dump?.ai_openai_base_url === LEGACY, JSON.stringify(dump));
    check(`${name}: ...and it is what the provider talks to`, baseUrl === LEGACY, baseUrl);
}
const keyed = library('key-without-origin', { ai_provider: 'openai', ai_openai_api_key: 'sk-local-test' });
check('a key saved before keys were bound: the old address is written', keyed.first.dump?.ai_openai_base_url === LEGACY, JSON.stringify(keyed.first.dump));
check('...and the key is bound to that address\'s origin, so it is still sent there', keyed.first.dump?.ai_openai_api_key_origin === 'http://127.0.0.1:8888', JSON.stringify(keyed.first.dump));

console.log('--- a library with its own address, or none used, is left alone ---');
const own = library('own-address', { ai_provider: 'openai', ai_openai_model: 'z-ai/glm-5.3-flash', ai_openai_base_url: OPENROUTER });
check('a saved address is untouched', own.first.dump?.ai_openai_base_url === OPENROUTER && own.first.baseUrl === OPENROUTER, JSON.stringify(own.first));
const ollama = library('ollama-only', { ai_provider: 'ollama', ai_model: 'qwen3:8b' });
check('a library that only ever used Ollama gets no address written', ollama.first.dump && !('ai_openai_base_url' in ollama.first.dump), JSON.stringify(ollama.first.dump));

console.log('--- a second start changes nothing ---');
for (const [name, lib] of Object.entries({ fresh, ...libs, 'key-without-origin': keyed, 'own-address': own, 'ollama-only': ollama })) {
    const second = child('--boot', lib.dir);
    check(`${name}: identical settings after a second start`, JSON.stringify(second) === JSON.stringify(lib.first), JSON.stringify([lib.first, second]));
}

// ---- one-shot: a library this build created is never migrated ---------------
console.log('--- a new library set up for OpenAI keeps OpenAI across restarts ---');
/** A library the code being tested creates, then configures as Settings would, then starts `n` times. */
const configured = (name, rows, n = 2) => {
    const dir = join(scratch, name);
    mkdirSync(dir, { recursive: true });
    child('--configure', dir, JSON.stringify(rows));
    return { dir, boots: Array.from({ length: n }, () => child('--boot', dir)) };
};
// Settings before this fix saved the provider, the model and (through
// PUT /api/ai/key) the key with the origin of the address on screen, and not
// the address itself while it still showed the default.
const setUp = configured('new-openai-no-address', {
    ai_provider: 'openai', ai_openai_model: 'gpt-4.1-mini',
    ai_openai_api_key: 'sk-test', ai_openai_api_key_origin: 'https://api.openai.com',
});
setUp.boots.forEach((b, i) => {
    const nth = ['first', 'second'][i];
    check(`${nth} restart: no address is written into it`, b.dump && !('ai_openai_base_url' in b.dump), JSON.stringify(b.dump));
    check(`${nth} restart: it still talks to OpenAI's endpoint`, b.baseUrl === OPENAI, b.baseUrl);
    check(`${nth} restart: and its key, bound to api.openai.com, is still sent`, b.keySent === true && b.dump?.ai_openai_api_key_origin === 'https://api.openai.com', JSON.stringify(b));
});

console.log('--- a cleared address field stays cleared ---');
const clearedNew = configured('new-cleared-address', { ai_provider: 'openai', ai_openai_model: 'm', ai_openai_base_url: '' });
clearedNew.boots.forEach((b, i) => {
    check(`new library, restart ${i + 1}: the empty field is not filled with the old address`, b.dump?.ai_openai_base_url === '' && b.baseUrl === OPENAI, JSON.stringify(b));
});
// An upgraded library whose empty row the migration DID fill (the
// empty-address-row case above), cleared again by the learner afterwards.
const upgraded = libs['empty-address-row'];
child('--configure', upgraded.dir, JSON.stringify({ ai_openai_base_url: '' }));
for (let i = 1; i <= 2; i++) {
    const b = child('--boot', upgraded.dir);
    check(`upgraded library cleared after its migration, restart ${i}: the old address is not written back`, b.dump?.ai_openai_base_url === '' && b.baseUrl === OPENAI, JSON.stringify(b));
}
// ...and an upgraded library that switches to OpenAI only AFTER its upgrade
// never relied on the old default, so it gets the new one.
const lateSwitch = library('ollama-then-openai', { ai_provider: 'ollama', ai_model: 'qwen3:8b' });
child('--configure', lateSwitch.dir, JSON.stringify({ ai_provider: 'openai', ai_openai_model: 'gpt-4.1-mini' }));
const lateBoot = child('--boot', lateSwitch.dir);
check('an upgraded Ollama library switched to OpenAI later gets OpenAI, not the old address', lateBoot.baseUrl === OPENAI && !('ai_openai_base_url' in (lateBoot.dump || {})), JSON.stringify(lateBoot));

console.log(`\n${pass} passed, ${fail} failed`);
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(fail ? 1 : 0);
