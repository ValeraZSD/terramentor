// tools/start-lock-gates.mjs — one start at a time on one library.
//
// A launch looks for a running server and starts its own when it finds none.
// A first launch of the day took 20-45 s before it listened, and a tray "Open"
// click in that time found nothing and started a second server; three were
// seen on one library. The launch that starts the server now holds a lock in
// the data folder (desktop/lib.js `settleStart`), and a later launch waits for
// it instead of starting another. These checks cover the lock's rules, a race
// of real processes for it, and two real launchers started at once on a
// scratch library: one server, and the second launch says it waited.
//
// Run:  node tools/start-lock-gates.mjs          (the launcher race takes ~10-30 s)
//       node tools/start-lock-gates.mjs --quick  (skip the launcher race)

import * as nodeFs from 'node:fs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, utimesSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
    START_LOCK, START_LOCK_MAX_MS, claimStartLock, readStartLock, startLockLive, markStartLockUp,
    releaseStartLock, settleStart, pidAlive, autostartPlan,
} from '../desktop/lib.js';
import { INSTANCE_KEY_FILE, OWNER_PROOF_HEADER, ownerProof, readInstanceKeyFile } from '../server/instanceKey.js';
import { scratchApp } from './lib/scratchApp.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const cache = join(repoRoot, 'node_modules', '.cache');
mkdirSync(cache, { recursive: true });
const scratch = mkdtempSync(join(cache, 'start-lock-gates-'));

