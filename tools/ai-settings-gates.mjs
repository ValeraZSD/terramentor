#!/usr/bin/env node
/**
 * Settings → AI & Models: what the panel keeps on screen after something
 * under it changes.
 *
 * The real AISettings is MOUNTED in jsdom; the api, the store and the
 * sections that draw their own requests are stubs, and the three pieces this
 * panel talks to (the connection list, the model picker, the serving-provider
 * list) are small stand-ins that expose what the panel hands them.
 *
 *   - The machines behind a router are listed per model. The list read for one
 *     model was kept when the model changed, and the providers ticked from it
 *     were saved as the order for the next one. A request that failed was kept
 *     as "this endpoint publishes no list" and never asked again.
 *   - Removing the Ollama model in use left it chosen: the reconcile effect
 *     keeps a saved name that is not installed, so no "Choose a model" line
 *     showed and every call named a model the server no longer had.
 *
 *   node tools/ai-settings-gates.mjs
 *   node tools/ai-settings-gates.mjs --head   (AISettings as it was at HEAD, to watch the cases fail)
 */
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEAD = process.argv.includes('--head');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
    cond ? pass++ : fail++;
    console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${cond || !detail ? '' : `  — ${detail}`}`);
};

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost/settings' });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
for (const k of ['HTMLElement', 'Element', 'Node', 'KeyboardEvent', 'MouseEvent', 'FocusEvent', 'Event']) if (window[k]) globalThis[k] = window[k];
globalThis.localStorage = window.localStorage;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = (q) => ({ matches: /pointer: fine/.test(q), media: q, addEventListener() { }, removeEventListener() { }, addListener() { }, removeListener() { } });

const settingsDir = path.join(ROOT, 'src', 'components', 'settings');
const stubs = {
    'react-i18next': `export const useTranslation = () => ({ t: (k, o) => { let s = k; for (const [a, b] of Object.entries(o ?? {})) s = s.replace('{{' + a + '}}', b); return s; }, i18n: { language: 'en' } });`,
    'i18n': `export default { t: (k) => k, language: 'en' }; export const k = (s) => s;`,
    'store': `const s = { addToast: () => {}, showConfirm: async () => true, aiConfigRev: 0 };
        export const useStore = (sel) => sel(s); useStore.getState = () => s; useStore.setState = () => {};`,
    'api': `export const api = new Proxy({}, { get: (_, name) => (...args) => globalThis.__api(name, args) });`,
    'nothing': `export default function Stub() { return null; }`,
    // The connection in use, reported the way the real list reports it.
    'connections': `import { useEffect } from 'react';
        export default function ConnectionsPanel({ onActive }) {
            useEffect(() => { onActive?.(globalThis.__connection); }, []);
            return null;
        }`,
    // What the panel hands the picker: the chosen id, and a button per way to change it.
    'picker': `import { createElement as h } from 'react';
        export default function ModelPicker({ value, onChange, models, onDelete }) {
            return h('div', { id: 'picker', 'data-value': value },
                h('button', { id: 'pick-b', onClick: () => onChange('model-b') }, 'pick b'),
                ...(onDelete ? models.map(m => h('button', { key: m.name, className: 'del', 'data-model': m.name, onClick: () => onDelete(m.name) }, 'delete ' + m.name)) : []));
        }`,
    'serving': `import { createElement as h } from 'react';
        export default function ServingEndpointsPicker({ servingEndpoints, endpointsLoading, loadServingEndpoints }) {
            return h('div', { id: 'serving', 'data-loading': String(endpointsLoading), 'data-list': JSON.stringify(servingEndpoints) },
                h('button', { id: 'ask', onClick: () => loadServingEndpoints() }, 'ask'));
        }`,
};

const scratch = mkdtempSync(path.join(ROOT, 'node_modules', '.cache', 'ai-settings-gates-'));
// At HEAD the file is read from git into a sibling of the real one, so its relative imports still resolve.
const settingsAbs = HEAD ? path.join(settingsDir, `.head-AISettings-${process.pid}.tsx`) : path.join(settingsDir, 'AISettings.tsx');
if (HEAD) writeFileSync(settingsAbs, execFileSync('git', ['show', 'HEAD:src/components/settings/AISettings.tsx'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 }));
const out = path.join(scratch, 'bundle.cjs');
try {
    await esbuild.build({
        stdin: { contents: `export { default as AISettings } from ${JSON.stringify(settingsAbs.replace(/\\/g, '/'))};`, resolveDir: ROOT, loader: 'tsx' },
        bundle: true, format: 'cjs', platform: 'node', outfile: out,
        jsx: 'automatic', loader: { '.css': 'empty', '.svg': 'dataurl' }, packages: 'external',
        define: { 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true' },
        logLevel: 'silent',
        plugins: [{
            name: 'stubs',
            setup(b) {
                const to = (p) => () => ({ path: p, namespace: 'stub' });
                b.onResolve({ filter: /^react-i18next$/ }, to('react-i18next'));
                b.onResolve({ filter: /^(\.\.\/)+store$/ }, to('store'));
                b.onResolve({ filter: /^(\.\.\/)+i18n$/ }, to('i18n'));
                b.onResolve({ filter: /^(\.\.\/)+api$/ }, to('api'));
                b.onResolve({ filter: /^\.\/connections\/ConnectionsPanel$/ }, to('connections'));
                b.onResolve({ filter: /^\.\.\/ModelPicker$/ }, to('picker'));
                b.onResolve({ filter: /^\.\/ServingEndpointsPicker$/ }, to('serving'));
                b.onResolve({ filter: /^\.\/(VisualKindsPanel|ModelJobsSection|JobModelsSection|ThinkingSlider)$/ }, to('nothing'));
                b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ contents: stubs[a.path], loader: 'js', resolveDir: ROOT }));
            },
        }],
    });
} catch (e) {
    ok('the Settings panel bundles for the mounted check', false, e.message.slice(0, 300));
    rmSync(scratch, { recursive: true, force: true });
    if (HEAD) rmSync(settingsAbs, { force: true });
    process.exit(1);
}
if (HEAD) rmSync(settingsAbs, { force: true });

const React = require('react');
const { createRoot } = require('react-dom/client');
const { AISettings } = require(out);
const act = (fn) => React.act(fn);
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); });
const doc = window.document;
const host = doc.getElementById('root');
const click = async (el) => { await act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); }); await flush(); };

let root = null;
const mount = async (values) => {
    if (root) await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => root.render(React.createElement(AISettings, { active: true, snapshot: { ok: true, values } })));
    await flush();
};

const writes = [];
let installed = [];
let status = {};
let endpointsFor = () => ({ available: true, endpoints: [] });
const endpointCalls = [];
// The server answers for the model asked for, else for the one saved.
let savedModel = 'model-a';
globalThis.__api = async (name, args) => {
    if (name === 'setSetting') { writes.push([args[0], args[1]]); if (args[0] === 'ai_openai_model') savedModel = args[1]; return { success: true }; }
    if (name === 'getAIStatus') return status;
    if (name === 'getModels') return { success: true, models: installed };
    if (name === 'getEfforts') return { levels: null };
    if (name === 'getEmbeddingStatus') throw new Error('stub');
    if (name === 'getServingEndpoints') { endpointCalls.push(args[0]); return endpointsFor(args[0] ?? savedModel); }
    if (name === 'deleteModel') { installed = installed.filter((m) => m.name !== args[0]); return { success: true }; }
    return { success: true };
};

const serving = () => doc.getElementById('serving');
const list = () => JSON.parse(serving()?.getAttribute('data-list') ?? '"absent"');
const slugs = () => (list() ?? []).map((e) => e.slug).join(',');

// ── the machines behind a router ──────────────────────────────────────────
console.log('\nthe list of machines behind a router follows the model');
globalThis.__connection = { id: 3, kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', hasKey: true, active: true };
status = { available: true, provider: 'openai', model: 'model-a' };
installed = [];
await mount({ ai_enabled: 'true', ai_provider: 'openai', ai_openai_model: 'model-a' });
ok('the list starts unasked', serving() && list() === null, serving()?.getAttribute('data-list'));
endpointsFor = (m) => ({ available: true, endpoints: [{ slug: m === 'model-a' ? 'a1' : 'b1' }] });
await click(doc.getElementById('ask'));
ok('opened, it is the saved model\'s list', slugs() === 'a1', slugs());
ok('and the request names that model', endpointCalls.at(-1) === 'model-a', String(endpointCalls.at(-1)));
await click(doc.getElementById('pick-b'));
ok('after another model is chosen, the list is the new model\'s, not the old one\'s', slugs() === 'b1', slugs());
ok('asked for the new model by name', endpointCalls.at(-1) === 'model-b', String(endpointCalls.at(-1)));

// A slow answer for the model before must not land on the one after it.
await mount({ ai_enabled: 'true', ai_provider: 'openai', ai_openai_model: 'model-a' });
let release;
endpointsFor = (m) => (m === 'model-a'
    ? new Promise((r) => { release = () => r({ available: true, endpoints: [{ slug: 'a-late' }] }); })
    : { available: true, endpoints: [{ slug: 'b1' }] });
await click(doc.getElementById('ask'));
await click(doc.getElementById('pick-b'));
await act(async () => { release?.(); });
await flush();
ok('a slow answer for the model before is dropped', slugs() === 'b1', slugs());

// A request that failed is not an answer.
await mount({ ai_enabled: 'true', ai_provider: 'openai', ai_openai_model: 'model-a' });
endpointsFor = () => { throw new Error('network down'); };
await click(doc.getElementById('ask'));
ok('a failed request leaves the list unasked, not "publishes no list"', list() === null, JSON.stringify(list()));
ok('and no request is left marked as running', serving().getAttribute('data-loading') === 'false');
endpointsFor = () => ({ available: true, endpoints: [{ slug: 'a1' }] });
await click(doc.getElementById('ask'));
ok('opening it again asks again', slugs() === 'a1', slugs());

// ── removing the model in use ─────────────────────────────────────────────
console.log('\nremoving the Ollama model in use clears the choice');
globalThis.__connection = { id: 1, kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', hasKey: false, active: true };
status = { available: true, provider: 'ollama', model: 'm1:latest' };
installed = [{ name: 'm1:latest', size: 1 }, { name: 'm2:latest', size: 1 }];
await mount({ ai_enabled: 'true', ai_provider: 'ollama', ai_model: 'm1:latest' });
const chosen = () => doc.getElementById('picker')?.getAttribute('data-value');
ok('the saved model shows as chosen', chosen() === 'm1:latest', chosen());
writes.length = 0;
await click(doc.querySelector('.del[data-model="m2:latest"]'));
ok('removing another model keeps the choice and writes nothing', chosen() === 'm1:latest' && !writes.some(([k]) => k === 'ai_model'), `${chosen()} ${JSON.stringify(writes)}`);
await click(doc.querySelector('.del[data-model="m1:latest"]'));
ok('removing the one in use clears it on screen', chosen() === '', JSON.stringify(chosen()));
ok('…and saves the empty choice, so no call names a model that is gone', writes.some(([k, v]) => k === 'ai_model' && v === ''), JSON.stringify(writes));

await act(async () => root.unmount());
rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed${HEAD ? ' (against HEAD)' : ''}`);
process.exit(fail ? 1 : 0);
