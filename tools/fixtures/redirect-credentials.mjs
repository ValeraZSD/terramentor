/**
 * Two questions about outbound fetches that only real sockets can answer: what
 * `safeFetch` hands the SECOND host when the first one redirects, and whether
 * `fetchPageContent` stops reading a body that never ends.
 *
 * A separate process because the sockets have to be loopback ones, which
 * `netSafety.js` refuses by design. `ALLOW_PRIVATE_FETCH=1` is read once at
 * import, so the caller sets it in this child's environment rather than the
 * gate's own.
 *
 * Prints one JSON line. The gate asserts on both halves of the redirect answer,
 * because dropping the credential everywhere would be its own bug — the hosted
 * search backends need it to survive a redirect a host makes to itself.
 */
import http from 'node:http';
import { safeFetch } from '../../server/netSafety.js';
import { fetchPageContent } from '../../server/ai.js';

const listen = (handler) => new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
});

const SENT = {
    'Authorization': 'Bearer secret-key-value',
    'X-Subscription-Token': 'secret-brave-token',
    'Accept': 'application/json',
};

const landed = {};

// Where a cross-origin redirect ends up.
const other = await listen((req, res) => {
    landed.crossOrigin = { ...req.headers };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
});

// The first host: redirects away on /away, and to itself on /self.
const first = await listen((req, res) => {
    if (req.url.startsWith('/away')) {
        res.writeHead(302, { Location: `http://127.0.0.1:${other.port}/landed` });
        return res.end();
    }
    if (req.url.startsWith('/self')) {
        res.writeHead(302, { Location: '/same-origin-landing' });
        return res.end();
    }
    landed.sameOrigin = { ...req.headers };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
});

/**
 * A page that sends plenty and then never finishes.
 *
 * The discriminator is TIME, not length: an unbounded `response.text()` waits
 * for a body that is never going to end, so it can only come back when the 10s
 * abort fires. A reader that stops at its cap has everything it needs from the
 * first write and returns immediately. Slicing the string afterwards would give
 * the same length and take the full ten seconds.
 */
const slow = await listen((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.write(`<p>${'x'.repeat(600_000)}</p>`);
    // No res.end(), and a keep-alive the client has to decide to stop reading.
});

try {
    await safeFetch(`http://127.0.0.1:${first.port}/away`, { headers: SENT });
    await safeFetch(`http://127.0.0.1:${first.port}/self`, { headers: SENT });

    // Raced against a clock, because the failure this asserts is a HANG, not a
    // wrong answer: `fetchPageContent` clears its abort timer the moment the
    // response headers arrive, so an unbounded read of a body that never ends
    // waits for ever rather than for ten seconds. Without the race the gate
    // would hang instead of going red, and a gate that hangs teaches nobody
    // anything.
    const LIMIT_MS = 15_000;
    const t0 = Date.now();
    const page = await Promise.race([
        fetchPageContent(`http://127.0.0.1:${slow.port}/`, 3000),
        new Promise((resolve) => setTimeout(() => resolve({ success: false, content: '', timedOut: true }), LIMIT_MS)),
    ]);
    landed.endlessPage = { ok: page.success, chars: page.content.length, ms: Date.now() - t0 };

    process.stdout.write(JSON.stringify(landed));
} finally {
    first.server.close();
    other.server.close();
    slow.server.closeAllConnections?.();
    slow.server.close();
    // A read still in flight keeps a handle open, and this process has said
    // everything it has to say.
    process.exit(0);
}
