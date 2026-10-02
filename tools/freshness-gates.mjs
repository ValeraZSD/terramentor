#!/usr/bin/env node
/**
 * tools/freshness-gates.mjs — the machinery that stops the app running a build
 * it no longer is, and the compression that carries that build to the browser.
 *
 * Run:  node tools/freshness-gates.mjs
 *
 * Why these particular things are asserted rather than eyeballed:
 *
 *  * THE SERVICE WORKER'S PLACEHOLDERS. `dist/sw.js` is `src/sw-template.js`
 *    with two strings substituted, and a substitution that misses fails in the
 *    quietest possible way: the worker installs, the cache is literally named
 *    `terramentor-__BUILD__`, every build shares it, and the app serves whatever
 *    is in it. The first version of the template DID miss, because the
 *    placeholder was spelled in a comment above the constant and a plain
 *    `.replace` takes the first match. So: no placeholder may survive.
 *
 *  * THE BUILD ID MOVES WITH THE BUILD AND ONLY WITH THE BUILD. The whole
 *    auto-reload rests on it. If it changed on a restart the app would reload
 *    itself in a loop; if it did not change on a rebuild we are back to the bug.
 *
 *  * A BUILD'S CACHE NAME IS ITS OWN. Two different bundles must produce two
 *    different worker caches, and the same bundle must produce the same one —
 *    otherwise either the stale cache survives, or every start of an unchanged
 *    app throws its cache away.
 *
 *  * COMPRESSION MUST NOT REACH SSE. The response stream is untouched on
 *    purpose: only `res.json` is wrapped. A future refactor that patches
 *    `write`/`end` instead would buffer every token of every streamed answer,
 *    and the symptom — the tutor typing nothing for a minute and then
 *    everything at once — looks like a model problem, not a middleware one.
 *
 *  * THE PRE-COMPRESSED STATIC HANDLER TAKES A PATH FROM THE REQUEST. `..` in
 *    it must not reach a file outside the build.
 *
 * No model, no network, no database.
 */

import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(join(tmpdir(), 'freshness-gates-'));

