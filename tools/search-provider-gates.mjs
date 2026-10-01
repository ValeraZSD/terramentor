// tools/search-provider-gates.mjs — the search-provider security boundary.
//
// Run:  node tools/search-provider-gates.mjs
//
// `validateUrlTemplate` is the only real attack surface in a declarative provider:
// its output goes straight into an `href`. A `javascript:` URL there is script
// execution in the app's own origin, which would defeat the entire point of a
// a feature that "cannot run code". These assertions are cheap and they are the
// difference between that claim being true and being a comment.

import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scratch = mkdtempSync(join(tmpdir(), 'provider-gates-'));
process.env.DB_PATH = join(scratch, 'test.db');
// …and VAULT_ROOT, or the blob store resolves to the learner's real server/vault.
process.env.VAULT_ROOT = join(scratch, 'vault');

const B = new URL('../server/', import.meta.url).href;
const {
    validateManifest, validateUrlTemplate, buildProviderUrl,
    syncBuiltinProviders, listProviders, saveProvider, deleteProvider, setProviderEnabled,
    BUILTIN_PROVIDERS, RETIRED_BUILTIN_IDS, PROVIDER_ICONS,
} = await import(B + 'searchProviders.js');
const db = (await import(B + 'database.js')).default;

let pass = 0, fail = 0;
const check = (name, got, want) => {
    const ok = got === want;
    ok ? pass++ : fail++;
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok ? '' : `  (got ${JSON.stringify(got)})`}`);
};

console.log('\n--- hostile URL templates are rejected ---');
const hostile = [
    ['javascript: scheme (script execution in our own origin)', 'javascript:alert(document.cookie)//{query}'],
    ['javascript: with mixed case + whitespace', ' JaVaScRiPt:alert(1)//{query}'],
    ['data: scheme', 'data:text/html,<script>alert(1)</script>{query}'],
    ['vbscript: scheme', 'vbscript:msgbox(1){query}'],
    ['plaintext http', 'http://example.com/search?q={query}'],
    ['embedded credentials', 'https://evil.example@trusted.com/?q={query}'],
    ['no {query} placeholder', 'https://example.com/search'],
    ['unknown placeholder', 'https://example.com/?q={query}&k={apikey}'],
    ['not a URL at all', 'not a url {query}'],
    ['no real hostname', 'https://localhost/?q={query}'],
    ['empty', ''],
];
for (const [name, tpl] of hostile) check(name, validateUrlTemplate(tpl).ok, false);

console.log('\n--- legitimate templates are accepted ---');
for (const [name, tpl] of [
    ['plain https search', 'https://www.youtube.com/results?search_query={query}'],
    ['fragment-based', 'https://pubchem.ncbi.nlm.nih.gov/#query={query}'],
    ['{lang} in the hostname', 'https://{lang}.wikipedia.org/w/index.php?search={query}'],
    ['multiple params', 'https://example.com/s?q={query}&hl={lang}&safe=on'],
]) check(name, validateUrlTemplate(tpl).ok, true);

console.log('\n--- manifest validation ---');
const base = {
    id: 'test-provider', kind: 'search_provider', label: 'Test',
    icon: 'search', urlTemplate: 'https://example.com/?q={query}', surfaces: ['topic'],
};
check('a good manifest passes', validateManifest(base).ok, true);
check('missing id fails', validateManifest({ ...base, id: '' }).ok, false);
check('uppercase id fails', validateManifest({ ...base, id: 'BadId' }).ok, false);
check('id with a dot fails', validateManifest({ ...base, id: 'a.b' }).ok, false);
check('id starting with a hyphen fails', validateManifest({ ...base, id: '-x' }).ok, false);
check('unknown kind fails', validateManifest({ ...base, kind: 'exec' }).ok, false);
check('unknown icon fails (no arbitrary icon URLs)', validateManifest({ ...base, icon: 'https://evil/x.png' }).ok, false);
check('over-long label fails', validateManifest({ ...base, label: 'x'.repeat(41) }).ok, false);
// `name` is what the Settings card is titled with; `label` is what the link
// says. A card headed "Look up on Wolfram MathWorld" is the row this replaced.
check('a short name is kept', validateManifest({ ...base, name: 'Test' }).manifest.name, 'Test');
check('over-long name fails', validateManifest({ ...base, name: 'x'.repeat(25) }).ok, false);
check('name is optional', validateManifest(base).ok, true);
check('...and absent rather than empty when omitted',
    validateManifest(base).manifest.name === undefined, true);
check('unknown surface is dropped, not honoured',
    JSON.stringify(validateManifest({ ...base, surfaces: ['topic', 'root'] }).manifest.surfaces), '["topic"]');
check('all-unknown surfaces fails', validateManifest({ ...base, surfaces: ['root'] }).ok, false);
check('a non-object fails', validateManifest('hello').ok, false);
check('an array fails', validateManifest([base]).ok, false);
check('extra fields are stripped, not stored',
    Object.hasOwn(validateManifest({ ...base, exec: 'rm -rf /' }).manifest, 'exec'), false);

console.log('\n--- URL building escapes the query ---');
const m = validateManifest(base).manifest;
check('spaces are encoded', buildProviderUrl(m, { query: 'wave optics' }), 'https://example.com/?q=wave%20optics');
check('a query cannot break out of the parameter',
    buildProviderUrl(m, { query: '&admin=1#' }), 'https://example.com/?q=%26admin%3D1%23');
check('quotes are encoded (no href breakout)',
    buildProviderUrl(m, { query: '"><script>' }), 'https://example.com/?q=%22%3E%3Cscript%3E');
const wiki = validateManifest({ ...base, id: 'w', urlTemplate: 'https://{lang}.wikipedia.org/w/index.php?search={query}' }).manifest;
check('{lang} fills', buildProviderUrl(wiki, { query: 'licht', lang: 'nl' }),
    'https://nl.wikipedia.org/w/index.php?search=licht');

console.log('\n--- every shipped built-in is itself valid ---');
for (const { manifest } of BUILTIN_PROVIDERS) {
    check(`built-in "${manifest.id}"`, validateManifest(manifest).ok, true);
    // Settings lists these as cards titled by `name`. A built-in that forgets
    // one falls back to its label and reads as a sentence among six brand
    // names — the exact thing the card layout was built to stop.
    check(`built-in "${manifest.id}" names its destination`, !!manifest.name, true);
}

// The fallback lives on the client, so the gate reads it there: without it a
// user-added provider with no `name` renders a blank card title.
const utilSrc = readFileSync(new URL('../src/utils/searchProviders.ts', import.meta.url), 'utf8');
// The label goes through `providerLabel`, which translates a built-in's English
// and returns a learner's own wording untouched — so the fallback is still the
// label, just the readable one.
check('the client falls back to label when name is absent',
    /provider\.name\?\.trim\(\)\s*\|\|\s*providerLabel\(provider\)/.test(utilSrc), true);

// PROVIDER_ICONS (server) and the ICONS map (ExternalSearchButton.tsx) are two
// mirrors of one list, and they fail in opposite, silent directions: a name only
// the server knows renders a fallback magnifier, a name only the client knows is
// rejected on save. Neither throws.
console.log('\n--- the icon allowlist matches what the client bundles ---');
const buttonSrc = readFileSync(new URL('../src/components/ExternalSearchButton.tsx', import.meta.url), 'utf8');
const clientIcons = new Set(
    [...buttonSrc.matchAll(/^\s+'?([a-z-]+)'?:\s*[A-Z]\w+,/gm)].map(m => m[1]),
);
for (const name of PROVIDER_ICONS) check(`client renders "${name}"`, clientIcons.has(name), true);

// Validity is not usefulness: `https://arxiv.org/abs/?searchtype=all&query={query}`
// passed every check above and had never worked once, because /abs/ resolves an
// article IDENTIFIER and answers "Invalid article identifier" for free text. A
// manifest can only be checked mechanically for *shape*, so the one thing worth
// pinning per provider is that {query} lands on that site's SEARCH endpoint.
console.log('\n--- built-in endpoints are search endpoints (not by-id lookups) ---');
const byId = Object.fromEntries(BUILTIN_PROVIDERS.map(b => [b.manifest.id, b.manifest.urlTemplate]));
check('arxiv uses /search/, never /abs/',
    byId.arxiv === 'https://arxiv.org/search/?searchtype=all&query={query}', true);
