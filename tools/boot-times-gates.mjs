// tools/boot-times-gates.mjs — a start says where its time went.
//
// A first launch of the day took 20-45 s and the log had nothing between the
// launcher's first lines and "Serving at", so nobody could say whether the
// time went on reading the app off the disk, opening the library, migrating
// it, or a machine paging too hard to run anything. The server now logs one
// `[Boot]` line when it listens (server/bootTimes.js): each phase's share, and
// the CPU the process used, which tells waiting from computing.
//
// The format from fixed marks, then a real `--check` start of the launcher on
// a scratch library: the line is there, its phases come in order, and they add
// up to the total.
//
// Run:  node tools/boot-times-gates.mjs   (the real start takes ~5-30 s)

import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bootLine } from '../server/bootTimes.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

let failures = 0;
let passed = 0;
const check = (label, actual, expected) => {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    const ok = a === e;
    if (ok) passed++; else failures++;
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${ok ? '' : ` — got ${a}, want ${e}`}`);
};

// --- the line ------------------------------------------------------------------
// The field case: 36 s to listen, almost all of it reading modules, 4 s of CPU.
const slow = [
    { name: 'launcher', at: 400, cpu: 150 },
    { name: 'modules', at: 28_400, cpu: 2_600 },
    { name: 'library opened', at: 29_600, cpu: 2_900 },
    { name: 'schema', at: 34_700, cpu: 3_900 },
    { name: 'listen', at: 36_100, cpu: 4_200 },
];
check('a slow cold start names each phase and calls it waiting', bootLine(slow),
    '[Boot] listening 36.1 s after the process started (CPU 4.20 s, mostly waiting: the disk, or memory paged out): '
    + 'launcher 0.40 s, modules 28.0 s, library opened 1.20 s, schema 5.10 s, listen 1.40 s');
check('a start that burned its time is computing', bootLine([{ name: 'modules', at: 2_000, cpu: 1_900 }, { name: 'listen', at: 2_500, cpu: 2_300 }]),
    '[Boot] listening 2.50 s after the process started (CPU 2.30 s, computing): modules 2.00 s, listen 0.50 s');
check('between the two is partly waiting', /partly waiting/.test(bootLine([{ name: 'listen', at: 1000, cpu: 450 }])), true);
check('no marks, no line', bootLine([]), null);

// --- a real start ----------------------------------------------------------------
{
    const cache = join(repoRoot, 'node_modules', '.cache');
    mkdirSync(cache, { recursive: true });
    const dataDir = mkdtempSync(join(cache, 'boot-times-gates-'));
    const env = { ...process.env };
    for (const k of ['DATA_DIR', 'DB_PATH', 'VAULT_ROOT', 'SECRETS_PATH', 'PORT', 'TERRAMENTOR_TRAY']) delete env[k];
    const port = 39000 + Math.floor(Math.random() * 800);
    // --data-dir is applied in the launcher's own process before the server is
    // imported; the vault and the secrets file follow it. --check starts,
    // verifies and quits.
    const out = await new Promise((res) => {
        const c = spawn(process.execPath, [join(repoRoot, 'desktop', 'launcher.js'), '--check', '--data-dir', dataDir, '--port', String(port)],
            { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        let text = '';
        c.stdout.on('data', (b) => { text += b; });
        c.stderr.on('data', (b) => { text += b; });
        const timer = setTimeout(() => c.kill(), 180_000);
        c.on('close', () => { clearTimeout(timer); res(text); });
    });
    const line = out.split(/\r?\n/).find((l) => l.startsWith('[Boot] '));
    check('a launcher start logs one [Boot] line', !!line, true);
    if (!line) console.log(out);
    const phases = [...(line || '').matchAll(/(?:: |, )([a-z ]+) (\d+\.\d+) s/g)].map((m) => [m[1], Number(m[2])]);
    check('…with the phases in the order a start goes through them', phases.map((p) => p[0]),
        ['launcher', 'modules read', 'library opened', 'schema', 'modules run', 'listen']);
    const total = Number(line?.match(/listening (\d+\.\d+) s/)?.[1]);
    const sum = phases.reduce((s, p) => s + p[1], 0);
    check('…which add up to the total', Math.abs(sum - total) <= 0.05 * phases.length, true);
    check('…and it says how much CPU that took', /\(CPU \d+\.\d+ s, (computing|partly waiting|mostly waiting)/.test(line || ''), true);
    check('…and the start still passes its check', /Check OK/.test(out), true);
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* a file still closing */ }
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
