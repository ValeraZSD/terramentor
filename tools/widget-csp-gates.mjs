// tools/widget-csp-gates.mjs — the widget sandbox's network lock is ours,
// whatever the model's markup says.
//
// Run:  node tools/widget-csp-gates.mjs [--builder <path to a renderWidget.ts>]
//
// Why this exists: a compiled widget is a model-written HTML document run in
// a sandboxed iframe (allow-scripts, opaque origin). What keeps it off the
// network is ONE element — the CSP meta `buildWidgetDoc` adds — and that
// element only counts if the parser puts it in <head> before anything the
// build wrote. The builder used to find the first textual `<head…>` with a
// regex and splice after it, so `<!-- <head> --><head></head>` put the whole
// injection inside a comment, and a `<header>` in a head-less build put it in
// the BODY, where a CSP meta is ignored. Either way the widget could fetch.
//
// This parses the builder's output with a real HTML parser (jsdom, parse5)
// for hostile and ordinary shapes and asserts, for each:
//   - the CSP meta is the FIRST element child of document.head, full policy;
//   - the theme style and the harness script are in <head> as elements;
//   - the theme tail is a real script after the build's own content;
//   - an ordinary widget keeps its own head elements, body and script.
// `--builder` runs the same cases against another copy of the file (the
// control: `git show HEAD:src/components/visuals/renderWidget.ts`).
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const argAt = process.argv.indexOf('--builder');
const builderPath = argAt !== -1 ? resolve(process.argv[argAt + 1]) : join(root, 'src/components/visuals/renderWidget.ts');

const cache = join(root, 'node_modules', '.cache');
mkdirSync(cache, { recursive: true });
const scratch = mkdtempSync(join(cache, 'widget-csp-gates-'));
const out = join(scratch, 'bundle.cjs');

// The builder reads the host's root font size off the live document.
const host = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = host.window;
globalThis.document = host.window.document;
globalThis.getComputedStyle = host.window.getComputedStyle.bind(host.window);

const stubs = {
    store: 'export const useStore = () => undefined;',
    api: 'export const api = {};',
    i18n: 'export default { t: (k) => k, language: "en" }; export const currentLocale = () => "en-GB";',
};
// The builder's file is bundled from its CONTENTS with the visuals folder as
// its resolve dir, so a copy of it anywhere on disk resolves the same siblings.
await esbuild.build({
    stdin: {
        contents: readFileSync(builderPath, 'utf8') + '\nexport { WIDGET_THEME_TAIL as __TAIL } from "./widgetTheme";',
        resolveDir: join(root, 'src/components/visuals'),
        loader: 'ts',
        sourcefile: 'renderWidget.ts',
    },
    bundle: true, format: 'cjs', platform: 'node', outfile: out,
    packages: 'external',
    plugins: [{
        name: 'stubs',
        setup(b) {
            b.onResolve({ filter: /(^|\/)(?:\.\.\/)+(api|store|i18n)$/ }, a => ({ path: a.path.split('/').pop(), namespace: 'stub' }));
            b.onLoad({ filter: /.*/, namespace: 'stub' }, a => ({ contents: stubs[a.path], loader: 'js' }));
        },
    }],
    logLevel: 'silent',
});
const { buildWidgetDoc, __TAIL: TAIL } = require(out);
rmSync(scratch, { recursive: true, force: true });

