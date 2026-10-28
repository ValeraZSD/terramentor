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
// The schema AND the plugin chain live in TypeScript, so the file is compiled
// to a temporary .mjs rather than copied: a copy would drift from the very file
// it is meant to be guarding. The gate once rendered its OWN chain, and the
// component's could lose the sanitizer with every check here still green.
const { transformSync } = await import('esbuild');
const schemaSrc = transformSync(fs.readFileSync(path.join(root, 'src/utils/markdownSanitize.ts'), 'utf8'), { loader: 'ts', format: 'esm' }).code;
const probeFile = path.join(root, 'tools', '.markdownSchema.probe.mjs');
fs.writeFileSync(probeFile, schemaSrc);
let markdownRehypePlugins;
try {
    ({ markdownRehypePlugins } = await import(`${pathToFileURL(probeFile).href}?t=${Date.now()}`));
} finally {
    fs.rmSync(probeFile, { force: true });
}
// …and the component renders that list and no other.
{
    const markdownTsx = fs.readFileSync(path.join(root, 'src/components/Markdown.tsx'), 'utf8');
    const chains = markdownTsx.match(/rehypePlugins=\{[^}]*\}/g) || [];
    ok('Markdown.tsx renders the shared rehype chain', chains.length === 1 && chains[0] === 'rehypePlugins={markdownRehypePlugins}');
}

