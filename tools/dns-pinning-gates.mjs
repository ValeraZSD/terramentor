#!/usr/bin/env node
/**
 * tools/dns-pinning-gates.mjs — the socket goes where the vet looked.
 *
 * Run:  node tools/dns-pinning-gates.mjs
 *
 * `safeFetch` (server/netSafety.js) resolves a name and refuses a private or
 * loopback answer. That check is worth nothing if the connection then asks the
 * resolver AGAIN: a name that answers a public address to the vet and 127.0.0.1
 * to the socket (DNS rebinding) reads a service on this machine.
 *
 * The resolver is controlled in-process: `node:dns/promises` `lookup` (what the vet asks) answers
 * a documentation-range public address, and `node:dns` `lookup` (what a plain
 * socket asks) answers loopback, where a real HTTP service is listening and
 * counting. The pass condition is that the loopback service is NEVER hit —
 * directly, after a redirect, or through an IPv6 answer — and that the socket
 * never asks the OS resolver at all.
 *
 * The second half runs in a child with `ALLOW_PRIVATE_FETCH=1` (read once at
 * import), because proving the pin WORKS needs a connection that lands: a name
 * the OS resolver refuses outright still reaches a loopback server when the
 * vetted answer says 127.0.0.1, the request keeps its own Host header, and each
 * redirect hop is resolved and pinned afresh.
 *
 * No network beyond loopback: the public answers are TEST-NET / 2001:db8::
 * addresses, so an attempt to reach them times out or is refused locally.
 */

