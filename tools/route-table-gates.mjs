// tools/route-table-gates.mjs — one app, built from many route files.
//
// Run:  node tools/route-table-gates.mjs
//
// server/app.js builds the Express app in createApp(); every route lives in a
// file under server/routes/ that RECORDS its registrations (routeTable.js) and
// exports them as blocks, and createApp mounts the blocks in one list. Express
// answers in registration order, so that list is behaviour, and splitting the
// routes across files made new ways to get it wrong — each of them silent at
// runtime:
//
//   * a route file app.js never imports registers nothing: a 404, and no
//     runtime check can see a module that was never loaded;
//   * a block nobody mounts, or a route recorded after its file's last
//     `takeRoutes()`, likewise (createApp throws on both; asserted below);
//   * a route mounted above `requireAuth` is open to anyone who can reach the
//     port — so the routes before the password check are an explicit list;
//   * a route registered after one whose pattern already matches it is never
//     reached (`/api/resources/reorder` after `/api/resources/:id`).
//
// Three halves: the recorder on its own, a source scan of server/routes/, and
// the built app on a scratch library (no model, no network, no port).

import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { serverFiles, readServer } from './lib/serverSource.mjs';

const require = createRequire(import.meta.url);
const express = require('express');

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
    cond ? pass++ : fail++;
    console.log(`${cond ? '  ok   ' : ' FAIL  '}${label}${cond || !detail ? '' : ` — ${detail}`}`);
};
const throwsWith = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(String(e.message)); } };

// ---------------------------------------------------------------------------
console.log('--- the recorder ---');
{
    // A module instance of its own (the query string), so the tables made here
    // are not the app's and the app's are not checked against them.
    const { routeTable, mountRoutes, assertEveryBlockMounted } = await import('../server/routes/routeTable.js?gate');
    const h1 = () => {}, h2 = () => {}, mw = () => {};
    const t = routeTable('one');
    t.use(mw);
    t.get('/a', h1);
    t.post('/b', mw, h2);
    const block = t.takeRoutes();
    ok('a block holds the calls in the order they were made',
        block.calls.map((c) => c.method).join(',') === 'use,get,post' && block.calls[2].args[2] === h2);
    const replayed = [];
    const fake = Object.fromEntries(['use', 'get', 'post'].map((m) => [m, (...args) => replayed.push([m, ...args])]));
    mountRoutes(fake, block);
    ok('mounting replays them onto the app in that order, arguments untouched',
        replayed.length === 3 && replayed[1][0] === 'get' && replayed[1][1] === '/a' && replayed[1][2] === h1 && replayed[2][2] === mw);
    ok('reading a setting off the recorder is refused (there is no app to read)', throwsWith(() => t.get('trust proxy'), /needs a handler/));
    ok('with every block mounted, nothing is reported', !throwsWith(() => assertEveryBlockMounted(new Set([block])), /./));

    const late = routeTable('late');
    late.get('/c', h1);
    ok('a call recorded after the last takeRoutes() is named',
        throwsWith(() => assertEveryBlockMounted(new Set([block])), /routeTable\('late'\) recorded 1 call/));
    const lateBlock = late.takeRoutes();
    ok('a block that was never mounted is named',
        throwsWith(() => assertEveryBlockMounted(new Set([block])), /routeTable\('late'\) is never mounted/));
    ok('…and mounting it clears the report', !throwsWith(() => assertEveryBlockMounted(new Set([block, lateBlock])), /./));
}

