// mcp/views/bridge.js — what both views share (mcp/views.js puts it in front of
// check.js or review.js, in one script):
//
//   - the MCP Apps conversation with the host: JSON-RPC 2.0 over postMessage
//     to the window that framed the view (protocol 2026-01-26), the host's
//     tool-result notification, and tools/call relayed to this MCP server;
//   - the host's theme (its CSS variables, set through CSSOM: the view's
//     policy allows no style attribute) and the view's height, reported as it
//     changes;
//   - the app's words in the learner's language (the JSON block mcp/views.js
//     wrote), with i18next's `{{name}}` and `_one`/`_other` plural keys;
//   - `h()`, which builds the DOM from text nodes: no string is ever parsed
//     as markup or run as code.
'use strict';

const TM = (() => {
    const PROTOCOL = '2026-01-26';
    const host = window.parent;
    const SVG = 'http://www.w3.org/2000/svg';
    let nextId = 1;
    const waiting = new Map();
    const handlers = Object.create(null);

    // ---- words
    const words = (() => {
        try { return JSON.parse(document.getElementById('tm-strings').textContent || '{}'); } catch { return {}; }
    })();
    let table = words.en || {};
    let plural = new Intl.PluralRules('en');
    let appLanguage = null;

    function setLanguage(code) {
        const c = String(code || '').replace('_', '-').trim();
        const base = c.split('-')[0].toLowerCase();
        const pick = words[c] ? c : (words[base] ? base : 'en');
        table = words[pick] || {};
        try { plural = new Intl.PluralRules(c || pick); } catch { plural = new Intl.PluralRules(pick); }
        document.documentElement.lang = pick;
    }

    /** The language the learner chose in Terramentor wins over the host's. */
    function setAppLanguage(code) {
        if (typeof code !== 'string' || !code) return;
        appLanguage = code;
        setLanguage(code);
    }

    function t(key, vars) {
        const find = (k) => (table[k] != null ? table[k] : (words.en || {})[k]);
        let s = null;
        if (vars && typeof vars.count === 'number') s = find(`${key}_${plural.select(vars.count)}`) ?? find(`${key}_other`);
        if (s == null) s = find(key) ?? key;
        return String(s).replace(/\{\{\s*(\w+)\s*\}\}/g, (m, name) => (vars && vars[name] != null ? String(vars[name]) : m));
    }

    // ---- the conversation with the host
    function send(msg) {
        host.postMessage({ jsonrpc: '2.0', ...msg }, '*');
    }

    function request(method, params) {
        const id = nextId++;
        return new Promise((resolve, reject) => {
            waiting.set(id, { resolve, reject });
            send({ id, method, params: params || {} });
        });
    }

    function notify(method, params) {
        send({ method, ...(params ? { params } : {}) });
    }

    window.addEventListener('message', (event) => {
        if (event.source !== host) return;
        const msg = event.data;
        if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return;
        if (msg.id != null && msg.method === undefined) {
            const w = waiting.get(msg.id);
            if (!w) return;
            waiting.delete(msg.id);
            if (msg.error) w.reject(new Error(String(msg.error.message || 'The host refused the request.')));
            else w.resolve(msg.result);
            return;
        }
        if (msg.method === 'ui/notifications/host-context-changed') return applyContext(msg.params || {});
        if (msg.method === 'ui/resource-teardown' || msg.method === 'ping') {
            if (msg.id != null) send({ id: msg.id, result: {} });
            return;
        }
        const handle = handlers[msg.method];
        if (handle) {
            try { handle(msg.params || {}); } catch (err) { showError(err); }
        } else if (msg.id != null) {
            send({ id: msg.id, error: { code: -32601, message: 'Method not found' } });
        }
    });

    // ---- theme and size
    // A fill and the text drawn on it are taken from the host only as a pair.
    // A host that sends one half (MCP Inspector 2.13 sends --color-text-inverse
    // in both themes, never --color-background-inverse) would otherwise put
    // its white text on the view's own fallback fill, which is near-white in
    // dark mode. Half a pair is dropped, so both halves fall back together.
    const COLOUR_PAIRS = [
        ['--color-background-primary', '--color-text-primary'],
        ['--color-background-inverse', '--color-text-inverse'],
    ];
    function halfPairs(vars) {
        const half = new Set();
        for (const [fill, text] of COLOUR_PAIRS) {
            if ((typeof vars[fill] === 'string') !== (typeof vars[text] === 'string')) { half.add(fill); half.add(text); }
        }
        return half;
    }

    function applyContext(ctx) {
        const root = document.documentElement;
        if (ctx.theme === 'dark' || ctx.theme === 'light') {
            root.dataset.theme = ctx.theme;
            root.style.setProperty('color-scheme', ctx.theme);
        }
        const vars = ctx.styles && ctx.styles.variables;
        if (vars && typeof vars === 'object') {
            const half = halfPairs(vars);
            for (const [name, value] of Object.entries(vars)) {
                if (half.has(name)) continue;
                if (/^--[A-Za-z0-9-]{1,64}$/.test(name) && typeof value === 'string' && value.length <= 400) root.style.setProperty(name, value);
            }
            for (const name of half) root.style.removeProperty(name);
        }
        if (!appLanguage && typeof ctx.locale === 'string') setLanguage(ctx.locale);
    }

    let lastHeight = 0;
    let lastWidth = 0;
    const resized = () => {
        const box = document.documentElement.getBoundingClientRect();
        const height = Math.ceil(box.height);
        const width = Math.ceil(box.width);
        if (height === lastHeight && width === lastWidth) return;
        lastHeight = height;
        lastWidth = width;
        notify('ui/notifications/size-changed', { width, height });
    };
    new ResizeObserver(resized).observe(document.body);

    // ---- the DOM, from text only
    function h(tag, props, ...children) {
        const el = document.createElement(tag);
        for (const [key, value] of Object.entries(props || {})) {
            if (value == null || value === false) continue;
            if (key.startsWith('on')) {
                if (typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
            } else if (key === 'class') {
                el.className = value;
            } else {
                el.setAttribute(key, value === true ? '' : String(value));
            }
        }
        append(el, children);
        return el;
    }

    function append(el, children) {
        for (const child of children.flat(Infinity)) {
            if (child == null || child === false) continue;
            el.append(child instanceof Node ? child : document.createTextNode(String(child)));
        }
    }

    /** Line icons, 20 units square, drawn from path data held here (never from a message). */
    const ICONS = {
        up: 'M5 12.5 10 7.5l5 5',
        down: 'M5 7.5l5 5 5-5',
        undo: 'M7.5 4.5 4 8l3.5 3.5M4 8h7.5a4.5 4.5 0 0 1 0 9H9',
        check: 'M4.5 10.5l3.5 3.5 7.5-8',
        cross: 'M5.5 5.5l9 9M14.5 5.5l-9 9',
    };
    function icon(name) {
        const svg = document.createElementNS(SVG, 'svg');
        svg.setAttribute('viewBox', '0 0 20 20');
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('class', 'icon');
        const path = document.createElementNS(SVG, 'path');
        path.setAttribute('d', ICONS[name] || '');
        svg.append(path);
        return svg;
    }

    const app = document.getElementById('app');
    function mount(...children) {
        const keep = document.activeElement && app.contains(document.activeElement) ? document.activeElement.dataset.focus : null;
        app.replaceChildren();
        append(app, children);
        // The same control again after a re-render keeps the keyboard where it was.
        const again = keep ? app.querySelector(`[data-focus="${CSS.escape(keep)}"]`) : null;
        if (again) again.focus();
    }

    function showError(err) {
        mount(h('div', { class: 'notice notice-error', role: 'alert' }, String((err && err.message) || err || 'Something went wrong.')));
    }

    // ---- tools
    const textOf = (result) => (result && Array.isArray(result.content) ? result.content : [])
        .filter(c => c && c.type === 'text' && typeof c.text === 'string').map(c => c.text).join('\n');

    /** A tool call through the host; its answer's data, or an Error with the text the server wrote. */
    async function callTool(name, args) {
        const result = await request('tools/call', { name, arguments: args });
        if (!result || result.isError) throw new Error(textOf(result) || 'Terramentor did not answer.');
        return result.structuredContent || {};
    }

    /** What the host's model should know now (the score, once the learner finished). */
    function tellModel(text, structuredContent) {
        request('ui/update-model-context', { content: [{ type: 'text', text }], ...(structuredContent ? { structuredContent } : {}) })
            .catch(() => { /* a host without model context still has the tool's own answer */ });
    }

    /** The handshake; `onToolResult` gets every tool result the host sends this view. */
    async function start({ name, onToolResult, onCancelled }) {
        handlers['ui/notifications/tool-result'] = onToolResult;
        handlers['ui/notifications/tool-input'] = () => { /* the arguments say nothing the result does not */ };
        handlers['ui/notifications/tool-input-partial'] = () => {};
        handlers['ui/notifications/tool-cancelled'] = onCancelled || (() => {});
        const info = { name, version: '1.0.0' };
        try {
            const res = await request('ui/initialize', {
                protocolVersion: PROTOCOL,
                appInfo: info,
                clientInfo: info,
                appCapabilities: { availableDisplayModes: ['inline'] },
                capabilities: {},
            });
            applyContext((res && res.hostContext) || {});
        } catch {
            // A host that refuses the handshake may still send the tool result.
        }
        notify('ui/notifications/initialized');
        resized();
    }

    setLanguage(navigator.language);
    return { h, icon, t, mount, showError, textOf, callTool, tellModel, start, setAppLanguage };
})();
