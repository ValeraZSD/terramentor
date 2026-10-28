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
// What it trusts. The server staged `.update/next` beside the release's signed
// manifest (`.update/manifest.json` and its `.sig`) and wrote `.update/ready.json`.
// This program trusts none of what the server wrote: before it moves anything
// it checks the manifest's signature again with the keys of the version
// installed now, takes the file list's hash from that manifest, and checks the
// staged tree file by file against the list; it refuses a version that is not
// newer than the one installed. ready.json only says that something is staged.
// It never reaches the network and installs nothing it was not handed in
// `.update/next`.
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
    SIGNATURE_NAME, UPDATE_DIR, appTopLevel, parseFileList, readJson, safeRelPath, sha256, swapIn, undoSwap, verifySignedManifest, verifyTree,
} from './updateCore.js';
import { compareVersions } from '../server/version.js';
import { newNonce, provesInstance, readInstanceKeyFile } from '../server/instanceKey.js';

const plan = readJson(process.argv[2]);
if (!plan || !plan.appRoot || !plan.relaunch) {
    console.error('updater: no plan');
    process.exit(2);
}

/* The library's instance key (server/instanceKey.js). "Up" means a server on
 * one of the ports proved it holds this key, not merely that something there
 * answered with the library's id: the id is a hash anyone on the machine can
 * compute, and a stand-in answering it would have this program declare a
 * broken version healthy and throw the working one away. Read once, before
 * anything moves; the server made it long before the person pressed Restart.
 * A plan without the path, or a key that cannot be read, falls back to the id
 * alone and says so in the log — refusing every update over an unreadable
 * file would leave the person on the old version with no way forward. */
const instanceKey = plan.instanceKeyFile ? readInstanceKeyFile(plan.instanceKeyFile) : null;

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
const readIfThere = (file) => { try { return readFileSync(file); } catch { return null; } };

async function waitForExit(pids, limitMs) {
    const until = Date.now() + limitMs;
    while (pids.some(alive)) {
        if (Date.now() > until) return false;
        await pause(200);
    }
    return true;
}

/** GET a JSON status from one port, http then https (a copy with its own
 *  certificates serves https), never more than `ms`. `nonce` is the challenge
 *  the answer's proof must be made from. */
