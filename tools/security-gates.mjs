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

import { isAllowedOrigin, isLocalHostname, hostnameOf, originGuard } from '../server/originGuard.js';
import { isBlockedAddress, assertFetchable } from '../server/netSafety.js';

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
ok('vite dev origin allowed', isAllowedOrigin('http://localhost:5173', { headers: { host: 'localhost:3001' } }));
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
ok('guard 403s rebound host', runGuard({ host: 'evil.example', origin: 'https://evil.example' }) === 403);
// The whole rebinding scenario end to end: under a rebound name, Host and
// Origin agree BY CONSTRUCTION (the attacker's page IS that origin), so the
// Host check is the only layer left — and the CORS callback, which judges the
// origin without the request, must refuse the same name on its own.
ok('guard 403s a rebound range-lookalike host', runGuard({ host: '10.evil.com:3001', origin: 'http://10.evil.com:3001' }) === 403);
ok('rebinding origin refused at the CORS layer too', !isAllowedOrigin('http://10.evil.com:3001'));

// --- 3. outbound fetch targets --------------------------------------------
for (const ip of ['127.0.0.1', '::1', '10.0.0.5', '192.168.1.1', '172.20.3.4', '169.254.169.254',
    '::ffff:127.0.0.1', '100.100.64.2', '0.0.0.0', 'fd00::1', 'fe80::1', '224.0.0.1']) {
    ok(`address blocked: ${ip}`, isBlockedAddress(ip));
}
for (const ip of ['93.184.216.34', '8.8.8.8', '2606:2800:220:1:248:1893:25c8:1946']) {
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

console.log(`security-gates: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
    for (const f of failures) console.error(`  FAIL ${f}`);
    process.exit(1);
}
