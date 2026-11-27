/**
 * What the outbound fetch helpers DO, measured on loopback sockets with the
 * resolver under control. tools/security-gates.mjs runs this in a child and
 * asserts on the JSON line it prints; nothing here decides pass or fail.
 *
 * A child because `ALLOW_PRIVATE_FETCH` is read once at import and the
 * listeners have to be loopback ones; the gate sets it, plus a scratch
 * `DB_PATH` and `VAULT_ROOT`, in this process's environment only.
 *
 * The resolver is split the way the code splits it. `node:dns/promises`
 * `lookup` is what the vet asks (netSafety resolves a name before it decides);
 * `node:dns` `lookup` is what a plain socket asks at connect time. For the
 * `.test` names below the vet hears a cloud metadata address, which is refused
 * even with private targets open, while a plain socket hears 127.0.0.1, where a
 * trap listener counts every request. So a helper that skips the vet, or vets
 * and then lets something else connect, shows up as a trap hit.
 */
import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import http from 'node:http';

const realLookup = dns.lookup;
const realPromiseLookup = dnsPromises.lookup;
const VET_ANSWER = [{ address: '169.254.169.254', family: 4 }];
const SOCKET_ANSWER = [{ address: '127.0.0.1', family: 4 }];
dnsPromises.lookup = async (host, opts) => {
    if (!String(host).endsWith('.test')) return realPromiseLookup(host, opts);
    return opts?.all ? VET_ANSWER : VET_ANSWER[0];
};
dns.lookup = (host, opts, cb) => {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    if (!String(host).endsWith('.test')) return realLookup(host, opts, cb);
    queueMicrotask(() => {
        if (opts?.all) cb(null, SOCKET_ANSWER);
        else cb(null, SOCKET_ANSWER[0].address, SOCKET_ANSWER[0].family);
    });
};

const servers = [];
/** A loopback listener that records every request it is handed. */
const listen = (handler = (req, res) => res.end('ok')) => new Promise((resolve) => {
    const hits = [];
    const sockets = new Set();
    const server = http.createServer((req, res) => { hits.push(req.url); handler(req, res); });
    server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    servers.push(server);
    server.listen(0, '127.0.0.1', () => resolve({ server, hits, sockets, port: server.address().port }));
});

const out = {};
const errorOf = async (p) => {
    try { await p; return null; } catch (e) { return e?.message || String(e); }
};

try {
    const trap = await listen();
    const trapUrl = (path) => `http://meta.test:${trap.port}${path}`;

    // A body that trickles one byte a second: never reaching the byte cap, so
    // only the page fetch's deadline can end it. Started first and awaited last
    // because the green answer takes that whole deadline.
    const trickle = await listen((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.write('<p>start');
        const tick = setInterval(() => res.write('x'), 1000);
        res.on('close', () => clearInterval(tick));
    });

    const { safeFetch } = await import('../../server/netSafety.js');
    const { fetchPageContent } = await import('../../server/ai.js');
    const TRICKLE_LIMIT_MS = 25_000;
    const trickleStart = Date.now();
    const tricklePage = Promise.race([
        fetchPageContent(`http://127.0.0.1:${trickle.port}/`, 3000),
        new Promise((resolve) => setTimeout(() => resolve({ raced: true }), TRICKLE_LIMIT_MS)),
    ]).then((r) => ({ success: r.success, raced: !!r.raced, ms: Date.now() - trickleStart }));

    // --- safeFetch -----------------------------------------------------------
    // A page that redirects into a name the vet refuses.
    const hop = await listen((req, res) => {
        res.writeHead(302, { Location: trapUrl(`/after-redirect${req.url}`) });
        res.end();
    });
    out.safeFetchDirect = await errorOf(safeFetch(trapUrl('/direct'), { signal: AbortSignal.timeout(5000) }));
    out.safeFetchRedirect = await errorOf(safeFetch(`http://127.0.0.1:${hop.port}/safe`, { signal: AbortSignal.timeout(5000) }));
    out.safeFetchFollow = await errorOf(safeFetch(`http://127.0.0.1:${hop.port}/follow`, { redirect: 'follow', signal: AbortSignal.timeout(5000) }));

    // A finished fetch leaves no socket behind, even when the server asks for
    // a ten-minute keep-alive.
    const keepAlive = await listen((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain', Connection: 'keep-alive', 'Keep-Alive': 'timeout=600' });
        res.end('body');
    });
    keepAlive.server.keepAliveTimeout = 600_000;
    const kaRes = await safeFetch(`http://127.0.0.1:${keepAlive.port}/`);
    out.keepAliveBody = await kaRes.text();
    const kaDeadline = Date.now() + 2000;
    while (keepAlive.sockets.size && Date.now() < kaDeadline) await new Promise((r) => setTimeout(r, 50));
    out.keepAliveOpenSockets = keepAlive.sockets.size;

    // --- fetchPageContent (the page reader the assistant and curator use) ---
    const pageDirect = await fetchPageContent(trapUrl('/page-direct'));
    const pageRedirect = await fetchPageContent(`http://127.0.0.1:${hop.port}/page`);
    out.pageDirect = { success: pageDirect.success, error: pageDirect.error };
    out.pageRedirect = { success: pageRedirect.success, error: pageRedirect.error };
    out.hopHits = [...hop.hits];

    // --- POST /api/searxng/test through the real app -------------------------
    const healthy = await listen((req, res) => { res.writeHead(200); res.end('OK'); });
    const redirectTarget = await listen((req, res) => { res.writeHead(200); res.end('OK'); });
    const redirecting = await listen((req, res) => {
        res.writeHead(302, { Location: `http://127.0.0.1:${redirectTarget.port}/landed` });
        res.end();
    });
    const { createApp } = await import('../../server/app.js');
    const app = http.createServer(createApp());
    servers.push(app);
    await new Promise((r) => app.listen(0, '127.0.0.1', r));
    const probe = async (url) => {
        const res = await fetch(`http://127.0.0.1:${app.address().port}/api/searxng/test`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ url }),
        });
        let body = null;
        try { body = await res.json(); } catch { /* reported as null */ }
        return { status: res.status, ok: body?.ok, error: body?.error };
    };
    out.searxng = {
        healthy: await probe(`http://127.0.0.1:${healthy.port}/search?q=x#frag`),
        redirect: await probe(`http://127.0.0.1:${redirecting.port}/`),
        metadata: await probe(trapUrl('/searx')),
        dataScheme: await probe('data:text/plain,reachable'),
        ftpScheme: await probe(`ftp://127.0.0.1:${healthy.port}/`),
        // 2,100 characters: over the 2,000 the route documents.
        longUrl: await probe(`http://127.0.0.1:${healthy.port}/${'a'.repeat(2100)}`),
    };
    out.searxngHealthyHits = [...healthy.hits];
    out.searxngRedirectTargetHits = [...redirectTarget.hits];

    out.tricklePage = await tricklePage;
    out.trapHits = [...trap.hits];
    process.stdout.write(`\n${JSON.stringify(out)}\n`);
} catch (e) {
    process.stdout.write(`\n${JSON.stringify({ ...out, crashed: e?.stack || String(e) })}\n`);
} finally {
    dns.lookup = realLookup;
    dnsPromises.lookup = realPromiseLookup;
    for (const s of servers) { s.closeAllConnections?.(); s.close(); }
    // An aborted read can still hold a handle; everything has been printed.
    process.exit(0);
}