check('no built-in points at arXiv /abs/',
    Object.values(byId).some(t => t.includes('arxiv.org/abs')), false);
// Wolfram|Alpha needs a computable question, and a topic title is not one — the
// slot is MathWorld, which takes a term. See RETIRED_BUILTIN_IDS.
check('the Wolfram slot is MathWorld, not Wolfram|Alpha input',
    byId.mathworld === 'https://mathworld.wolfram.com/search/?query={query}', true);
check('wolframalpha is no longer shipped', 'wolframalpha' in byId, false);
check('...and is listed as retired', RETIRED_BUILTIN_IDS.includes('wolframalpha'), true);
check('nothing is both shipped and retired',
    RETIRED_BUILTIN_IDS.some(id => id in byId), false);

console.log('\n--- storage lifecycle ---');
syncBuiltinProviders();
const all = listProviders();
check('built-ins are seeded', all.length >= BUILTIN_PROVIDERS.length, true);
check('youtube is on by default (unchanged behaviour)', listProviders({ enabledOnly: true }).some(a => a.id === 'youtube'), true);
check('google is off by default', all.find(a => a.id === 'google').enabled, false);

check('a user provider saves', saveProvider(base).ok, true);
check('it is enabled on save', listProviders().find(a => a.id === 'test-provider').enabled, true);
check('it can be disabled', setProviderEnabled('test-provider', false) && !listProviders().find(a => a.id === 'test-provider').enabled, true);
check('a built-in id cannot be shadowed', saveProvider({ ...base, id: 'youtube' }).ok, false);
check('a built-in cannot be removed', deleteProvider('youtube').ok, false);
check('a user provider can be removed', deleteProvider('test-provider').ok, true);
check('and is gone', listProviders().some(a => a.id === 'test-provider'), false);