const render = (md) => renderToStaticMarkup(React.createElement(ReactMarkdown, {
    remarkPlugins: [remarkGfm, remarkMath, remarkBreaks],
    rehypePlugins: markdownRehypePlugins,
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
// A <source srcset> inside <picture> loads INSTEAD of the <img>, and its srcset
// had no address check (fourth review): the picture rule has to cover it.
for (const src of ['https://evil.example/pixel.png', '/api/feed?nodeId=3']) {
    const out = render(`<picture><source srcset="${src}"><img src="a.png" alt="x"></picture>`);
    ok(`markdown drops <picture><source srcset="${src}">`, !/<source|<picture|srcset/i.test(out), out);
}
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
// sharing `localhost` with it. A guard that compares hostnames only misses this.
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
// Behind a proxy. `tailscale serve` passes the browser's Host through, so its
// requests are same-origin outright. A proxy that REWRITES Host names the host
// the browser asked for in X-Forwarded-Host, and the origin must be exactly
// that host under the forwarded scheme; X-Forwarded-Proto alone is not a
// licence for any local-network origin.
const behindProxy = (extra) => ({ headers: { host: '127.0.0.1:3001', 'x-forwarded-proto': 'https', ...extra } });
ok('tailscale serve (browser Host kept, scheme forwarded) is same-origin',
    isAllowedOrigin('https://pc.tail1234.ts.net', { headers: { host: 'pc.tail1234.ts.net', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'pc.tail1234.ts.net' } }));
ok('a Host-rewriting proxy is allowed for the host it forwarded',
    isAllowedOrigin('https://other-device.ts.net', behindProxy({ 'x-forwarded-host': 'other-device.ts.net' })));
ok('…on that host\'s own port', isAllowedOrigin('https://192.168.1.20:8443', behindProxy({ 'x-forwarded-host': '192.168.1.20:8443' })));
ok('X-Forwarded-Proto with no forwarded host does not admit a local-network origin',
    !isAllowedOrigin('https://other-device.ts.net', behindProxy({})) && !isAllowedOrigin('http://192.168.1.50:8080', behindProxy({})));
ok('…nor one that is not the forwarded host',
    !isAllowedOrigin('http://192.168.1.50:8080', behindProxy({ 'x-forwarded-host': 'pc.tail1234.ts.net' }))
    && !isAllowedOrigin('https://pc.tail1234.ts.net:8443', behindProxy({ 'x-forwarded-host': 'pc.tail1234.ts.net' })));
ok('…nor the forwarded host under the other scheme',
    !isAllowedOrigin('http://other-device.ts.net', behindProxy({ 'x-forwarded-host': 'other-device.ts.net' })));
ok('a public name still needs ALLOWED_ORIGINS behind a proxy', !isAllowedOrigin('https://embed.example.com', behindProxy({ 'x-forwarded-host': 'embed.example.com' })));

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
// An <img src="http://127.0.0.1:3001/api/feed?nodeId=7"> on another site sends
// no Origin, so the Origin check alone called it "not a browser" and a GET that
// starts a paid lesson ran. The browser's Sec-Fetch-Site label says who asked.
ok('guard 403s a cross-site GET that carries no Origin', runGuard({ host: '127.0.0.1:3001', 'sec-fetch-site': 'cross-site' }) === 403);
ok('guard 403s a same-site other-port GET that carries no Origin', runGuard({ host: 'localhost:3001', 'sec-fetch-site': 'same-site' }) === 403);
ok('guard passes the app\'s own fetch', runGuard({ host: '127.0.0.1:3001', 'sec-fetch-site': 'same-origin' }) === 200);
ok('guard passes an address typed into the bar', runGuard({ host: '127.0.0.1:3001', 'sec-fetch-site': 'none' }) === 200);
ok('guard passes the dev proxy (the browser judged the page it sees)', runGuard({ host: 'localhost:5173', origin: 'http://localhost:5173', 'sec-fetch-site': 'same-origin' }) === 200);
// A `.local` name is whatever the first device to answer mDNS says it is, so a
// neighbour can rebind it to 127.0.0.1 and its page becomes same-origin with
// this app on the owner's socket. On loopback that name is refused; a phone
// that reached this computer by it arrives from the LAN and is not.
{
    const from = (remoteAddress, headers) => {
        let status = 0;
        const res = { status(c) { status = c; return this; }, json() { return this; } };
        originGuard({ headers, socket: { remoteAddress } }, res, () => { status = 200; });
        return status;
    };
    const rebound = { host: 'printer.local:3001', origin: 'http://printer.local:3001', 'sec-fetch-site': 'same-origin' };
    ok('guard 403s a .local name arriving on loopback', from('127.0.0.1', rebound) === 403 && from('::1', rebound) === 403 && from('::ffff:127.0.0.1', rebound) === 403);
    ok('…and passes it from another device on the LAN', from('192.168.1.9', rebound) === 200);
    ok('…and localhost on loopback is untouched', from('127.0.0.1', { host: 'localhost:3001', origin: 'http://localhost:3001', 'sec-fetch-site': 'same-origin' }) === 200);
}
// The head of the middleware chain is recorded in server/app.js in the order
// createApp mounts it.
const indexForOrder = fs.readFileSync(path.join(root, 'server/app.js'), 'utf8');
const at = (s) => indexForOrder.indexOf(s);
ok('origin guard and headers run before the body parser and CORS',
    at("app.use('/api', originGuard)") > 0 && at("res.setHeader('X-Content-Type-Options', 'nosniff')") < at("app.use('/api', originGuard)")
    && at("app.use('/api', originGuard)") < at("app.use(express.json(") && at("app.use('/api', originGuard)") < at('app.use(cors('));

// --- 2b. the aggregate cap on a multipart upload ----------------------------
// multer's caps are per file, so the body is judged on Content-Length BEFORE
// any of it is read. A body that declares no length (chunked) is the one
// shape that check cannot bound, so it is refused rather than let through on
// the per-file caps.
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
    // The whole fe80::/10, not the text "fe80:" (fe81::1 and febf::1 must
    // be refused too), plus case and the other
    // bit-prefixed ranges at both ends.
    'fe81::1', 'fea0::1', 'febf::1', 'FE81::1', 'fec0::1', 'fc00::1', 'ff02::1',
    // An IPv4 address inside an IPv6 one, in the forms the URL parser and a
    // resolver actually produce: new URL('http://[::ffff:127.0.0.1]/') writes
    // the host as [::ffff:7f00:1], which a dotted-quad test never sees.
    '::ffff:7f00:1', '[::ffff:7f00:1]', '::ffff:a9fe:a9fe', '::ffff:10.0.0.1', '0:0:0:0:0:ffff:7f00:1',
    '::127.0.0.1', '::7f00:1', '64:ff9b::7f00:1', '64:ff9b::127.0.0.1', '64:ff9b:1::1', '2002:7f00:1::1',
    '2001:0:4136:e378::1', 'fe80::1%eth0', '::ffff:0:127.0.0.1', '::ffff:0:7f00:1',
    // The special-purpose blocks that are not globally reachable: IETF
    // protocol assignments, the three documentation ranges, discard-only IPv6,
    // and the same inside an IPv6 wrapper.
    '192.0.0.8', '192.0.2.10', '198.51.100.7', '203.0.113.5',
    '100::1', '100::ffff:ffff:ffff:ffff', '::ffff:c000:20a']) {
    ok(`address blocked: ${ip}`, isBlockedAddress(ip));
}
for (const ip of ['93.184.216.34', '8.8.8.8', '2606:2800:220:1:248:1893:25c8:1946',
    // Just outside each range: a public address that merely LOOKS close.
    'fe7f::1', 'fb00::1', '2001:db8::1',
    '198.17.255.255', '198.20.0.1', '192.0.1.1', '192.0.3.1', '198.51.101.1', '203.0.114.1', '100:0:0:1::1',
    // A public IPv4 address stays fetchable in the same wrappers.
    '::ffff:808:808', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::1',
    // The benchmarking block 198.18.0.0/15 stays ALLOWED on purpose. Proxy
    // clients in fake-IP mode (Clash, Surge, sing-box) and some VPN clients
    // answer every public name with an address from it and carry the real
    // connection themselves, so refusing it would refuse every fetch on those
    // machines, and the only way out would be ALLOW_PRIVATE_FETCH=1, which
    // opens every private target at once.
    '198.18.0.1', '198.19.255.254', '::ffff:198.18.0.1']) {
    ok(`address allowed: ${ip}`, !isBlockedAddress(ip));
}

const refuses = async (url) => {
    try { await assertFetchable(url); return false; } catch { return true; }
};
for (const u of ['http://127.0.0.1:8888/v1/models', 'http://localhost:11434/api/tags', 'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data/', 'http://[::1]:3001/api/projects', 'file:///etc/passwd',
    'javascript:alert(1)', 'http://2130706433/', 'http://user:pass@example.com/',
    'http://[::ffff:127.0.0.1]:3001/api/projects', 'http://[::ffff:169.254.169.254]/latest/meta-data/']) {
    ok(`fetch refused: ${u}`, await refuses(u));
}

// --- 4. the one endpoint that fetches a private address on purpose ---------
// A SearXNG instance is normally on loopback or the LAN, so `/api/searxng/test`
// is exempt from netSafety. That exemption is about the ADDRESS; the endpoint
// still has to refuse a scheme the learner cannot have meant and must not
// follow a redirect, or the reply ("reachable" / "status N" / "timed out")
// answers the same question for anything else on the network. Source scan,
// because the route is inside the server's own request wiring.
const indexSrc = (await import('./lib/serverSource.mjs')).httpLayer();
const probeStart = indexSrc.indexOf("app.post('/api/searxng/test'");
ok('the SearXNG probe route exists', probeStart > 0);
// The route ends at the next registration or at the end of its file.
const probeEnd = Math.min(...['\napp.', '\nexport const ', '\n// ==== server/']
    .map((s) => indexSrc.indexOf(s, probeStart + 10)).filter((i) => i > 0));
const probe = indexSrc.slice(probeStart, probeEnd);
ok('probe refuses a non-http scheme', /SAFE_URL_PROTOCOLS\.includes\(\s*parsed\.protocol\s*\)/.test(probe));
ok('probe does not follow redirects', /redirect:\s*'manual'/.test(probe));
ok('probe bounds the URL length', /MAX_URL_LENGTH/.test(probe));
ok('probe fetches once', (probe.match(/\bfetch\(/g) || []).length === 1);

// --- 5. a vetted fetch stays vetted through the probe ----------------------
// assertFetchable vets only the INITIAL url; a bare fetch after it follows
// redirects un-vetted, so an open redirect hands the connection to an internal
// address and answers the probe with its status. Every call site outside netSafety.js must
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
ok('safeFetch re-vets every hop', /for \(let hop[\s\S]*await vetUrl\(target\)/.test(sfBody));
ok('safeFetch never follows redirects itself', /redirect:\s*'manual'/.test(sfBody));
// Where the socket actually goes is measured in tools/dns-pinning-gates.mjs
// (a resolver that answers the vet and the socket differently); this only
// keeps the two halves of the pin from drifting apart. Node's built-in fetch
// with the npm Agent fails at runtime ("invalid onRequestStart method").
ok('safeFetch connects through a dispatcher pinned to the vetted addresses', /dispatcher = new Agent\(\{[^}]*connect: \{ lookup: pinnedLookup\(/.test(sfBody) && /undiciFetch\([^)]*dispatcher/.test(sfBody));
// One Agent per hop, never reused: with keep-alive on, each fetch left its
// socket open for as long as the server's Keep-Alive hint (600 s measured).
ok('…with keep-alive off (pipelining: 0), so a per-hop Agent leaves no idle socket', /new Agent\(\{ pipelining: 0,/.test(sfBody));
ok('…and the Agent and the fetch come from the same undici', /import \{ Agent, fetch as undiciFetch \} from 'undici'/.test(netSrc) && !/(?<![.\w])fetch\(/.test(sfBody));

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
    ok('a caller asking for redirect:"follow" still has every hop vetted',
        /refused a redirect/.test(landed?.followRefused || '') && landed?.trapHits === 0, `${landed?.followRefused} · trap hit ${landed?.trapHits}`);

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
    for (const k of ['auth_password_hash', 'auth_session_secret', 'auth_api_key', 'ai_openai_api_key', 'ai_api_format', 'ai_active_connection']) {
        ok(`settings dump refuses ${k}`, auth.isSecretSettingKey(k));
    }
    ok('settings dump carries ordinary settings', !['theme', 'accent', 'ai_model', 'ai_provider', 'ai_reasoning_effort'].some(k => auth.isSecretSettingKey(k)));
    const dumpGet = indexSrc.slice(indexSrc.indexOf("app.get('/api/settings'"), indexSrc.indexOf('\napp.', indexSrc.indexOf("app.get('/api/settings'")));
    ok('GET /api/settings filters through isSecretSettingKey', dumpGet.includes('isSecretSettingKey'));
    const dumpPut = indexSrc.slice(indexSrc.indexOf("app.put('/api/settings/:key'"), indexSrc.indexOf('\napp.', indexSrc.indexOf("app.put('/api/settings/:key'")));
    ok('PUT /api/settings/:key refuses secrets too', dumpPut.includes('isSecretSettingKey'));
    ok('the provider key has its own write route', indexSrc.includes("app.put('/api/ai/key'") && indexSrc.includes("app.delete('/api/ai/key'"));
    ok('/api/ai/status answers hasApiKey, not the key', /\napp\.get\('\/api\/ai\/status'[\s\S]*?hasApiKey/.test(indexSrc));
    // The Settings screen is a shell over one file per tab (src/components/settings/),
    // so the whole screen is read, not only the file that holds the key form.
    const settingsDir = path.join(root, 'src/components/settings');
    const settingsTsx = [path.join(root, 'src/components/Settings.tsx'),
        ...fs.readdirSync(settingsDir, { recursive: true }).filter(f => /\.tsx?$/.test(f)).map(f => path.join(settingsDir, f))]
        .map(f => fs.readFileSync(f, 'utf8')).join('\n');
    ok('Settings no longer reads the key from the dump', !/\.ai_openai_api_key\b/.test(settingsTsx));
    // Keys are typed in the Connect dialog (settings/connections/) and written
    // through the saved-connections routes, which test them first; the generic
    // settings writer is never handed one.
    ok('Settings writes keys through the connections routes, never the settings writer',
        settingsTsx.includes('api.addConnection(') && settingsTsx.includes('api.updateConnection(')
        && !/setSetting\(\s*['"]ai_openai_api_key/.test(settingsTsx));
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
    // The door is now three pieces: the route (which opens the archive and tells
    // a course from a library), `importBundleZip` (the ONE bundle parser, which
    // every course and every entry of a library passes through) and
    // `importLibraryZip`. The bound has to hold in all of them.
    const bundleRoute = indexSrc.slice(bundleFrom, indexSrc.indexOf('\napp.', bundleFrom + 10));
    const sliceFn = (name) => { const at = indexSrc.indexOf(`async function ${name}(`); return at < 0 ? '' : indexSrc.slice(at, indexSrc.indexOf('\n}\n', at)); };
    const bundleBody = [bundleRoute, sliceFn('importBundleZip'), sliceFn('importLibraryZip')].join('\n');
    ok('the bundle importer and the library reader exist', sliceFn('importBundleZip').length > 0 && sliceFn('importLibraryZip').length > 0);
    ok('the bundle door checks the archive before reading it', /assertZipSafe\(/.test(bundleRoute));
    ok('the bundle door reads entries through readZipEntry', sliceFn('importBundleZip').includes('readZipEntry(') && sliceFn('importLibraryZip').includes('readZipEntry('));
    ok('the bundle door has no unbounded entry read left', !/\.async\('(nodebuffer|string)'\)/.test(bundleBody));
    ok('each project of a library is checked before it is read', /assertZipSafe\(innerZip/.test(sliceFn('importLibraryZip')));

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
    const parseAt = extractBody.indexOf('parseOfficeIsolated(');
    ok('extractText runs the inflate pass before mammoth and ExcelJS', guardAt > 0 && parseAt > guardAt);
    ok('extractText never calls mammoth or ExcelJS on its own thread',
        !/mammoth\.|extractXlsx\(|parseOffice\(/.test(extractBody.slice(0, extractBody.indexOf('\n}\n'))));
    // The bytes are bounded; the TREE the parser builds from them is not, and it
    // costs up to ~100x the XML (a 367 kB docx of one-letter runs, 120 MB of XML,
    // took the whole server down). So the parse runs in a child process with a
    // heap ceiling (a worker thread's ceiling let V8 abort the whole process on
    // some inputs). Proved here with a small ceiling so the gate allocates
    // little: a 4 MB document.xml of tiny runs needs ~400 MB and must be
    // REFUSED, not crash this process.
    const { parseOfficeIsolated } = await import('../server/extract.js');
    const runs = new JSZip();
    runs.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    runs.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    runs.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${'<w:p><w:r><w:t>a</w:t></w:r></w:p>'.repeat(4 * 1024 * 1024 / 34)}</w:body></w:document>`);
    const runsDoc = await runs.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const tree = await parseOfficeIsolated('docx', runsDoc, { heapMb: 64 })
        .then(() => 'read', (e) => (e.tooLarge ? 'refused' : `other: ${e.message}`));
    ok('a docx whose parse outgrows the reader heap is refused and this process lives', tree === 'refused', tree);
    runs.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Snell law</w:t></w:r></w:p></w:body></w:document>');
    const honestDoc = await extractText(await runs.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), 'ok.docx').then(r => r.text, (e) => `error: ${e.message}`);
    ok('an honest docx still reads through the child process', honestDoc.includes('Snell law'), honestDoc.slice(0, 80));
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
// The function is lifted out of its own source (server/ai.js, shared by the
// route and the vision probe), the way the markdown schema above is lifted out
// of its .ts: a copy would drift from the thing it guards. The pre-fix
// one-liner is run beside it as the control, so the fixture cannot pass by
// naming a harmless string.
{
    const aiSrc = fs.readFileSync(path.join(root, 'server', 'ai.js'), 'utf8');
    const from = aiSrc.indexOf('export function modelEndpointPath(');
    ok('modelEndpointPath exists in server/ai.js', from > 0);
    const probeFile = path.join(root, 'tools', '.modelPath.probe.mjs');
    fs.writeFileSync(probeFile, aiSrc.slice(from, aiSrc.indexOf('\n}', from) + 2));
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

// --- 9. the provider key goes only where it was saved for -----------------
// The base URL is an ordinary preference, writable through the generic
// settings route; the key is not. Before the binding, anything that could
// write one setting could aim the app at its own host and receive the key on
// the next model call. Driven through the real getAISettings against the
// scratch database section 6 opened, then a SECOND PROCESS for the upgrade
// path (a key saved before the binding existed must stay usable where it was).
{
    const setRow = (k, v) => authDb().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(k, v);
    const delRow = (k) => authDb().prepare('DELETE FROM settings WHERE key = ?').run(k);
    function authDb() { return dbModule.default; }
    const dbModule = await import('../server/database.js');
    delete process.env.AI_API_KEY; delete process.env.OPENAI_API_KEY; delete process.env.AI_BASE_URL;
    setRow('ai_openai_base_url', 'https://openrouter.ai/api/v1');
    const ai = await import('../server/ai.js');
    const auth = await import('../server/auth.js');

    ok('the origin row is refused by the generic writer', auth.isSecretSettingKey(ai.API_KEY_ORIGIN_SETTING));
    ok('an origin is scheme + host + port', ai.apiKeyOriginOf('https://openrouter.ai/api/v1') === 'https://openrouter.ai'
        && ai.apiKeyOriginOf('http://127.0.0.1:8888') === 'http://127.0.0.1:8888'
        && ai.apiKeyOriginOf('http://127.0.0.1:8889/v1') !== ai.apiKeyOriginOf('http://127.0.0.1:8888/v1'));
    ok('an unparseable or opaque URL binds nothing', ai.apiKeyOriginOf('not a url') === '' && ai.apiKeyOriginOf('file:///etc/passwd') === '');

    // Through the one writer the routes use: the key and its origin into the
    // credentials file beside the library, the origin also into the library.
    ai.saveActiveKey('sk-gate', 'https://openrouter.ai');
    ok('the key is sent to the origin it was saved for', ai.getAISettings().apiKey === 'sk-gate');
    setRow('ai_openai_base_url', 'https://attacker.example/v1');
    let s = ai.getAISettings();
    ok('a re-aimed base URL gets no key', s.apiKey === '' && s.apiKeyWithheld === true && s.apiKeyOrigin === 'https://openrouter.ai');
    setRow('ai_openai_base_url', 'https://openrouter.ai:8443/api/v1');
    ok('...nor does another PORT on the same host', ai.getAISettings().apiKey === '');
    setRow('ai_openai_base_url', 'https://openrouter.ai/api/v1/');
    ok('setting it back brings the key back (withheld, not deleted)', ai.getAISettings().apiKey === 'sk-gate');
    // The library's origin row is writable by nothing but the key routes, but a
    // library restored beside a credentials file of another time can still
    // name another origin: the key goes only where BOTH copies say.
    setRow(ai.API_KEY_ORIGIN_SETTING, 'https://attacker.example');
    setRow('ai_openai_base_url', 'https://attacker.example/v1');
    ok('a library that names another origin than the credentials file gets no key', ai.getAISettings().apiKey === '');
    setRow(ai.API_KEY_ORIGIN_SETTING, 'https://openrouter.ai');
    setRow('ai_openai_base_url', 'https://openrouter.ai/api/v1');
    delRow(ai.API_KEY_ORIGIN_SETTING);
    ok('a stored key with no origin row is sent nowhere', ai.getAISettings().apiKey === '');

    // The operator's env key: bound to AI_BASE_URL when set, otherwise to the
    // base URL this process started with (openrouter, set before the import).
    ai.clearActiveKey();
    process.env.AI_API_KEY = 'sk-env';
    setRow('ai_openai_base_url', 'https://openrouter.ai/api/v1');
    ok('an env key goes to the base URL the process started with', ai.getAISettings().apiKey === 'sk-env');
    setRow('ai_openai_base_url', 'https://attacker.example/v1');
    ok('...and not to one written afterwards', ai.getAISettings().apiKey === '' && ai.getAISettings().apiKeyWithheld === true);
    process.env.AI_BASE_URL = 'https://api.example.com/v1';
    ok('AI_BASE_URL pins the env key to itself (and the calls go there too)', ai.getAISettings().apiKey === 'sk-env' && ai.getAISettings().baseUrl === 'https://api.example.com/v1');
    delete process.env.AI_API_KEY; delete process.env.AI_BASE_URL;

    const route = indexSrc.slice(indexSrc.indexOf("app.put('/api/ai/key'"), indexSrc.indexOf("app.delete('/api/ai/key'"));
    ok('PUT /api/ai/key saves the key with the origin it was entered for', route.includes('saveActiveKey(apiKey, origin)') && route.includes('apiKeyOriginOf('));
    ok('clearing the key clears its origin', route.includes('clearActiveKey()')
        && (ai.clearActiveKey(), !authDb().prepare('SELECT 1 FROM settings WHERE key = ?').get(ai.API_KEY_ORIGIN_SETTING)));

    // Upgrade: a library with a key and no origin row gets one on boot, bound
    // to the base URL it was using. Its own process, its own file.
    const upScratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-gates-up-'));
    const upDb = path.join(upScratch, 'up.db');
    const seed = `import Database from 'better-sqlite3'; const d = new Database(${JSON.stringify(upDb)});
        d.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)");
        d.prepare("INSERT INTO settings VALUES ('ai_openai_api_key','sk-old'),('ai_openai_base_url','https://openrouter.ai/api/v1')").run(); d.close();`;
    const boot = `const m = await import(${JSON.stringify(pathToFileURL(path.join(root, 'server/database.js')).href)});
        const r = m.default.prepare("SELECT value FROM settings WHERE key='ai_openai_api_key_origin'").get(); console.log('ORIGIN=' + (r?.value ?? ''));`;
    const env = { ...process.env, DB_PATH: upDb, VAULT_ROOT: path.join(upScratch, 'vault') };
    spawnSync(process.execPath, ['--input-type=module', '-e', seed], { cwd: root, env });
    const out = spawnSync(process.execPath, ['--input-type=module', '-e', boot], { cwd: root, env, encoding: 'utf8' });
    ok('an upgraded library binds its saved key to the base URL it used', /ORIGIN=https:\/\/openrouter\.ai\s*$/m.test(out.stdout || ''));
    try { fs.rmSync(upScratch, { recursive: true, force: true }); } catch { /* a temp dir */ }
}

// --- 10. no password means this machine only ------------------------------
// An app with no password served every note to whoever could reach its port,
// and the first stranger to POST /api/auth/setup chose the password. Driven
// through the real middleware against the scratch database above: a response
// double records what requireAuth did.
{
    const auth = await import('../server/auth.js');
    auth.clearAuth();
    delete process.env.AUTH_ALLOW_OPEN_REMOTE;
    const run = (ip, headers = {}) => {
        let status = 200, body = null, passed = false;
        const res = { status(s) { status = s; return this; }, json(b) { body = b; return this; } };
        auth.requireAuth({ ip, headers, socket: { remoteAddress: ip } }, res, () => { passed = true; });
        return { passed, status, body };
    };
    const quiet = console.log; console.log = () => {};
    try {
        ok('no password: this machine (IPv4 loopback) is let through', run('127.0.0.1').passed);
        ok('no password: this machine (IPv6 loopback) is let through', run('::1').passed && run('::ffff:127.0.0.1').passed);
        const lan = run('192.168.1.20');
        ok('no password: another machine is refused', !lan.passed && lan.status === 401 && lan.body?.setupRequired === true);
        ok('no password: a container bridge address is another machine', !run('172.17.0.1').passed);
        ok('no password: a tailnet peer relayed by a local proxy is judged by its own address', !run('100.101.102.103').passed);
        process.env.AUTH_ALLOW_OPEN_REMOTE = '1';
        ok('AUTH_ALLOW_OPEN_REMOTE=1 restores the open LAN', run('192.168.1.20').passed);
        delete process.env.AUTH_ALLOW_OPEN_REMOTE;

        const code = auth.announceSetupCode();
        ok('the setup code is long enough not to guess (12 hex digits)', /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/.test(code));
        ok('the setup code is stable until spent', auth.announceSetupCode() === code);
        ok('the right code is accepted, typed lowercase or padded', auth.checkSetupCode(code) && auth.checkSetupCode(` ${code.toLowerCase()} `));
        ok('a wrong or missing code is refused', !auth.checkSetupCode('0000-0000-0000') && !auth.checkSetupCode(undefined) && !auth.checkSetupCode(''));
        auth.clearSetupCode();
        ok('a spent code no longer works', !auth.checkSetupCode(code));
    } finally { console.log = quiet; }

    // The routes: status tells a remote device to set up, setup demands the
    // code from anything but this machine, and the throttle applies to it.
    const setupRoute = indexSrc.slice(indexSrc.indexOf("app.post('/api/auth/setup'"), indexSrc.indexOf("app.post('/api/auth/change'"));
    ok('setup from another machine checks the code', /if \(!isLocalRequest\(req\)\)[\s\S]*checkSetupCode\(/.test(setupRoute));
    ok('...under the login throttle', setupRoute.includes('loginBlocked(') && setupRoute.includes('recordLoginFailure('));
    ok('...and a set password spends the code', setupRoute.includes('clearSetupCode()'));
    const statusRoute = indexSrc.slice(indexSrc.indexOf("app.get('/api/auth/status'"), indexSrc.indexOf("app.post('/api/auth/login'"));
    ok('status answers setupRequired to another machine', statusRoute.includes('remoteSetupRequired(req)') && statusRoute.includes('setupRequired: true'));
    ok('trust proxy stays loopback-only (a remote client cannot claim to be local)', /app\.set\('trust proxy', 'loopback'\)/.test(indexSrc));
}

// --- 11. an AI-drawn animation is inert, and stays inside its own frame ------
// The scene is mounted INLINE, so three things about it are the page's: a link
// it can rewrite, a resource it can fetch, and a stylesheet that is the whole
// document's. Driven through the real sanitizer (bundled, under jsdom), and the
// same cases through the pre-fix sanitizer (tools/fixtures/) as the control.
{
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const esbuild = require('esbuild');
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><body></body>');
    for (const k of ['window', 'document', 'DOMParser', 'XMLSerializer', 'Node', 'NodeFilter', 'SVGElement', 'CSSStyleSheet']) globalThis[k] = k === 'window' ? dom.window : dom.window[k];
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-svg-'));
    const load = async (entry, name) => {
        const outfile = path.join(scratch, `${name}.mjs`);
        await esbuild.build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent' });
        return import(pathToFileURL(outfile).href);
    };
    const current = await load(path.join(root, 'src/components/visuals/sanitizeSvgAnim.ts'), 'current');
    // Pinned, not read from HEAD: once the fix is committed, HEAD IS the fix,
    // and a control that runs the current code proves nothing.
    const preFix = await load(path.join(root, 'tools/fixtures/sanitizeSvgAnim.prefix.ts'), 'prefix');

    const scene = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 600 300">${inner}<circle cx="10" cy="10" r="5"><animate attributeName="cx" values="10;50;10" dur="2s" repeatCount="indefinite"/></circle></svg>`;
    const out = (mod, inner) => new XMLSerializer().serializeToString(mod.sanitizeAnimatedSvg(scene(inner)));
    const cases = [
        ['a <set> may not rewrite a link to javascript:', '<a href="#x"><set attributeName="href" to="javascript:alert(1)"/><text>go</text></a>', s => !/javascript:/i.test(s)],
        ['an <animate> may not rewrite xlink:href', '<a><animate attributeName="xlink:href" values="#a;javascript:alert(1)" dur="1s"/></a>', s => !/javascript:/i.test(s)],
        ['fill="url(https://…)" fetches nothing', '<rect width="5" height="5" fill="url(https://tracker.example/p.svg#g)"/>', s => !/tracker\.example/.test(s)],
        ['a style attribute fetches nothing', '<rect width="5" height="5" style="fill:red;background:url(http://tracker.example/p.png)"/>', s => !/tracker\.example/.test(s)],
        ['a stylesheet rule reaches only the drawing', '<style>.flex{display:none} body{background:red} rect{fill:blue}</style>', s => /\[data-vb-scope="[a-z0-9]+"\] \.flex/.test(s) && !/(^|[}\s>])\.flex\s*\{/.test(s.replace(/\[data-vb-scope="[a-z0-9]+"\] \.flex/g, ''))],
        ['its @keyframes cannot take the app\'s own name', '<style>@keyframes spin { from { opacity: 0 } to { opacity: 1 } } rect { animation: spin 2s infinite }</style><rect width="5" height="5"/>', s => /@keyframes spin-[a-z0-9]+/.test(s) && !/@keyframes spin\s*\{/.test(s) && /animation[^;]*spin-[a-z0-9]+/.test(s) && !/animation[^;]*spin\s/.test(s)],
        ['a CSS escape does not smuggle a url()', '<style>rect { background: \\75 rl(http://tracker.example/e.png) }</style>', s => !/tracker\.example/.test(s)],
        ['image-set() fetches nothing', '<style>rect { background-image: image-set("http://tracker.example/i.png" 1x) }</style>', s => !/tracker\.example/.test(s)],
        ['@import is dropped', '<style>@import url(http://tracker.example/x.css); rect { fill: red }</style>', s => !/tracker\.example|@import/.test(s)],
    ];
    for (const [label, inner, safe] of cases) {
        let s = '';
        try { s = out(current, inner); } catch (e) { s = `THREW ${e.message}`; }
        ok(`svg: ${label}`, safe(s) && !s.startsWith('THREW'));
    }
    // The drawing must still draw: an internal gradient and a CSS-only scene live.
    const keep = out(current, '<defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/></linearGradient></defs><rect width="5" height="5" fill="url(#g)"/>');
    ok('svg: an internal url(#g) is kept', /fill="url\(#g\)"/.test(keep));
    let cssOnly = '';
    try {
        cssOnly = new XMLSerializer().serializeToString(current.sanitizeAnimatedSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 300"><style>@keyframes pulse { 0% { opacity: 0.2 } 100% { opacity: 1 } } .dot { animation: pulse 1s infinite; font-size: 8px }</style><circle class="dot" cx="5" cy="5" r="4"/></svg>'));
    } catch (e) { cssOnly = `THREW ${e.message}`; }
    ok('svg: a CSS-only animation still counts as animated after scoping', !cssOnly.startsWith('THREW') && /animation[^;]*pulse-[a-z0-9]+/.test(cssOnly));
    ok('svg: the label floor still reads the rebuilt stylesheet', /font-size: 12(\.0)?px/.test(cssOnly));
    const controls = cases.filter(([, inner, safe]) => { try { return !safe(out(preFix, inner)); } catch { return false; } }).length;
    ok(`svg: the pre-fix sanitizer fails these cases (the control, ${controls}/${cases.length})`, controls >= 6);

    // What a drawing may CONTAIN is a list of what is allowed, not of what is
    // forbidden. An XML parse admits any namespace, and an element of the HTML
    // namespace inside a <g> is an HTML element in the page once the scene is
    // mounted: an <html:img> fetches, an <html:meta http-equiv=refresh>
    // navigates, and neither name was on the old list. Each case must leave
    // nothing outside the SVG namespace and no off-document address; the
    // denylist this replaced kept the first five (the red run, on the old file).
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const HTML = 'xmlns:h="http://www.w3.org/1999/xhtml"';
    const allowCases = [
        ['an HTML image inside a group', `<g ${HTML}><h:img src="http://tracker.example/i.png"/></g>`],
        ['an HTML refresh inside a group', `<g ${HTML}><h:meta http-equiv="refresh" content="0;url=http://tracker.example/"/></g>`],
        ['an HTML audio element', `<h:audio ${HTML} src="http://tracker.example/a.mp3" autoplay="autoplay"/>`],
        ['an HTML image by srcset',`<h:img ${HTML} srcset="http://tracker.example/s.png 1x"/>`],
        ['a foreignObject written in capitals', '<FOREIGNOBJECT width="9" height="9"><body xmlns="http://www.w3.org/1999/xhtml"><img src="http://tracker.example/f.png"/></body></FOREIGNOBJECT>'],
        ['a namespaced foreignObject', `<s:foreignObject xmlns:s="${SVG_NS}" width="9" height="9"><h:iframe ${HTML} src="http://tracker.example/"/></s:foreignObject>`],
        ['a link to javascript: by xlink:href', '<a xlink:href="javascript:alert(1)"><text y="20">go</text></a>'],
        ['an animation whose target is a handler', '<rect width="5" height="5"><animate attributeName="onbegin" to="alert(1)" dur="1s"/></rect>'],
        ['a handler on an animation', '<rect width="5" height="5"><animate attributeName="x" values="0;5" dur="1s" onbegin="alert(1)"/></rect>'],
        ['a use of a data: document', '<use href="data:image/svg+xml,%3Csvg%20onload%3Dalert(1)%3E"/>'],
    ];
    const foreign = (svg) => [svg, ...svg.querySelectorAll('*')].filter(el => el.namespaceURI !== SVG_NS).map(el => el.tagName);
    const allowVerdict = (mod, inner) => {
        const svg = mod.sanitizeAnimatedSvg(scene(inner));
        const s = new XMLSerializer().serializeToString(svg);
        return { s, bad: foreign(svg).length > 0 || /tracker\.example|javascript:|alert\(|data:image/i.test(s) };
    };
    for (const [label, inner] of allowCases) {
        let v;
        try { v = allowVerdict(current, inner); } catch (e) { v = { bad: true, s: `THREW ${e.message}` }; }
        ok(`svg allowlist: ${label} leaves nothing that runs, loads or navigates${v.bad ? ` — ${v.s.slice(0, 200)}` : ''}`, !v.bad);
    }

    // ...and the allowlist must not cost a drawing anything. One scene that uses
    // every element and attribute the animation guide teaches (gradients,
    // filters, markers, clip paths, masks, patterns, symbols and <use>, text on
    // a path, all four SMIL elements and their timing attributes, a CSS
    // keyframe): every element and every attribute name must come out.
    const kitchen = `<svg xmlns="${SVG_NS}" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 600 300">
<title>t</title><desc>d</desc>
<style>@keyframes pulse { 0% { opacity: 0.2 } 100% { opacity: 1 } } .dot { animation: pulse 1s infinite }</style>
<defs>
<linearGradient id="lg" x1="0" y1="0" x2="1" y2="1" gradientUnits="objectBoundingBox" gradientTransform="rotate(10)" spreadMethod="pad"><stop offset="0" stop-color="#f00" stop-opacity="0.5"/></linearGradient>
<radialGradient id="rg" cx="0.5" cy="0.5" r="0.5" fx="0.4" fy="0.4"><stop offset="1" stop-color="#00f"/></radialGradient>
<filter id="f" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur in="SourceGraphic" stdDeviation="2" result="b"/><feOffset dx="1" dy="1"/><feMerge><feMergeNode in="b"/></feMerge><feColorMatrix type="saturate" values="0.5"/><feDropShadow dx="1" dy="1" stdDeviation="1" flood-color="#000" flood-opacity="0.3"/></filter>
<marker id="m" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse" markerUnits="strokeWidth"><path d="M0 0L10 5L0 10z"/></marker>
<clipPath id="cp" clipPathUnits="userSpaceOnUse"><rect width="50" height="50"/></clipPath>
<mask id="mk" maskUnits="userSpaceOnUse"><rect width="50" height="50" fill="#fff"/></mask>
<pattern id="pt" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><circle cx="5" cy="5" r="2"/></pattern>
<symbol id="sy" viewBox="0 0 10 10" preserveAspectRatio="xMidYMid meet"><circle cx="5" cy="5" r="4"/></symbol>
<path id="orbit" d="M100 150 A 50 50 0 1 1 200 150 A 50 50 0 1 1 100 150" pathLength="100"/>
</defs>
<g transform="translate(10 10)" opacity="0.9" clip-path="url(#cp)" mask="url(#mk)" filter="url(#f)">
<rect x="1" y="1" width="40" height="20" rx="3" ry="3" fill="url(#lg)" stroke="url(#rg)" stroke-width="2" stroke-dasharray="4 2" stroke-dashoffset="1" stroke-linecap="round" stroke-linejoin="round" fill-opacity="0.8" vector-effect="non-scaling-stroke"/>
<ellipse cx="60" cy="30" rx="10" ry="5" fill="url(#pt)"/>
<line x1="0" y1="0" x2="50" y2="50" marker-end="url(#m)" marker-start="url(#m)"/>
<polyline points="0,0 10,10 20,0" fill="none"/><polygon points="0,0 10,10 20,0" fill-rule="evenodd"/>
<use href="#sy" x="100" y="10" width="20" height="20"/><use xlink:href="#sy" x="130" y="10" width="20" height="20"/>
<circle class="dot" cx="5" cy="5" r="4" transform-origin="5 5"/>
<text x="10" y="80" font-family="sans-serif" font-size="14" font-weight="bold" text-anchor="middle" dominant-baseline="middle" letter-spacing="1" textLength="80" lengthAdjust="spacingAndGlyphs">a<tspan dx="2" dy="1" fill="#333">b</tspan></text>
<text font-size="12"><textPath href="#orbit" startOffset="10%">around</textPath></text>
<circle r="5"><animateMotion dur="4s" repeatCount="indefinite" rotate="auto" keyPoints="0;1" keyTimes="0;1" calcMode="linear"><mpath href="#orbit"/></animateMotion></circle>
<rect width="5" height="5"><animate attributeName="x" from="0" to="50" by="5" dur="2s" begin="0s" end="indefinite" fill="freeze" restart="always" repeatDur="indefinite" additive="sum" accumulate="none" attributeType="XML"/></rect>
<rect width="5" height="5"><animate attributeName="opacity" values="0;1;0" keyTimes="0;0.5;1" keySplines="0.4 0 0.2 1;0.4 0 0.2 1" calcMode="spline" dur="2s" repeatCount="indefinite" min="1s" max="5s"/></rect>
<g><animateTransform attributeName="transform" type="rotate" from="0 300 150" to="360 300 150" dur="8s" repeatCount="indefinite"/><rect x="290" y="140" width="20" height="20"/></g>
<rect id="flash" width="5" height="5"><set attributeName="fill" to="#f00" begin="1s" dur="1s"/></rect>
</g></svg>`;
    const names = (svg) => new Set([svg, ...svg.querySelectorAll('*')].flatMap(el => [`<${el.localName}>`, ...[...el.attributes].map(a => `<${el.localName}> ${a.name}`)]));
    let kept = null;
    try { kept = names(current.sanitizeAnimatedSvg(kitchen)); } catch (e) { kept = e; }
    const before = names(new DOMParser().parseFromString(kitchen, 'image/svg+xml').documentElement);
    const lost = kept instanceof Error ? [`THREW ${kept.message}`] : [...before].filter(n => !kept.has(n));
    ok(`svg allowlist: a scene using every taught element and attribute keeps all of them${lost.length ? ` — lost ${lost.join(', ')}` : ''}`, lost.length === 0);
    // The control: the first five cases are ones a list of forbidden names let through.
    const keptBefore = allowCases.slice(0, 5).filter(([, inner]) => { try { return allowVerdict(preFix, inner).bad; } catch { return false; } }).length;
    ok(`svg allowlist control: the pre-fix sanitizer keeps all five of the first cases (${keptBefore}/5)`, keptBefore === 5);
    // An id is a drawing's own name for a gradient or a <use> target, even
    // when it is also the name of a document property.
    const ids = current.sanitizeAnimatedSvg(scene('<defs><linearGradient id="title"><stop offset="0"/></linearGradient><g id="body"><rect width="4" height="4"/></g></defs><use href="#body"/><rect fill="url(#title)" width="9" height="9"/><text id="links">t</text>'));
    ok('svg allowlist: ids named like document properties (title, body, links) keep their names',
        ['title', 'body', 'links'].every(id => ids.querySelector(`[id="${id}"]`)), new XMLSerializer().serializeToString(ids).slice(0, 200));
    // A model that forgets xmlns still gets its drawing, in the SVG namespace.
    let bare;
    try { bare = current.sanitizeAnimatedSvg('<svg viewBox="0 0 600 300"><circle cx="10" cy="10" r="5"><animate attributeName="cx" values="10;50;10" dur="2s" repeatCount="indefinite"/></circle></svg>'); } catch (e) { bare = e; }
    ok(`svg allowlist: an <svg> written without xmlns is drawn${bare instanceof Error ? ` — THREW ${bare.message}` : ''}`,
        !(bare instanceof Error) && bare.namespaceURI === SVG_NS && bare.querySelector('animate')?.namespaceURI === SVG_NS);

    // "Is this image / chart data address our own?" is answered by resolving
    // it the way the browser will. The old test read the TEXT ("starts with /,
    // not //"), and a browser resolves "/\host" and "/<tab>/host" off-origin.
    const { isSameOrigin, isInertOwnAddress, planLink } = await load(path.join(root, 'src/utils/sameOrigin.ts'), 'sameorigin');
    const here = 'http://127.0.0.1:3001/project/4/study';
    const oldTest = (src) => src.startsWith('/') && !src.startsWith('//');
    const leaves = ['//evil.example/p.png', '/\\evil.example/p.png', '/\t/evil.example/p.png', '/\n/evil.example/p.png',
        'https://evil.example/p.png', 'http://127.0.0.1:3002/api/media/x', 'data:image/png;base64,AAAA', 'javascript:alert(1)'];
    for (const src of leaves) ok(`same-origin: ${JSON.stringify(src)} is another origin`, !isSameOrigin(src, here));
    for (const src of ['/api/media/abc123', '/assets/logo.png', 'http://127.0.0.1:3001/api/media/x', 'api/media/rel'])
        ok(`same-origin: ${JSON.stringify(src)} is this origin`, isSameOrigin(src, here));
    ok('same-origin: the old text test let the backslash and tab forms through (the control)',
        oldTest('/\\evil.example/p.png') && oldTest('/\t/evil.example/p.png'));
    // Same origin is not enough for a picture in content the app did not write:
    // `![](/api/feed?nodeId=12)` in an imported course would start writing a
    // lesson. Only the read-only paths load unasked.
    for (const src of ['/api/feed?nodeId=12', '/API/feed?nodeId=12', '/api/media/../feed?nodeId=1', '/api/media/%2e%2e/feed',
        '/api/nodes/3/mastery-check/draw', '/api/embeddings/status', 'http://127.0.0.1:3001/api/feed?nodeId=1', '//evil.example/api/media/x'])
        ok(`inert: ${JSON.stringify(src)} does not load unasked`, !isInertOwnAddress(src, here));
    for (const src of ['/api/media/abc123', '/API/Media/abc123', '/api/icon/favicon-32.png', '/assets/logo.png', '/icons/x.png'])
        ok(`inert: ${JSON.stringify(src)} loads`, isInertOwnAddress(src, here));
    ok('inert: plain same-origin would have let the feed route through (the control)', isSameOrigin('/api/feed?nodeId=12', here));

    // A LINK in content the app did not write is decided the same way. Every
    // address the browser resolves off this origin opens in a new tab (the old
    // test was the text starting "http", which `//host` and `HTTP://host` do
    // not, so they replaced the app's own tab); an API route of this app is
    // not a link at all; and words that do not say where a link goes get the
    // host printed beside them.
    for (const href of ['//evil.example/login', 'HTTP://evil.example/', '/\\evil.example/', 'https://evil.example/x', 'mailto:someone@evil.example'])
        ok(`link: ${JSON.stringify(href)} opens away from the app's tab`, planLink(href, 'Log in again', here).kind === 'away');
    for (const href of ['/api/feed?nodeId=12', '/API/Feed?nodeId=1', 'http://127.0.0.1:3001/api/nodes/3/mastery-check/draw', '/api'])
        ok(`link: ${JSON.stringify(href)} is not a link`, planLink(href, 'next lesson', here).kind === 'text');
    ok('link: a page of this app opens here', planLink('/project/4', 'your project', here).kind === 'here');
    const disguised = planLink('https://elsewhere.example/?d=1', 'Your notes', here);
    ok('link: words that hide the destination get the host beside them', disguised.kind === 'away' && disguised.shows === 'elsewhere.example');
    const plain = planLink('https://en.wikipedia.org/wiki/Ohm', 'https://en.wikipedia.org/wiki/Ohm', here);
    ok('link: words that are the address get nothing added', plain.kind === 'away' && plain.shows === '');
    ok('link: a mail link shows the address it writes to', planLink('mailto:a@evil.example', 'Contact support', here).shows === 'a@evil.example');
    // A label that only CONTAINS the host is not one that names it.
    for (const [href, label] of [['https://bank.co/login', 'https://bank.com/login'], ['https://ank.com/', 'bank.com'], ['https://evil.example/', 'not evil.example'], ['https://evil.example/', 'bank.com@evil.example']]) {
        const p = planLink(href, label, here);
        ok(`link: ${JSON.stringify(label)} → ${href} still names ${new URL(href).host}`, p.kind === 'away' && p.shows === new URL(href).host);
    }
    ok('link: another scheme that has a host shows the host', planLink('irc://elsewhere.example/channel', 'chat', here).shows === 'elsewhere.example');
    ok('link: a label that is the host, scheme or www. aside, gets nothing added',
        planLink('https://www.example.org/a', 'example.org', here).shows === '' && planLink('https://example.org/a', 'https://www.example.org/b', here).shows === '');
    const markdownSrc = fs.readFileSync(path.join(root, 'src/components/Markdown.tsx'), 'utf8');
    ok('link: Markdown draws every link through planLink, and no text test decides "external"',
        /a: \(\{ href, children \}\) => <MarkdownLink/.test(markdownSrc) && /planLink\(href/.test(markdownSrc) && !/href\?\.startsWith\('http'\)/.test(markdownSrc));

    // Diagrams: Mermaid lays a diagram out inside the live page to measure it, so
    // anything in it that fetches does so before the render returns. The check
    // lives in Mermaid's own sanitiser (an allow-list handed to its DOMPurify) and
    // its own `secure` keys, never in rewrites of the source text: two rounds of
    // those missed spellings and broke `i < n` (fourth and fifth reviews).
    const mermaidMod = await load(path.join(root, 'src/components/visuals/sanitizeMermaid.ts'), 'mermaid');
    const { stripMermaidFetches, sanitizeMermaid, inertMermaidSvg, mermaidAsksForPicture, MERMAID_SECURE_KEYS, MERMAID_DOMPURIFY } = mermaidMod;
    const legitDiagrams = [
        'flowchart TD\n  A[Start] --> C{i < n?}\n  C -->|yes| D[i++]\n  C -->|no| E[Done]',
        'flowchart LR\n  A["x < y"] --> B["y > z"]',
        'sequenceDiagram\n  Alice->>Bob: is a<b?\n  Bob-->>Alice: yes',
        'stateDiagram-v2\n  Idle --> Busy : load < max\n  Busy --> Idle : done',
        'classDiagram\n  class Lens {\n    <<interface>>\n    +focus() float\n  }',
        'flowchart TD\n  A(["Done"])',
        'flowchart TD\n  A@{ shape: hex, label: "Silicon" }',
        "flowchart LR\n  A@{ shape: rect, label: Newton's law } --> B[Image of the force]",
        'flowchart TD\n  A["<b>bold</b> and H<sub>2</sub>O"]',
    ];
    // "Unchanged" apart from the quotes the label-quoting has always added
    // (`C{i < n?}` → `C{"i < n?"}`, which Mermaid needs).
    const unquoted = (s) => s.replace(/"/g, '');
    for (const src of legitDiagrams) {
        ok(`mermaid: a legitimate diagram passes through unchanged: ${JSON.stringify(src.split('\n')[1])}`, unquoted(sanitizeMermaid(src)) === unquoted(src), sanitizeMermaid(src));
        ok(`mermaid: ...and is not refused as asking for a picture`, !mermaidAsksForPicture(src));
    }
    // Mermaid's own copy, by path: it is Mermaid's dependency, not the app's.
    const { default: createDOMPurify } = await import(pathToFileURL(path.join(root, 'node_modules/dompurify/dist/purify.es.mjs')).href);
    const purify = createDOMPurify(dom.window);
    const labelFetches = /<\s*(img|input|image|svg|feimage|picture|source|a|iframe|object)\b|\ssrc=|\sstyle=|\shref=/i;
    for (const label of [
        "<img src='/api/feed?nodeId=7'> Start",
        "<<img src=https://evil.example/x.png> Start",
        '<input type=image src=https://evil.example/i.png>',
        '<svg><filter><feImage href=https://evil.example/f.png/></filter></svg>',
        "<span style='background:url(/api/feed?nodeId=9)'>x</span>",
        '<picture><source srcset="https://evil.example/p.png"></picture>',
    ]) {
        const out = purify.sanitize(label, MERMAID_DOMPURIFY).toString();
        ok(`mermaid label: ${JSON.stringify(label)} keeps nothing that fetches`, !labelFetches.test(out), out);
    }
    ok('mermaid label: formatting survives the allow-list', purify.sanitize('<b>bold</b> H<sub>2</sub>O<br>', MERMAID_DOMPURIFY).toString() === '<b>bold</b> H<sub>2</sub>O<br>');
    // A less-than glued to a letter is a tag to an HTML parser: `x<y means …`
    // reached the reader as "x", the rest parsed as an unclosed `<y …>` and
    // dropped by the sanitiser above. Mermaid turns `#lt;` into text before its
    // sanitiser runs (entity placeholders), so the label as it is SHOWN is the
    // sanitised label with `#lt;` read as `&lt;`.
    const shownLabel = (src) => {
        const label = /"([^"]*)"/.exec(sanitizeMermaid(src))[1];
        labelBox.innerHTML = purify.sanitize(label.replace(/#lt;/g, '&lt;'), MERMAID_DOMPURIFY).toString();
        return labelBox.textContent;
    };
    const labelBox = document.createElement('div');
    for (const [src, text] of [
        ['flowchart TD\n  P["x<y means x is less than y"] --> Q', 'x<y means x is less than y'],
        ['flowchart TD\n  P[a<b and c<d] --> Q', 'a<b and c<d'],
        ['flowchart TD\n  A -->|"n<m holds"| B', 'n<m holds'],
        ['flowchart TD\n  P["<b>bold</b> x<y"]', 'bold x<y'],
    ]) ok(`mermaid label: ${JSON.stringify(text)} is shown whole`, shownLabel(src) === text, shownLabel(src));
    ok('mermaid label: formatting in a label is still markup, not text',
        /<b>bold<\/b>/.test(purify.sanitize(/"([^"]*)"/.exec(sanitizeMermaid('flowchart TD\n  P["<b>bold</b> x<y"]'))[1].replace(/#lt;/g, '&lt;'), MERMAID_DOMPURIFY).toString()));
    ok('mermaid label: unescaped, the sanitiser cuts it to "x" (the control)',
        purify.sanitize('x<y means x is less than y', MERMAID_DOMPURIFY).toString() === 'x');
    ok('mermaid label: an escaped <img> is text, not a picture',
        shownLabel('flowchart TD\n  A["<img src=/api/feed?nodeId=1> x"]') === '<img src=/api/feed?nodeId=1> x' && !labelBox.querySelector('*'));
    for (const src of [
        'flowchart TD\n  C@{ img: "/api/feed?nodeId=8", label: "Pic", pos: "t", h: 60 }',
        'flowchart TD\n  A@{ "img": "https://evil.example/qk.png", w: 60, h: 60 }\n  A --> B',
        'flowchart TD\n  A@{ label: "}", img: "https://evil.example/s.png", w: 60, h: 60 }\n  A --> B',
        'flowchart TD\n  A@{ "\\x69mg": "https://evil.example/e.png" }',
    ]) ok(`mermaid: an image shape is refused: ${JSON.stringify(src.split('\n')[1])}`, mermaidAsksForPicture(src));
    for (const key of ['themeCSS', 'themeVariables', 'fontFamily', 'dompurifyConfig', 'securityLevel'])
        ok(`mermaid: a diagram's own directive cannot set ${key}`, MERMAID_SECURE_KEYS.includes(key));
    const renderMermaidSrc = fs.readFileSync(path.join(root, 'src/components/visuals/renderMermaid.ts'), 'utf8');
    ok('mermaid: the renderer hands Mermaid the secure keys and the label allow-list',
        /secure: MERMAID_SECURE_KEYS,/.test(renderMermaidSrc) && /dompurifyConfig: MERMAID_DOMPURIFY,/.test(renderMermaidSrc)
        && /if \(mermaidAsksForPicture\(safe\)\) \{\s*throw/.test(renderMermaidSrc));
    ok('mermaid: a classDef carrying a stylesheet address is dropped',
        !/evil/.test(stripMermaidFetches('flowchart TD\n  A --> B\n  classDef hot fill:#f96,background:url(https://evil.example/e.png)\n  classDef esc background:\\75 rl(https://evil.example/f.png)')));
    const svgOut = inertMermaidSvg('<svg><style>.n{fill:red} .x{background:url(https://evil.example/s.png)} .m{marker-end:url(#arrow)}</style><use href="#m1"/><use href="https://evil.example/u.svg#x"/><foreignObject><div style="background:url(/api/feed?nodeId=2)"><img src="/api/feed?nodeId=1"><input type="image" src="https://evil.example/i.png"></div></foreignObject><image href="https://evil.example/p.png"/><a href="https://example.org/read">x</a></svg>');
    const holder = document.createElement('div');
    holder.appendChild(svgOut);
    const rendered = holder.innerHTML;
    ok('mermaid: the finished SVG keeps nothing that fetches',
        !/<img|<input|<image|\ssrc=|href="https?:\/\/evil|url\((?!#)/i.test(rendered) && /href="#m1"/.test(rendered) && /url\(#arrow\)/.test(rendered), rendered);
    ok('mermaid: a link keeps its address (it loads only on a press)', /<a href="https:\/\/example\.org\/read">/.test(rendered));
    const mathSrc = fs.readFileSync(path.join(root, 'src/components/MathText.tsx'), 'utf8');
    ok('question, option and card text: a picture loads only from the media store', /img: \(\{ src, alt \}\) => \(typeof src === 'string' && isInertOwnAddress\(src\)/.test(mathSrc));
    const mdSrc = fs.readFileSync(path.join(root, 'src/components/Markdown.tsx'), 'utf8');
    ok('markdown: an /api address written in full draws no "Show image" button', /if \(isSameOrigin\(src\)\) return alt \?/.test(mdSrc));
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* a temp dir */ }

    // Markdown images: the sanitizer lets <img src="https://…"> through (it is
    // a legitimate thing for a course to contain), so the renderer decides.
    const md = fs.readFileSync(path.join(root, 'src/components/Markdown.tsx'), 'utf8');
    ok('markdown: <img> goes through MarkdownImage', /\n\s+img: \(\{ src, alt \}\) => <MarkdownImage /.test(md));
    ok('markdown: only a read-only address of this app loads without a press', /function isOwnImage\(src: string\): boolean \{\s*return isInertOwnAddress\(src\);/.test(md));
    const vegaSrc = fs.readFileSync(path.join(root, 'src/components/visuals/renderVega.ts'), 'utf8');
    ok('charts: vega fetches no address at all', /loader: noFetchLoader\(embedModule\.vega, refused\)/.test(vegaSrc)
        && /async sanitize\(uri: string\) \{[\s\S]{0,400}?throw new Error\(reason\);\s*\}/.test(vegaSrc));
    ok('charts: a refused address is the chart\'s error, not "zero rows"', /if \(refused\.length\) throw new Error\(refused\[0\]\);/.test(vegaSrc));
    ok('markdown: a pressed remote image sends no referrer', /<img src=\{src\}[^>]*referrerPolicy="no-referrer"/.test(md));
    ok('enforced CSP carries object-src/base-uri/form-action/frame-ancestors/frame-src', /const CSP_ENFORCED = \[\s*"object-src 'none'",\s*"base-uri 'self'",\s*"form-action 'self'",\s*"frame-ancestors 'self'",\s*"frame-src 'self'",/.test(indexSrc)
        && indexSrc.includes("res.setHeader('Content-Security-Policy', CSP_ENFORCED)"));
}

// --- 12. a reader of untrusted input starts with almost no environment -------
// Office documents and Anki decks are read in a child process of their own
// (server/isolatedProcess.js). That child is handed hostile input by design, so
// it must not hold what the server's environment holds: provider keys, the
// password, the library's paths, NODE_OPTIONS. A real child is run here, with
// such variables set in this process, and asked what it was started with.
{
    const { runIsolated } = await import('../server/isolatedProcess.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-isolated-env-'));
    const isolatedUrl = pathToFileURL(path.join(root, 'server/isolatedProcess.js')).href;
    const reporter = path.join(dir, 'env-reporter.mjs');
    fs.writeFileSync(reporter, `import { serveIsolated } from ${JSON.stringify(isolatedUrl)};
serveIsolated(() => ({ keys: Object.keys(process.env), execArgv: process.execArgv }));
`);
    const planted = {
        AI_API_KEY: 'sk-gate-planted', OPENAI_API_KEY: 'sk-gate-planted', TERRAMENTOR_PASSWORD: 'gate-planted',
        DB_PATH: path.join(dir, 'x.db'), VAULT_ROOT: dir, NODE_OPTIONS: '--max-http-header-size=16384',
    };
    const saved = Object.fromEntries(Object.keys(planted).map((k) => [k, process.env[k]]));
    Object.assign(process.env, planted);
    let seen = null;
    try {
        seen = await runIsolated(reporter, null, {
            heapMb: 64, timeoutMs: 20_000,
            messages: { timeout: 'timeout', outOfMemory: 'oom', reply: 'reply', stopped: (how) => `stopped ${how}` },
        });
    } catch (e) {
        seen = { error: e.message };
    } finally {
        for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    const keys = (seen?.keys || []).map((k) => k.toUpperCase());
    ok(`isolated reader: the child ran and answered (${seen?.error || 'ok'})`, Array.isArray(seen?.keys));
    for (const k of Object.keys(planted)) ok(`isolated reader: ${k} does not reach the child`, Array.isArray(seen?.keys) && !keys.includes(k));
    ok('isolated reader: the child still has a PATH to start with', keys.includes('PATH'));
}

console.log(`security-gates: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
    for (const f of failures) console.error(`  FAIL ${f}`);
    process.exit(1);
}