import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CHILD = process.argv.includes('--child');
let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`  ok    ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const listen = (host, handler) => new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.once('error', reject);
    server.listen(0, host, () => resolve(server));
});

// The two resolvers, replaced. `vet` answers what `dns/promises` returns (the
// lookup safeFetch vets); `socket` answers what `dns.lookup` returns (the one a
// plain socket asks at connect time). Anything not ending `.test` goes to the
// real resolver untouched.
const realLookup = dns.lookup;
const realPromiseLookup = dnsPromises.lookup;
const osLookups = [];
function controlResolvers({ vet, socket }) {
    dnsPromises.lookup = async (host, opts) => {
        const answer = host.endsWith('.test') ? vet(host) : null;
        if (!answer) return realPromiseLookup(host, opts);
        return opts?.all ? answer : answer[0];
    };
    dns.lookup = (host, opts, cb) => {
        if (typeof opts === 'function') { cb = opts; opts = {}; }
        if (!host.endsWith('.test')) return realLookup(host, opts, cb);
        osLookups.push(host);
        const answer = socket(host);
        queueMicrotask(() => {
            if (!answer) return cb(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' }));
            if (opts?.all) cb(null, answer);
            else cb(null, answer[0].address, answer[0].family);
        });
    };
}
const restoreResolvers = () => { dns.lookup = realLookup; dnsPromises.lookup = realPromiseLookup; };

if (!CHILD) {
    delete process.env.ALLOW_PRIVATE_FETCH;
    console.log('dns-pinning-gates: the vetted answer is the one the socket uses\n');

    // A loopback-only service that counts every request it is handed.
    const hits = [];
    const v4 = await listen('127.0.0.1', (req, res) => {
        hits.push(`v4 ${req.url}`);
        if (req.url === '/hop') {
            res.writeHead(302, { Location: `http://landed.rebind.test:${v4.address().port}/landed` });
            return res.end();
        }
        res.end('private service');
    });
    // A host with no IPv6 loopback (many containers and CI sandboxes) cannot
    // run the IPv6 case at all; that is a skip, not a failure. Any other error
    // listening on ::1 still fails.
    let v6 = null, v6Error = null;
    try {
        v6 = await listen('::1', (req, res) => { hits.push(`v6 ${req.url}`); res.end('private service'); });
    } catch (e) { v6Error = e; }
    const noIPv6 = ['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(v6Error?.code);
    if (noIPv6) console.log(`  SKIPPED: the IPv6 case — this host has no IPv6 loopback (${v6Error.code})`);
    else check('an IPv6 loopback service is listening for the IPv6 case', !!v6, v6Error?.code || v6Error?.message);

    // The vet's answer must be one the vet ACCEPTS, or the case proves the
    // blocklist rather than the pin. The IPv4 documentation ranges are refused
    // as not globally reachable, so every vetted answer here is the IPv6
    // documentation prefix, which is not on the list and is never routed.
    controlResolvers({
        vet: () => [{ address: '2001:db8::10', family: 6 }],
        socket: (host) => host.startsWith('six.')
            ? [{ address: '::1', family: 6 }]
            : [{ address: '127.0.0.1', family: 4 }],
    });

    const { safeFetch } = await import('../server/netSafety.js');
    const attempt = async (url) => {
        try {
            const res = await safeFetch(url, { signal: AbortSignal.timeout(2000) });
            return { body: await res.text() };
        } catch (e) {
            return { error: e?.message || String(e) };
        }
    };
    const port4 = v4.address().port;
    const [direct, redirected, six] = await Promise.all([
        attempt(`http://direct.rebind.test:${port4}/`),
        attempt(`http://hop.rebind.test:${port4}/hop`),
        v6 ? attempt(`http://six.rebind.test:${v6.address().port}/`) : Promise.resolve({ error: 'no ::1' }),
    ]);
    restoreResolvers();

    check('a rebinding name does not read the loopback service', direct.body !== 'private service', JSON.stringify(direct));
    check('…nor after a redirect hop', redirected.body !== 'private service' && !hits.some(h => h.includes('/landed')), JSON.stringify(redirected));
    if (!noIPv6) check('…nor through an IPv6 answer', six.body !== 'private service', JSON.stringify(six));
    check('the loopback services were never hit at all', hits.length === 0, hits.join(', '));
    check('the socket never asked the OS resolver for a vetted name', osLookups.length === 0, osLookups.join(', '));
    check('…and the vet accepted every answer, so the pin was what held',
        [direct, redirected, six].every(r => !/refusing/.test(r.error || '')), JSON.stringify([direct.error, redirected.error, six.error]));

    const closed = (s) => new Promise(r => { s.closeAllConnections(); s.close(() => r()); });
    await closed(v4);
    if (v6) await closed(v6);

    // --- a lookup that never answers ----------------------------------------
    // getaddrinfo runs on libuv's small thread pool, shared with file reads,
    // zlib and crypto. Names whose resolver never answers must not occupy all
    // of it, and the caller must hear a refusal in bounded time.
    {
        const netSafety = await import('../server/netSafety.js');
        let running = 0, most = 0;
        const hung = [];
        dnsPromises.lookup = (host, opts) => {
            if (!host.endsWith('.test')) return realPromiseLookup(host, opts);
            if (host.startsWith('ok.')) return Promise.resolve(opts?.all ? [{ address: '2001:db8::10', family: 6 }] : { address: '2001:db8::10', family: 6 });
            running++; most = Math.max(most, running);
            return new Promise((resolve) => hung.push(() => { running--; resolve([{ address: '2001:db8::10', family: 6 }]); }));
        };
        const bounded = (p, ms) => Promise.race([p.then(() => 'resolved', (e) => e?.message || String(e)),
            new Promise(r => setTimeout(() => r('still waiting'), ms))]);
        const t0 = Date.now();
        const outcomes = await Promise.all([1, 2, 3, 4, 5].map(i => bounded(netSafety.assertFetchable(`http://hang${i}.slow.test/`), 9_000)));
        const took = Date.now() - t0;
        check('at most two lookups run at once, whatever is asked', most <= 2, `${most} at once`);
        check('every caller hears that the lookup took too long, within the bound',
            outcomes.every(o => /took longer than/.test(o)) && took < 8_500, `${JSON.stringify(outcomes)} after ${took} ms`);
        const load = netSafety.dnsLookupLoad?.();
        check('a lookup that outlives its caller keeps its slot; nobody is left queued',
            load?.inFlight === 2 && load?.waiting === 0, JSON.stringify(load));
        for (const release of hung.splice(0)) release();
        await new Promise(r => setTimeout(r, 50));
        let after;
        try { after = (await netSafety.assertFetchable('http://ok.slow.test/')).hostname; } catch (e) { after = e.message; }
        check('once they return, the slots are free and a lookup goes through', after === 'ok.slow.test'
            && netSafety.dnsLookupLoad?.().inFlight === 0, `${after} ${JSON.stringify(netSafety.dnsLookupLoad?.())}`);
        for (const release of hung.splice(0)) release();
        restoreResolvers();
    }

    // --- the pin reaches what it was pinned to ------------------------------
    const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child'], {
        encoding: 'utf8',
        env: { ...process.env, ALLOW_PRIVATE_FETCH: '1' },
        timeout: 30_000,
    });
    let landed = null;
    try { landed = JSON.parse(run.stdout.trim().split('\n').pop()); } catch { /* reported below */ }
    check('the pinned-connection probe ran', !!landed, (run.stderr || run.stdout || '').slice(0, 300));
    check('a name the OS cannot resolve is reached through its resolved address', landed?.body === 'landed', JSON.stringify(landed));
    check('each request keeps its own Host header', landed?.hosts?.[0] === `first.pin.test:${landed?.port}`
        && landed?.hosts?.[1] === `second.pin.test:${landed?.port}`, JSON.stringify(landed?.hosts));
    check('the redirect hop was resolved again, by the vetted path', landed?.vetted?.join(',') === 'first.pin.test,second.pin.test', JSON.stringify(landed?.vetted));
    check('…and neither hop asked the OS resolver at connect time', Array.isArray(landed?.osLookups) && landed.osLookups.length === 0, JSON.stringify(landed?.osLookups));

    console.log(`\n${pass} passed, ${fail} failed`);
    // Exit rather than drain: the aborted attempts at the TEST-NET addresses
    // leave a socket in connect() until undici's own 10 s connect timeout
    // (destroying the Agent does not reach it, measured). Every server is
    // closed above.
    process.exit(fail ? 1 : 0);
} else {
    // Child: ALLOW_PRIVATE_FETCH=1, so loopback is permitted and the question is
    // only WHERE the socket goes. The OS resolver refuses every `.test` name, so
    // the only way to land is the address the vetted lookup returned.
    const hosts = [];
    const server = await listen('127.0.0.1', (req, res) => {
        hosts.push(req.headers.host);
        if (req.url === '/start') {
            res.writeHead(302, { Location: `http://second.pin.test:${server.address().port}/landed` });
            return res.end();
        }
        res.end('landed');
    });
    const port = server.address().port;
    const vetted = [];
    controlResolvers({
        vet: (host) => { vetted.push(host); return [{ address: '127.0.0.1', family: 4 }]; },
        socket: () => null,
    });
    const { safeFetch } = await import('../server/netSafety.js');
    let body = null, error = null;
    try {
        const res = await safeFetch(`http://first.pin.test:${port}/start`, { signal: AbortSignal.timeout(5000) });
        body = await res.text();
    } catch (e) { error = e?.cause?.message || e?.message || String(e); }
    restoreResolvers();
    server.closeAllConnections(); server.close();
    console.log(JSON.stringify({ body, error, hosts, vetted, osLookups, port }));
}
