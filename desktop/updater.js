#!/usr/bin/env node
// Installs a staged update, starts it, and puts the old version back if the
// new one does not come up.
//
//   node <app>/.update/runner/desktop/updater.js <plan.json>
//
// Started by desktop/launcher.js when the person presses "Restart to update",
// as a DETACHED process running from a copy of the runtime under
// `.update/runner/`, because nothing can rename a folder while a program inside
// it is running — and the folders this moves are the ones the app runs from.
// The copy holds this file, updateCore.js and server/version.js (for the
// version comparison), laid out as in the app so the imports below resolve.
//
// What it trusts. The server staged `.update/next` and wrote `.update/ready.json`
// from a manifest it fetched from this repository's releases; this program
// checks the staged tree again, file by file, against that release's file list
// before it moves anything, and refuses a version that is not newer than the
// one installed. It never reaches the network and installs nothing it was not
// handed in `.update/next`.
//
// Order of events:
//   1. wait for the app's processes (the server, and the Windows tray host) to exit
//   2. verify `.update/next` against the release's file list
//   3. move the app's own top-level entries to `.update/previous`, the staged
//      ones into the app folder — journalled, so a cut can be undone
//   4. start the new version with the same command line the person used
//   5. wait for it to answer as THIS library on THAT version; if it does not
//      within the limit, or exits first: stop it, undo the swap, start the old
//      version, and leave `.update/result.json` saying why — which the old
//      version shows the person.

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { join } from 'node:path';
import {
    UPDATE_DIR, appTopLevel, parseFileList, readJson, sha256, swapIn, undoSwap, verifyTree,
} from './updateCore.js';
import { compareVersions } from '../server/version.js';

const plan = readJson(process.argv[2]);
if (!plan || !plan.appRoot || !plan.relaunch) {
    console.error('updater: no plan');
    process.exit(2);
}

const appRoot = plan.appRoot;
const upd = join(appRoot, UPDATE_DIR);
const nextDir = join(upd, 'next');
const previousDir = join(upd, 'previous');
const journalFile = join(upd, 'swap.json');
const resultFile = join(upd, 'result.json');

function log(line) {
    const text = `${new Date().toISOString()} [updater] ${line}\n`;
    try { if (plan.logFile) appendFileSync(plan.logFile, text); } catch { /* the log is a courtesy */ }
    process.stdout.write(text);
}

const alive = (pid) => {
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForExit(pids, limitMs) {
    const until = Date.now() + limitMs;
    while (pids.some(alive)) {
        if (Date.now() > until) return false;
        await pause(200);
    }
    return true;
}

/** GET a JSON status from one port, http then https (a copy with its own
 *  certificates serves https), never more than `ms`. */
function probe(port, ms = 1500) {
    const once = (mod) => new Promise((resolve) => {
        const req = mod.get({ host: '127.0.0.1', port, path: '/api/desktop/status', timeout: ms, rejectUnauthorized: false }, (res) => {
            let body = '';
            res.on('data', (d) => { body += d; });
            res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
        });
        req.on('timeout', () => req.destroy());
        req.on('error', () => resolve(null));
    });
    return once(http).then((s) => s || once(https));
}

/** Up when some port answers as this library. The public probe carries no
 *  version (it answers anyone who asks), and none is needed: the processes of
 *  the old version are gone (`waitForExit`), so a server on this library is
 *  the one just started. A probe that does name a version must name this one.
 *  `exited` ends the wait early: a launcher that quit has nothing left to come up. */
async function waitHealthy({ version, exited }) {
    const until = Date.now() + (plan.timeoutMs || 120_000);
    while (Date.now() < until) {
        for (const port of plan.ports || []) {
            const s = await probe(port);
            if (s && s.app === 'terramentor' && s.libraryId === plan.libraryId && (s.version === undefined || s.version === version)) return { ok: true, port };
        }
        // A version on trial that cannot start says so in this file and exits
        // (launcher.js `fatal`); either sign ends the wait.
        if (exited() || existsSync(join(upd, 'start-failed.txt'))) return { ok: false, why: 'exited' };
        await pause(500);
    }
    return { ok: false, why: 'timeout' };
}

function start() {
    const { target, args = [] } = plan.relaunch;
    const child = spawn(target, args, { cwd: appRoot, detached: true, stdio: 'ignore', env: process.env });
    let gone = false;
    child.on('exit', () => { gone = true; });
    child.on('error', (e) => { gone = true; log(`could not start ${target}: ${e.message}`); });
    child.unref();
    return { child, exited: () => gone };
}

/** Stop a version that did not come up, and everything it started. */
function stop(child) {
    if (!child?.pid) return;
    try {
        if (process.platform === 'win32') {
            spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 15_000 });
        } else {
            process.kill(-child.pid, 'SIGKILL');
        }
    } catch { /* already gone */ }
}

