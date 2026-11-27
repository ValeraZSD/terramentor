// tools/no-model-gates.mjs — a library with no model connected calls no model.
//
// Run:  node tools/no-model-gates.mjs
//
// WHY. A new install has no model connected, and its settings carry only
// defaults: provider `ollama` at 127.0.0.1:11434, no model. Every path that
// read those defaults went to that address anyway, so "Create with AI" on a
// fresh install answered "AI provider is not available: Ollama is not running
// at http://127.0.0.1:11434. Please start Ollama first." to a learner who never
// chose Ollama, and topic mapping logged ECONNREFUSED on every pass.
//
// So this boots the REAL app in-process on a scratch library with nothing
// connected, and sends every connection the process opens to port 11434 to a
// local listener that records it (whether or not an Ollama runs on this
// machine). Then it walks what a learner can reach: the status, the model
// list, creating a course, the assistant, an embedding pass, and the probes the
// server runs before a call. Each must answer with the one "no model" sentence,
// never name Ollama, and open no connection. Last, the other side: a learner
// who DID choose Ollama, with it down, still reads the Ollama message.

import net from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const scratch = mkdtempSync(join(tmpdir(), 'no-model-gates-'));
process.env.DB_PATH = join(scratch, 'scratch.db');
process.env.VAULT_ROOT = join(scratch, 'vault');
process.env.DATA_DIR = join(scratch, 'data');
for (const k of ['AI_EXTRA_BODY', 'AI_PROVIDER', 'AI_BASE_URL', 'AI_MODEL', 'AI_API_KEY', 'OPENAI_API_KEY', 'AI_OLLAMA_URL']) delete process.env[k];

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const listen = (srv) => new Promise(ok => srv.listen(0, '127.0.0.1', () => ok(srv.address().port)));

// The REAL failure card (jsdom), once with an action and once without: which
// buttons each shows.
async function renderTurnError() {
    const require = createRequire(import.meta.url);
    const { JSDOM } = require('jsdom');
    const code = (await require('esbuild').build({
        stdin: {
            contents: `
                import ChatTurnError from './src/components/ChatTurnError';
                import { createElement as h, act } from 'react';
                import { createRoot } from 'react-dom/client';
                window.__gate = { ChatTurnError, h, act, createRoot };`,
            resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'tsx',
        },
        bundle: true, write: false, format: 'iife', platform: 'browser', logLevel: 'silent', jsx: 'automatic',
        define: { 'process.env.NODE_ENV': '"development"' },
        loader: { '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl' },
    })).outputFiles[0].text;
    const w = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true }).window;
    w.IS_REACT_ACT_ENVIRONMENT = true;
    w.eval(code);
    const { ChatTurnError, h, act, createRoot } = w.__gate;
    const shot = (action) => {
        const el = w.document.createElement('div');
        w.document.body.appendChild(el);
        const r = createRoot(el);
        act(() => r.render(h(ChatTurnError, { message: NO_MODEL, onRetry: () => { }, onDismiss: () => { }, action })));
        const words = [...el.querySelectorAll('button')].map(b => b.textContent.trim());
        act(() => r.unmount());
        return { retry: words.includes('Try again'), hasAction: words.includes('Connect here'), words };
    };
    const withAction = shot(h('button', { type: 'button' }, 'Connect here'));
    const plain = shot(undefined);
    w.close();
    return { withAction, plain };
}