// ---------------------------------------------------------------------------
console.log('\n--- every route file is imported and every block mounted (source) ---');
// A route file app.js does not import is never loaded, so createApp cannot
// know it exists. This half reads the files instead of the running app.
const appSrc = readServer('app.js');
const unmountedIn = (fileName, src, app) => {
    const problems = [];
    const name = fileName.replace(/^routes\//, '').replace(/\.js$/, '');
    const declared = src.match(/^const app = routeTable\('([^']+)'\);$/m);
    if (!declared) return problems;
    if (declared[1] !== name) problems.push(`${fileName} records under '${declared[1]}', not its own name '${name}'`);
    if (!app.includes(`import * as ${name}Api from './routes/${name}.js';`)) problems.push(`app.js does not import ${fileName}`);
    for (const [, block] of src.matchAll(/^export const (\w+) = app\.takeRoutes\(\);$/gm)) {
        if (!app.includes(`mount(${name}Api.${block});`)) problems.push(`createApp never mounts ${name}Api.${block}`);
    }
    return problems;
};
{
    const routeFiles = serverFiles().filter((f) => f.startsWith('routes/'));
    const tables = routeFiles.filter((f) => /^const app = routeTable\('/m.test(readServer(f)));
    ok('the scan finds the route files', tables.length >= 30, String(tables.length));
    const problems = routeFiles.flatMap((f) => unmountedIn(f, readServer(f), appSrc));
    ok('every route file records under its own name, is imported by app.js, and has every block mounted',
        problems.length === 0, problems.join('; '));
    // The helpers that live beside the route files (request.js, taskStream.js,
    // projectRows.js, the recorder itself) register nothing.
    const REGISTERS = /^app\.(?:get|post|put|patch|delete|all|use)\(/m;
    const helpersThatRegister = routeFiles.filter((f) => !tables.includes(f) && REGISTERS.test(readServer(f)));
    ok('a file in routes/ that registers a route goes through a routeTable', helpersThatRegister.length === 0, helpersThatRegister.join(', '));
    // The control: the same scan over a route file app.js forgot.
    const stray = "const app = routeTable('stray');\napp.get('/api/stray', h);\nexport const routes = app.takeRoutes();\n";
    ok('control: a route file app.js does not import is reported', unmountedIn('routes/stray.js', stray, appSrc).length === 2);
}

// ---------------------------------------------------------------------------
console.log('\n--- the built app ---');
const scratch = mkdtempSync(join(tmpdir(), 'route-table-gates-'));
process.env.DATA_DIR = scratch;
process.env.DB_PATH = join(scratch, 'gate.db');
process.env.VAULT_ROOT = join(scratch, 'vault');
delete process.env.TERRAMENTOR_DESKTOP;

let listens = 0;
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) { listens++; return listen.apply(this, args); };

const { createApp } = await import('../server/app.js');
const { requireAuth } = await import('../server/auth.js');
const app = createApp();
ok('importing server/app.js and building the app opens no socket', listens === 0, `${listens} listen call(s)`);

/** Every route in a stack, nested routers included, as `METHOD path`. */
const routesOf = (stack) => stack.flatMap((layer) => {
    if (layer.route) return Object.keys(layer.route.methods).map((m) => ({ key: `${m.toUpperCase()} ${layer.route.path}`, path: layer.route.path, method: m, re: layer.regexp }));
    return Array.isArray(layer.handle?.stack) ? routesOf(layer.handle.stack) : [];
});
const shapeOf = (a) => a._router.stack.map((l) => `${l.name} ${l.route ? routesOf([l])[0].key : l.regexp}`).join('\n');

ok('two calls build the same stack', shapeOf(createApp()) === shapeOf(app));
const stack = app._router.stack;
ok('the error handler is the last layer', stack.at(-1).handle.length === 4 && !stack.at(-1).route);

// The routes a request reaches WITHOUT a session. Each one on this list either
// discloses nothing (status, the icon, the desktop probe) or checks the session
// itself before acting (the auth routes that change a password or a key).
const PUBLIC = [
    'GET /api/auth/status', 'POST /api/auth/login', 'POST /api/auth/logout', 'POST /api/auth/setup',
    'POST /api/auth/change', 'POST /api/auth/disable',
    'GET /api/auth/apikey', 'POST /api/auth/apikey/regenerate', 'DELETE /api/auth/apikey',
    'GET /api/desktop/status',
    'GET /manifest.webmanifest', 'GET /api/icon/:name',
];
const publicOf = (a) => {
    const at = a._router.stack.findIndex((l) => l.handle === requireAuth);
    return at < 0 ? null : routesOf(a._router.stack.slice(0, at)).map((r) => r.key).sort();
};
const open = publicOf(app);
ok('the password check is mounted', open !== null);
ok('the routes before it are exactly the public list',
    JSON.stringify(open) === JSON.stringify([...PUBLIC].sort()),
    `extra: ${(open || []).filter((k) => !PUBLIC.includes(k)).join(', ') || 'none'}; missing: ${PUBLIC.filter((k) => !(open || []).includes(k)).join(', ') || 'none'}`);

/** Routes an earlier route answers first: B's own path, its params filled, matched by an earlier pattern. */
const shadowedIn = (a) => {
    const routes = routesOf(a._router.stack);
    const out = [];
    routes.forEach((b, j) => {
        const url = b.path.replace(/:(\w+)/g, 'zz-$1-zz');
        const by = routes.slice(0, j).find((r) => (r.method === b.method || r.method === '_all') && r.re.test(url));
        if (by) out.push(`${b.key} is answered first by ${by.key}`);
    });
    return out;
};
const shadowed = shadowedIn(app);
ok('no route is answered first by an earlier one', shadowed.length === 0, shadowed.join('; '));
{
    // The control: the order the comment beside /api/resources/reorder warns about.
    const bad = express();
    bad.put('/api/resources/:id', () => {});
    bad.put('/api/resources/reorder', () => {});
    bad.get('/api/resources/reorder', () => {});
    const found = shadowedIn(bad);
    ok('control: a static path after a parameter that swallows it is reported, for that method only',
        found.length === 1 && found[0] === 'PUT /api/resources/reorder is answered first by PUT /api/resources/:id', found.join('; '));
}

// The desktop launcher's process: the probe becomes a router with a heartbeat,
// both public, and the controls (quit, library) stay behind the check.
process.env.TERRAMENTOR_DESKTOP = '1';
const desktopApp = createApp();
const desktopOpen = publicOf(desktopApp);
ok('under the desktop launcher the public list gains only the heartbeat',
    JSON.stringify(desktopOpen) === JSON.stringify([...PUBLIC, 'POST /api/desktop/ping'].sort()),
    (desktopOpen || []).filter((k) => !PUBLIC.includes(k)).join(', '));
ok('…and its routes are not shadowed either', shadowedIn(desktopApp).length === 0, shadowedIn(desktopApp).join('; '));
ok('still no socket', listens === 0);

console.log(`\n${pass} passed, ${fail} failed`);
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* Windows holds the database open */ }
process.exit(fail ? 1 : 0);
