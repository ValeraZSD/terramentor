// Other devices: how a phone gets into an app that answers only its own machine.
//
// With no password the app answers only the computer it runs on (auth.js). A
// password was the one way past that, and setting the first one from a phone
// took a code printed in the server's log — a log a desktop user never sees.
// Two ways in now carry the proof instead:
//
//   - A CONNECTED DEVICE. Settings shows a QR code; the phone that scans it
//     within ten minutes is given its own long-lived key and listed, with a
//     Remove button. Seeing this computer's screen is the proof. The library
//     keeps only a SHA-256 of each key: the key is 32 random bytes, so the hash
//     cannot be turned back into it, and a copy of the library lets nobody in.
//
//   - THE COMPUTER'S OWN TAILSCALE ACCOUNT. `tailscale serve` tells the app who
//     is connecting (`Tailscale-User-Login`), strips that header from anything
//     arriving with one already, and adds none for tagged devices or Funnel. A
//     request it relays for the account this computer is signed in to Tailscale
//     with is the owner on another of their devices, so it is let in with no
//     password and no code — which is what works from a hotel with nobody at
//     the computer. On by default, one switch in Settings, and ONLY while no
//     password is set (see remoteAccessOf).
//
// What the second one rests on: the header is believed only on a request that
// looks exactly like `tailscale serve` relaying to this computer
// (tailscaleLoginOf). Any program on this machine could send the same thing,
// so it is worth what a request from this machine is worth, and no more. A
// local reverse proxy that forwards a client's headers unchanged and keeps
// the tailnet Host would defeat it, as it would any proxy-asserted identity.

import crypto from 'crypto';
import os from 'os';
import { execFile } from 'child_process';
import db from './database.js';

export const DEVICE_COOKIE = 'sp_dev';
/** Browsers cap a cookie's life at 400 days; a connected phone should not have to reconnect sooner. */
export const DEVICE_COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60;
const OFFER_TTL_MS = 10 * 60 * 1000;
const TOUCH_EVERY_MS = 10 * 60 * 1000;

/** `off` turns Tailscale sign-in off; absent (the default) is on. Written only by its own route. */
const TAILSCALE_SETTING = 'auth_tailscale_trust';
export const DEVICE_SETTING_KEYS = [TAILSCALE_SETTING];

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const nowIso = () => new Date().toISOString();

let stmts = null;
function q() {
    if (!stmts) {
        stmts = {
            byHash: db.prepare('SELECT id, name, via, created_at, last_seen_at FROM auth_devices WHERE token_hash = ?'),
            insert: db.prepare('INSERT INTO auth_devices (name, via, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)'),
            list: db.prepare('SELECT id, name, via, created_at, last_seen_at FROM auth_devices ORDER BY created_at DESC, id DESC'),
            remove: db.prepare('DELETE FROM auth_devices WHERE id = ?'),
            touch: db.prepare('UPDATE auth_devices SET last_seen_at = ? WHERE id = ?'),
            getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
            setSetting: db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)'),
        };
    }
    return stmts;
}

// --- connected devices -------------------------------------------------------

const lastTouched = new Map(); // device id -> ms, so a busy phone writes "last used" once per 10 minutes

/** A device unused this long is forgotten: a key nobody carries any more should not stand for ever. */
export const DEVICE_IDLE_MS = 180 * 24 * 60 * 60 * 1000;

/** The connected device a device key belongs to, or null (unknown, or idle past DEVICE_IDLE_MS). */
export function deviceForToken(token) {
    if (!token || typeof token !== 'string' || token.length < 32) return null;
    let row;
    try { row = q().byHash.get(sha256(token)); } catch { return null; }
    if (!row) return null;
    const now = Date.now();
    const seen = Date.parse(row.last_seen_at || row.created_at);
    if (!Number.isFinite(seen) || now - seen > DEVICE_IDLE_MS) {
        try { q().remove.run(row.id); } catch { /* refused either way */ }
        return null;
    }
    if (now - (lastTouched.get(row.id) || 0) > TOUCH_EVERY_MS) {
        lastTouched.set(row.id, now);
        try { q().touch.run(nowIso(), row.id); } catch { /* "last used" is a courtesy */ }
    }
    return row;
}