// The REAL connect group (jsdom) with the three buttons, laid out in a group
// whose width the case sets. jsdom lays nothing out, so widths are given: each
// button is 7.5 rem wide (120 px at the base text size, 0 while hidden) and
// the group's width is `groupPx`, announced by a window resize as the hook
// hears it. Stacked = the group is a column of full-width buttons.
async function renderConnectGroup() {
    const require = createRequire(import.meta.url);
    const { JSDOM } = require('jsdom');
    const code = (await require('esbuild').build({
        stdin: {
            contents: `
                import ConnectAIActions from './src/components/ConnectAIActions';
                import { createElement as h, act } from 'react';
                import { createRoot } from 'react-dom/client';
                import { MemoryRouter } from 'react-router-dom';
                window.__gate = { mount: (el, chatbot = true) => { const r = createRoot(el); act(() => r.render(h(MemoryRouter, null, h(ConnectAIActions, { returnTo: '/', onChatbot: chatbot ? () => { } : undefined })))); return r; }, act };`,
            resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'tsx',
        },
        bundle: true, write: false, format: 'iife', platform: 'browser', logLevel: 'silent', jsx: 'automatic',
        define: { 'process.env.NODE_ENV': '"development"' },
        loader: { '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl' },
    })).outputFiles[0].text;
    const w = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true }).window;
    w.IS_REACT_ACT_ENVIRONMENT = true;
    w.MessageChannel = MessageChannel;
    let groupPx = 600, hidden = false;
    const rootPx = () => parseFloat(w.document.documentElement.style.fontSize) || 16;
    Object.defineProperty(w.HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { return this.tagName === 'BUTTON' && !hidden ? 7.5 * rootPx() : 0; } });
    Object.defineProperty(w.HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return this.tagName === 'DIV' && !hidden ? groupPx : 0; } });
    w.eval(code);
    const { mount, act } = w.__gate;
    const settle = async () => { await act(async () => { for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r)); }); };
    const resize = async (px) => { groupPx = px; await act(async () => { w.dispatchEvent(new w.Event('resize')); }); await settle(); };
    const el = w.document.createElement('div');
    w.document.body.appendChild(el);
    const layout = () => {
        const group = [...el.querySelectorAll('div')].find(d => d.querySelectorAll(':scope > button').length === 3);
        const buttons = group ? [...group.querySelectorAll(':scope > button')] : [];
        return { stacked: !!group && group.className.includes('flex-col') && buttons.every(b => b.className.includes('w-full')), buttons: buttons.map(b => b.textContent.trim()) };
    };
    // A framed button has a border or a fill at rest; a quiet one has neither
    // (its fill is a hover's).
    const framed = () => {
        const group = [...el.querySelectorAll('div')].find(d => d.querySelector(':scope > button'));
        return group ? [...group.querySelectorAll(':scope > button')].map(b => /(^|\s)(border|bg-[a-z])/.test(b.className)) : [];
    };
    const seen = {};
    // Room for the row (3 x 120 = 360 of 600), then not (300), then again.
    let r = mount(el); await settle();
    seen.wide = layout();
    await resize(300); seen.narrow = layout();
    await resize(600); seen.wideAgain = layout();
    act(() => r.unmount());
    // Mounted hidden (no width anywhere), then shown in a narrow place.
    hidden = true; groupPx = 300;
    r = mount(el); await settle();
    hidden = false; await resize(300);
    seen.shownNarrow = layout();
    act(() => r.unmount());
    // The row fits 400 at the base size; the text size goes up (16 -> 20 px:
    // 3 x 150 = 450), so the same 400 no longer holds it.
    r = mount(el); await resize(400);
    seen.beforeBigText = layout();
    await act(async () => { w.document.documentElement.style.fontSize = '20px'; });
    await settle(); await resize(400);
    seen.bigText = layout();
    act(() => r.unmount());
    // The two-button group (home card, assistant): in a row "Other ways" is
    // quiet beside the primary; stacked, it is framed like the primary.
    w.document.documentElement.style.fontSize = '';
    r = mount(el, false); await resize(600);
    seen.pairRow = framed();
    await resize(150);
    seen.pairStack = framed();
    act(() => r.unmount());
    w.close();
    return seen;
}

// The sentence, written out here rather than imported: the gate states what
// the learner reads.
const NO_MODEL = 'No AI model is connected. Connect one in Settings → AI & Models.';
const OLLAMA_PORT = 11434;

