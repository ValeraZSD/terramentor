#!/usr/bin/env node
/**
 * The endpoint Settings shows is the endpoint the server uses.
 *
 * With nothing saved, server/ai.js talks to `DEFAULT_OLLAMA_URL` or
 * `DEFAULT_OPENAI_BASE_URL`. Settings starts its two address fields on those
 * and shows them as the placeholder, from a copy in
 * src/components/settings/aiDefaults.ts (the page cannot import the server
 * module). The copy had drifted: Settings started on http://127.0.0.1:8888/v1,
 * one developer's llama-swap port, while the server fell back to another
 * address, so a fresh install displayed an endpoint it was not using and ticked
 * a preset chip for it.
 *
 * Two more halves (30 Sep 2026):
 *   - ONE copy of each default in the page. The welcome screen's model step
 *     carried the Ollama address as a second literal, which can drift exactly
 *     as the first one did; any `:11434` outside aiDefaults.ts fails.
 *   - Settings SAVES the address it shows. The field autosaved only when it
 *     changed, so a library switched to the OpenAI-compatible provider with the
 *     field left on the default held no address, and "no address" is the shape
 *     the 1.0.0 migration in server/database.js reads as "relied on the old
 *     loopback default". The real component is MOUNTED (api, store and the
 *     sibling sections are stubs) and its writes are recorded: switching the
 *     provider, pressing the preset that is already on, and saving a key each
 *     write `ai_openai_base_url`.
 *
 *   node tools/settings-defaults-gates.mjs
 *   node tools/settings-defaults-gates.mjs --settings <file>   check another copy of AISettings
 */
import { readFileSync, readdirSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.isAbsolute(rel) ? rel : path.join(ROOT, rel), 'utf8');
const argAt = process.argv.indexOf('--settings');
const SETTINGS_FILE = argAt > 0 ? process.argv[argAt + 1] : 'src/components/settings/AISettings.tsx';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
    cond ? pass++ : fail++;
    console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${cond || !detail ? '' : `  — ${detail}`}`);
};
const constant = (src, name) => new RegExp(`const ${name} = '([^']+)'`).exec(src)?.[1] ?? null;

const server = read('server/ai.js');
const client = read('src/components/settings/aiDefaults.ts');
const settings = read(SETTINGS_FILE);

for (const name of ['DEFAULT_OLLAMA_URL', 'DEFAULT_OPENAI_BASE_URL']) {
    const s = constant(server, name);
    const c = constant(client, name);
    ok(`server/ai.js declares ${name}`, !!s);
    ok(`aiDefaults.ts mirrors ${name} (${s})`, !!s && s === c, `server ${s}, page ${c}`);
}

// The fields START on the defaults and SHOW them as the placeholder. Read off
// the component, so a literal address typed back in beside the import fails.
ok('the Ollama field starts on DEFAULT_OLLAMA_URL', /useState\(DEFAULT_OLLAMA_URL\)/.test(settings));
ok('the API field starts on DEFAULT_OPENAI_BASE_URL', /useState\(DEFAULT_OPENAI_BASE_URL\)/.test(settings));
ok('the placeholder is the default of the provider shown',
    /placeholder=\{provider === 'ollama' \? DEFAULT_OLLAMA_URL : DEFAULT_OPENAI_BASE_URL\}/.test(settings));

// No developer's private port anywhere in the page. 8888 is llama-swap as one
// machine runs it; llama-swap's own default is 8080.
const walk = (dir) => readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? (f === 'locales' ? [] : walk(p)) : /\.(ts|tsx)$/.test(f) ? [p] : [];
});
const privatePort = walk(path.join(ROOT, 'src')).filter((f) => /127\.0\.0\.1:8888|localhost:8888/.test(read(f)));
ok('no source file names 127.0.0.1:8888', privatePort.length === 0, privatePort.map((f) => path.relative(ROOT, f)).join(', '));
ok('…and neither does the Settings file checked', !/:8888\b/.test(settings));

// ONE copy of the Ollama default in the page: every other file imports it.
// Matched on the port, so `localhost:11434` or a trailing slash is a copy too.
const ollamaPort = /:(\d+)\/?$/.exec(constant(client, 'DEFAULT_OLLAMA_URL') || '')?.[1];
const copies = ollamaPort ? walk(path.join(ROOT, 'src'))
    .filter((f) => path.basename(f) !== 'aiDefaults.ts')
    .filter((f) => new RegExp(`(127\\.0\\.0\\.1|localhost|\\[::1\\]):${ollamaPort}\\b`).test(read(f))) : ['(no port read)'];
ok(`no second literal copy of the Ollama default (:${ollamaPort}) outside aiDefaults.ts`, copies.length === 0,
    copies.map((f) => path.relative(ROOT, f)).join(', '));

// Two preset chips for one address light up together.
const presets = [...settings.matchAll(/url: '([^']+)'/g)].map((m) => m[1]);
ok('the endpoint presets are distinct addresses', presets.length >= 3 && new Set(presets).size === presets.length,
    presets.join(' '));

