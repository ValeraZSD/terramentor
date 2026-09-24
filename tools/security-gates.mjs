/**
 * Deterministic security gates. No model calls, no database, no network.
 *
 *   node tools/security-gates.mjs
 *
 * Three boundaries, each of which was open at some point and each of which
 * fails SILENTLY when it regresses — a sanitizer that stops stripping, a CORS
 * policy that goes back to `*`, an SSRF check that stops resolving. None of them
 * raise an error when they break; they just quietly start allowing things, which
 * is the shape of bug a gate exists for.
 *
 *   1. The markdown pipeline (src/utils/markdownSanitize.ts) — the schema is
 *      read from the real source file and driven through the real
 *      rehype-raw → rehype-sanitize → rehype-katex chain, so a change to either
 *      the schema or the plugin ORDER is caught. Both halves are asserted: the
 *      payloads must die AND the maths, timelines, fences and tables must live,
 *      because a sanitizer that also deletes every equation is not a fix.
 *   2. The origin/host guard (server/originGuard.js).
 *   3. Outbound fetch targets (server/netSafety.js).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkBreaks from 'remark-breaks';

import JSZip from 'jszip';
import zlib from 'node:zlib';

import { isAllowedOrigin, isLocalHostname, hostnameOf, originGuard } from '../server/originGuard.js';
import { isBlockedAddress, assertFetchable } from '../server/netSafety.js';
import { rejectOversizedBody } from '../server/uploadGuard.js';
import { assertZipSafe, readZipEntry } from '../server/extract.js';
import { zstdDecompressSync } from '../server/zstd.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
const failures = [];
const ok = (label, cond) => { if (cond) pass++; else failures.push(label); };

// --- 1. markdown sanitize -------------------------------------------------
// The schema lives in TypeScript; its only TS syntax is a type import and one
// annotation, so it is stripped to a temporary .mjs rather than copied — a copy
// would drift from the very file it is meant to be guarding.
const schemaSrc = fs.readFileSync(path.join(root, 'src/utils/markdownSanitize.ts'), 'utf8')
    .replace(/^import type .*$/m, '')
    .replace(/: SanitizeSchema/, '');
const probeFile = path.join(root, 'tools', '.markdownSchema.probe.mjs');
fs.writeFileSync(probeFile, schemaSrc);
let markdownSchema;
try {
    ({ markdownSchema } = await import(`${pathToFileURL(probeFile).href}?t=${Date.now()}`));
} finally {
    fs.rmSync(probeFile, { force: true });
}

const render = (md) => renderToStaticMarkup(React.createElement(ReactMarkdown, {
    remarkPlugins: [remarkGfm, remarkMath, remarkBreaks],
    rehypePlugins: [rehypeRaw, [rehypeSanitize, markdownSchema], rehypeKatex],
}, md)).replace(/\n/g, ' ');

const DANGEROUS = /<(iframe|script|meta|form|object|embed|link|base|style|foreignobject|applet|frame|frameset)\b/i;
const attacks = {
    // The decisive one: a srcdoc iframe inherits the parent origin, so this is
    // script execution inside the app, not a defaced paragraph.
    'iframe srcdoc': '<iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"></iframe>',
    'iframe src': '<iframe src="https://evil.example/t"></iframe>',
    'script tag': '<script>alert(1)</script>',
    'meta refresh': '<meta http-equiv="refresh" content="0;url=https://evil.example">',
    'form action': '<form action="https://evil.example/x"><input name=a></form>',
    'object data': '<object data="https://evil.example/x"></object>',
    embed: '<embed src="https://evil.example/x">',
    'link stylesheet': '<link rel="stylesheet" href="https://evil.example/x.css">',
    'base href': '<base href="https://evil.example/">',
    'style tag': '<style>body{display:none}</style>',
    'svg foreignObject': '<svg><foreignObject><body onload="alert(1)"/></foreignObject></svg>',
};
for (const [name, md] of Object.entries(attacks)) ok(`markdown blocks ${name}`, !DANGEROUS.test(render(md)));
// Arbitrary class names would hand an attacker the app's own utility CSS to
// paint a full-screen fake dialog, so span/div keep only the math handoff.
ok('markdown blocks class-based overlay', !/fixed inset-0/.test(render('<span class="fixed inset-0 z-50">x</span>')));

const legit = {
    // Math is the subtlest of these: it only survives while the sanitizer runs
    // BEFORE rehype-katex and keeps the `math*` classes remark-math writes.
    'inline math': ['The value $x^2 + 1$ here.', /katex/],
    'display math': ['$$\nE = mc^2\n$$', /katex-display/],
    'code fence language': ['```mermaid\ngraph TD;A-->B;\n```', /language-mermaid/],
    'timeline tags': ['<timeline>\n\n<timeline-event time="1905" title="Annus Mirabilis">\n\nBody **bold**.\n\n</timeline-event>\n\n</timeline>', /<timeline-event[^>]*time="1905"/],
    table: ['| a | b |\n|---|---|\n| 1 | 2 |', /<table>/],
    'external link': ['[x](https://example.com)', /href="https:\/\/example\.com"/],
    'task list': ['- [x] done', /type="checkbox"/],
    details: ['<details><summary>More</summary>\n\ntext\n\n</details>', /<details>/],
    'sub and sup': ['a <sub>1</sub> and <sup>2</sup>', /<sub>1<\/sub>/],
};
for (const [name, [md, want]] of Object.entries(legit)) ok(`markdown keeps ${name}`, want.test(render(md)));

// --- 2. origin / host guard -----------------------------------------------
ok('hostnameOf strips port', hostnameOf('localhost:3001') === 'localhost');
ok('hostnameOf keeps IPv6 literal', hostnameOf('[::1]:3001') === '[::1]');
for (const h of ['localhost', '127.0.0.1', '192.168.1.40', '10.1.2.3', '172.20.0.5', 'desktop.local', 'box.tail1a2b.ts.net',
    // A tailnet address typed by hand, which is how a phone reaches this
    // server when MagicDNS was not set up. Both ends of 100.64.0.0/10.
    '100.64.0.1', '100.101.102.103', '100.127.255.254',
    // The bind-all address a browser can type, and IPv6 locals — raw (isIP
    // sees 6) and bracketed (isIP sees 0, so the bracket branch answers).
    '0.0.0.0', 'fd00::1', 'fe80::1', '[fd00::1]', '[fe80::1]']) {
    ok(`host allowed: ${h}`, isLocalHostname(h));
}
for (const h of ['evil.example', 'study.example.com', 'attacker.co.uk', '',
    // The octets either side of that range are ordinary public internet and
    // must stay refused, or the allowance is a /8 nobody asked for.
    '100.63.255.255', '100.128.0.1', '100.5.6.7',
    // The rebinding hole: these are DNS
    // names that BEGIN with a private-range prefix, not IP literals — whoever
    // controls the zone decides where they resolve, so a name the attacker
    // chose must not pass for the characters it starts with.
    '10.evil.com', '192.168.evil.com', '127.evil.com', '100.64.evil.com',
    '172.16.evil.com', '169.254.evil.com',
    // A malformed literal is not an IP, and a public IP is not a name this
    // machine is legitimately reached by.
    '10.0.0.256', '8.8.8.8']) {
    ok(`host refused: ${h || '(empty)'}`, !isLocalHostname(h));
}

ok('no Origin (curl/tools/bot) allowed', isAllowedOrigin(undefined));
ok('Origin: null refused', !isAllowedOrigin('null'));
// The Vite proxy does not rewrite Host (`changeOrigin` is off for `/api`), so
// the dev page asks as exactly the origin it is.
ok('vite dev origin allowed', isAllowedOrigin('http://localhost:5173', { headers: { host: 'localhost:5173' } }));
// The same NAME on another port is another origin: a second local web service
// (a dev server, a dashboard, anything on 8080) must not get the API for
// sharing `localhost` with it. This was the first outside audit's finding —
// the guard compared hostnames only.
for (const o of ['http://localhost:5173', 'http://localhost:65535', 'https://localhost:4443', 'http://localhost']) {
    ok(`same name, other port refused: ${o}`, !isAllowedOrigin(o, { headers: { host: 'localhost:3001' } }));
}
// The scheme is part of the origin too, judged by the socket the request came
// in on: a plain socket cannot have served an https page.
ok('https origin over a plain socket refused', !isAllowedOrigin('https://localhost:3001', { headers: { host: 'localhost:3001' }, socket: {} }));
ok('https origin over a TLS socket allowed', isAllowedOrigin('https://localhost:3001', { headers: { host: 'localhost:3001' }, socket: { encrypted: true } }));
ok('http origin over a plain socket allowed', isAllowedOrigin('http://localhost:3001', { headers: { host: 'localhost:3001' }, socket: {} }));
// A default port written out on one side and omitted on the other is one place.
ok('explicit :443 folds into https', isAllowedOrigin('https://study.example.com', { headers: { host: 'study.example.com:443' }, socket: { encrypted: true } }));
ok('explicit :80 folds into http', isAllowedOrigin('http://study.example.com', { headers: { host: 'study.example.com:80' }, socket: {} }));
ok(':443 on a plain-http request is another port', !isAllowedOrigin('http://study.example.com', { headers: { host: 'study.example.com:443' }, socket: {} }));
ok('bracketed IPv6 with a port matches itself', isAllowedOrigin('http://[::1]:3001', { headers: { host: '[::1]:3001' } }));
ok('bracketed IPv6 on another port refused', !isAllowedOrigin('http://[::1]:5173', { headers: { host: '[::1]:3001' } }));
// A phone that opened the tailnet name: its Origin IS the Host it typed.
ok('tailnet origin allowed', isAllowedOrigin('https://box.tail1a2b.ts.net', { headers: { host: 'box.tail1a2b.ts.net' } }));
ok('hostile origin refused', !isAllowedOrigin('https://evil.example'));
// Same-host is what lets a custom deployment work without ALLOWED_ORIGINS.
ok('same-host origin allowed', isAllowedOrigin('https://study.example.com', { headers: { host: 'study.example.com' } }));
ok('non-http origin refused', !isAllowedOrigin('chrome-extension://abc'));
// The drive-by a local-network fallthrough allows: the victim's own browser
// can always reach loopback, so a
// page on another LAN/tailnet device is a real origin whose Host pairs with
// loopback. A local-network name means nothing without matching THIS request's
// Host — and the CORS callback, which runs without the request, reflects only
// the explicit ALLOWED_ORIGINS entries, never a bare local name.
for (const o of ['http://192.168.1.50:8080', 'http://attacker.local', 'https://other-device.ts.net']) {
    ok(`cross-host local origin refused: ${o}`, !isAllowedOrigin(o, { headers: { host: '127.0.0.1:3001' } }));
}
ok('bare CORS callback refuses a local name too', !isAllowedOrigin('http://192.168.1.50:8080'));
// The legitimate cross-host case is a reverse proxy that rewrites Host: the
// origin the browser sees differs from the upstream Host, and such a request
// arrives with X-Forwarded-Proto — a header a browser cannot set, so a direct
// page fetch cannot forge it.
ok('proxied origin allowed behind X-Forwarded-Proto', isAllowedOrigin('https://other-device.ts.net', { headers: { host: '127.0.0.1:3001', 'x-forwarded-proto': 'https' } }));
ok('a public name still needs ALLOWED_ORIGINS behind a proxy', !isAllowedOrigin('https://embed.example.com', { headers: { host: '127.0.0.1:3001', 'x-forwarded-proto': 'https' } }));

const runGuard = (headers) => {
    let status = 0;
    const res = { status(c) { status = c; return this; }, json() { return this; } };
    originGuard({ headers }, res, () => { status = 200; });
    return status;
};
ok('guard passes same-origin', runGuard({ host: 'localhost:3001', origin: 'http://localhost:3001' }) === 200);
ok('guard passes headerless client', runGuard({ host: 'localhost:3001' }) === 200);
ok('guard 403s hostile origin', runGuard({ host: 'localhost:3001', origin: 'https://evil.example' }) === 403);
ok('guard 403s a same-name other-port origin', runGuard({ host: 'localhost:3001', origin: 'http://localhost:8080' }) === 403);

// --- 2b. the aggregate cap on a multipart upload ----------------------------
// multer's caps are per file, so the body is judged on Content-Length BEFORE
// any of it is read. A body that declares no length (chunked) is the one
// shape that check cannot bound, so it is refused rather than let through on
// the per-file caps — the first outside audit's second finding.
{
    const run = (headers) => {
        let status = 0, body = null;
        const res = { status(c) { status = c; return this; }, json(b) { body = b; return this; } };
        rejectOversizedBody(10 * 1024 * 1024)({ headers }, res, () => { status = 200; });
        return { status, body };
    };
    ok('under the cap passes', run({ 'content-length': String(9 * 1024 * 1024) }).status === 200);
    ok('exactly the cap passes', run({ 'content-length': String(10 * 1024 * 1024) }).status === 200);
    ok('over the cap is 413', run({ 'content-length': String(10 * 1024 * 1024 + 1) }).status === 413);
    ok('the 413 names the limit in MB', /10 MB/.test(run({ 'content-length': String(11 * 1024 * 1024) }).body?.error || ''));
    ok('no Content-Length (chunked) is 411', run({}).status === 411);
    ok('an unparseable Content-Length is 411', run({ 'content-length': 'abc' }).status === 411);
    ok('a negative Content-Length is 411', run({ 'content-length': '-1' }).status === 411);
    ok('the 411 says what to send', /Content-Length/.test(run({}).body?.error || ''));
}
ok('guard 403s rebound host', runGuard({ host: 'evil.example', origin: 'https://evil.example' }) === 403);
// The whole rebinding scenario end to end: under a rebound name, Host and
// Origin agree BY CONSTRUCTION (the attacker's page IS that origin), so the
// Host check is the only layer left — and the CORS callback, which judges the
// origin without the request, must refuse the same name on its own.
ok('guard 403s a rebound range-lookalike host', runGuard({ host: '10.evil.com:3001', origin: 'http://10.evil.com:3001' }) === 403);
ok('rebinding origin refused at the CORS layer too', !isAllowedOrigin('http://10.evil.com:3001'));

// --- 3. outbound fetch targets --------------------------------------------
for (const ip of ['127.0.0.1', '::1', '10.0.0.5', '192.168.1.1', '172.20.3.4', '169.254.169.254',
    '::ffff:127.0.0.1', '100.100.64.2', '0.0.0.0', 'fd00::1', 'fe80::1', '224.0.0.1',
    // The whole fe80::/10, not the text "fe80:" (the outside audit's finding,
    // 2026-09-24: fe81::1 and febf::1 were fetchable), plus case and the other
    // bit-prefixed ranges at both ends.
    'fe81::1', 'fea0::1', 'febf::1', 'FE81::1', 'fec0::1', 'fc00::1', 'ff02::1']) {
    ok(`address blocked: ${ip}`, isBlockedAddress(ip));
}
for (const ip of ['93.184.216.34', '8.8.8.8', '2606:2800:220:1:248:1893:25c8:1946',
    // Just outside each range: a public address that merely LOOKS close.
    'fe7f::1', 'fb00::1', '2001:db8::1']) {
    ok(`address allowed: ${ip}`, !isBlockedAddress(ip));
}

const refuses = async (url) => {
    try { await assertFetchable(url); return false; } catch { return true; }
};
for (const u of ['http://127.0.0.1:8888/v1/models', 'http://localhost:11434/api/tags', 'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data/', 'http://[::1]:3001/api/projects', 'file:///etc/passwd',
    'javascript:alert(1)', 'http://2130706433/', 'http://user:pass@example.com/']) {
    ok(`fetch refused: ${u}`, await refuses(u));
}

// --- 4. the one endpoint that fetches a private address on purpose ---------
// A SearXNG instance is normally on loopback or the LAN, so `/api/searxng/test`
// is exempt from netSafety. That exemption is about the ADDRESS; the endpoint
// still has to refuse a scheme the learner cannot have meant and must not
// follow a redirect, or the reply ("reachable" / "status N" / "timed out")
// answers the same question for anything else on the network. Source scan,
// because the route is inside the server's own request wiring.
const indexSrc = fs.readFileSync(path.join(root, 'server/index.js'), 'utf8');
const probeStart = indexSrc.indexOf("app.post('/api/searxng/test'");
ok('the SearXNG probe route exists', probeStart > 0);
const probe = indexSrc.slice(probeStart, indexSrc.indexOf('\napp.', probeStart + 10));
ok('probe refuses a non-http scheme', /SAFE_URL_PROTOCOLS\.includes\(\s*parsed\.protocol\s*\)/.test(probe));
ok('probe does not follow redirects', /redirect:\s*'manual'/.test(probe));
ok('probe bounds the URL length', /MAX_URL_LENGTH/.test(probe));
ok('probe fetches once', (probe.match(/\bfetch\(/g) || []).length === 1);

// --- 5. a vetted fetch stays vetted through the probe ----------------------
// assertFetchable vets only the INITIAL url; a bare fetch after it follows
// redirects un-vetted, so an open redirect hands the connection to an internal
// address and answers the probe with its status (found in ai.js
// verifyResourcesBatch, 2026-09-17). Every call site outside netSafety.js must
// probe through safeFetch, whose loop re-vets each hop with redirect:'manual'.
const aiSrc = fs.readFileSync(path.join(root, 'server/ai.js'), 'utf8');
const vet = aiSrc.indexOf('await assertFetchable(');
ok('ai.js vets its resource probe', vet > 0);
const probeSlice = aiSrc.slice(vet, aiSrc.indexOf('clearTimeout(id)', vet));
ok('resource probe fetches through safeFetch', probeSlice.includes('safeFetch('));
ok('resource probe has no bare fetch after the vet', !/(?<!safe)fetch\(/.test(probeSlice));

const netSrc = fs.readFileSync(path.join(root, 'server/netSafety.js'), 'utf8');
const sfStart = netSrc.indexOf('export async function safeFetch');
ok('netSafety exports safeFetch', sfStart > 0);
const sfBody = netSrc.slice(sfStart, netSrc.indexOf('\n}', sfStart) + 2);
ok('safeFetch re-vets every hop', sfBody.includes('assertFetchable('));
ok('safeFetch never follows redirects itself', /redirect:\s*'manual'/.test(sfBody));
ok('safeFetch demands the same answer twice before connecting', sfBody.includes('resolveAndVet(host)') && sfBody.includes('changed its addresses between resolutions'));

// --- 5b. …and the KEY does not travel with it ------------------------------
// Re-vetting the address says nothing about whether the new host should be
// trusted with the learner's credential. The hosted search backends call
// safeFetch with `Authorization: Bearer <key>` or `X-Subscription-Token`
// attached, so forwarding the init verbatim meant one 302 from api.tavily.com,
// s.jina.ai or api.search.brave.com would hand that key to whatever host the
// redirect named.
//
// Measured against real sockets rather than read off the source, because the
// thing being asserted is what the second server RECEIVES. It runs in a child
// process: the sockets have to be loopback, netSafety refuses loopback by
// design, and `ALLOW_PRIVATE_FETCH` is read once at import — so the exemption
// belongs to that child and not to this gate.
//
// Both halves matter. Dropping the credential on a same-origin redirect would
// be its own bug: a host that redirects to itself (a trailing slash, a region)
// would silently start getting unauthenticated requests.
{
    const probe = path.join(root, 'tools/fixtures/redirect-credentials.mjs');
    const run = spawnSync(process.execPath, [probe], {
        encoding: 'utf8',
        env: { ...process.env, ALLOW_PRIVATE_FETCH: '1' },
        // A backstop, not the mechanism: the probe races its own clock and
        // always prints. This only stops a wedged child from wedging the suite.
        timeout: 40_000,
    });
    let landed = null;
    try { landed = JSON.parse(run.stdout); } catch { /* reported as the failure below */ }
    ok('the redirect probe ran', !!landed && !!landed.crossOrigin && !!landed.sameOrigin);
    const cross = landed?.crossOrigin || {};
    const same = landed?.sameOrigin || {};
    ok('a cross-origin redirect drops Authorization', cross.authorization === undefined);
    ok('a cross-origin redirect drops the search-backend token', cross['x-subscription-token'] === undefined);
    ok('a cross-origin redirect keeps the ordinary headers', cross.accept === 'application/json');
    ok('a same-origin redirect keeps Authorization', same.authorization === 'Bearer secret-key-value');
    ok('a same-origin redirect keeps the search-backend token', same['x-subscription-token'] === 'secret-brave-token');

    // --- 5c. and a page that never ends does not hold the process ----------
    // `response.text()` waits for the body to finish, and the body here was
    // chosen by a captured link or by the model reading search results. The
    // discriminator is TIME: a reader that stops at its cap has what it needs
    // from the first write, while an unbounded one can only come back when the
    // 10s abort fires. Asserting the character count alone would pass either
    // way, because the slice happens afterwards.
    const endless = landed?.endlessPage || {};
    ok('an endless page still yields its content', endless.ok === true && endless.chars === 3000);
    // 5s, not a tight bound: the discriminator is the pre-fix behaviour, which is an
    // unbounded wait — `fetchPageContent` clears its abort timer when the headers
    // arrive, so a body that never ends never returns, and the probe's own 15s race
    // is what ends it. Anything under the abort budget is a pass; a threshold tight
    // enough to trip on a loaded machine would make this gate flaky for no gain.
    ok('…and does not wait for a body that never ends', typeof endless.ms === 'number' && endless.ms < 5000);
    // A body that TRICKLES (a byte every few seconds) never reaches the cap, so
    // time is the only bound: the abort timer must outlive the body read, i.e.
    // be cleared in a `finally`, never once the headers are in.
    const aiSrc = fs.readFileSync(path.join(root, 'server/ai.js'), 'utf8');
    const fpcFrom = aiSrc.indexOf('export async function fetchPageContent(');
    const fpcEnd = aiSrc.slice(fpcFrom).search(/\r?\n\}\r?\n/);
    const fpcBody = aiSrc.slice(fpcFrom, fpcEnd > 0 ? fpcFrom + fpcEnd : fpcFrom);
    const clears = [...fpcBody.matchAll(/clearTimeout\(/g)].map(m => m.index);
    ok('the page fetch clears its timer only after the body is read', fpcFrom > 0 && clears.length > 0
        && clears.every(i => fpcBody.lastIndexOf('finally', i) > fpcBody.indexOf('readCapped(')));
}