/** Record a new device and return the key its cookie will carry (never stored). */
export function addDevice({ name, via }) {
    const token = crypto.randomBytes(32).toString('base64url');
    const at = nowIso();
    const info = q().insert.run(String(name || 'Device').slice(0, 80), via, sha256(token), at, at);
    return { id: Number(info.lastInsertRowid), token };
}

export function listDevices() {
    return q().list.all().map(r => ({ id: r.id, name: r.name, via: r.via, createdAt: r.created_at, lastSeenAt: r.last_seen_at }));
}

export function removeDevice(id) {
    lastTouched.delete(Number(id));
    return q().remove.run(Number(id)).changes > 0;
}

/**
 * A changed password is the answer to "something leaked", so it ends every
 * connected device too, except the one that changed it.
 */
export function removeDevicesExcept(keepId) {
    lastTouched.clear();
    return db.prepare('DELETE FROM auth_devices WHERE id IS NOT ?').run(keepId ?? null).changes;
}

/**
 * A name a person recognises in the list: "Chrome on Android". Read off the
 * User-Agent once, when the device connects. Data, not interface text.
 */
export function deviceName(userAgent) {
    const ua = String(userAgent || '');
    const system = /iPhone/.test(ua) ? 'iPhone'
        : /iPad/.test(ua) ? 'iPad'
            : /Android/.test(ua) ? 'Android'
                : /CrOS/.test(ua) ? 'ChromeOS'
                    : /Windows/.test(ua) ? 'Windows'
                        : /Mac OS X|Macintosh/.test(ua) ? 'Mac'
                            : /Linux/.test(ua) ? 'Linux' : '';
    const browser = /SamsungBrowser/.test(ua) ? 'Samsung Internet'
        : /EdgA?\//.test(ua) ? 'Edge'
            : /Firefox|FxiOS/.test(ua) ? 'Firefox'
                : /OPR\//.test(ua) ? 'Opera'
                    : /Chrome|CriOS/.test(ua) ? 'Chrome'
                        : /Safari/.test(ua) ? 'Safari' : '';
    if (browser && system) return `${browser} on ${system}`;
    return browser || system || 'Device';
}

// --- the QR code's one-time offer ----------------------------------------------

let offer = null; // { code, expires } — one at a time; showing a new code retires the old one

export function createPairingOffer() {
    offer = { code: crypto.randomBytes(24).toString('base64url'), expires: Date.now() + OFFER_TTL_MS };
    return { code: offer.code, expiresAt: new Date(offer.expires).toISOString() };
}

/** Spend the offer if `code` is it and still fresh. True once, then never again. */
export function claimPairingOffer(code) {
    if (!offer || typeof code !== 'string') return false;
    if (Date.now() > offer.expires) { offer = null; return false; }
    const a = Buffer.from(code);
    const b = Buffer.from(offer.code);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
    offer = null;
    return true;
}

// --- Tailscale ----------------------------------------------------------------

/**
 * Where the CLI lives. The installed path FIRST: a bare name is looked up on
 * PATH (and, on Windows, possibly the working directory), which is the copy
 * a planted `tailscale.exe` would win; PATH is the fallback for other installs.
 */
function tailscaleCandidates() {
    if (process.platform === 'win32') return ['C:\\Program Files\\Tailscale\\tailscale.exe', 'tailscale'];
    if (process.platform === 'darwin') return ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', 'tailscale'];
    return ['tailscale'];
}

/** Run the Tailscale CLI: its stdout, or null when it is absent, refused or slow. */
async function runTailscaleCli(args, timeout = 5000) {
    for (const bin of tailscaleCandidates()) {
        const out = await new Promise((resolve) => {
            execFile(bin, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
                resolve(err ? null : stdout);
            });
        });
        if (out != null) return out;
    }
    return null;
}
let runTailscale = runTailscaleCli;

/**
 * For the gates: stand in for the CLI (`fn(args)` → stdout or null). A gate
 * must never reach the machine's real Tailscale: with a guard mutated away,
 * "Turn it on" really ran `tailscale serve` for a test server's port.
 */
export function setTailscaleRunnerForTest(fn) {
    runTailscale = fn || runTailscaleCli;
}

/** Run the Tailscale CLI with JSON output; null when it is absent, stopped or slow. */
async function tailscaleJson(args) {
    const out = await runTailscale(args);
    if (out == null) return null;
    try { return JSON.parse(out); } catch { return null; }
}

