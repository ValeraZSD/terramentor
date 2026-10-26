// tools/resource-choice-gates.mjs — how a topic's study links are chosen
// (server/agentic.js, the "Resource Discovery Pipeline").
//
// The pipeline used to take the top results of one search per query, show a
// curator only the topic's title, and, when the curator answered "none of
// these", keep the top three raw results anyway. A course on Dutch grammar got
// a newspaper's "Articles" page for its "Articles" topic, three links from one
// site, and a Pinterest board. What is pinned here is the deterministic half:
//
//   * candidates are taken in turn from each query's results, without the same
//     page twice, without feeds and homework farms, and with at most two from
//     one site (rankResourceCandidates);
//   * a curator's EMPTY answer is final, its invented URLs are dropped, and
//     only a curator that did not answer at all is replaced by the top
//     candidates (decideResources);
//   * a section's query plan is used only when it has one row per topic
//     (parseSectionQueries);
//   * the curator is told the course, section, what the topic covers and who
//     reads it, and that [] is a correct answer (AI_PROMPTS.find_resources);
//   * a link from the model's memory survives only if it answered here
//     (verifyResourcesBatch keepUnreachable: false).
//
// Nothing here calls a model or the network.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'resource-choice-gates-'));
// In-process, before any import reaches database.js.
process.env.DB_PATH = join(scratch, 'gate.db');
process.env.VAULT_ROOT = join(scratch, 'vault');

const {
    hostOf, isLowValueHost, rankResourceCandidates, onePerHost, decideResources, parseSectionQueries,
} = await import('../server/agentic.js');
const { AI_PROMPTS, verifyResourcesBatch } = await import('../server/ai.js');

let passed = 0;
let failures = 0;
const check = (label, ok, extra = '') => {
    if (ok) passed++; else failures++;
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${ok || !extra ? '' : ` — ${extra}`}`);
};
const same = (label, actual, expected) => {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    check(label, a === e, `got ${a}, want ${e}`);
};
const r = (url, title = url) => ({ title, url, snippet: '' });

// --- sites --------------------------------------------------------------------
same('host drops www', hostOf('https://www.Example.org/a'), 'example.org');
same('unparseable url has no host', hostOf('not a url'), '');
check('pinterest on a country domain is low value', isLowValueHost('nl.pinterest.de'));
check('brainly on a country domain is low value', isLowValueHost('brainly.in'));
check('a subdomain of a listed site is low value', isLowValueHost('m.facebook.com'));
check('a university is not', !isLowValueHost('ocw.mit.edu'));
check('a name merely CONTAINING a listed label is not', !isLowValueHost('pinterestingfacts.org'));
check('x.com is low value, a site ending in x.com is not', isLowValueHost('x.com') && !isLowValueHost('netflix.com'));

// --- ranking ------------------------------------------------------------------
const q1 = [r('https://a.org/1'), r('https://a.org/2'), r('https://a.org/3'), r('https://b.org/1')];
const q2 = [r('https://c.org/1'), r('https://www.a.org/1/?utm_source=x#top'), r('https://pinterest.com/pin/1'), r('https://d.org/1')];
const ranked = rankResourceCandidates([q1, q2], { max: 10, perHost: 2 }).map(c => c.url);
same('round robin across queries, one site capped at two, the same page once, feeds dropped', ranked,
    ['https://a.org/1', 'https://c.org/1', 'https://a.org/2', 'https://b.org/1', 'https://d.org/1']);
same('max is a ceiling', rankResourceCandidates([q1, q2], { max: 2 }).map(c => c.url), ['https://a.org/1', 'https://c.org/1']);
same('a search-results URL and a non-URL never become candidates',
    rankResourceCandidates([[r('https://www.google.com/search?q=x'), r('ftp://e.org/f'), { title: 'no url' }, r('https://e.org/ok')]]).map(c => c.url),
    ['https://e.org/ok']);
same('no results, no candidates', rankResourceCandidates([[], null]), []);
same('one per host keeps the first of each', onePerHost([r('https://a.org/1'), r('https://www.a.org/2'), r('https://b.org/1')]).map(c => c.url),
    ['https://a.org/1', 'https://b.org/1']);

// --- the curator's answer ---------------------------------------------------------
const candidates = [r('https://a.org/1', 'A one'), r('https://a.org/2', 'A two'), r('https://b.org/1', 'B'), r('https://c.org/1', 'C'), r('https://d.org/1', 'D')];
same('an empty answer is kept empty (the curator found nothing that teaches the topic)', decideResources(candidates, []), []);
same('no answer at all: the top candidates, one per site, at most three',
    decideResources(candidates, null).map(x => x.url), ['https://a.org/1', 'https://b.org/1', 'https://c.org/1']);
const picked = decideResources(candidates, [
    { title: 'Invented', url: 'https://invented.org/x', type: 'article' },
    { title: 'B page', url: 'https://b.org/1', type: 'Documentation' },
    { title: '', url: 'https://a.org/1', type: 'podcast' },
    { title: 'Second from a', url: 'https://a.org/2', type: 'video' },
]);
same('invented URLs dropped, one per site, curator order kept', picked.map(x => x.url), ['https://b.org/1', 'https://a.org/1']);
same('type normalised, unknown type becomes article', picked.map(x => x.type), ['documentation', 'article']);
same('an empty title falls back to the candidate\'s', picked[1].title, 'A one');
same('at most four', decideResources(
    [1, 2, 3, 4, 5, 6].map(i => r(`https://s${i}.org/`)),
    [1, 2, 3, 4, 5, 6].map(i => ({ title: `S${i}`, url: `https://s${i}.org/`, type: 'article' })),
).length, 4);

