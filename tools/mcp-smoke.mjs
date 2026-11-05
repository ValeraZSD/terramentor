#!/usr/bin/env node
// Is the MCP server in an installed copy of the app alive?
//
//   node tools/mcp-smoke.mjs <app folder> [app url]
//   docker exec -i <container> node --input-type=module - /app < tools/mcp-smoke.mjs
//
// Starts <app folder>/mcp/index.js over stdio, the way Claude or VS Code
// starts it, as a host that draws views, against the app already running at
// [app url] (default http://127.0.0.1:3001). The MCP server must list its
// tools and the mastery check's view, hand over that view with the words of
// every language in <app folder>/src/locales, and answer a call that reaches
// the app. Exit 0 with one "MCP check OK" line, or exit 1 with the reason.
//
// tools/build-desktop.mjs runs it against every staged desktop package, and
// the release workflow against the Docker image. It imports nothing but
// Node's own modules, so it can be piped into a container that has no tools/.

import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [appDir, appUrl = 'http://127.0.0.1:3001'] = process.argv.slice(2);
if (!appDir) {
    console.error('usage: node tools/mcp-smoke.mjs <app folder> [app url]');
    process.exit(2);
}
const root = resolve(appDir);

// The app named here, whatever TERRAMENTOR_URL says. TERRAMENTOR_API_KEY is
// passed through, for a library with a password (the Docker image's always
// has one after its first visit).
const env = { ...process.env, TERRAMENTOR_URL: appUrl };

const mcp = spawn(process.execPath, [join(root, 'mcp', 'index.js')], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
let buf = '', stderr = '', nextId = 1, exited = null;
const waiting = new Map();
mcp.stdout.setEncoding('utf8');
mcp.stdout.on('data', (d) => {
    buf += d;
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        waiting.get(msg.id)?.(msg);
    }
});
mcp.stderr.on('data', (d) => { stderr += d; });
mcp.on('exit', (code) => {
    exited = code;
    for (const answer of waiting.values()) answer({ error: { message: `the MCP server exited (${code})` } });
});

const send = (msg) => mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
const rpc = (method, params = {}) => new Promise((res, rej) => {
    if (exited !== null) return rej(new Error(`the MCP server exited (${exited})`));
    const id = nextId++;
    const timer = setTimeout(() => { waiting.delete(id); rej(new Error(`no answer to ${method} within 30 s`)); }, 30_000);
    waiting.set(id, (m) => {
        clearTimeout(timer);
        waiting.delete(id);
        if (m.error) rej(new Error(`${method}: ${m.error.message}`)); else res(m.result);
    });
    send({ id, method, params });
});

try {
    const init = await rpc('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } },
        clientInfo: { name: 'mcp-smoke', version: '1.0.0' },
    });
    if (init?.serverInfo?.name !== 'terramentor') throw new Error(`initialize answered as ${JSON.stringify(init?.serverInfo)}`);
    send({ method: 'notifications/initialized' });

    // The model's tools, and two of the tools only a view may call (enabled
    // for a host that draws views).
    const tools = (await rpc('tools/list')).tools || [];
    const names = tools.map((t) => t.name);
    const missing = ['project_state', 'get_due', 'record_claim', 'mastery_check', 'review_cards', 'check_submit', 'review_rate']
        .filter((n) => !names.includes(n));
    if (missing.length) throw new Error(`tools/list lacks ${missing.join(', ')}`);
    const viewUri = tools.find((t) => t.name === 'mastery_check')?._meta?.ui?.resourceUri;
    if (!viewUri) throw new Error('mastery_check names no view');

    const html = String((await rpc('resources/read', { uri: viewUri })).contents?.[0]?.text || '');
    if (!/^<!doctype html>/i.test(html.trim())) throw new Error(`${viewUri} is not an HTML document`);
    const words = JSON.parse(/<script type="application\/json" id="tm-strings">([\s\S]*?)<\/script>/.exec(html)?.[1] || '{}');
    const shipped = readdirSync(join(root, 'src', 'locales')).filter((f) => f.endsWith('.json')).length;
    const languages = Object.keys(words).length;
    if (languages < 2 || languages !== shipped) throw new Error(`${viewUri} carries ${languages} languages; src/locales has ${shipped}`);

    const state = await rpc('tools/call', { name: 'project_state', arguments: {} });
    if (!state || state.isError) throw new Error(`project_state failed: ${JSON.stringify(state?.content).slice(0, 400)}`);

    console.log(`MCP check OK: ${names.length} tools, the check's view in ${languages} languages, project_state answered`);
    mcp.kill();
} catch (e) {
    console.error(`MCP check FAILED: ${e.message}${stderr ? `\n${stderr.slice(-800)}` : ''}`);
    mcp.kill();
    process.exit(1);
}