function finish(result) {
    writeFileSync(resultFile, JSON.stringify({ ...result, at: new Date().toISOString() }, null, 2));
    log(result.ok ? `installed ${result.to}` : `${result.to} not installed: ${result.reason}`);
}

(async () => {
    // Read by the launcher: a swap journal with a LIVE updater is work in
    // progress, one without is a swap that was cut short (launcher.js).
    writeFileSync(join(upd, 'updater.pid'), String(process.pid));
    process.on('exit', () => { try { rmSync(join(upd, 'updater.pid'), { force: true }); } catch { /* gone */ } });
    const ready = readJson(join(upd, 'ready.json'));
    const installed = readJson(join(appRoot, 'package.json'))?.version || '0.0.0';
    const base = { from: installed, to: ready?.version || null };

    if (!await waitForExit(plan.waitPids || [], 60_000)) {
        // The app is still running: moving its files now would break it. Do
        // nothing; the next "Restart to update" tries again.
        finish({ ...base, ok: false, step: 'wait', reason: 'Terramentor did not close, so nothing was changed.' });
        start();
        return;
    }
    log(`app closed; installing ${base.to} over ${installed}`);

    // 2. Verify before anything moves.
    let problem = null, list = null;
    try {
        if (!ready || typeof ready.version !== 'string' || !ready.files) throw new Error('No update is staged.');
        if (compareVersions(ready.version, installed) <= 0) throw new Error(`${ready.version} is not newer than ${installed}.`);
        const text = readFileSync(join(nextDir, ...ready.files.path.split('/')));
        if (sha256(text) !== ready.files.sha256) throw new Error('The staged file list is not the release\'s.');
        list = parseFileList(text.toString('utf8'), { version: ready.version });
        problem = await verifyTree(nextDir, list, { linkedFrom: appRoot });
    } catch (e) {
        problem = e.message;
    }
    if (problem) {
        // A damaged staging area is thrown away so the next try downloads again.
        rmSync(nextDir, { recursive: true, force: true });
        rmSync(join(upd, 'ready.json'), { force: true });
        finish({ ...base, ok: false, step: 'verify', reason: `The downloaded update failed its check (${problem}). Nothing was changed.` });
        start();
        return;
    }

    // 3. Swap.
    const names = appTopLevel(readJson(join(appRoot, 'files.json')) ? parseFileList(readFileSync(join(appRoot, 'files.json'), 'utf8')) : null, list);
    let journal;
    try {
        journal = await swapIn({ appRoot, nextDir, previousDir, names, journalFile });
    } catch (e) {
        finish({ ...base, ok: false, step: 'swap', reason: `Files of the app could not be replaced (${e.code || e.message}). Nothing was changed.` });
        start();
        return;
    }
    log(`swapped ${names.length} entries`);

    // 4–5. Start it and watch.
    rmSync(join(upd, 'start-failed.txt'), { force: true });
    const t0 = Date.now();
    const run = start();
    const up = await waitHealthy({ version: ready.version, exited: run.exited });
    if (up.ok) {
        rmSync(journalFile, { force: true });
        rmSync(join(upd, 'ready.json'), { force: true });
        rmSync(join(upd, 'download'), { recursive: true, force: true });
        rmSync(nextDir, { recursive: true, force: true });
        finish({ ...base, ok: true, startedInMs: Date.now() - t0, port: up.port });
        return;
    }

    log(`${ready.version} did not come up (${up.why}); putting ${installed} back`);
    stop(run.child);
    await waitForExit([run.child.pid].filter(Boolean), 15_000);
    try {
        await undoSwap({ journal, journalFile });
    } catch (e) {
        finish({ ...base, ok: false, step: 'rollback', reason: `The new version did not start and the old one could not be put back (${e.code || e.message}). The old files are in ${previousDir}.` });
        return;
    }
    rmSync(join(upd, 'ready.json'), { force: true });
    let said = '';
    try { said = readFileSync(join(upd, 'start-failed.txt'), 'utf8').trim().split(/\r?\n/).filter(Boolean).slice(0, 3).join(' ').slice(0, 300); } catch { /* it only exited */ }
    rmSync(join(upd, 'start-failed.txt'), { force: true });
    finish({
        ...base, ok: false, step: 'start', failed: ready.version,
        reason: (up.why === 'exited'
            ? `Version ${ready.version} stopped while starting, so Terramentor went back to ${installed}.`
            : `Version ${ready.version} did not start within ${Math.round((plan.timeoutMs || 120_000) / 1000)} seconds, so Terramentor went back to ${installed}.`)
            + (said ? ` It said: ${said}` : ''),
    });
    const back = start();
    const ok = await waitHealthy({ version: installed, exited: back.exited });
    log(ok.ok ? `${installed} is running again` : `${installed} did not come back up (${ok.why})`);
})().catch((e) => {
    log(`unexpected: ${e.stack || e.message}`);
    process.exitCode = 1;
});