// --- 6. the settings dump carries no secrets --------------------------------
// GET /api/settings is readable by anything that can reach the app's origin,
// so the dump carries no credentials at all — a key in it is a key handed to
// whoever can reach the origin. The predicate is asserted behaviourally — the real
// module, against a scratch database, because auth.js opens one at module
// load — and the WIRING is a source scan, because a predicate that exists but
// is never asked fails exactly as silently as no predicate.
{
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-gates-'));
    process.env.DB_PATH = path.join(scratch, 'dump-gate.db');
    process.env.VAULT_ROOT = path.join(scratch, 'vault');
    const auth = await import(`${pathToFileURL(path.join(root, 'server/auth.js')).href}?t=${Date.now()}`);
    for (const k of ['auth_password_hash', 'auth_session_secret', 'auth_api_key', 'ai_openai_api_key']) {
        ok(`settings dump refuses ${k}`, auth.isSecretSettingKey(k));
    }
    ok('settings dump carries ordinary settings', !['theme', 'accent', 'ai_model', 'ai_provider', 'ai_reasoning_effort'].some(k => auth.isSecretSettingKey(k)));
    const dumpGet = indexSrc.slice(indexSrc.indexOf("app.get('/api/settings'"), indexSrc.indexOf('\napp.', indexSrc.indexOf("app.get('/api/settings'")));
    ok('GET /api/settings filters through isSecretSettingKey', dumpGet.includes('isSecretSettingKey'));
    const dumpPut = indexSrc.slice(indexSrc.indexOf("app.put('/api/settings/:key'"), indexSrc.indexOf('\napp.', indexSrc.indexOf("app.put('/api/settings/:key'")));
    ok('PUT /api/settings/:key refuses secrets too', dumpPut.includes('isSecretSettingKey'));
    ok('the provider key has its own write route', indexSrc.includes("app.put('/api/ai/key'") && indexSrc.includes("app.delete('/api/ai/key'"));
    ok('/api/ai/status answers hasApiKey, not the key', /\napp\.get\('\/api\/ai\/status'[\s\S]*?hasApiKey/.test(indexSrc));
    const settingsTsx = fs.readFileSync(path.join(root, 'src/components/Settings.tsx'), 'utf8');
    ok('Settings.tsx no longer reads the key from the dump', !settingsTsx.includes('settings.ai_openai_api_key'));
    ok('Settings.tsx writes the key through /api/ai/key', settingsTsx.includes('api.setAIKey(') && settingsTsx.includes('api.clearAIKey()'));
}

// --- 7. what an imported archive may INFLATE to -----------------------------
// The two import doors take a file the learner was handed — a deck off
// AnkiWeb, a .studyvault from a stranger — and the failure to prevent is not a
// bad import, it is this single process being taken to OOM by one upload,
// which kills every SSE stream, review session and generation run in flight.
//
// The bound that existed read the archive's own declared sizes, and those are
// written by whoever built the archive. So the fixture here is the one that
// matters: a central directory declaring 100 bytes for an entry carrying
// megabytes. `assertZipSafe` waving it through is asserted deliberately — that
// is the control, and it is why the ceiling now sits where the bytes are
// produced instead of where they are announced.
{
    // The uncompressed size lives at +22 in the local file header and +24 in
    // the central directory record. The records are walked from the End Of
    // Central Directory, never found by scanning for signatures, so the patch
    // cannot land inside compressed data and the fixture is deterministic.
    const lyingZip = async (realBytes, declared = 100) => {
        const z = new JSZip();
        z.file('big.bin', Buffer.alloc(realBytes, 0x41));
        const bytes = await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
        let eocd = bytes.length - 22;
        while (eocd >= 0 && bytes.readUInt32LE(eocd) !== 0x06054b50) eocd--;
        const count = bytes.readUInt16LE(eocd + 10);
        let p = bytes.readUInt32LE(eocd + 16);
        for (let i = 0; i < count; i++) {
            const localAt = bytes.readUInt32LE(p + 42);
            bytes.writeUInt32LE(declared, p + 24);
            bytes.writeUInt32LE(declared, localAt + 22);
            p += 46 + bytes.readUInt16LE(p + 28) + bytes.readUInt16LE(p + 30) + bytes.readUInt16LE(p + 32);
        }
        return bytes;
    };
    const CAP = 1024 * 1024;
    const REAL = 8 * 1024 * 1024;
    const hostile = await JSZip.loadAsync(await lyingZip(REAL));

    // The control: the fixture is only interesting if the old bound passes it.
    ok('the fixture declares a tiny entry', hostile.files['big.bin']._data.uncompressedSize === 100);
    let declaredVerdict = 'passed';
    try { assertZipSafe(hostile, { maxEntries: 20000, maxTotalBytes: CAP }); } catch (e) { declaredVerdict = e.message; }
    ok('a declared-size check passes an 8 MB entry under a 1 MB cap (why it cannot be the bound)', declaredVerdict === 'passed');

    const refusal = await readZipEntry(hostile, 'big.bin', { cap: CAP, what: 'This deck' }).then(
        (v) => ({ value: v }), (e) => ({ error: e }));
    ok('readZipEntry refuses the lying entry', !!refusal.error && refusal.value === undefined);
    ok('...and flags it as a size refusal, not a corrupt file', refusal.error?.tooLarge === true);
    ok('...and says what is wrong with the FILE', /big\.bin/.test(refusal.error?.message || '') && /1 MB/.test(refusal.error?.message || ''));
    ok('...in words, not a zlib or JSZip internal message',
        !/ERR_BUFFER_TOO_LARGE|Cannot create a Buffer|Bug :/.test(refusal.error?.message || ''));

    // The other half: nothing legitimate may change. A deflated entry, a
    // stored one, an entry exactly ON the ceiling, and a name that is not there.
    const honestZip = new JSZip();
    honestZip.file('deflated.txt', 'hello deck'.repeat(500), { compression: 'DEFLATE' });
    honestZip.file('stored.bin', Buffer.alloc(4096, 0x7f), { compression: 'STORE' });
    honestZip.file('exact.bin', Buffer.alloc(CAP, 0x21), { compression: 'DEFLATE' });
    const honest = await JSZip.loadAsync(await honestZip.generateAsync({ type: 'nodebuffer' }));
    ok('a deflated entry reads back byte-identical', (await readZipEntry(honest, 'deflated.txt', { cap: CAP })).toString() === 'hello deck'.repeat(500));
    ok('a stored entry reads back byte-identical', (await readZipEntry(honest, 'stored.bin', { cap: CAP })).equals(Buffer.alloc(4096, 0x7f)));
    ok('an entry exactly on the ceiling is allowed', (await readZipEntry(honest, 'exact.bin', { cap: CAP })).length === CAP);
    ok('one byte under the ceiling refuses it', await readZipEntry(honest, 'exact.bin', { cap: CAP - 1 }).then(() => false, (e) => e.tooLarge === true));
    ok('a missing entry is null, not a throw', (await readZipEntry(honest, 'nope.bin', { cap: CAP })) === null);
    ok('a reader with no ceiling is a programming error', await readZipEntry(honest, 'stored.bin', {}).then(() => false, (e) => /byte ceiling/.test(e.message)));

    // zstd, the other compressor an .apkg arrives in. Same shape: the frame is
    // a ratio its author chose, and the ceiling has to be inside the inflate.
    const frame = zlib.zstdCompressSync(Buffer.alloc(REAL, 0x42));
    ok('the zstd fixture really does expand past the cap (the control)', zlib.zstdDecompressSync(frame).length === REAL);
    let zstdErr = null;
    try { zstdDecompressSync(frame, { maxOutputBytes: CAP, what: "This deck's collection" }); } catch (e) { zstdErr = e; }
    ok('zstdDecompressSync refuses a frame that expands past its ceiling', zstdErr?.tooLarge === true);
    ok('...and names the file, not the buffer allocator',
        /collection/.test(zstdErr?.message || '') && !/Cannot create a Buffer/.test(zstdErr?.message || ''));
    const small = zlib.zstdCompressSync(Buffer.from('a real collection'));
    ok('a frame under the ceiling still round-trips', zstdDecompressSync(small, { maxOutputBytes: CAP }).toString() === 'a real collection');
    let noCeiling = null;
    try { zstdDecompressSync(small); } catch (e) { noCeiling = e; }
    ok('a zstd call site that names no ceiling is a programming error', /byte ceiling/.test(noCeiling?.message || ''));
}

// --- 7b. ...and the doors actually go through it ----------------------------
// A ceiling that exists and is never passed fails exactly as silently as no
// ceiling. These are source scans for the same reason section 6's are: the
// call sites are inside a 8,000-line request file and an importer that needs a
// real deck to exercise.
{
    const ankiImportSrc = fs.readFileSync(path.join(root, 'server/ankiImport.js'), 'utf8');
    const ankiMediaSrc = fs.readFileSync(path.join(root, 'server/ankiMedia.js'), 'utf8');

    const parseFrom = ankiImportSrc.indexOf('export async function parseApkg(');
    ok('parseApkg exists', parseFrom > 0);
    const parseBody = ankiImportSrc.slice(parseFrom, ankiImportSrc.indexOf('\nexport ', parseFrom + 10));
    // The .apkg door is the one people feed files from the internet through,
    // and it was the one with no bound at all while the bundle door had one.
    ok('the .apkg door checks the archive before reading it', /assertZipSafe\(/.test(parseBody));

    for (const [name, src] of [['ankiImport.js', ankiImportSrc], ['ankiMedia.js', ankiMediaSrc]]) {
        ok(`${name} reads zip entries through readZipEntry`, src.includes('readZipEntry('));
        ok(`${name} has no unbounded entry read left`, !/\.async\('nodebuffer'\)/.test(src));
        const calls = [...src.matchAll(/zstdDecompressSync\(/g)];
        ok(`${name} still decompresses zstd`, calls.length > 0);
        ok(`${name}: every zstd call names a ceiling`, calls.every(m => src.slice(m.index, m.index + 220).includes('maxOutputBytes')));
    }

    const bundleFrom = indexSrc.indexOf("app.post('/api/import/bundle'");
    ok('the bundle door exists', bundleFrom > 0);
    const bundleBody = indexSrc.slice(bundleFrom, indexSrc.indexOf('\napp.', bundleFrom + 10));
    ok('the bundle door reads entries through readZipEntry', bundleBody.includes('readZipEntry('));
    ok('the bundle door has no unbounded entry read left', !/\.async\('(nodebuffer|string)'\)/.test(bundleBody));

    // The vault's own PowerPoint reader, run rather than scanned: a slide that
    // declares 100 bytes and inflates to 40 MB is refused, not read.
    const extractSrc = fs.readFileSync(path.join(root, 'server/extract.js'), 'utf8');
    const pptxBody = extractSrc.slice(extractSrc.indexOf('async function extractPptx('), extractSrc.indexOf('export async function extractText('));
    ok('the pptx reader has no unbounded entry read left', pptxBody.length > 0 && !/\.async\('(nodebuffer|string)'\)/.test(pptxBody));
    const { extractText } = await import('../server/extract.js');
    const deck = new JSZip();
    deck.file('[Content_Types].xml', '<Types/>');
    deck.file('ppt/slides/slide1.xml', `<p:sld><a:t>${'x'.repeat(40 * 1024 * 1024)}</a:t></p:sld>`);
    const lying = Buffer.from(await deck.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
    for (let i = 0; i + 30 < lying.length; i++) {
        const sig = lying.readUInt32LE(i);
        if (sig === 0x04034b50) lying.writeUInt32LE(100, i + 22);
        else if (sig === 0x02014b50) lying.writeUInt32LE(100, i + 24);
    }
    const pptxResult = await extractText(lying, 'slides.pptx').then(() => 'read', (e) => (e.tooLarge ? 'refused' : `other: ${e.message}`));
    ok('a pptx slide lying about its size is refused as a bomb', pptxResult === 'refused', pptxResult);
    const small = new JSZip();
    small.file('[Content_Types].xml', '<Types/>');
    small.file('ppt/slides/slide1.xml', '<p:sld><a:t>Refraction</a:t></p:sld>');
    const smallText = await extractText(await small.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), 'ok.pptx').then(r => r.text, () => '');
    ok('an honest pptx still reads', smallText.includes('Refraction'), smallText.slice(0, 60));

    // .docx and .xlsx are unzipped again inside mammoth / ExcelJS, where no
    // ceiling of ours reaches. So every entry is inflated first under the
    // bounded reader: the same deflate stream inflates to the same bytes in the
    // parser, so a pass here bounds the parser. Run with a small budget rather
    // than the real 300 MB one, which a gate should not allocate.
    const { assertInflatesWithin } = await import('../server/extract.js');
    // One entry only: the size forgery below rewrites EVERY header, and a small
    // honest part with a forged size is refused as damaged before the big one
    // is reached — still a refusal, but not the one this line is about.
    const doc = new JSZip();
    doc.file('word/document.xml', `<w:document>${'x'.repeat(2 * 1024 * 1024)}</w:document>`);
    const lyingDoc = Buffer.from(await doc.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
    for (let i = 0; i + 30 < lyingDoc.length; i++) {
        const sig = lyingDoc.readUInt32LE(i);
        if (sig === 0x04034b50) lyingDoc.writeUInt32LE(100, i + 22);
        else if (sig === 0x02014b50) lyingDoc.writeUInt32LE(100, i + 24);
    }
    const docResult = await assertInflatesWithin(await JSZip.loadAsync(lyingDoc), 1024 * 1024, 'This document')
        .then(() => 'read', (e) => (e.tooLarge ? 'refused' : `other: ${e.message}`));
    ok('a docx part lying about its size is refused before the parser sees it', docResult === 'refused', docResult);
    const spread = new JSZip();
    for (let k = 0; k < 4; k++) spread.file(`xl/worksheets/sheet${k + 1}.xml`, 'y'.repeat(400 * 1024));
    const spreadResult = await assertInflatesWithin(await JSZip.loadAsync(await spread.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })), 1024 * 1024, 'This spreadsheet')
        .then(() => 'read', (e) => (e.tooLarge ? 'refused' : `other: ${e.message}`));
    ok('the ceiling is a TOTAL: four honest 400 kB parts over a 1 MB budget are refused', spreadResult === 'refused', spreadResult);
    const within = await assertInflatesWithin(await JSZip.loadAsync(await spread.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })), 4 * 1024 * 1024, 'This spreadsheet')
        .then(() => 'read', (e) => `refused: ${e.message}`);
    ok('the same parts under a budget that holds them pass', within === 'read', within);
    const extractBody = extractSrc.slice(extractSrc.indexOf('export async function extractText('));
    const guardAt = extractBody.indexOf('assertInflatesWithin(');
    ok('extractText runs the inflate pass before mammoth and ExcelJS',
        guardAt > 0 && guardAt < extractBody.indexOf('mammoth.extractRawText') && guardAt < extractBody.indexOf('extractXlsx(buffer)'));
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Lenses').addRow(['focal length', 'Refraction']);
    const xlsxText = await extractText(Buffer.from(await wb.xlsx.writeBuffer()), 'ok.xlsx').then(r => r.text, (e) => `error: ${e.message}`);
    ok('an honest xlsx still reads', xlsxText.includes('Refraction'), xlsxText.slice(0, 80));
}