// A user's choice must survive an app upgrade that re-syncs manifests.
setProviderEnabled('youtube', false);
syncBuiltinProviders();
check('re-sync preserves a disabled built-in', listProviders().find(a => a.id === 'youtube').enabled, false);

// A withdrawn built-in must actually leave an existing install. Built-ins refuse
// deleteProvider, so without this the learner is stuck with a link we know is
// broken. Simulated by writing the old row back exactly as an upgrade would find
// it, then re-syncing.
db.prepare(`INSERT INTO search_providers (id, kind, manifest, enabled, builtin) VALUES (?, ?, ?, 1, 1)
            ON CONFLICT(id) DO UPDATE SET enabled = 1`).run(
    'wolframalpha', 'search_provider',
    JSON.stringify({
        id: 'wolframalpha', kind: 'search_provider', label: 'Compute on WolframAlpha',
        icon: 'microscope', urlTemplate: 'https://www.wolframalpha.com/input?i={query}',
        surfaces: ['topic'],
    }),
);
check('a stale retired built-in is present before sync', listProviders().some(a => a.id === 'wolframalpha'), true);
syncBuiltinProviders();
check('re-sync deletes a retired built-in', listProviders().some(a => a.id === 'wolframalpha'), false);
check('and leaves the live built-ins alone', listProviders().some(a => a.id === 'arxiv'), true);
setProviderEnabled('youtube', true);
syncBuiltinProviders();
check('re-sync preserves an enabled built-in', listProviders().find(a => a.id === 'youtube').enabled, true);