let failures = 0;
let passed = 0;
const check = (label, actual, expected) => {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    const ok = a === e;
    if (ok) passed++; else failures++;
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${ok ? '' : ` — got ${a}, want ${e}`}`);
};
let n = 0;
const freshDir = () => { const d = join(scratch, `d${n++}`); mkdirSync(d); return d; };
const lockIn = (d) => join(d, START_LOCK);
const realFs = { readFileSync: nodeFs.readFileSync, writeFileSync: nodeFs.writeFileSync, unlinkSync: nodeFs.unlinkSync, renameSync: nodeFs.renameSync, statSync: nodeFs.statSync, linkSync: nodeFs.linkSync };
const alive = () => true;
const dead = () => false;
let app = null;
// The lock rules are judged at one fixed instant; real time is used only for
// the processes below, which really race.
const T = Date.parse('2026-11-19T12:00:00Z');
const at = () => T;

try {
    // --- the lock's rules ---------------------------------------------------------
    {
        const f = lockIn(freshDir());
        const a = claimStartLock(f, { pid: 111, alive, now: at });
        check('the first launch on a library claims the lock', a.claimed, true);
        const lock = readStartLock(f);
        check('the lock names its process and says starting', [lock.pid, lock.state, lock.token === a.token], [111, 'starting', true]);
        const b = claimStartLock(f, { pid: 222, alive, now: at });
        check('a second launch while the first is starting is told to wait', [b.claimed, b.lock?.pid], [false, 111]);
        check('…and the lock is still the first one\'s', readStartLock(f).token, a.token);

        check('someone else\'s token cannot mark the lock up', markStartLockUp(f, 'not-mine', { window: true }), false);
        check('the holder marks it up with its window decision', markStartLockUp(f, a.token, { window: true }), true);
        check('…which keeps the holder and says up', [readStartLock(f).pid, readStartLock(f).state, readStartLock(f).window], [111, 'up', true]);
        check('…and leaves no temporary file behind', existsSync(`${f}.${a.token}.tmp`), false);
        check('an up lock holds nobody back', startLockLive(readStartLock(f), { alive, now: T }), false);

        check('someone else\'s token cannot release the lock', releaseStartLock(f, 'not-mine'), false);
        check('the holder releases it on exit', [releaseStartLock(f, a.token), existsSync(f)], [true, false]);
    }
    {
        const f = lockIn(freshDir());
        claimStartLock(f, { pid: 111, alive, now: at });
        const c = claimStartLock(f, { pid: 222, alive: dead, now: at });
        check('a dead holder\'s lock is taken over', [c.claimed, readStartLock(f).pid], [true, 222]);
    }
    {
        const f = lockIn(freshDir());
        claimStartLock(f, { pid: 111, alive, now: () => T - START_LOCK_MAX_MS - 1 });
        const c = claimStartLock(f, { pid: 222, alive, now: at });
        check('a start older than the limit (a hung holder) is taken over', [c.claimed, readStartLock(f).pid], [true, 222]);
    }
    {
        const f = lockIn(freshDir());
        const a = claimStartLock(f, { pid: 111, alive, now: at });
        markStartLockUp(f, a.token, { window: false });
        const c = claimStartLock(f, { pid: 222, alive, now: at });
        check('an up lock from a living server is taken over (finding that server is not the lock\'s job)', c.claimed, true);
    }
    {
        const f = lockIn(freshDir());
        writeFileSync(f, '');
        utimesSync(f, T / 1000, T / 1000);
        const c = claimStartLock(f, { pid: 222, alive, now: at });
        check('an empty lock written this instant means wait a moment, not take over', [c.claimed, c.busy, existsSync(f)], [false, true, true]);
        const old = (T - 60_000) / 1000;
        utimesSync(f, old, old);
        check('an old unreadable lock is taken over', claimStartLock(f, { pid: 222, alive, now: at }).claimed, true);
    }
    {
        const missing = join(scratch, 'not-there', 'deeper');
        const c = claimStartLock(lockIn(missing), { pid: 1, alive, now: at });
        check('no folder: no lock, the launch goes ahead unguarded', [c.claimed, c.lock, c.busy], [false, undefined, undefined]);
        check('…and the folder is not created', existsSync(missing), false);
    }
    {
        // Two launches taking over one stale lock: B read the stale lock, then
        // A took it over and wrote its own before B acted on what it read.
        const f = lockIn(freshDir());
        writeFileSync(f, JSON.stringify({ pid: 999, at: new Date(0).toISOString(), state: 'starting', token: 'stale' }));
        const deadButA = (pid) => pid === 111;
        let a = null;
        const fsB = {
            ...realFs,
            readFileSync: (p, enc) => {
                const text = realFs.readFileSync(p, enc);
                if (p === f && !a) a = claimStartLock(f, { pid: 111, alive: deadButA, now: at });
                return text;
            },
        };
        const b = claimStartLock(f, { pid: 222, alive: deadButA, fs: fsB, now: at });
        check('two launches taking over one stale lock: the first wins', a?.claimed, true);
        check('…and the second does not move the winner\'s lock away', [b.claimed, readStartLock(f)?.pid], [false, 111]);
        check('…nothing is left beside the lock', readdirSync(dirname(f)).filter((n) => n !== 'start.lock'), []);
    }
    {
        const at = new Date(Date.parse('2026-11-19T12:00:00Z') + 3600_000).toISOString();
        check('a start stamped an hour ahead (the clock went back) holds nobody',
            startLockLive({ pid: 111, at, state: 'starting' }, { now: Date.parse('2026-11-19T12:00:00Z'), alive }), false);
    }
    check('this process is alive', pidAlive(process.pid), true);
    check('a nonsense pid is not', [pidAlive(0), pidAlive(-5), pidAlive('12'), pidAlive(undefined)], [false, false, false, false]);

    // --- settleStart: what a launch does ----------------------------------------
    // A simulated holder: starting for three polls, then up with `window`.
    const simulate = async ({ window, holderDies = false }) => {
        const f = lockIn(freshDir());
        const holder = claimStartLock(f, { pid: 111, alive, now: at });
        let polls = 0;
        let serverUp = false;
        const sleep = async () => {
            polls++;
            if (polls === 3) {
                if (holderDies) rmSync(f);
                else { markStartLockUp(f, holder.token, { window }); serverUp = true; }
            }
        };
        let waited = null;
        const result = await settleStart({
            lockFile: f,
            find: async () => (serverUp ? { port: 1, url: 'http://127.0.0.1:1' } : null),
            claim: (file) => claimStartLock(file, { pid: 222, alive, now: at }),
            live: (lock) => startLockLive(lock, { alive, now: T }),
            sleep,
            onWait: (lock) => { waited = lock.pid; },
        });
        return { result, waited, polls, lock: readStartLock(f) };
    };
    {
        const r = await simulate({ window: true });
        check('a launch during a start waits for it and says whom it waits for', r.waited, 111);
        check('…then finds the server and starts none', [!!r.result.running, r.result.token], [true, undefined]);
        check('…and opens no window when that start opened one', r.result.openedByHolder, true);
    }
    {
        const r = await simulate({ window: false });
        check('a start that opened no window (sign-in, hidden) leaves the window to the waiting launch', [!!r.result.running, r.result.openedByHolder], [true, false]);
    }
    {
        const r = await simulate({ window: true, holderDies: true });
        check('a holder that dies while starting: the waiting launch starts the server itself', [!!r.result.token, r.lock?.pid], [true, 222]);
    }
    {
        // A server already up long ago, its lock still saying window:true: a
        // later click did not wait, so it must open its window.
        const f = lockIn(freshDir());
        const old = claimStartLock(f, { pid: 111, alive, now: at });
        markStartLockUp(f, old.token, { window: true });
        const r = await settleStart({ lockFile: f, find: async () => ({ port: 1 }), sleep: async () => {} });
        check('a launch that did not wait never reads an old start\'s window', r.openedByHolder, false);
    }
    {
        const r = await settleStart({ lockFile: lockIn(join(scratch, 'gone')), find: async () => null, sleep: async () => {} });
        check('no lock possible: start unguarded rather than not at all', r, {});
    }
    {
        // A server that is up (its lock says so, its process lives) but missed
        // the first probes: busy with its start, or paged out.
        const f = lockIn(freshDir());
        const holder = claimStartLock(f, { pid: 111, alive, now: at });
        markStartLockUp(f, holder.token, { window: true });
        let probes = 0;
        const r = await settleStart({
            lockFile: f,
            find: async () => (++probes >= 4 ? { port: 1 } : null),
            claim: (file) => claimStartLock(file, { pid: 222, alive, now: at }),
            serving: (lock) => lock?.state === 'up' && alive(lock.pid),
            sleep: async () => {},
        });
        check('a running server that missed a probe is asked again, not started beside', [!!r.running, r.token, readStartLock(f)?.pid], [true, undefined, 111]);
    }
    {
        const f = lockIn(freshDir());
        const holder = claimStartLock(f, { pid: 111, alive, now: at });
        markStartLockUp(f, holder.token, { window: true });
        let probes = 0;
        const r = await settleStart({
            lockFile: f,
            find: async () => { probes++; return null; },
            claim: (file) => claimStartLock(file, { pid: 222, alive, now: at }),
            serving: (lock) => lock?.state === 'up' && alive(lock.pid),
            sleep: async () => {},
        });
        check('…one that never answers is given up on after a bounded number of probes', [!!r.token, probes], [true, 11]);
    }
    {
        // A holder that listens but never marks its lock up.
        const f = lockIn(freshDir());
        claimStartLock(f, { pid: 111, alive, now: at });
        let polls = 0;
        const r = await settleStart({
            lockFile: f,
            find: async () => (polls > 0 ? { port: 1 } : null),
            claim: (file) => claimStartLock(file, { pid: 222, alive, now: at }),
            live: (lock) => startLockLive(lock, { alive, now: T }),
            sleep: async () => { polls++; },
        });
        check('a holder stuck after it listens: the waiting launch finds its server', [!!r.running, r.openedByHolder], [true, false]);
        check('…after waiting a while, and a while longer for its window decision', polls >= 60 && polls < 70, true);
    }
    {
        // A holder that listens, stalls past the probe, then decides its window.
        const f = lockIn(freshDir());
        const holder = claimStartLock(f, { pid: 111, alive, now: at });
        let polls = 0;
        const r = await settleStart({
            lockFile: f,
            find: async () => (polls > 0 ? { port: 1 } : null),
            claim: (file) => claimStartLock(file, { pid: 222, alive, now: at }),
            live: (lock) => startLockLive(lock, { alive, now: T }),
            sleep: async () => { if (++polls === 45) markStartLockUp(f, holder.token, { window: true }); },
        });
        check('a holder that opens its window after the probe found its server: one window, not two', [!!r.running, r.openedByHolder], [true, true]);
    }
    {
        // A lock that stays "being written" (new empty lock files keep appearing).
        let claims = 0;
        const r = await settleStart({
            lockFile: lockIn(freshDir()),
            find: async () => null,
            claim: () => { claims++; return { claimed: false, busy: true }; },
            sleep: async () => {},
        });
        check('a lock that stays busy never leads to an unguarded start: the launch stops', [r.stuck, r.token, claims > 5], [true, undefined, true]);
    }
    {
        // Start after start holds the library, each live when asked.
        const f = lockIn(freshDir());
        let n2 = 0;
        const r = await settleStart({
            lockFile: f,
            find: async () => null,
            claim: () => ({ claimed: false, lock: { pid: 900 + n2++, state: 'starting', at: new Date(T).toISOString(), token: `t${n2}` } }),
            live: () => false,
            sleep: async () => {},
        });
        check('…nor do starts that keep holding it: the launch stops after a bounded wait', [r.stuck, r.token], [true, undefined]);
    }

    // --- real processes racing for one lock ------------------------------------
    {
        const libUrl = pathToFileURL(join(repoRoot, 'desktop', 'lib.js')).href;
        const rounds = 4;
        const racers = 6;
        const winners = [];
        for (let round = 0; round < rounds; round++) {
            const f = lockIn(freshDir());
            const go = Date.now() + 2500;
            // Each racer stays alive past the round, as a real holder does: a
            // winner that exited at once would be a dead holder, rightly taken over.
            const code = `import { claimStartLock } from ${JSON.stringify(libUrl)};
                while (Date.now() < ${go}) {}
                process.stdout.write(JSON.stringify(claimStartLock(${JSON.stringify(f)})));
                setTimeout(() => {}, ${go - Date.now()} + 1500);`;
            const outs = await Promise.all(Array.from({ length: racers }, () => new Promise((res) => {
                const c = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
                let out = '';
                c.stdout.on('data', (b) => { out += b; });
                c.on('close', () => { try { res(JSON.parse(out)); } catch { res({ error: out }); } });
            })));
            winners.push(outs.filter((o) => o.claimed).length);
        }
        check(`${racers} processes claiming at once: exactly one wins, ${rounds} rounds`, winners, Array(rounds).fill(1));
    }

    // --- two real launchers at once -----------------------------------------------
    if (!process.argv.includes('--quick')) {
        const dataDir = freshDir();
        // A port the system hands out as free, not one from a fixed range: other
        // suites run beside this one.
        const port = await new Promise((resolve, reject) => {
            const probe = createServer();
            probe.once('error', reject);
            probe.listen(0, '127.0.0.1', () => { const free = probe.address().port; probe.close(() => resolve(free)); });
        });
        const env = { ...process.env };
        for (const k of ['DATA_DIR', 'DB_PATH', 'VAULT_ROOT', 'SECRETS_PATH', 'PORT', 'TERRAMENTOR_TRAY']) delete env[k];
        // A scratch home, so nothing these launchers write per user (the login
        // item, the Start Menu shortcut) can reach the real one. Inside it, a
        // login item some other library wrote: a server on this scratch library
        // must leave it exactly as it is.
        const home = freshDir();
        Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: join(home, 'Roaming'), LOCALAPPDATA: join(home, 'Local'), XDG_CONFIG_HOME: join(home, '.config') });
        const loginItem = autostartPlan({ target: process.execPath, env, home });
        const sentinel = 'a login item written for another library\n';
        if (loginItem.supported) {
            mkdirSync(dirname(loginItem.path), { recursive: true });
            writeFileSync(loginItem.path, sentinel);
        }
        // --data-dir is set in the launcher's own process (it writes DATA_DIR
        // before importing the server); VAULT_ROOT and the secrets file follow it.
        app = scratchApp(repoRoot, freshDir());
        const args = [app.launcher, '--no-window', '--data-dir', dataDir, '--port', String(port)];
        const run = () => {
            const c = spawn(process.execPath, args, { cwd: app.root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
            const p = { child: c, out: '', exited: null };
            c.stdout.on('data', (b) => { p.out += b; });
            c.stderr.on('data', (b) => { p.out += b; });
            p.done = new Promise((res) => c.on('close', (code) => { p.exited = code; res(code); }));
            return p;
        };
        // This process holds the library's start lock first, as a start in
        // progress, and lets go only once both launchers say they are waiting
        // for it. Started bare, the two raced on runner speed: on a slow runner
        // one booted after the other already served, so it never waited.
        const waitLine = /waiting for it instead of starting a second server/;
        const held = claimStartLock(lockIn(dataDir));
        const a = run();
        const b = run();
        const deadline = Date.now() + 120_000;
        while (Date.now() < deadline && ![a, b].every((p) => waitLine.test(p.out) || /Serving at /.test(p.out) || p.exited !== null)) {
            await new Promise((r) => setTimeout(r, 100));
        }
        const bothWaited = [a, b].map((p) => waitLine.test(p.out));
        const startedBeside = [a, b].some((p) => /Serving at /.test(p.out));
        releaseStartLock(lockIn(dataDir), held.token);
        check('two launchers, while another start holds the library: both wait, neither serves', [held.claimed, bothWaited, startedBeside], [true, [true, true], false]);
        const serving = () => [a, b].filter((p) => /Serving at /.test(p.out));
        // Wait until one serves and the other has left.
        while (Date.now() < deadline && !(serving().length >= 1 && [a, b].some((p) => p.exited !== null))) {
            await new Promise((r) => setTimeout(r, 250));
        }
        await new Promise((r) => setTimeout(r, 1500)); // a second server would have printed by now
        const servers = serving();
        const other = [a, b].find((p) => !servers.includes(p));
        check('…then one of them serves: one server', servers.length, 1);
        check('…found it and left', [/already running on port/.test(other?.out || ''), other?.exited], [true, 0]);
        if (servers.length === 0 || failures) console.log(`--- launcher A ---\n${a.out}\n--- launcher B ---\n${b.out}`);
        const url = servers[0]?.out.match(/Serving at (\S+)/)?.[1];
        if (url) {
            // The desktop server answers this computer's owner only (server/auth.js):
            // the quit carries a proof made with the library's key, as the launcher's own does.
            const key = readInstanceKeyFile(join(dataDir, INSTANCE_KEY_FILE));
            const headers = key ? { [OWNER_PROOF_HEADER]: ownerProof(key, Number(new URL(url).port)) } : {};
            try { await fetch(`${url}/api/desktop/quit`, { method: 'POST', headers }); } catch { /* killed below */ }
            await Promise.race([servers[0].done, new Promise((r) => setTimeout(r, 10_000))]);
            check('the server releases its lock when it stops', existsSync(lockIn(dataDir)), false);
        }
        for (const p of [a, b]) if (p.exited === null) p.child.kill();
        if (loginItem.supported) {
            // A rewrite runs PowerShell on Windows, which lands a second or two
            // after the server asked for it.
            const until = Date.now() + 4000;
            const read = () => { try { return readFileSync(loginItem.path, 'utf8'); } catch { return null; } };
            while (Date.now() < until && read() === sentinel) await new Promise((r) => setTimeout(r, 250));
            // A yes/no: a rewritten .lnk is binary and names the machine and the user.
            check("a server on another library leaves the user's login item alone", read() === sentinel, true);
        }
    }
} finally {
    // The scratch app links into the repo: those links go first, or nothing is removed.
    if (!app || app.dispose()) {
        try { rmSync(scratch, { recursive: true, force: true }); } catch { /* a server still closing */ }
    }
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
