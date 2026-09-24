// tools/search-backend-gates.mjs — the hosted search backends.
//
// Run:  node tools/search-backend-gates.mjs
//
// Three keyed engines (Tavily, Brave, Jina) join the webSearch fan-out when
// their key is saved. The claims that have to hold: a parser never invents a
// source from a shape it does not recognise; an unconfigured backend is a
// settled zero while a REFUSED one is an error ("the search failed", never
// "no results"); the keys are credentials (write-only, out of the settings
// dump, sent to their own service alone); a hosted result that arrived with
// its text does not cost a page fetch; and SECURITY.md names every host the
// feature can reach. All deterministic — the parsers run against recorded
// response shapes, no network, no model.

import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scratch = mkdtempSync(join(tmpdir(), 'search-backend-gates-'));
process.env.DB_PATH = join(scratch, 'test.db');
// …and VAULT_ROOT, or the blob store resolves to the learner's real server/vault.
process.env.VAULT_ROOT = join(scratch, 'vault');

const B = new URL('../server/', import.meta.url).href;
const {
    SEARCH_BACKENDS, SECRET_SEARCH_KEYS, searchKeysStatus, setSearchBackendKey,
    tavilyParse, braveParse, jinaParse,
} = await import(B + 'searchBackends.js');
const { isSecretSettingKey } = await import(B + 'auth.js');
const db = (await import(B + 'database.js')).default;

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = p => readFileSync(join(ROOT, p), 'utf8');
const indexSrc = read('server/index.js');
const authSrc = read('server/auth.js');
const aiSrc = read('server/ai.js');
const webCtxSrc = read('server/webContext.js');
const secMd = read('SECURITY.md');