let pass = 0, fail = 0;
const check = (name, got, want) => {
    const good = JSON.stringify(got) === JSON.stringify(want);
    good ? pass++ : fail++;
    console.log(`${good ? '  ok  ' : ' FAIL '} ${name}${good ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};
const ok = (name, cond, detail = '') => check(name + (detail ? ` — ${detail}` : ''), !!cond, true);

const { buildId } = await import('../server/buildId.js');
const { compressJson, precompressedStatic } = await import('../server/httpCompression.js');
const { serviceWorkerPlugin } = await import('./vite-plugin-sw.mjs');

console.log('\n--- build identity -------------------------------------------------');

{
    // A build in progress. `vite build --watch` empties dist/assets and writes
    // index.html before the chunks are back; announcing that would send every
    // open page into a document whose script is a 404.
    const dist = join(scratch, 'half');
    mkdirSync(join(dist, 'assets'), { recursive: true });
    const html = join(dist, 'index.html');
    writeFileSync(html, '<script type="module" src="/assets/entry-DONE.js"></script>');
    check('a build whose chunks are missing is not announced', buildId(html), null);

    writeFileSync(join(dist, 'assets', 'entry-DONE.js'), 'console.log(1)');
    const id = buildId(html);
    ok('...and is, once they land', typeof id === 'string' && id.length >= 8);

    // The half-written state must report the LAST GOOD id, never null, or a page
    // that started on a finished build would forget which one it was on.
    writeFileSync(html, '<script type="module" src="/assets/entry-NEXT.js"></script>');
    utimesSync(html, new Date(Date.now() + 2000), new Date(Date.now() + 2000));
    check('a rebuild mid-flight keeps reporting the build that still works', buildId(html), id);

    writeFileSync(join(dist, 'assets', 'entry-NEXT.js'), 'console.log(2)');
    utimesSync(html, new Date(Date.now() + 4000), new Date(Date.now() + 4000));
    const next = buildId(html);
    ok('and moves on when the rebuild finishes', next !== id);

    // Truncated to nothing mid-write: still the last build that worked.
    writeFileSync(html, '<p>no script here</p>');
    utimesSync(html, new Date(Date.now() + 6000), new Date(Date.now() + 6000));
    check('a document naming no entry is not a new build', buildId(html), next);
}

{
    // Two finished builds, side by side: the document AND the chunk it names,
    // because a build with no chunks is not a build (see the block above).
    mkdirSync(join(scratch, 'assets'), { recursive: true });
    for (const tag of ['AAAA', 'BBBB', 'CCCC']) {
        writeFileSync(join(scratch, 'assets', `index-${tag}.js`), `console.log("${tag}")`);
    }
    const a = join(scratch, 'a.html');
    const b = join(scratch, 'b.html');
    writeFileSync(a, '<script src="/assets/index-AAAA.js"></script>');
    writeFileSync(b, '<script src="/assets/index-BBBB.js"></script>');

    const idA = buildId(a);
    ok('a build has an id', typeof idA === 'string' && idA.length >= 8);
    check('the same file reads the same id', buildId(a), idA);
    ok('a different build has a different id', buildId(b) !== idA);
    check('no build at all is null, not a throw', buildId(join(scratch, 'nope.html')), null);

    // A rebuild: same path, new bytes, new mtime. This is the case the whole
    // feature exists for, and the cache in front of it is what could break it.
    writeFileSync(a, '<script src="/assets/index-CCCC.js"></script>');
    utimesSync(a, new Date(Date.now() + 2000), new Date(Date.now() + 2000));
    ok('a rebuild in place changes the id', buildId(a) !== idA);

    // ...and a restart that rebuilt nothing must NOT, or the app reloads forever.
    const after = buildId(a);
    check('re-reading an unchanged build is stable', buildId(a), after);
}

console.log('\n--- the service worker is a build artefact --------------------------');

{
    const template = readFileSync(join(repoRoot, 'src', 'sw-template.js'), 'utf8');
    // One occurrence each, in the line that uses it — see the note in the template.
    check('__BUILD__ appears exactly once in the template',
        (template.match(/__BUILD__/g) || []).length, 1);
    check('__PRECACHE__ appears exactly once in the template',
        (template.match(/__PRECACHE__/g) || []).length, 1);

    ok('no static public/sw.js shadows the emitted one',
        !existsSync(join(repoRoot, 'public', 'sw.js')),
        'a file there is copied verbatim and wins, unstamped');

    // Drive the plugin against a bundle shaped like Vite's.
    const bundleOf = (entryName) => ({
        [entryName]: {
            type: 'chunk', isEntry: true, imports: ['assets/vendor-react-1.js'],
            viteMetadata: { importedCss: new Set(['assets/index-1.css']) },
        },
        'assets/vendor-react-1.js': { type: 'chunk', isEntry: false, imports: [], viteMetadata: { importedCss: new Set() } },
        'assets/lazy-route-1.js': { type: 'chunk', isEntry: false, imports: [], viteMetadata: { importedCss: new Set() } },
    });

    const emit = (bundle) => {
        let emitted = null;
        const plugin = serviceWorkerPlugin();
        plugin.generateBundle.call({ emitFile: (f) => { emitted = f; } }, {}, bundle);
        return emitted;
    };

    const first = emit(bundleOf('assets/index-1.js'));
    check('it is emitted as sw.js', first.fileName, 'sw.js');
    ok('no placeholder survives into the emitted worker',
        !first.source.includes('__BUILD__') && !first.source.includes('__PRECACHE__'));
    ok('the cache is named after the build',
        /const CACHE = `terramentor-\$\{BUILD\}`/.test(first.source) && /const BUILD = '[0-9a-f]{8,}'/.test(first.source));

    const precache = JSON.parse(first.source.match(/const PRECACHE = (\[.*?\]);/s)[1]);
    ok('the shell is precached', precache.includes('/') && precache.includes('/assets/index-1.js'));
    ok('so is what the entry statically imports', precache.includes('/assets/vendor-react-1.js'));
    ok('and its stylesheet', precache.includes('/assets/index-1.css'));
    ok('a lazy route chunk is NOT precached',
        !precache.includes('/assets/lazy-route-1.js'),
        'it is cached the first time it is opened');

    const same = emit(bundleOf('assets/index-1.js'));
    check('an unchanged build emits an identical worker', same.source, first.source);
    const other = emit(bundleOf('assets/index-2.js'));
    ok('a changed build emits a different one', other.source !== first.source);
}

console.log('\n--- compression ----------------------------------------------------');

/** The smallest express-shaped response this middleware touches. */
function fakeRes() {
    const headers = new Map();
    const res = {
        headersSent: false,
        writableEnded: false,
        sent: null,
        statusCode: 200,
        vary(v) { headers.set('vary', v); },
        setHeader(k, v) { headers.set(k.toLowerCase(), v); },
        getHeader(k) { return headers.get(k.toLowerCase()); },
        removeHeader(k) { headers.delete(k.toLowerCase()); },
        send(body) { res.sent = body; res.headersSent = true; return res; },
        json(body) { res.sent = body; res.headersSent = true; return res; },
        headers,
    };
    return res;
}
const fakeReq = (encoding) => ({ method: 'GET', headers: encoding ? { 'accept-encoding': encoding } : {}, path: '/' });

const settle = () => new Promise((r) => setTimeout(r, 30));

{
    const big = { rows: Array.from({ length: 500 }, (_, i) => ({ i, title: `topic ${i}`, mastery: 0.5 })) };

    let res = fakeRes();
    compressJson()(fakeReq('gzip, deflate, br'), res, () => { });
    res.json(big);
    await settle();
    ok('a large answer is gzipped', res.getHeader('Content-Encoding') === 'gzip');
    check('and round-trips to the same data', JSON.parse(gunzipSync(res.sent).toString('utf8')), big);
    ok('it says it varies by encoding', res.getHeader('vary') === 'Accept-Encoding');
    ok('it is actually smaller', res.sent.length < JSON.stringify(big).length / 2);

    res = fakeRes();
    compressJson()(fakeReq(''), res, () => { });
    res.json(big);
    await settle();
    check('a client that takes no encoding gets plain JSON', res.getHeader('Content-Encoding'), undefined);
    check('...and the right content type', res.getHeader('content-type'), 'application/json; charset=utf-8');

    res = fakeRes();
    compressJson()(fakeReq('gzip'), res, () => { });
    res.json({ ok: true });
    await settle();
    check('a tiny answer is not compressed', res.getHeader('Content-Encoding'), undefined);

    // The SSE rule, from the other side: a handler that already started writing
    // must fall through to express untouched.
    res = fakeRes();
    const original = res.json;
    compressJson()(fakeReq('gzip'), res, () => { });
    res.headersSent = true;
    ok('a response already streaming is left alone', res.json !== original ? (res.json({ error: 'late' }), res.sent.error === 'late') : false);
}

{
    // Only `res.json` is wrapped — the write/end pair an SSE handler uses must
    // be exactly what it was.
    const res = fakeRes();
    res.write = function write() { return true; };
    res.end = function end() { return res; };
    const write = res.write, end = res.end;
    compressJson()(fakeReq('gzip'), res, () => { });
    ok('res.write is untouched', res.write === write, 'or every SSE token would be buffered');
    ok('res.end is untouched', res.end === end);
}

console.log('\n--- pre-compressed static ------------------------------------------');

{
    const dist = join(scratch, 'dist');
    mkdirSync(join(dist, 'assets'), { recursive: true });
    writeFileSync(join(dist, 'assets', 'app.js'), 'console.log(1)');
    writeFileSync(join(dist, 'assets', 'app.js.br'), 'brotli-bytes');
    writeFileSync(join(dist, 'assets', 'app.js.gz'), 'gzip-bytes');
    writeFileSync(join(scratch, 'secret.js'), 'not yours');

    const handler = precompressedStatic(dist);
    const drive = (path, encoding) => new Promise((resolve) => {
        const req = { method: 'GET', path, headers: encoding ? { 'accept-encoding': encoding } : {} };
        const res = fakeRes();
        res.sendFile = (p) => { res.file = p; resolve({ res, next: false }); };
        handler(req, res, () => resolve({ res, next: true }));
    });

    let r = await drive('/assets/app.js', 'br, gzip');
    ok('brotli wins when the caller takes it', r.res.getHeader('Content-Encoding') === 'br' && r.res.file.endsWith('.br'));
    check('the content type is the RESOURCE\'s, not the twin\'s', r.res.getHeader('content-type'), 'text/javascript; charset=utf-8');
    check('a hashed asset is immutable', r.res.getHeader('cache-control'), 'public, max-age=31536000, immutable');

    r = await drive('/assets/app.js', 'gzip');
    ok('gzip when brotli is not on offer', r.res.getHeader('Content-Encoding') === 'gzip' && r.res.file.endsWith('.gz'));

    r = await drive('/assets/app.js', '');
    ok('a caller that takes neither falls through to the plain file', r.next);
    check('...and is still told the answer varies', r.res.getHeader('vary'), 'Accept-Encoding');

    r = await drive('/assets/missing.js', 'br');
    ok('a file with no twin falls through', r.next);

    r = await drive('/../secret.js', 'br');
    ok('a path climbing out of dist is refused', r.next, 'never served, never stat-ed');

    r = await drive('/api/projects', 'br');
    ok('an API path is not this handler\'s business', r.next);
}

console.log('\n--- installing a new build (the handover) --------------------------');

/**
 * The client half, driven against a fake browser whose one rule is the browser's
 * own: A PLAIN RELOAD DOES NOT ACTIVATE A WAITING SERVICE WORKER. Only
 * `skipWaiting()` or closing every tab does.
 *
 * That rule is the whole reason this section exists. The automatic path reloaded
 * without asking for the handover, so the page came back controlled by the same
 * old worker with the same new one waiting, decided it was out of date again,
 * and reloaded again — the app never finished updating, and each round purged
 * the cache and re-downloaded the bundle. Nothing in a green suite noticed,
 * because every piece was individually right.
 *
 * So what is asserted is the SEQUENCE across reloads, not the pieces: a reload
 * for an update is preceded by a handover request, a successful handover leaves
 * the new worker in charge, and a handover that never lands stops after one
 * reload and shows the banner instead of going round again.
 */
{
    const { buildSync } = await import('esbuild');

    // One bundle so the three modules share state exactly as they do in the app;
    // re-imported with a fresh query per "page load", which is what a reload is.
    const entry = join(scratch, 'update-entry.ts');
    writeFileSync(entry, [
        `export { registerSW, onUpdateReady } from ${JSON.stringify(join(repoRoot, 'src/sw-register.ts'))};`,
        `export { watchFreshness, noteServerReconnected } from ${JSON.stringify(join(repoRoot, 'src/utils/freshness.ts'))};`,
        `export { installNewBuild, shouldInstallNow, HANDOVER_GRACE_MS } from ${JSON.stringify(join(repoRoot, 'src/utils/installUpdate.ts'))};`,
    ].join('\n'));
    const outfile = join(scratch, 'update-bundle.mjs');
    buildSync({
        entryPoints: [entry], outfile, bundle: true, format: 'esm', target: 'es2022',
        define: { 'import.meta.env.DEV': 'false' }, logLevel: 'silent',
    });
    const bundleUrl = pathToFileURL(outfile).href;

    const emitter = () => {
        const listeners = new Map();
        return {
            addEventListener: (type, fn) => { (listeners.get(type) ?? listeners.set(type, []).get(type)).push(fn); },
            fire: (type, ev = {}) => (listeners.get(type) ?? []).forEach((fn) => fn(ev)),
        };
    };

    /** A tab: one persistent registration and one sessionStorage across reloads. */
    function openTab({ handoverWorks }) {
        const store = new Map();
        const tab = { reloads: 0, handoversAsked: 0, updateChecks: 0, buildId: 'one-build', caches: new Set(['terramentor-old']) };
        const registration = { installing: null, waiting: null, active: null, ...emitter() };

        // `reg.update()`: the browser re-fetches /sw.js on demand. A worker that
        // the server already has but this page has never asked for arrives here.
        registration.update = async () => {
            tab.updateChecks++;
            if (!tab.unnoticed) return;
            const next = tab.unnoticed;
            tab.unnoticed = null;
            next.state = 'installed';
            registration.waiting = next;
        };
        const container = {
            controller: null, ...emitter(),
            register: async () => registration,
            getRegistration: async () => registration,
            getRegistrations: async () => [registration],
        };

        const worker = (state) => {
            const w = { state, ...emitter() };
            w.postMessage = (msg) => {
                if (msg?.type !== 'SKIP_WAITING') return;
                tab.handoversAsked++;
                if (!handoverWorks) return;          // the message that never arrives
                // A worker is another thread: the message lands after the caller
                // has finished, never inside postMessage. Modelled, because the
                // page uses that gap to arm its fallback.
                setTimeout(() => {
                    registration.waiting = null;     // skipWaiting(): activate + claim
                    registration.active = w;
                    w.state = 'activated';
                    container.controller = w;
                    container.fire('controllerchange');
                }, 0);
            };
            return w;
        };

        const first = worker('activated');
        registration.active = first;
        container.controller = first;

        tab.registration = registration;
        tab.container = container;
        tab.worker = worker;

        /** A page load: fresh module state, the same browser underneath. */
        tab.load = async () => {
            const win = emitter();
            globalThis.window = Object.assign(win, {
                isSecureContext: true,
                location: { reload: () => { tab.reloads++; } },
                setInterval: () => 0,
                setTimeout: (fn, ms) => setTimeout(fn, ms),
                clearTimeout: (id) => clearTimeout(id),
            });
            globalThis.document = Object.assign(emitter(), { visibilityState: 'visible', activeElement: null });
            Object.defineProperty(globalThis, 'navigator', { value: { serviceWorker: container }, configurable: true, writable: true });
            globalThis.sessionStorage = {
                getItem: (k) => (store.has(k) ? store.get(k) : null),
                setItem: (k, v) => store.set(k, String(v)),
                removeItem: (k) => store.delete(k),
            };
            globalThis.caches = { keys: async () => [...tab.caches], delete: async (k) => tab.caches.delete(k) };
            globalThis.fetch = async () => ({ ok: true, json: async () => ({ buildId: tab.buildId }) });

            const mod = await import(`${bundleUrl}?load=${Math.random()}`);
            tab.bannered = false;
            const stale = () => {                      // exactly UpdatePrompt's effect
                if (mod.shouldInstallNow()) mod.installNewBuild();
                else tab.bannered = true;
            };
            mod.onUpdateReady(stale);
            mod.watchFreshness(stale);
            mod.registerSW();
            window.fire('load');
            await new Promise((r) => setTimeout(r, 20));
            tab.grace = mod.HANDOVER_GRACE_MS;
            tab.reconnect = mod.noteServerReconnected;   // a stream came back: check now
        };

        /** A new build: the browser installs a second worker, which WAITS. */
        tab.newBuildArrives = async () => {
            const next = worker('installing');
            registration.installing = next;
            registration.fire('updatefound');
            next.state = 'installed';
            registration.waiting = next;
            next.fire('statechange');
            await new Promise((r) => setTimeout(r, 20));
            return next;
        };

        tab.settle = () => new Promise((r) => setTimeout(r, tab.grace + 200));
        return tab;
    }

    {
        const tab = openTab({ handoverWorks: true });
        await tab.load();
        check('an up-to-date page does not reload itself', tab.reloads, 0);

        const next = await tab.newBuildArrives();
        check('a waiting worker is asked to take over', tab.handoversAsked, 1);
        ok('...before anything reloads', tab.container.controller === next,
            'reloading first leaves the old worker in charge and the new one waiting — the loop');
        check('the new worker is no longer waiting', tab.registration.waiting, null);

        const reloadsAfterHandover = tab.reloads;
        await tab.load();
        await tab.settle();
        check('the load that follows is done updating', tab.reloads, reloadsAfterHandover);
        ok('...and raises no banner', !tab.bannered);
    }

    {
        // The handover message never arrives. One reload is the fallback doing its
        // job; a second would be the loop starting.
        const tab = openTab({ handoverWorks: false });
        await tab.load();
        await tab.newBuildArrives();
        await tab.settle();
        check('a handover that never lands still reloads, once', tab.reloads, 1);

        await tab.load();
        await tab.settle();
        check('the next load does NOT reload again', tab.reloads, 1);
        ok('...it shows the banner instead', tab.bannered,
            'the person gets a working way through, not an app in a reload loop');

        await tab.load();
        await tab.settle();
        check('and it stays that way', tab.reloads, 1);
    }

    {
        // The usual way a rebuild is noticed here: the server says so first. The
        // browser only re-fetches /sw.js on a navigation, so at this moment
        // nothing is waiting — and reloading to make it notice, then again to
        // hand over, downloads the whole bundle twice (the first reload having
        // purged the cache). Measured in a real browser at 2 reloads before this.
        const tab = openTab({ handoverWorks: true });
        await tab.load();
        tab.unnoticed = tab.worker('installing');    // installed on demand, not before
        tab.buildId = 'two-builds';                  // what the server now serves

        tab.reconnect();                             // a stream reconnected
        await tab.settle();
        ok('a build the browser has not seen yet is looked for', tab.updateChecks >= 1);
        check('...and handed over to, not reloaded past', tab.handoversAsked, 1);
        check('...so the page reloads once, not twice', tab.reloads, 1);
        check('nothing is left waiting', tab.registration.waiting, null);
    }
}

console.log('\n--- the container build can reach the plugins ------------------------');

/*
 * The image builds the frontend INSIDE Docker (`RUN npm run build`), so every
 * file vite.config.ts imports has to survive .dockerignore. Excluding `tools/`
 * as "local tooling" breaks this one path and nothing else: the config imports
 * three files out of it, and the release dies with
 *
 *     vite.config.ts:5:36: ERROR: Could not resolve "./tools/vite-plugin-sw.mjs"
 *
 * which reads as a broken dependency rather than as a build-context problem —
 * `npm run build` on a checkout has the whole repo, so the suite, the desktop
 * packages and every local build stay green while the one install path the
 * README leads with is broken.
 *
 * Asserted from the CONFIG rather than a list of filenames, so a fourth plugin
 * is covered the day it is added — which is the way this breaks a second time.
 */
{
    const viteConfig = readFileSync(join(repoRoot, 'vite.config.ts'), 'utf8');
    const imported = [...viteConfig.matchAll(/from\s+'\.\/(tools\/[A-Za-z0-9._/-]+)'/g)].map((m) => m[1]);
    ok('vite.config.ts imports from tools/ at all', imported.length > 0, `${imported.length} found`);

    // The whole transitive set: a plugin may import a sibling (compressPlugin
    // imports precompress.mjs), and a sibling left out of the context fails
    // exactly the same way one line further in.
    const reachable = new Set();
    const walk = (rel) => {
        if (reachable.has(rel) || !existsSync(join(repoRoot, rel))) return;
        reachable.add(rel);
        const src = readFileSync(join(repoRoot, rel), 'utf8');
        for (const m of src.matchAll(/from\s+'(\.[A-Za-z0-9._/-]+)'/g)) {
            reachable.add(join(dirname(rel), m[1]).split('\\').join('/'));
            walk(join(dirname(rel), m[1]).split('\\').join('/'));
        }
    };
    for (const rel of imported) walk(rel);

    for (const rel of reachable) ok(`${rel} is on disk`, existsSync(join(repoRoot, rel)));

    /* .dockerignore's own rules, reduced to the question being asked: does any
     * line exclude one of these paths, and is it un-done by a later `!` line?
     * Last match wins, which is Docker's rule and NOT git's. */
    const dockerignore = readFileSync(join(repoRoot, '.dockerignore'), 'utf8')
        .split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    const excluded = (path) => {
        let verdict = false;
        for (const raw of dockerignore) {
            const negate = raw.startsWith('!');
            const pattern = (negate ? raw.slice(1) : raw).replace(/\/$/, '');
            const hit = path === pattern
                || path.startsWith(`${pattern}/`)
                || (pattern.startsWith('*.') && path.endsWith(pattern.slice(1)) && !path.includes('/'))
                || path.split('/').pop() === pattern;
            if (hit) verdict = !negate;
        }
        return verdict;
    };

    // The control: the rule only means something if it can say yes as well as no.
    ok('the matcher does exclude what .dockerignore excludes', excluded('temp/scratch.mjs'));
    ok('...and a negated root file survives', !excluded('package.json'));

    for (const rel of reachable) {
        ok(`${rel} survives .dockerignore`, !excluded(rel));
    }
}

// ---------------------------------------------------------------------------

try { rmSync(scratch, { recursive: true, force: true }); } catch { /* Windows may hold a handle */ }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