// --- a section's query plan ------------------------------------------------------
same('one row per topic is used', parseSectionQueries([['a b', ' c '], ['d']], 2), [['a b', 'c'], ['d']]);
same('the { queries } wrapper is accepted', parseSectionQueries({ queries: [['x'], ['y']] }, 2), [['x'], ['y']]);
same('a bare string row becomes one query', parseSectionQueries(['x', ['y']], 2), [['x'], ['y']]);
same('a row too few is refused (topics would get their neighbour\'s queries)', parseSectionQueries([['a'], ['b']], 3), null);
same('an empty row is refused', parseSectionQueries([['a'], []], 2), null);
same('not an array is refused', parseSectionQueries('nope', 1), null);
same('at most three queries per topic', parseSectionQueries([['1', '2', '3', '4']], 1), [['1', '2', '3']]);

// --- the curator's prompt ------------------------------------------------------
const lang = { code: 'ru', name: 'Russian', endonym: 'русский', learning: { code: 'nl', name: 'Dutch', endonym: 'Nederlands' } };
const prompt = AI_PROMPTS.find_resources('Lidwoorden', '[0] ...', {
    course: 'Нидерландский язык', phase: 'A1', section: 'Grammar basics', description: 'de and het, when each is used', lang,
});
check('the curator sees the course, section and what the topic covers',
    prompt.user.includes('Нидерландский язык') && prompt.user.includes('Grammar basics') && prompt.user.includes('de and het'));
check('the curator is told who reads it, and what the course teaches',
    prompt.user.includes('Russian (русский)') && prompt.user.includes('teaches Dutch'));
check('the curator is told [] is a correct answer', /output \[\]/.test(prompt.system));
check('the curator is told one link per site', /one link per site/i.test(prompt.system));
const bare = AI_PROMPTS.find_resources('Topic', '[0] ...');
check('without context the prompt still builds, with no empty lines for missing fields',
    bare.user.startsWith('Topic: "Topic"') && !bare.user.includes('undefined') && !bare.user.includes('null'));

// --- links from memory must have answered --------------------------------------------
// A loopback address is refused by the fetch guard before any request leaves,
// which is the same branch an unreachable host takes: deterministic, offline.
const unreachable = [{ title: 'x', url: 'http://127.0.0.1/page', type: 'article' }];
same('a search result that cannot be reached is kept (it was seen on the web)',
    (await verifyResourcesBatch(unreachable, 2000)).length, 1);
same('a remembered link that cannot be reached is dropped',
    (await verifyResourcesBatch(unreachable, 2000, { keepUnreachable: false })).length, 0);

try { (await import('../server/database.js')).default.close(); } catch { /* best effort */ }
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* Windows file locks */ }
// `tools/run-gates.mjs` reads the assertion count out of this line.
console.log(`\n${passed} passed, ${failures} failed`);
process.exitCode = failures ? 1 : 0;