let pass = 0, fail = 0;
const check = (name, got, want) => {
    const ok = got === want;
    ok ? pass++ : fail++;
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok ? '' : `  (got ${JSON.stringify(got)})`}`);
};
const ok = (name, cond) => check(name, !!cond, true);

console.log('\n--- the parsers read the real response shapes ---');
// Tavily: results[] with query-relevant content chunks.
const tav = tavilyParse({
    results: [
        { title: 'Speed limits in the Netherlands', url: 'https://example.com/nl-speed', score: 0.9, content: 'The maximum speed on Dutch motorways is 130 km/h where signed, 100 km/h by day since 2020. The day rule applies between 6:00 and 19:00 on the A2 and other wide carriageways, and the fine for exceeding it is graduated by how far over you were going.' },
        { title: 'No content here', url: 'https://example.com/thin', content: 'short' },
        { url: 'https://example.com/notitle', content: 'A page with no title field still gets its URL as the title, and a healthy chunk still counts as text-ready reading for the turn. It needs enough length to be worth more than the sentence a snippet is, which is the threshold the parser applies.' },
        { title: 'No url is dropped', content: 'orphan chunk' },
    ],
});
check('tavily: results mapped', tav.length, 3);
check('tavily: content becomes snippet', tav[0].snippet.includes('130 km/h'), true);
ok('tavily: a healthy chunk arrives text-ready', typeof tav[0].text === 'string' && tav[0].text.includes('motorway'));
ok('tavily: a thin chunk does not claim text', tav[1].text === undefined);
ok('tavily: titleless result falls back to its url', tav[2].title === 'https://example.com/notitle');

// Brave: web.results[] with description snippets only — never claims text.
const brv = braveParse({
    web: {
        results: [
            { title: 'Brave hit', url: 'https://example.com/brave', description: 'A snippet only.' },
            { title: 'No description', url: 'https://example.com/brave2' },
        ],
    },
});
check('brave: results mapped', brv.length, 2);
check('brave: description becomes snippet', brv[0].snippet, 'A snippet only.');
ok('brave: links+snippets engine never claims page text', brv.every(r => r.text === undefined));

// Jina: data[] with full extracted page text, capped to a reading-sized slice.
const jina = jinaParse({
    data: [
        { title: 'Jina hit', url: 'https://example.com/jina', content: 'x'.repeat(5000) },
        { title: 'Thin', url: 'https://example.com/jina2', content: 'tiny' },
    ],
});
check('jina: results mapped', jina.length, 2);
ok('jina: page text capped', jina[0].text.length <= 1500 && jina[0].text.length >= 200);
ok('jina: thin content not text-ready', jina[1].text === undefined);

console.log('\n--- the parsers survive junk without inventing sources ---');
for (const [name, fn] of [['tavily', tavilyParse], ['brave', braveParse], ['jina', jinaParse]]) {
    check(`${name}: null payload -> []`, fn(null).length, 0);
    check(`${name}: {} -> []`, fn({}).length, 0);
    check(`${name}: strings not shapes -> []`, fn({ results: 'florid', data: 'florid', web: 'florid' }).length, 0);
    check(`${name}: numbers not objects -> []`, fn({ results: 42, data: 42, web: { results: 42 } }).length, 0);
}

console.log('\n--- keys are credentials: write-only, out of the dump ---');
check('three backends registered', Object.keys(SEARCH_BACKENDS).length, 3);
for (const [name, setting] of [['tavily', 'search_tavily_key'], ['brave', 'search_brave_key'], ['jina', 'search_jina_key']]) {
    check(`${name} key row named`, SEARCH_BACKENDS[name].setting, setting);
    ok(`${setting} is a secret setting`, SECRET_SEARCH_KEYS.includes(setting) && isSecretSettingKey(setting));
}
ok('auth.js imports the registry (single source of names)', /import \{ SECRET_SEARCH_KEYS \} from '\.\/searchBackends\.js'/.test(authSrc));
ok('isSecretSettingKey covers the search keys', /SECRET_SEARCH_KEYS\.includes\(key\)/.test(authSrc));

setSearchBackendKey('tavily', 'tvly-secret-value');
setSearchBackendKey('brave', '');
setSearchBackendKey('jina', 'jina_xxx');
check('status answers booleans only', Object.values(searchKeysStatus()).every(v => typeof v === 'boolean'), true);
check('tavily saved', searchKeysStatus().tavily, true);
check('brave empty means cleared', searchKeysStatus().brave, false);
check('jina saved', searchKeysStatus().jina, true);
check('an empty string clears, not stores', setSearchBackendKey('brave', ''), false);
check('cleared key is gone from the db', db.prepare('SELECT value FROM settings WHERE key = ?').get('search_brave_key'), undefined);
let unknownThrew = false;
try { setSearchBackendKey('kagi', 'x'); } catch { unknownThrew = true; }
ok('an unregistered backend refuses to store', unknownThrew);
const dumpRow = db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'search_%' AND value IS NOT NULL").get();
check('the stored key sits in its own row (the dump strips it by name)', dumpRow.n, 2);

console.log('\n--- the routes follow the /api/ai/key pattern ---');
ok('GET /api/search/keys exists', indexSrc.includes("app.get('/api/search/keys'"));
ok('PUT /api/search/keys/:provider exists', indexSrc.includes("app.put('/api/search/keys/:provider'"));
ok('DELETE /api/search/keys/:provider exists', indexSrc.includes("app.delete('/api/search/keys/:provider'"));
ok('an unknown provider is a 400, not a stored row', /SEARCH_BACKENDS\[req\.params\.provider\]/.test(indexSrc));
ok('the status route answers searchKeysStatus() (booleans only)', indexSrc.includes('res.json(searchKeysStatus())'));
ok('the generic settings dump still strips secrets via isSecretSettingKey', indexSrc.includes('!isSecretSettingKey(s.key)'));
ok('the generic settings writer still refuses secret keys', /isSecretSettingKey\(req\.params\.key\)/.test(indexSrc));

console.log('\n--- the fan-out reaches a hosted engine only with its key ---');
const aiSearchRegion = aiSrc.slice(aiSrc.indexOf('export async function webSearch'));
ok('tavily is a source', aiSearchRegion.includes('tavilySearch(query, maxResults)'));
ok('brave is a source', aiSearchRegion.includes('braveSearch(query, maxResults)'));
ok('jina is a source', aiSearchRegion.includes('jinaSearch(query, maxResults)'));
ok('hosted engines run BEFORE the built-in general search', aiSearchRegion.indexOf('tavilySearch') < aiSearchRegion.indexOf('ddgSearch'));
for (const name of ['tavily', 'brave', 'jina']) {
    ok(`${name}: unconfigured is a settled []`, new RegExp(`export async function ${name}Search[\\s\\S]*?if \\(!key\\) return \\[\\];`).test(read('server/searchBackends.js')));
}
const backendSrc = read('server/searchBackends.js');
check('all three fetches go through safeFetch', (backendSrc.match(/await safeFetch\(/g) || []).length, 3);
ok('no bare fetch in the backend module', !/\bawait fetch\(/.test(backendSrc));
ok('every backend host is https', backendSrc.includes('https://api.tavily.com/search') && backendSrc.includes('https://api.search.brave.com/res/v1/web/search') && backendSrc.includes('https://s.jina.ai/') && !/['"`]http:\/\//.test(backendSrc));
ok('a refusal throws (the search failed, never no results)', (backendSrc.match(/Declined with \$\{res\.status\}/g) || []).length === 3);