// ---------------------------------------------------------------------------
// The 0.69 rename, against a database shaped the way an older build left it.
//
// This is a one-way door on somebody's real library, and it fails in a way that
// is easy to miss: `CREATE TABLE IF NOT EXISTS search_providers` in the schema
// block would happily make an empty table, the rename would then be skipped
// forever, and the learner's own providers plus every enabled/disabled choice
// would sit in an `addons` table nothing reads any more. Screen looks fine; the
// data is stranded. So the order is asserted rather than trusted, in a child
// process because database.js migrates at import time and this one has already
// been imported above.
console.log('\n--- migrating a pre-0.69 database ---');
{
    const old = join(scratch, 'pre069.db');
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import Database from 'better-sqlite3';
        process.env.DB_PATH = ${JSON.stringify(old)};
        process.env.VAULT_ROOT = ${JSON.stringify(join(scratch, 'vault'))};
        const seed = new Database(process.env.DB_PATH);
        seed.exec("CREATE TABLE addons (id TEXT PRIMARY KEY, kind TEXT NOT NULL, manifest TEXT NOT NULL, enabled INTEGER DEFAULT 0, builtin INTEGER DEFAULT 0, installed_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
        const ins = seed.prepare('INSERT INTO addons VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)');
        ins.run('pubchem', 'search_provider', JSON.stringify({ id: 'pubchem', kind: 'search_provider', label: 'Find on PubChem', icon: 'microscope', urlTemplate: 'https://pubchem.ncbi.nlm.nih.gov/#query={query}', surfaces: ['topic'] }), 1, 0);
        ins.run('youtube', 'search_provider', JSON.stringify({ id: 'youtube', kind: 'search_provider', label: 'Watch on YouTube', icon: 'youtube', urlTemplate: 'https://www.youtube.com/results?search_query={query}', surfaces: ['topic', 'missed_answer'] }), 0, 1);
        seed.close();

        const db = (await import(${JSON.stringify(B + 'database.js')})).default;
        const m = await import(${JSON.stringify(B + 'searchProviders.js')});
        m.syncBuiltinProviders();
        const all = m.listProviders();
        console.log('@@' + JSON.stringify({
            tables: db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('addons','search_providers')").all().map(r => r.name),
            columns: db.prepare('PRAGMA table_info(search_providers)').all().map(c => c.name),
            user: all.find(p => p.id === 'pubchem') || null,
            youtube: all.find(p => p.id === 'youtube') || null,
        }));
    `], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' });

    const line = (child.stdout || '').split('\n').find(l => l.startsWith('@@'));
    if (!line) {
        check('the migration child ran', String(child.stderr || child.error || '').trim().slice(-400) || 'no output', '');
    } else {
        const r = JSON.parse(line.slice(2));
        check('the old addons table is gone', r.tables.includes('addons'), false);
        check('search_providers exists', r.tables.includes('search_providers'), true);
        check('installed_at became created_at', r.columns.includes('created_at') && !r.columns.includes('installed_at'), true);
        check('a user provider survives the rename', r.user?.label, 'Find on PubChem');
        check('and keeps its enabled flag', r.user?.enabled, true);
        check('a built-in the learner turned OFF stays off', r.youtube?.enabled, false);
        check('and its manifest is re-synced from the shipped one', r.youtube?.builtin, true);
    }
}

// --- the built-in providers' own words are translatable -----------------------
//
// A provider is data the SERVER writes, so its label and description arrive in
// English and cannot be extracted from the client source. `searchProviders.ts`
// mirrors the six built-in ones as `k()` markers and reads them back through
// `t()`; this is the assertion that keeps the two lists in step, so a seventh
// provider added here fails a gate instead of shipping one English line among
// six translated ones.
console.log('\n--- the built-in providers can be read in any language ---');
{
    const client = readFileSync(new URL('../src/utils/searchProviders.ts', import.meta.url), 'utf8');
    const marked = new Set([...client.matchAll(/\bk\(\s*"((?:[^"\\]|\\.)*)"\s*\)/g)]
        .map((m) => JSON.parse(`"${m[1]}"`)));
    const en = JSON.parse(readFileSync(new URL('../src/locales/en.json', import.meta.url), 'utf8'));
    const words = BUILTIN_PROVIDERS.flatMap(({ manifest }) =>
        [manifest.label, manifest.description].filter(Boolean));
    const unmarked = words.filter((w) => !marked.has(w));
    check('every built-in label and description is a k() marker in searchProviders.ts',
        unmarked.join(' | '), '');
    const unlisted = words.filter((w) => !(w in en));
    check('and every one of them is a key in en.json', unlisted.join(' | '), '');
}
try { db.close(); } catch { }
try { rmSync(scratch, { recursive: true, force: true }); } catch { }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
