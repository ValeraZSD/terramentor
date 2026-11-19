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

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
    START_LOCK, START_LOCK_MAX_MS, claimStartLock, readStartLock, startLockLive, markStartLockUp,
    releaseStartLock, settleStart, pidAlive,
} from '../desktop/lib.js';

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
const alive = () => true;
const dead = () => false;

try {
    // --- the lock's rules ---------------------------------------------------------
    {
        const f = lockIn(freshDir());
        const a = claimStartLock(f, { pid: 111, alive });
        check('the first launch on a library claims the lock', a.claimed, true);
        const lock = readStartLock(f);
        check('the lock names its process and says starting', [lock.pid, lock.state, lock.token === a.token], [111, 'starting', true]);
        const b = claimStartLock(f, { pid: 222, alive });
        check('a second launch while the first is starting is told to wait', [b.claimed, b.lock?.pid], [false, 111]);
        check('…and the lock is still the first one\'s', readStartLock(f).token, a.token);

        check('someone else\'s token cannot mark the lock up', markStartLockUp(f, 'not-mine', { window: true }), false);
        check('the holder marks it up with its window decision', markStartLockUp(f, a.token, { window: true }), true);
        check('…which keeps the holder and says up', [readStartLock(f).pid, readStartLock(f).state, readStartLock(f).window], [111, 'up', true]);
        check('…and leaves no temporary file behind', existsSync(`${f}.${a.token}.tmp`), false);
        check('an up lock holds nobody back', startLockLive(readStartLock(f), { alive }), false);

        check('someone else\'s token cannot release the lock', releaseStartLock(f, 'not-mine'), false);
        check('the holder releases it on exit', [releaseStartLock(f, a.token), existsSync(f)], [true, false]);
    }
    {
        const f = lockIn(freshDir());
        claimStartLock(f, { pid: 111, alive });
        const c = claimStartLock(f, { pid: 222, alive: dead });
        check('a dead holder\'s lock is taken over', [c.claimed, readStartLock(f).pid], [true, 222]);
    }
    {
        const f = lockIn(freshDir());
        const t0 = Date.now();
        claimStartLock(f, { pid: 111, alive, now: () => t0 - START_LOCK_MAX_MS - 1 });
        const c = claimStartLock(f, { pid: 222, alive });
        check('a start older than the limit (a hung holder) is taken over', [c.claimed, readStartLock(f).pid], [true, 222]);
    }
    {
        const f = lockIn(freshDir());
        const a = claimStartLock(f, { pid: 111, alive });
        markStartLockUp(f, a.token, { window: false });
        const c = claimStartLock(f, { pid: 222, alive });
        check('an up lock from a living server is taken over (finding that server is not the lock\'s job)', c.claimed, true);
    }
    {
        const f = lockIn(freshDir());
        writeFileSync(f, '');
        const c = claimStartLock(f, { pid: 222, alive });
        check('an empty lock written this instant means wait a moment, not take over', [c.claimed, c.busy, existsSync(f)], [false, true, true]);
        const old = (Date.now() - 60_000) / 1000;
        utimesSync(f, old, old);
        check('an old unreadable lock is taken over', claimStartLock(f, { pid: 222, alive }).claimed, true);
    }
    {
        const missing = join(scratch, 'not-there', 'deeper');
        const c = claimStartLock(lockIn(missing), { pid: 1, alive });
        check('no folder: no lock, the launch goes ahead unguarded', [c.claimed, c.lock, c.busy], [false, undefined, undefined]);
        check('…and the folder is not created', existsSync(missing), false);
    }
    check('this process is alive', pidAlive(process.pid), true);
    check('a nonsense pid is not', [pidAlive(0), pidAlive(-5), pidAlive('12'), pidAlive(undefined)], [false, false, false, false]);

    // --- settleStart: what a launch does ----------------------------------------
    // A simulated holder: starting for three polls, then up with `window`.
    const simulate = async ({ window, holderDies = false }) => {
        const f = lockIn(freshDir());
        const holder = claimStartLock(f, { pid: 111, alive });
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
            claim: (file) => claimStartLock(file, { pid: 222, alive }),
            live: (lock) => startLockLive(lock, { alive }),
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
        const old = claimStartLock(f, { pid: 111, alive });
        markStartLockUp(f, old.token, { window: true });
        const r = await settleStart({ lockFile: f, find: async () => ({ port: 1 }), sleep: async () => {} });
        check('a launch that did not wait never reads an old start\'s window', r.openedByHolder, false);
    }
    {
        const r = await settleStart({ lockFile: lockIn(join(scratch, 'gone')), find: async () => null, sleep: async () => {} });
        check('no lock possible: start unguarded rather than not at all', r, {});
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
        const port = 39000 + Math.floor(Math.random() * 800);
        const env = { ...process.env };
        for (const k of ['DATA_DIR', 'DB_PATH', 'VAULT_ROOT', 'SECRETS_PATH', 'PORT', 'TERRAMENTOR_TRAY']) delete env[k];
        // --data-dir is set in the launcher's own process (it writes DATA_DIR
        // before importing the server); VAULT_ROOT and the secrets file follow it.
        const args = [join(repoRoot, 'desktop', 'launcher.js'), '--no-window', '--data-dir', dataDir, '--port', String(port)];
        const run = () => {
            const c = spawn(process.execPath, args, { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
            const p = { child: c, out: '', exited: null };
            c.stdout.on('data', (b) => { p.out += b; });
            c.stderr.on('data', (b) => { p.out += b; });
            p.done = new Promise((res) => c.on('close', (code) => { p.exited = code; res(code); }));
            return p;
        };
        const a = run();
        const b = run();
        const deadline = Date.now() + 120_000;
        const serving = () => [a, b].filter((p) => /Serving at /.test(p.out));
        // Wait until one serves and the other has left.
        while (Date.now() < deadline && !(serving().length >= 1 && [a, b].some((p) => p.exited !== null))) {
            await new Promise((r) => setTimeout(r, 250));
        }
        await new Promise((r) => setTimeout(r, 1500)); // a second server would have printed by now
        const servers = serving();
        const other = [a, b].find((p) => !servers.includes(p));
        check('two launchers started at once on one library: one server', servers.length, 1);
        check('…the other waited for that start', /waiting for it instead of starting a second server/.test(other?.out || ''), true);
        check('…found it and left', [/already running on port/.test(other?.out || ''), other?.exited], [true, 0]);
        if (servers.length === 0 || failures) console.log(`--- launcher A ---\n${a.out}\n--- launcher B ---\n${b.out}`);
        const url = servers[0]?.out.match(/Serving at (\S+)/)?.[1];
        if (url) {
            try { await fetch(`${url}/api/desktop/quit`, { method: 'POST' }); } catch { /* killed below */ }
            await Promise.race([servers[0].done, new Promise((r) => setTimeout(r, 10_000))]);
            check('the server releases its lock when it stops', existsSync(lockIn(dataDir)), false);
        }
        for (const p of [a, b]) if (p.exited === null) p.child.kill();
    }
} finally {
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* a server still closing */ }
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