console.log('\n--- a hosted result with text does not cost a page fetch ---');
ok('searchWebSources partitions text-ready results', webCtxSrc.includes('const textReady = new Map()'));
ok('only thin results are fetched', webCtxSrc.includes('toFetch.slice(0, MAX_PAGES)'));
ok('text-ready reading wins over a fetched page', /textReady\.get\(i\)\s*\n\s*\|\|/.test(webCtxSrc) || /textReady\.get\(i\)\s*\|\|/.test(webCtxSrc));

// …and the caps are pinned by VALUE, not by the spelling of the line they
// appear in. `toFetch.slice(0, MAX_PAGES)` reads the same whether MAX_PAGES is
// 2 or 200, so the assertion above says nothing about how much a single answer
// can pull off the network. These three are the whole of that budget: how many
// results are considered, how many of them are fetched in full, and how much of
// each reaches the model. Changing one is a deliberate act that should have to
// come through here — the numbers back a paragraph in SECURITY.md.
const capOf = (name) => Number(new RegExp(`const ${name} = (\\d+);`).exec(webCtxSrc)?.[1]);
ok('MAX_RESULTS is 4 — how many results one query considers', capOf('MAX_RESULTS') === 4, `got ${capOf('MAX_RESULTS')}`);
ok('MAX_PAGES is 2 — how many of them are fetched in full', capOf('MAX_PAGES') === 2, `got ${capOf('MAX_PAGES')}`);
ok('PAGE_CHARS is 1500 — how much of each page reaches the model', capOf('PAGE_CHARS') === 1500, `got ${capOf('PAGE_CHARS')}`);
ok('the page budget is smaller than the result set, so a thin answer costs nothing',
    capOf('MAX_PAGES') < capOf('MAX_RESULTS'));

console.log('\n--- SECURITY.md names what the feature can reach ---');
for (const host of ['api.tavily.com', 'api.search.brave.com', 's.jina.ai']) ok(`${host} named`, secMd.includes(host));
ok('the doc says a host is reached only with its key', secMd.includes('no connection to that host') || secMd.includes('only if its key is saved'));
ok('the doc says the key goes to its own service alone', secMd.includes('sent to its own service and nowhere else'));
ok('the packet-capture walkthrough mentions the hosted engines', /hosted\s+search engine you saved a key for/.test(secMd));

console.log(`\n${pass} passed, ${fail} failed`);
try { db.close(); } catch { /* already closed by a failure path */ }
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* a held WAL handle leaves the temp dir behind — not a gate failure */ }
process.exit(fail ? 1 : 0);