/**
 * This computer on Tailscale: `{ login, host }` — the login it is signed in
 * with and its own name on the tailnet (`pc.tail1234.ts.net`) — or null (no
 * Tailscale, not running, or a TAGGED machine, which belongs to no person and
 * so has no owner to recognise).
 */
export function ownerFromStatus(status) {
    const self = status && status.Self;
    if (!self || status.BackendState !== 'Running') return null;
    if (Array.isArray(self.Tags) && self.Tags.length) return null;
    const user = status.User && status.User[self.UserID];
    const login = user && typeof user.LoginName === 'string' ? user.LoginName.trim() : '';
    const host = typeof self.DNSName === 'string' ? self.DNSName.trim().replace(/\.$/, '').toLowerCase() : '';
    return login && login !== 'tagged-devices' && host ? { login, host } : null;
}

/** A minute: signing out of Tailscale or switching accounts reaches the app that quickly. */
const OWNER_FRESH_MS = 60 * 1000;
let ownerCache = { self: null, at: 0, pending: null };

/** This computer on Tailscale (see ownerFromStatus), refreshed at most once a minute; one CLI run at a time. */
async function tailscaleSelf() {
    if (Date.now() - ownerCache.at < OWNER_FRESH_MS) return ownerCache.self;
    if (!ownerCache.pending) {
        ownerCache.pending = tailscaleJson(['status', '--json'])
            .then(status => { ownerCache = { self: ownerFromStatus(status), at: Date.now(), pending: null }; return ownerCache.self; })
            .catch(() => { ownerCache = { self: null, at: Date.now(), pending: null }; return null; });
    }
    return ownerCache.pending;
}

/** The login this computer is signed in to Tailscale with, or null. */
export async function tailscaleOwner() {
    return (await tailscaleSelf())?.login ?? null;
}

/** For the gates: put this computer's Tailscale identity in the cache without a CLI. */
export function setTailscaleOwnerForTest(login, host = 'desk.tail1234.ts.net') {
    ownerCache = { self: login ? { login, host } : null, at: login === undefined ? 0 : Date.now(), pending: null };
}

export function tailscaleTrustOn() {
    try { return q().getSetting.get(TAILSCALE_SETTING)?.value !== 'off'; } catch { return true; }
}
export function setTailscaleTrust(on) {
    q().setSetting.run(TAILSCALE_SETTING, on ? 'on' : 'off');
}

const isLoopback = (ip) => ip === '::1' || ip.startsWith('127.') || ip.startsWith('::ffff:127.');

/** Tailscale's addresses: 100.64.0.0/10 and fd7a:115c:a1e0::/48. */
export function isTailnetAddress(ip) {
    const v4 = String(ip || '').replace(/^::ffff:/, '');
    const m = /^100\.(\d+)\.\d+\.\d+$/.exec(v4);
    if (m) { const b = Number(m[1]); return b >= 64 && b <= 127; }
    return /^fd7a:115c:a1e0:/i.test(String(ip || ''));
}

/** Headers another proxy or tunnel (Cloudflare, nginx, ngrok) adds and `tailscale serve` does not. */
const OTHER_PROXY_HEADERS = ['forwarded', 'x-real-ip', 'cf-connecting-ip', 'cf-ray', 'true-client-ip', 'x-client-ip', 'fly-client-ip'];

/**
 * What `tailscale serve` claims about this request: `{ login, host }`, or
 * null. It must look like serve and nothing else: the connection itself from
 * this machine (serve connects over loopback), exactly ONE relayed address and
 * that one a tailnet address, no header another proxy or tunnel adds, and a
 * Host that is a `.ts.net` name. A tunnel that forwards a client's headers
 * (cloudflared, ngrok) fails on the Host — the caller then compares it with
 * THIS computer's own name — and 100.64.0.0/10 is also carrier NAT space, so
 * the address alone proves nothing.
 */