function probe(port, nonce, ms = 1500) {
    const once = (mod) => new Promise((resolve) => {
        const req = mod.get({ host: '127.0.0.1', port, path: `/api/desktop/status?nonce=${nonce}`, timeout: ms, rejectUnauthorized: false }, (res) => {
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
            const nonce = newNonce();
            const s = await probe(port, nonce);
            if (s && s.app === 'terramentor' && s.libraryId === plan.libraryId && (s.version === undefined || s.version === version)
                && (!instanceKey || provesInstance(s, { key: instanceKey, nonce, port }))) return { ok: true, port };
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
    // With the time it started, so a pid the system has since handed to some
    // other process is recognised as stale by its age (launcher.js).
    writeFileSync(join(upd, 'updater.pid'), `${process.pid} ${Date.now()}`);
    process.on('exit', () => { try { rmSync(join(upd, 'updater.pid'), { force: true }); } catch { /* gone */ } });
    const ready = readJson(join(upd, 'ready.json'));
    const installed = readJson(join(appRoot, 'package.json'))?.version || '0.0.0';
    const base = { from: installed, to: ready?.version || null };

    if (!await waitForExit(plan.waitPids || [], 60_000)) {
        // The app is still running: moving its files now would break it, and
        // starting another copy beside it would put two servers on one
        // library. Do nothing; the next "Restart to update" tries again.
        finish({ ...base, ok: false, step: 'wait', reason: 'Terramentor did not close, so nothing was changed.' });
        return;
    }
    log(`app closed; installing ${base.to} over ${installed}`);
    if (!instanceKey) log('no instance key to check the new version against; accepting the library id alone');

    // 2. Verify before anything moves.
    let problem = null, list = null;
    try {
        if (!ready || typeof ready.version !== 'string') throw new Error('No update is staged.');
        // The release's signed manifest, checked again with the keys of the
        // version installed now (this copy of updateCore.js is that version's).
        // Which channel this copy follows is a setting the server keeps, so
        // it is checked at staging; here a release of either channel is taken
        // when it carries the signature of the key listed for that channel.
        const manifest = verifySignedManifest(readIfThere(join(upd, 'manifest.json')), readIfThere(join(upd, SIGNATURE_NAME)), { channels: ['stable', 'nightly'] });
        if (manifest.version !== ready.version) throw new Error(`The signed manifest (${manifest.version}) does not match the staged update (${ready.version}).`);
        if (compareVersions(manifest.version, installed) <= 0) throw new Error(`${manifest.version} is not newer than ${installed}.`);
        // The file list's hash from the signed manifest, never from ready.json.
        const ref = manifest.assets?.[`${process.platform}-${process.arch}`]?.files;
        if (!ref || safeRelPath(ref.path) !== ref.path || !/^[0-9a-f]{64}$/.test(ref.sha256 || '')) throw new Error('The signed manifest names no file list for this computer.');
        const text = readFileSync(join(nextDir, ...ref.path.split('/')));
        if (sha256(text) !== ref.sha256) throw new Error('The staged file list is not the release\'s.');
        list = parseFileList(text.toString('utf8'), { version: manifest.version });
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
    // The installed list only widens what counts as the app's; one that cannot
    // be read is not a reason to stop half way with the app already closed.
    let installedList = null;
    try { installedList = parseFileList(readFileSync(join(appRoot, 'files.json'), 'utf8')); } catch { /* the new list alone */ }
    const names = appTopLevel(installedList, list);
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
        // The result before the journal: an open page asks again only while
        // the journal is there (`trial`), so a result written after it, behind
        // the slow delete of the download, landed after the asking had stopped.
        try {
            finish({ ...base, ok: true, startedInMs: Date.now() - t0, port: up.port });
        } finally {
            rmSync(journalFile, { force: true });
            rmSync(join(upd, 'ready.json'), { force: true });
            rmSync(join(upd, 'download'), { recursive: true, force: true });
            rmSync(nextDir, { recursive: true, force: true });
        }
        return;
    }

    log(`${ready.version} did not come up (${up.why}); putting ${installed} back`);
    stop(run.child);
    await waitForExit([run.child.pid].filter(Boolean), 15_000);
    try {
        await undoSwap({ journal, journalFile });
    } catch (e) {
        finish({ ...base, ok: false, step: 'rollback', reason: `The new version did not start and the old one could not be put back (${e.code || e.message}). The old files are in ${previousDir}.` });
        // The journal stays for the next start to undo (launcher.js), but no
        // updater is watching any more, so this is no longer a trial: the
        // launcher reads a live updater pid for that, which goes with this exit.
        return;
    }
    rmSync(join(upd, 'ready.json'), { force: true });
    let said = '';
    try { said = readFileSync(join(upd, 'start-failed.txt'), 'utf8').trim().split(/\r?\n/).filter(Boolean).slice(0, 3).join(' ').slice(0, 300); } catch { /* it only exited */ }
    rmSync(join(upd, 'start-failed.txt'), { force: true });
    finish({
        ...base, ok: false, step: 'start', failed: ready.version,
        reason: up.why === 'exited'
            ? `Version ${ready.version} stopped while starting, so Terramentor went back to ${installed}.`
            : `Version ${ready.version} did not start within ${Math.round((plan.timeoutMs || 120_000) / 1000)} seconds, so Terramentor went back to ${installed}.`,
        // What the new version itself reported, kept apart so the note can
        // show it under Details without repeating the sentence above.
        ...(said ? { said } : {}),
    });
    const back = start();
    const ok = await waitHealthy({ version: installed, exited: back.exited });
    log(ok.ok ? `${installed} is running again` : `${installed} did not come back up (${ok.why})`);
})().catch((e) => {
    log(`unexpected: ${e.stack || e.message}`);
    // Still say something the app can show, and start whatever is installed:
    // the person pressed "Restart" and must not be left with no app.
    try { finish({ ok: false, step: 'updater', reason: `The updater stopped unexpectedly (${e.code || e.message}).` }); } catch { /* the log line stands */ }
    try { start(); } catch { /* nothing more to try */ }
    process.exitCode = 1;
});