const POLICY = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:;";
const palette = {
    theme: 'light:#ffffff', dark: false, bg: '#ffffff', fg: '#0f172a', muted: '#64748b', border: '#e2e8f0',
    accent: '#0e7490', accentFg: '#0e7490', accent2: '#b45309', series: ['#0e7490', '#b45309', '#7c3aed'],
};
const TOKEN = 'tok-csp-gate';
// What the build itself does: a marked script, so we can find it after parsing.
const BUILD = '<div id="w">widget</div><script>/*BUILD*/window.x=1;</script>';

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) pass++; else fail++;
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && extra ? `  — ${extra}` : ''}`);
};

function inspect(label, html, { ownHead = [] } = {}) {
    for (const probe of [false, true]) {
        const doc = buildWidgetDoc(html, TOKEN, { probe, palette });
        const d = new JSDOM(doc).window.document;
        const tag = `${label}${probe ? ' (probe)' : ''}`;
        const first = d.head && d.head.firstElementChild;
        check(`${tag}: the CSP meta is the first element in <head>`,
            !!first && first.localName === 'meta'
            && (first.getAttribute('http-equiv') || '').toLowerCase() === 'content-security-policy',
            first ? `first is <${first.localName}>` : 'no head child');
        check(`${tag}: … with the whole policy`, first?.getAttribute('content') === POLICY, first?.getAttribute('content'));
        check(`${tag}: the theme style and the harness are head elements`,
            d.head.querySelector('style#__w-theme') !== null
            && [...d.head.querySelectorAll('script')].some(s => s.textContent.includes(JSON.stringify(TOKEN))));
        const scripts = [...d.querySelectorAll('script')];
        const build = scripts.findIndex(s => s.textContent.includes('/*BUILD*/'));
        const tail = scripts.findIndex(s => s.textContent === TAIL);
        check(`${tag}: the build's own script survives, and the tail runs after it`,
            build !== -1 && tail > build, `build #${build}, tail #${tail}`);
        check(`${tag}: nothing we inject is left as text`,
            !d.documentElement.textContent.includes('Content-Security-Policy')
            && ![...d.querySelectorAll('*')].some(el => [...el.attributes].some(a => a.value.includes('Content-Security-Policy') && el !== first)));
        for (const sel of ownHead) {
            check(`${tag}: the build's own ${sel} stays in <head>`, d.head.querySelector(sel) !== null);
        }
    }
}

console.log(`builder: ${builderPath}\n`);

// Ordinary shapes the compiler actually produces.
inspect('a full document', `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Pendulum</title><style>#w{color:red}</style></head><body>${BUILD}</body></html>`,
    { ownHead: ['title', 'style:not(#__w-theme)', 'meta[charset]'] });
inspect('no <head>', `<!doctype html><html><body>${BUILD}</body></html>`);
inspect('no <html> at all', BUILD);
inspect('upper-case tags', `<!DOCTYPE HTML><HTML><HEAD><STYLE>#w{}</STYLE></HEAD><BODY>${BUILD}</BODY></HTML>`, { ownHead: ['style:not(#__w-theme)'] });
inspect('two <head>s', `<!doctype html><html><head><style>#w{}</style></head><head></head><body>${BUILD}</body></html>`, { ownHead: ['style:not(#__w-theme)'] });
inspect('a leading BOM and whitespace', `﻿  \n<!doctype html><html><head><style>#w{}</style></head><body>${BUILD}</body></html>`, { ownHead: ['style:not(#__w-theme)'] });

// Hostile shapes: the first textual `<head` is not the head.
inspect('<head> inside a comment', `<!doctype html><html><!-- <head> --><head></head><body>${BUILD}</body></html>`);
inspect('<head> inside an attribute value', `<!doctype html><html data-x="<head>"><head></head><body>${BUILD}</body></html>`);
inspect('<head> inside <title>', `<!doctype html><html><title><head></title><body>${BUILD}</body></html>`);
inspect('<head> inside a script string', `<!doctype html><html><script>var s = "<head>";</script><body>${BUILD}</body></html>`);
inspect('a <header> and no <head>', `<!doctype html><html><body><header>Title</header>${BUILD}</body></html>`);
inspect('<head> inside a <textarea>', `<!doctype html><html><body><textarea><head></textarea>${BUILD}</body></html>`);
inspect('</body> inside a trailing comment', `<!doctype html><html><head></head><body>${BUILD}</body></html><!-- </body> -->`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