export function tailscaleLoginOf(req) {
    const h = req.headers || {};
    const login = h['tailscale-user-login'];
    if (typeof login !== 'string' || !login.trim()) return null;
    if (!isLoopback(String(req.socket?.remoteAddress || ''))) return null;
    const hops = String(h['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
    if (hops.length !== 1 || !isTailnetAddress(hops[0]) || !isTailnetAddress(req.ip)) return null;
    if (OTHER_PROXY_HEADERS.some(k => h[k] !== undefined)) return null;
    // The REAL Host, which serve sets to the tailnet name (measured). An
    // X-Forwarded-Host is only a second copy of it: one that disagrees is a
    // client's word a proxy passed along, never a reason to believe.
    const bare = (v) => String(v || '').replace(/:\d+$/, '').toLowerCase();
    const host = bare(h.host);
    if (!host.endsWith('.ts.net')) return null;
    if (h['x-forwarded-host'] !== undefined && bare(h['x-forwarded-host']) !== host) return null;
    return { login: login.trim(), host, ip: hops[0] };
}

const PEER_FRESH_MS = 60 * 1000;
const peerCache = new Map(); // tailnet ip -> { login, at }
let peersForTest = null;

/**
 * Who Tailscale ITSELF says owns a tailnet address (`tailscale whois`), or
 * null (not a peer, a tagged device, no Tailscale). The headers say who serve
 * relayed; this asks the daemon directly, so a header a proxy passed along
 * cannot make an address belong to the owner.
 */
async function loginOfPeer(ip) {
    if (peersForTest) return peersForTest[ip] ?? null;
    if (!isTailnetAddress(ip)) return null;
    const hit = peerCache.get(ip);
    if (hit && Date.now() - hit.at < PEER_FRESH_MS) return hit.login;
    const who = await tailscaleJson(['whois', '--json', ip]);
    const tagged = Array.isArray(who?.Node?.Tags) && who.Node.Tags.length > 0;
    const login = !tagged && typeof who?.UserProfile?.LoginName === 'string' ? who.UserProfile.LoginName.trim() : null;
    peerCache.set(ip, { login, at: Date.now() });
    return login;
}

/** For the gates: who owns which tailnet address, without a CLI (null = ask the CLI). */
export function setTailscalePeersForTest(map) {
    peersForTest = map;
    peerCache.clear();
}

/**
 * How a request from another device is let in without the password:
 * 'device' (a connected device's key), 'tailscale' (the computer's own
 * Tailscale account), or null. Stored on `req.remoteAccess` by
 * `identifyRemoteAccess`, which runs before every /api route.
 *
 * Tailscale counts only while NO password is set. The header it rests on is
 * one any program on this computer could also send, so it is exactly as
 * trustworthy as a request from this computer — which is let in without a
 * password and stopped by one. A password set means the owner does not trust
 * everything on this machine, and then neither does this.
 */
export async function remoteAccessOf(req, cookies, { passwordSet = false } = {}) {
    const device = deviceForToken(cookies[DEVICE_COOKIE]);
    if (device) { req.device = device; return 'device'; }
    if (passwordSet || !tailscaleTrustOn()) return null;
    const claim = tailscaleLoginOf(req);
    if (!claim) return null;
    const self = await tailscaleSelf();
    if (!self || self.login.toLowerCase() !== claim.login.toLowerCase() || self.host !== claim.host) return null;
    // And Tailscale itself must agree that the relayed address is the owner's.
    const peer = await loginOfPeer(claim.ip);
    return peer && peer.toLowerCase() === self.login.toLowerCase() ? 'tailscale' : null;
}

// --- where a phone can reach this app ----------------------------------------

const isLoopbackHost = (h) => /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i.test(h);

/**
 * The address to put in the QR code, or null when no phone could reach this
 * app. In order: the address this page was opened at, when that is not this
 * machine's own; the `tailscale serve` site that proxies to this port; the
 * local network address, when the server listens on more than loopback.
 */
export async function phoneAddress(req) {
    const host = String(req.headers.host || '');
    const hostname = host.replace(/:\d+$/, '');
    const proto = (String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()) || (req.secure ? 'https' : 'http');
    if (hostname && !isLoopbackHost(hostname)) return `${proto}://${host}`;

    const port = Number(req.socket?.localPort) || Number(process.env.PORT) || 3001;
    const served = servedAddress(await tailscaleJson(['serve', 'status', '--json']), port);
    if (served) return served;

    const bind = process.env.HOST || '127.0.0.1';
    if (!isLoopbackHost(bind)) {
        for (const list of Object.values(os.networkInterfaces())) {
            for (const a of list || []) {
                if (a.family === 'IPv4' && !a.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) {
                    return `${req.secure ? 'https' : 'http'}://${a.address}:${port}`;
                }
            }
        }
    }
    return null;
}

/** The https address of a `tailscale serve` handler whose proxy target is this port. */
export function servedAddress(serveStatus, port) {
    const web = serveStatus && serveStatus.Web;
    if (!web || typeof web !== 'object') return null;
    const funnel = (serveStatus && serveStatus.AllowFunnel) || {};
    for (const [hostPort, conf] of Object.entries(web)) {
        // A site on Funnel is on the public internet: never an address to hand a phone.
        if (funnel[hostPort]) continue;
        const root = conf && conf.Handlers && conf.Handlers['/'];
        const target = root && typeof root.Proxy === 'string' ? root.Proxy : '';
        const m = /^(?:https?|https\+insecure):\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::(\d+))?\/?$/i.exec(target);
        if (!m || Number(m[1] || 80) !== port) continue;
        const [name, p] = hostPort.split(':');
        return p && p !== '443' ? `https://${name}:${p}` : `https://${name}`;
    }
    return null;
}

/**
 * The HTTPS port to give this app on the tailnet: 443 when nothing holds it,
 * else the first free one from 8443 up. Never a port another site already
 * uses — `tailscale serve --https=443` REPLACES whatever was there, which on a
 * machine running a second copy of the app is that copy's address.
 */
export function chooseServePort(serveStatus) {
    const taken = new Set(Object.keys((serveStatus && serveStatus.TCP) || {}).map(Number));
    for (const hostPort of Object.keys((serveStatus && serveStatus.Web) || {})) taken.add(Number(hostPort.split(':')[1] || 443));
    if (!taken.has(443)) return 443;
    for (let p = 8443; p < 8500; p++) if (!taken.has(p)) return p;
    return null;
}

/** The `tailscale serve` arguments that pass this app on to the tailnet (and only the tailnet: never Funnel). */
export function serveArgs(httpsPort, appPort, appIsHttps) {
    const target = appIsHttps ? `https+insecure://localhost:${appPort}` : `http://127.0.0.1:${appPort}`;
    return ['serve', '--bg', `--https=${httpsPort}`, target];
}

/**
 * Make this app reachable from the owner's other Tailscale devices, on the
 * press of a button in Settings. Answers `{ url }` once it is, or
 * `{ url: null, command }` with the line to run by hand when the CLI refused
 * (on Linux `tailscale serve` wants root or an operator) or is not there.
 */
/**
 * What to do, given `tailscale serve status --json` as it stands (null when
 * it could not be read): `{ url }` already served, `{ args }` to run, or
 * `{ refuse: true }`. An unreadable status REFUSES rather than guessing: read
 * as "nothing served", it would pick 443 and replace whatever site is there.
 */
export function planServe(before, appPort, appIsHttps) {
    if (!before || typeof before !== 'object') return { refuse: true };
    const already = servedAddress(before, appPort);
    if (already) return { url: already };
    const httpsPort = chooseServePort(before);
    if (!httpsPort) return { refuse: true };
    return { args: serveArgs(httpsPort, appPort, appIsHttps) };
}

/** The tailnet address this app is served at, or null (not served, or no Tailscale). */
export async function servedHere(req) {
    const appPort = Number(req.socket?.localPort) || Number(process.env.PORT) || 3001;
    return servedAddress(await tailscaleJson(['serve', 'status', '--json']), appPort);
}

export async function serveOnTailnet(req) {
    const appPort = Number(req.socket?.localPort) || Number(process.env.PORT) || 3001;
    const appIsHttps = !!req.socket?.encrypted;
    const plan = planServe(await tailscaleJson(['serve', 'status', '--json']), appPort, appIsHttps);
    if (plan.url) return { url: plan.url };
    // No command here: the status could not be read, so any port suggested
    // could be the one another site holds.
    if (plan.refuse) return { url: null, command: null };
    const { args } = plan;
    const command = `tailscale ${args.join(' ')}`;
    if (await runTailscale(args, 15000) == null) return { url: null, command };
    const url = servedAddress(await tailscaleJson(['serve', 'status', '--json']), appPort);
    return url ? { url } : { url: null, command };
}