// ---- Settings saves the address it shows ------------------------------------
await (async () => {
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

    const DEFAULT_OPENAI = constant(client, 'DEFAULT_OPENAI_BASE_URL');
    const settingsAbs = path.isAbsolute(SETTINGS_FILE) ? SETTINGS_FILE : path.join(ROOT, SETTINGS_FILE);
    const settingsDir = path.join(ROOT, 'src', 'components', 'settings');
    const nothing = `export default function Stub() { return null; }`;
    const stubs = {
        'react-i18next': `export const useTranslation = () => ({ t: (k, o) => { let s = k; for (const [a, b] of Object.entries(o ?? {})) s = s.replace('{{' + a + '}}', b); return s; } });`,
        'i18n': `export default { t: (k) => k, language: 'en' }; export const k = (s) => s;`,
        'store': `const s = { addToast: () => {}, showConfirm: async () => true };
            export const useStore = (sel) => sel(s); useStore.getState = () => s;`,
        'api': `export const api = new Proxy({}, { get: (_, name) => (...args) => globalThis.__api(name, args) });`,
        'openRouterConnect': `export const connectOpenRouter = async () => {};`,
        'nothing': nothing,
    };
    const scratch = mkdtempSync(path.join(ROOT, 'node_modules', '.cache', 'settings-defaults-gates-'));
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
                    b.onResolve({ filter: /utils\/openRouterConnect$/ }, to('openRouterConnect'));
                    // The sibling sections and the model picker draw their own
                    // requests; what is under test is this panel's writes.
                    b.onResolve({ filter: /^(\.\.\/ModelPicker|\.\/(VisualKindsPanel|WebAnswersSection|ModelJobsSection|SetupHelpSection|ThinkingSlider|ServingEndpointsPicker))$/ }, to('nothing'));
                    b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ contents: stubs[a.path], loader: 'js', resolveDir: ROOT }));
                    // A copy checked with --settings sits elsewhere; its relative
                    // imports meant src/components/settings/.
                    b.onResolve({ filter: /^\.\.?\// }, async (a) => {
                        if (path.resolve(a.importer) !== path.resolve(settingsAbs) || path.dirname(settingsAbs) === settingsDir) return undefined;
                        return b.resolve(a.path, { resolveDir: settingsDir, kind: a.kind });
                    });
                },
            }],
        });
    } catch (e) {
        ok('the Settings panel bundles for the mounted check', false, e.message.slice(0, 300));
        rmSync(scratch, { recursive: true, force: true });
        return;
    }
    const React = require('react');
    const { createRoot } = require('react-dom/client');
    const { AISettings } = require(out);
    const act = (fn) => React.act(fn);
    const flush = () => act(async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); });
    const wait = (ms) => act(() => new Promise((r) => setTimeout(r, ms)));

    const writes = [];
    globalThis.__api = async (name, args) => {
        if (name === 'setSetting') writes.push([args[0], args[1]]);
        if (name === 'setAIKey') writes.push(['(key)', args[1]]);
        if (name === 'getAIStatus') return { available: false, error: 'stub', hasApiKey: false };
        if (name === 'getModels') return { success: false, models: [] };
        if (name === 'getEmbeddingStatus') throw new Error('stub');
        return { success: true };
    };
    const baseWrites = () => writes.filter(([k]) => k === 'ai_openai_base_url').map(([, v]) => v);
    const doc = window.document;
    const host = doc.getElementById('root');
    let root = null;
    /** A library whose settings row set is `values`, as the shell hands it over, on a fresh mount. */
    const mount = async (values) => {
        if (root) await act(async () => root.unmount());
        root = createRoot(host);
        writes.length = 0;
        await act(async () => root.render(React.createElement(AISettings, { active: true, snapshot: { ok: true, values } })));
        await flush();
        await wait(900);      // past every debounced autosave the mount itself may schedule
        writes.length = 0;
    };
    const radio = (label) => [...doc.querySelectorAll('[role="radio"]')].find((b) => b.textContent.trim() === label);
    const button = (label) => [...doc.querySelectorAll('button')].find((b) => b.textContent.trim() === label);
    const click = async (el) => { if (el) await act(async () => { el.click(); }); await flush(); };

    // A fresh library: Ollama, nothing about the OpenAI-compatible path saved.
    await mount({ ai_enabled: 'true' });
    await click(radio('OpenAI-compatible API'));
    await wait(900);
    ok('switching to the OpenAI-compatible provider saves the address shown, default included',
        baseWrites().includes(DEFAULT_OPENAI), JSON.stringify(writes));
    const order = writes.map(([k]) => k);
    ok('…before the provider, so the connection check that follows already talks to it',
        order.indexOf('ai_openai_base_url') >= 0 && order.indexOf('ai_openai_base_url') < order.indexOf('ai_provider'), JSON.stringify(order));

    // A library already on the provider, the field on the default: pressing
    // the "OpenAI" chip changes no state, which is where nothing got written.
    await mount({ ai_enabled: 'true', ai_provider: 'openai' });
    await click(button('OpenAI'));
    await wait(900);
    ok('pressing the preset that is already on saves its address', baseWrites().includes(DEFAULT_OPENAI), JSON.stringify(writes));
    await click(button('OpenRouter'));
    await wait(900);
    ok('…and pressing another still saves that one, once', baseWrites().filter((v) => v === 'https://openrouter.ai/api/v1').length === 1, JSON.stringify(writes));

    // Saving a key binds it to the address on screen; the address goes with it.
    await mount({ ai_enabled: 'true', ai_provider: 'openai' });
    const keyField = doc.querySelector('input[type="password"]');
    if (keyField) {
        await act(async () => {
            Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(keyField, 'sk-test');
            keyField.dispatchEvent(new window.Event('input', { bubbles: true }));
        });
        await act(async () => { keyField.focus(); keyField.blur(); });
        await flush();
    }
    ok('saving a key saves the address it is bound to', !!keyField && baseWrites().includes(DEFAULT_OPENAI)
        && writes.findIndex(([k]) => k === 'ai_openai_base_url') < writes.findIndex(([k]) => k === '(key)'), JSON.stringify(writes));

    await act(async () => root.unmount());
    rmSync(scratch, { recursive: true, force: true });
})();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