// ── the listener behind the default Ollama address ─────────────────────────
const hits = [];
const recorder = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end('{"error":"recorder"}');
});
const RECORDER_PORT = await listen(recorder);
// Every socket the process opens goes through Socket#connect (fetch, the
// Ollama client, wireFetch). One aimed at the default Ollama port is counted
// and sent to the recorder instead; one to anywhere but the app itself or the
// recorder is counted too (no provider at all should be asked).
let APP_PORT = -1;
const elsewhere = [];
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function patched(...args) {
    const opts = Array.isArray(args[0]) ? args[0][0] : args[0];
    if (opts && typeof opts === 'object' && opts.port != null) {
        const port = Number(opts.port);
        if (port === OLLAMA_PORT) {
            hits.push(`connect ${opts.host || 'localhost'}:${port}`);
            opts.port = RECORDER_PORT;
            opts.host = '127.0.0.1';
        } else if (port !== APP_PORT && port !== RECORDER_PORT && !gateOwnPorts.has(port)) {
            elsewhere.push(`${opts.host || 'localhost'}:${port}`);
        }
    }
    return connect.apply(this, args);
};
// Ports the gate itself opens on purpose (the closed port of the last row).
const gateOwnPorts = new Set();

// ── the real app, in-process ───────────────────────────────────────────────
const { default: db } = await import('../server/database.js');
const { createApp } = await import('../server/app.js');
const appServer = createServer(createApp());
APP_PORT = await listen(appServer);
const api = (path, init = {}) => fetch(`http://127.0.0.1:${APP_PORT}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init.headers || {}) } });

/** Every frame of a server-sent stream, until a terminal one or the end. */
async function frames(res, { limitMs = 60000 } = {}) {
    const out = [];
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const until = Date.now() + limitMs;
    while (Date.now() < until) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let cut;
        while ((cut = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, cut);
            buf = buf.slice(cut + 2);
            const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n');
            if (!data) continue;
            try { out.push(JSON.parse(data)); } catch { /* keep-alive or a non-JSON line */ }
        }
        const last = out[out.length - 1];
        if (last && (last.phase === 'error' || last.phase === 'complete' || last.done || last.error || last.cancelled)) break;
    }
    reader.cancel().catch(() => { });
    return out;
}
/** What a learner reads from a body: its sentence and its key, never its settings fields. */
const words = (b) => JSON.stringify({ error: b?.error ?? null, messageKey: b?.messageKey ?? null, reason: b?.reason ?? null, failure: b?.failure ? { message: b.failure.message, messageKey: b.failure.messageKey } : null });
const saysNoModel = (b) => b?.messageKey === NO_MODEL || b?.error === NO_MODEL;
const namesOllama = (b) => /ollama|11434/i.test(words(b));

try {
    check('the scratch library has no AI rows at all', db.prepare("SELECT COUNT(*) n FROM settings WHERE key LIKE 'ai\\_%' ESCAPE '\\'").get().n === 0);

    console.log('\n--- the status the app shows ---');
    const status = await (await api('/api/ai/status?fresh=1')).json();
    check('the status is "not available"', status.available === false, JSON.stringify({ available: status.available }));
    check('…with the no-model sentence', saysNoModel(status), words(status));
    check('…which names no provider', !namesOllama(status), words(status));

    console.log('\n--- the model list (Settings, the welcome) ---');
    const models = await (await api('/api/ai/models')).json();
    check('no models, and the no-model sentence', models.success === false && saysNoModel(models), words(models));
    check('…naming no provider', !namesOllama(models), words(models));

    console.log('\n--- the atlas of a library with no courses ---');
    const atlas = await (await api('/api/atlas')).json();
    check('says there is nothing to map (empty), not that a model is missing', atlas.available === false && atlas.empty === true, JSON.stringify({ available: atlas.available, empty: atlas.empty, reason: atlas.reason }));

    console.log('\n--- creating a course ---');
    const created = await frames(await api('/api/ai/create-project', { method: 'POST', body: JSON.stringify({ name: 'Basic Dutch greetings', description: 'Greet people in Dutch' }) }));
    const errFrame = created.find(f => f.phase === 'error');
    check('the run stops with an error frame', !!errFrame, JSON.stringify(created.map(f => f.phase)));
    check('…whose words are the no-model sentence', errFrame?.error === NO_MODEL, errFrame?.error);
    check('…and whose record carries its key, final, and the noModel flag (the dialog\'s title, "Set up AI" first)',
        errFrame?.failure?.messageKey === NO_MODEL && errFrame?.failure?.final === true && errFrame?.failure?.noModel === true, JSON.stringify(errFrame?.failure));
    check('…naming no provider', !namesOllama(errFrame), words(errFrame));
    check('no project was made', db.prepare('SELECT COUNT(*) n FROM projects').get().n === 0);
    const progress = readFileSync(new URL('../src/components/creation/CreationProgress.tsx', import.meta.url), 'utf8');
    check('the run\'s title says it, once: no sentence repeats it under the title',
        /run\.failure\?\.noModel \? t\("No AI model connected"\)/.test(progress)
        && /run\.status === 'error' && run\.error && !run\.failure\?\.noModel && \(cause \?/.test(progress));

    console.log('\n--- the assistant ---');
    const turn = await frames(await api('/api/ai/assistant/stream', { method: 'POST', body: JSON.stringify({ message: 'What should I study first?' }) }));
    const turnErr = turn.find(f => f.error);
    check('the turn ends with an error frame', !!turnErr, JSON.stringify(turn).slice(0, 300));
    check('…whose words are the no-model sentence', turnErr?.error === NO_MODEL || turnErr?.messageKey === NO_MODEL, words(turnErr));
    check('…naming no provider', !namesOllama(turnErr), words(turnErr));
    const conv = turn.find(f => f.conversationId != null)?.conversationId;
    if (conv != null) {
        // The server drops a conversation whose only turn failed, so the panel
        // that adopted its id from the first frame must not keep asking for it,
        // and a reload that does ask must still leave the failure on screen.
        const after = await api(`/api/ai/conversations/${conv}/messages`);
        check('a failed first turn leaves no conversation behind', after.status === 404, `status ${after.status}`);
        const drawer = readFileSync(new URL('../src/components/AssistantDrawer.tsx', import.meta.url), 'utf8');
        check('…so the panel goes back to a new chat when its first turn fails',
            /if \(startedNew\) switchTo\(null\)/.test(drawer));
        check('…and a history load answered "not found" resolves an empty list, so the failure card is still raised',
            /not found[^]{0,700}switchTo\(null\);\s*id = null;/.test(drawer));
        // The error frame arrives AFTER the task id, and a turn with a task id
        // that ends without a terminal frame is followed again as a dropped
        // socket, which raised no card: the learner saw only the dock's chip.
        const taskAt = turn.findIndex(f => typeof f.taskId === 'string');
        check('the turn names its task before its error frame', taskAt >= 0 && taskAt < turn.findIndex(f => f.error),
            JSON.stringify(turn).slice(0, 300));
        const apiSrc = readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8');
        check('the chat stream throws its error frame as the end of the turn',
            /if \(json\.error\) throw Object\.assign\([^\n]*\{ turnEnded: true \}\)/.test(apiSrc));
        // Only a turn that produced nothing: one that wrote or reasoned is kept
        // by the server and is read back from history with its card under it.
        check('…and the panel settles a turn that produced nothing, so the failure card shows the sentence',
            /if \(e\?\.turnEnded && !full\.trim\(\) && !reasoned\) terminal = true;/.test(drawer)
            && /onThinkingChunk: delta => \{ if \(delta\.trim\(\)\) reasoned = true;/.test(drawer)
            && /const dropped = !terminal && !controller\.signal\.aborted && taskId != null;/.test(drawer));
    } else {
        check('the turn names its conversation', false, 'no conversationId frame');
    }
    {
        // With no model connected the failure card and the composer's notice
        // said the same thing twice, and the card's "Try again" sent the
        // question into the same refusal. The card is the one place: it
        // carries the connect buttons, and the notice steps aside while it shows.
        const drawer = readFileSync(new URL('../src/components/AssistantDrawer.tsx', import.meta.url), 'utf8');
        check('the failure card offers the connect buttons in place of a retry when no model is connected, and only then',
            /<ChatTurnError\b[^]{0,1500}?action=\{isAINotConnected\(status\)\s*\?\s*<ConnectAIActions returnTo=\{window\.location\.pathname\} onLeave=\{\(\) => \{ if \(!docked\) onClose\(\); \}\} \/>\s*:\s*undefined\}/.test(drawer));
        check('…and the composer\'s no-model notice steps aside while that card shows',
            /!isAIUsable\(status\) && !\(turnError && isAINotConnected\(status\)\) && \(\s*<AIUnavailableNotice/.test(drawer));
        const shown = await renderTurnError();
        check('a card given an action shows it and no "Try again"', shown.withAction.hasAction && !shown.withAction.retry, JSON.stringify(shown));
        check('…and without one it keeps "Try again"', shown.plain.retry, JSON.stringify(shown));
        // The connect group, with the chatbot as its third way (the New course
        // form): one row while the row fits, one even stack when it does not.
        const g = await renderConnectGroup();
        const says = JSON.stringify(g);
        check('the three ways on stand in one row where they fit', g.wide.buttons.length === 3 && !g.wide.stacked, says);
        check('…stack evenly where they do not', g.narrow.stacked, says);
        check('…and return to a row when the room comes back', !g.wideAgain.stacked, says);
        check('…a group mounted hidden measures once it is shown', g.shownNarrow.stacked, says);
        check('…and a larger text size re-measures them', !g.beforeBigText.stacked && g.bigText.stacked, says);
        check('the two-button group keeps "Other ways" quiet in a row and frames it in a stack',
            g.pairRow.length === 2 && g.pairRow[0] && !g.pairRow[1] && g.pairStack.length === 2 && g.pairStack.every(Boolean), says);
    }

    console.log('\n--- an embedding pass ---');
    const pid = Number(db.prepare("INSERT INTO projects (name) VALUES ('Greetings')").run().lastInsertRowid);
    db.prepare("INSERT INTO nodes (project_id, title, description, status, is_note, position) VALUES (?, 'Hello and goodbye', 'Saying hello', 'not_started', 0, 0)").run(pid);
    const { syncNodeEmbeddings } = await import('../server/nodeEmbeddings.js');
    const swept = await syncNodeEmbeddings({ force: true });
    check('topic mapping stops as "no model", not as an error', swept?.status === 'unavailable' || swept?.skipped === 'unavailable', JSON.stringify(swept));
    const emb = await (await api('/api/embeddings/status?force=true')).json();
    if (emb?.config?.vecAvailable === false) {
        check('the embedding probe (sqlite-vec missing on this build: nothing to ask)', true);
    } else {
        check('the embedding probe answers with the no-model sentence', saysNoModel(emb?.probe), words(emb?.probe));
        check('…naming no provider and no model', !namesOllama(emb?.probe) && !emb?.probe?.model, JSON.stringify(emb?.probe));
    }

    console.log('\n--- the checks the server runs before a call ---');
    const ai = await import('../server/ai.js');
    const reach = await ai.probeAiReachable({ job: 'conversation' });
    check('probeAiReachable (quiz, insights): not ok, the no-model sentence', reach.ok === false && saysNoModel(reach), words(reach));
    const reachMain = await ai.probeAiReachable();
    check('…and for the main model', reachMain.ok === false && saysNoModel(reachMain), words(reachMain));
    check('visionAvailability: no', (await ai.visionAvailability('llava', ai.getAISettings())) === 'no');
    check('modelSupportsThinking: no', (await ai.modelSupportsThinking('qwen3', ai.getAISettings())) === false);
    const health = await ai.checkOllamaHealth();
    check('the health check: the no-model sentence', health.available === false && saysNoModel(health), words(health));
    let thrown = null;
    try { await ai.generateResponse('Say hi', '', [], { job: 'small' }); } catch (err) { thrown = err; }
    check('a model call refuses with the no-model sentence, final', thrown?.messageKey === NO_MODEL && thrown?.final === true, String(thrown?.message));
    const { firstChoice } = await import('../server/aiJobs.js');
    const head = firstChoice('vision', { model: 'llava' });
    check('firstChoice marks "no model" (unavailable) and names no model', head.unavailable === true && !head.model, JSON.stringify({ unavailable: head.unavailable, model: head.model }));

    console.log('\n--- nothing went out ---');
    check('no request reached the default Ollama address', hits.length === 0, hits.slice(0, 5).join(', '));
    check('no connection went to any other address either', elsewhere.length === 0, elsewhere.slice(0, 5).join(', '));

    console.log('\n--- anything chosen is not "nothing connected" ---');
    // Each case sets what a learner (or the environment) chose, asks the
    // settings and the chain, and takes it back. No call is made here.
    const { chainFor } = await import('../server/aiJobs.js');
    const setRow = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    const dropRow = db.prepare('DELETE FROM settings WHERE key = ?');
    const chosenCases = [
        ['an OpenAI-compatible endpoint chosen', { ai_provider: 'openai', ai_openai_base_url: 'http://127.0.0.1:9/v1', ai_openai_model: 'm' }, {}],
        ['Ollama chosen, no model picked yet (the welcome\'s local card)', { ai_provider: 'ollama', ai_ollama_url: 'http://127.0.0.1:9' }, {}],
        ['a model saved by an older version, with no provider row', { ai_model: 'llama3' }, {}],
        ['AI_MODEL set in the environment', {}, { AI_MODEL: 'm' }],
        ['AI_PROVIDER set in the environment', {}, { AI_PROVIDER: 'openai' }],
    ];
    for (const [label, rows, env] of chosenCases) {
        for (const [k, v] of Object.entries(rows)) setRow.run(k, v);
        for (const [k, v] of Object.entries(env)) process.env[k] = v;
        let chain;
        try { chain = chainFor('courses'); } catch (err) { chain = err; }
        for (const k of Object.keys(rows)) dropRow.run(k);
        for (const k of Object.keys(env)) delete process.env[k];
        // The chain files a chosen endpoint as a saved connection (reconcile).
        dropRow.run('ai_active_connection');
        db.prepare('DELETE FROM ai_connections').run();
        const want = env.AI_PROVIDER || rows.ai_provider || 'ollama';
        check(`${label}: the chain serves it, on the provider chosen`,
            Array.isArray(chain) && chain.length > 0 && chain[0].provider === want,
            Array.isArray(chain) ? JSON.stringify(chain.map(c => c.provider)) : String(chain?.message));
    }
    let after = null;
    try { after = chainFor('courses'); } catch (err) { after = err; }
    check('…and with every choice taken back, the chain refuses as "no model" again', after?.messageKey === NO_MODEL, String(after?.message ?? JSON.stringify(after)));

    console.log('\n--- a learner who chose Ollama, with it down ---');
    // A port that was open a moment ago and is closed now: nothing listens.
    const closed = createServer();
    const downPort = await listen(closed);
    await new Promise(ok => closed.close(ok));
    gateOwnPorts.add(downPort);
    const put = (key, value) => api(`/api/settings/${key}`, { method: 'PUT', body: JSON.stringify({ value }) });
    const r1 = await put('ai_ollama_url', `http://127.0.0.1:${downPort}`);
    const r2 = await put('ai_provider', 'ollama');
    check('the welcome\'s own two writes are taken', r1.ok && r2.ok, `${r1.status} ${r2.status}`);
    const chosen = await (await api('/api/ai/status?fresh=1')).json();
    check('the status names Ollama, at the address chosen', /Ollama is not running at/.test(chosen.error || '') && (chosen.error || '').includes(String(downPort)), words(chosen));
    check('…and not the no-model sentence', !saysNoModel(chosen), words(chosen));
    const run2 = await frames(await api('/api/ai/create-project', { method: 'POST', body: JSON.stringify({ name: 'Basic Dutch greetings' }) }));
    const err2 = run2.find(f => f.phase === 'error');
    check('creating a course says Ollama is not running', /Ollama is not running/.test(err2?.error || ''), err2?.error);
} finally {
    net.Socket.prototype.connect = connect;
    appServer.close();
    recorder.close();
    try { db.close(); } catch { }
    try { rmSync(scratch, { recursive: true, force: true }); } catch { }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