// --- 8. ?model= may not walk the provider's URL -----------------------------
// `/api/ai/endpoints` builds `<base>/models/<id>/endpoints` on the endpoint the
// learner configured and sends it with the learner's API key. The id is
// allowed a slash of its own (`vendor/model`), so only the segments were
// encoded — and `encodeURIComponent('..')` is `'..'`, a dot being unreserved.
// `?model=../../x` therefore asked a different path on that host. There is no
// escaping that survives the URL normaliser, so the segment is refused.
//
// The function is lifted out of the route's own source, the way the markdown
// schema above is lifted out of its .ts: a copy would drift from the thing it
// guards. The pre-fix one-liner is run beside it as the control, so the
// fixture cannot pass by naming a harmless string.
{
    const from = indexSrc.indexOf('function modelEndpointPath(');
    ok('modelEndpointPath exists in the route file', from > 0);
    const probeFile = path.join(root, 'tools', '.modelPath.probe.mjs');
    fs.writeFileSync(probeFile, `export ${indexSrc.slice(from, indexSrc.indexOf('\n}', from) + 2)}`);
    let modelEndpointPath;
    try {
        ({ modelEndpointPath } = await import(`${pathToFileURL(probeFile).href}?t=${Date.now()}`));
    } finally {
        fs.rmSync(probeFile, { force: true });
    }

    const base = 'https://openrouter.ai/api/v1';
    const preFix = (model) => model.split('/').map(encodeURIComponent).join('/');
    const under = (built) => built !== null && new URL(`${base}/models/${built}/endpoints`).pathname.startsWith('/api/v1/models/');

    for (const hostile of ['../../x', '..', '.', 'a/../../../v1/keys', 'vendor/./../../../auth/keys', 'a//b', '/leading', 'trailing/']) {
        ok(`?model=${hostile} is refused`, modelEndpointPath(hostile) === null);
    }
    // The control: the same strings, through the line this replaced.
    ok('the pre-fix line let ../../x through (the control)', preFix('../../x') === '../../x');
    ok('...and fetch would have left /models/ with it', !under(preFix('../../x')));
    ok('...and reached the provider root with a/../../../v1/keys', new URL(`${base}/models/${preFix('a/../../../v1/keys')}/endpoints`).pathname === '/api/v1/keys/endpoints');

    // Nothing a real endpoint answers to may change.
    for (const good of ['z-ai/glm-5.3-flash', 'openai/gpt-4o-mini', 'meta-llama/llama-3.1-70b-instruct:free', 'llama3', 'qwen/qwen3-next-80b-a3b-instruct']) {
        ok(`a real model id is unchanged: ${good}`, modelEndpointPath(good) === preFix(good) && under(modelEndpointPath(good)));
    }
    const routeFrom = indexSrc.indexOf("app.get('/api/ai/endpoints'");
    const routeBody = indexSrc.slice(routeFrom, indexSrc.indexOf('\napp.', routeFrom + 10));
    ok('the route builds its path through modelEndpointPath', routeBody.includes('modelEndpointPath(model)'));
    ok('...and the route no longer encodes segments itself', !routeBody.includes("split('/').map(encodeURIComponent)"));
    ok('...and a refused id fetches nothing', /if \(path === null\) return res\.json/.test(routeBody));
}

console.log(`security-gates: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
    for (const f of failures) console.error(`  FAIL ${f}`);
    process.exit(1);
}
