#!/usr/bin/env node
// Terramentor's MCP server: lets an agent harness (Claude Code, Claude Desktop,
// VS Code, Cursor) read the learner's library and propose two things to it.
// docs/MCP.md is the guide; mcp/tools.js the tools; mcp/app.js the only door
// into the library (the running app's HTTP API — this process never opens the
// database).
//
//   node mcp/index.js                      stdio, as a harness launches it
//   node mcp/index.js --http [--port N]    Streamable HTTP on 127.0.0.1:N/mcp
//
// Environment: TERRAMENTOR_URL (default http://127.0.0.1:3001) and, when the
// library has a password, TERRAMENTOR_API_KEY (Settings → Devices & security →
// API key).
//
// THE HTTP LISTENER HOLDS NO KEY OF ITS OWN. It forwards each caller's own
// Authorization header and ignores TERRAMENTOR_API_KEY: a listener that added
// the key itself would hand the password-protected library to any process on
// this computer that can open a socket, and to any web page able to reach
// loopback. It binds loopback only, refuses to start on another address, and
// refuses a foreign Host (DNS rebinding), a foreign Origin, a relayed request
// and a non-loopback peer.

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { appClient, appOrigin, isLoopbackHost } from './app.js';
import { buildServer } from './tools.js';

const VERSION = (() => {
    try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || '0.0.0'; } catch { return '0.0.0'; }
})();
const DEFAULT_HTTP_PORT = 3002;
// The same list the app refuses as "not this computer" (server/auth.js).
const RELAY_HEADERS = ['forwarded', 'via', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'x-forwarded-server', 'x-real-ip'];
const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

const timeZone = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; } })();

const HELP = `Terramentor MCP server ${VERSION}

  node mcp/index.js                   serve over stdio (how Claude Code, Claude Desktop, VS Code and Cursor start it)
  node mcp/index.js --http            serve Streamable HTTP at http://127.0.0.1:${DEFAULT_HTTP_PORT}/mcp
      --port N                        another port (0 picks a free one)
      --host 127.0.0.1 | ::1          loopback only; any other address is refused

Environment:
  TERRAMENTOR_URL      where the app runs (default http://127.0.0.1:3001)
  TERRAMENTOR_API_KEY  the library's API key, when it has a password (stdio only;
                       an HTTP client sends "Authorization: Bearer <key>" itself)

Guide: docs/MCP.md`;

function parseArgs(argv) {
    const out = { http: false, port: DEFAULT_HTTP_PORT, host: '127.0.0.1', help: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--http') out.http = true;
        else if (a === '--port') out.port = Number(argv[++i]);
        else if (a === '--host') out.host = String(argv[++i] || '');
        else if (a === '--help' || a === '-h') out.help = true;
        else throw new Error(`Unknown option "${a}" (try --help)`);
    }
    if (!Number.isInteger(out.port) || out.port < 0 || out.port > 65535) throw new Error('--port must be a whole number from 0 to 65535');
    return out;
}

/** A client for this call: the app's origin is read per call, so a bad TERRAMENTOR_URL is a tool's answer, not a crash. */
const clientFor = ({ authorization, keyHint, clientName }) => () => appClient({
    origin: appOrigin(process.env.TERRAMENTOR_URL),
    authorization,
    keyHint,
    clientName,
    timeZone,
});

function serveOverStdio() {
    const key = String(process.env.TERRAMENTOR_API_KEY || '').trim();
    serveStdio(() => {
        let server = null;
        server = buildServer({
            version: VERSION,
            appFor: clientFor({
                authorization: key ? `Bearer ${key}` : null,
                keyHint: 'set it as TERRAMENTOR_API_KEY in this MCP server\'s config (its "env"), then restart the server.',
                clientName: () => server?.server?.getClientVersion?.()?.name || null,
            }),
        });
        return server;
    }, { onerror: (err) => console.error(`[terramentor-mcp] ${err?.message || err}`) });
}

function refuse(res, status, message) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message } }));
}

function serveOverHttp({ port, host }) {
    if (!isLoopbackHost(host)) {
        console.error(`Refusing to listen on ${host}: this MCP server answers this computer only, so it binds loopback (127.0.0.1 or ::1).`);
        process.exit(2);
    }
    const handler = createMcpHandler((ctx) => {
        // The caller's own credential, passed through; never TERRAMENTOR_API_KEY (see the top of this file).
        const authorization = ctx.requestInfo?.headers.get('authorization') || null;
        let server = null;
        server = buildServer({
            version: VERSION,
            appFor: clientFor({
                authorization,
                keyHint: 'send it from this MCP client as the header "Authorization: Bearer <key>" (the "headers" of its server config).',
                clientName: () => server?.server?.getClientVersion?.()?.name || null,
            }),
        });
        return server;
    }, { legacy: 'stateless', onerror: (err) => console.error(`[terramentor-mcp] ${err?.message || err}`) });
    const serve = toNodeHandler(handler);
    const validHost = localhostHostValidation();
    const validOrigin = localhostOriginValidation();

    const listener = createServer((req, res) => {
        if (!LOOPBACK_PEERS.has(req.socket.remoteAddress)) return refuse(res, 403, 'This MCP server answers this computer only.');
        if (!validHost(req, res)) return;
        if (!validOrigin(req, res)) return;
        if (RELAY_HEADERS.some(h => req.headers[h] !== undefined)) {
            return refuse(res, 403, 'A relayed request is refused: this MCP server answers this computer only.');
        }
        if (new URL(req.url || '/', 'http://127.0.0.1').pathname !== '/mcp') return refuse(res, 404, 'The MCP endpoint is /mcp.');
        serve(req, res).catch((err) => {
            console.error(`[terramentor-mcp] ${err?.message || err}`);
            if (!res.headersSent) refuse(res, 500, 'The MCP server failed on this request.');
        });
    });
    listener.on('error', (err) => {
        console.error(`Could not listen on ${host}:${port}: ${err.code || err.message}`);
        process.exit(1);
    });
    listener.listen(port, host, () => {
        const bound = listener.address();
        const shown = bound.family === 'IPv6' ? `[${bound.address}]` : bound.address;
        console.log(`Terramentor MCP server ${VERSION} on http://${shown}:${bound.port}/mcp (app: ${process.env.TERRAMENTOR_URL || 'http://127.0.0.1:3001'})`);
    });
    const stop = () => listener.close(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
}

let args;
try {
    args = parseArgs(process.argv.slice(2));
} catch (err) {
    console.error(err.message);
    process.exit(2);
}
if (args.help) {
    console.log(HELP);
} else if (args.http) {
    serveOverHttp(args);
} else {
    serveOverStdio();
}
