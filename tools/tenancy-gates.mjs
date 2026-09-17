#!/usr/bin/env node
/**
 * One process, one library — enforced.
 *
 * The app binds to a single SQLite handle opened at module load (39 of 72
 * server modules `import db from './database.js'`), so a second learner is a
 * second PROCESS with its own DATA_DIR, not a second connection. That shape is
 * free and needs no refactor, but it holds only while EVERYTHING a process
 * writes is decided by `server/paths.js`. One module reading `VAULT_ROOT`
 * itself, or naming a directory beside its own source, is a file two tenants
 * share — and the same mistake is already a data-loss bug in a packaged
 * install, where the application folder is unwritable and is replaced on
 * update.
 *
 * Two modules had done exactly that: `visualFeedback.js` read VAULT_ROOT and
 * stopped, so the desktop launcher's DATA_DIR was ignored; `pdfRecovery.js`
 * pinned the OCR model cache to `server/vault/ocr-data` off `__dirname`,
 * ignoring both. Fixed 2026-09-16; this suite is what keeps the next one out.
 *
 * `desktop-gates.mjs` already asserts the precedence TABLE — that
 * `resolveDataPaths` answers correctly. This suite asserts the CALL SITES: that
 * every module asks it, and that two real processes on one machine touch
 * nothing in common.
 *
 *   node tools/tenancy-gates.mjs
 */
import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const serverDir = join(repoRoot, 'server');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
    cond ? pass++ : fail++;
    console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${cond || !detail ? '' : `  (${detail})`}`);
};

const modules = readdirSync(serverDir).filter((f) => f.endsWith('.js'));
const source = new Map(modules.map((f) => [f, readFileSync(join(serverDir, f), 'utf8')]));

// ---------------------------------------------------------------------------
console.log('--- paths.js is the only module that reads where the data lives ---');
{
    // Reading one of the three directly skips the precedence table, so a module
    // can honour a scratch server and miss the desktop launcher — which is the
    // exact shape of the visualFeedback.js bug.
    const DATA_ENV = /process\.env\.(DB_PATH|VAULT_ROOT|DATA_DIR)\b/;
    for (const [file, text] of source) {
        if (file === 'paths.js') continue;
        const hit = text.split('\n').findIndex((l) => DATA_ENV.test(l) && !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'));
        ok(`${file} does not read DB_PATH/VAULT_ROOT/DATA_DIR itself`, hit === -1, `line ${hit + 1}`);
    }
    ok('…and paths.js reads all three', ['DB_PATH', 'VAULT_ROOT', 'DATA_DIR']
        .every((k) => source.get('paths.js').includes(`env.${k}`)));
}

// ---------------------------------------------------------------------------
console.log('\n--- no data path is named beside the source ---');
{
    // `__dirname` is legitimate for reading CODE that ships with the app (the
    // built client, package.json, the dev certificates). It is never how a
    // directory the app WRITES to is found: those move per install and per
    // tenant, and only paths.js knows where they went.
    const DATA_NAMES = /(vault|\.db\b|terramentor\.db|ocr-|feedback|media|blobs|uploads|logs)/i;
    const ALLOW = new Set(['paths.js']);
    for (const [file, text] of source) {
        if (ALLOW.has(file)) continue;
        const offenders = text.split('\n')
            .map((line, i) => ({ line: line.trim(), n: i + 1 }))
            .filter(({ line }) => !line.startsWith('//') && !line.startsWith('*'))
            .filter(({ line }) => /(__dirname|process\.cwd\(\))/.test(line) && DATA_NAMES.test(line));
        ok(`${file} builds no data path from __dirname/cwd`, offenders.length === 0,
            offenders.map((o) => `line ${o.n}`).join(', '));
    }
}

// ---------------------------------------------------------------------------
console.log('\n--- every module that writes gets its root from paths.js ---');
{
    // A module that creates or writes files must have asked paths.js where to
    // put them, directly or through the blob store. `mkdtempSync(tmpdir())` is
    // exempt: it makes a unique directory per call and deletes it, so it is
    // shared by nobody.
    const WRITES = /\b(writeFileSync|appendFileSync|createWriteStream|mkdirSync|renameSync)\s*\(/;
    const VIA_PATHS = /from '\.\/paths\.js'|from '\.\/vaultStorage\.js'/;

    // A module writes outside the data directory only with a reason, stated
    // here — the `BESPOKE` convention from control-gates.mjs.
    const EXEMPT = new Map([
        ['desktop.js', 'the autostart entry belongs in the OS\'s own startup location (Startup folder, LaunchAgents, ~/.config/autostart) and the PowerShell helper is pid-suffixed in tmpdir and deleted on exit — neither is library data, and a hosted per-tenant process never calls either'],
    ]);

    for (const [file, text] of source) {
        if (file === 'paths.js') continue;
        if (EXEMPT.has(file)) { ok(`${file} is exempt: ${EXEMPT.get(file)}`, true); continue; }
        const lines = text.split('\n');
        const writes = lines
            .map((line, i) => ({ line: line.trim(), n: i + 1 }))
            .filter(({ line }) => WRITES.test(line) && !line.startsWith('*') && !line.startsWith('//') && !/^import\b/.test(line))
            .filter(({ line }) => !/mkdtempSync/.test(line));
        if (!writes.length) continue;
        const scoped = VIA_PATHS.test(text) || /mkdtempSync/.test(text);
        ok(`${file} writes only under a root paths.js chose`, scoped,
            `writes at ${writes.map((w) => w.n).join(', ')} with no paths.js/vaultStorage import`);
    }
}

// ---------------------------------------------------------------------------
console.log('\n--- two tenants, two processes, nothing in common ---');
{
    // The claim process-per-tenant rests on, checked rather than argued: boot
    // two real processes with two DATA_DIRs, import the modules that own a data
    // path (which opens each database and runs its migrations), and compare
    // every path each one decided on. A probe that recomputed a path from
    // paths.js instead of reading the module's own would pass whatever the
    // module did, so each value here comes from the module that owns it.
    // DATA_DIR reaches the child in its ENVIRONMENT, which is how the desktop
    // launcher and a container set it too.
    const probe = `
        const { dataPaths } = await import(${JSON.stringify(pathToUrl(join(serverDir, 'paths.js')))});
        const { visualFeedbackPath } = await import(${JSON.stringify(pathToUrl(join(serverDir, 'visualFeedback.js')))});
        const { DB_PATH } = await import(${JSON.stringify(pathToUrl(join(serverDir, 'database.js')))});
        const { ocrDataDir } = await import(${JSON.stringify(pathToUrl(join(serverDir, 'pdfRecovery.js')))});
        const p = dataPaths();
        console.log(JSON.stringify({
            pid: process.pid, dataDir: p.dataDir, source: p.source,
            vaultRoot: p.vaultRoot, dbPath: DB_PATH,
            visualFeedback: visualFeedbackPath(), ocr: ocrDataDir(),
        }));
        process.exit(0);
    `;
    const dirs = [mkdtempSync(join(tmpdir(), 'tenancy-a-')), mkdtempSync(join(tmpdir(), 'tenancy-b-'))];
    const KEYS = ['vaultRoot', 'dbPath', 'visualFeedback', 'ocr'];
    const read = (dir) => {
        const env = { ...process.env, DATA_DIR: dir, PYTHONIOENCODING: 'utf-8' };
        delete env.DB_PATH;
        delete env.VAULT_ROOT;
        const r = spawnSync(process.execPath, ['--input-type=module', '-e', probe],
            { encoding: 'utf8', cwd: repoRoot, timeout: 60_000, env });
        const line = (r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
        if (!line) throw new Error(`probe produced nothing: ${r.stderr || r.stdout}`);
        return JSON.parse(line);
    };
    const inside = (p, dir) => p.replace(/\\/g, '/').toLowerCase().startsWith(`${dir.replace(/\\/g, '/').toLowerCase()}/`);
    try {
        const [a, b] = dirs.map(read);
        ok('two different processes', a.pid !== b.pid);
        for (const [label, t] of [['A', a], ['B', b]]) {
            ok(`${label}: DATA_DIR alone decided the layout`, t.source === 'data-dir', t.source);
            for (const key of KEYS) ok(`${label}: ${key} is inside its own data dir`, inside(t[key], t.dataDir), t[key]);
        }
        for (const key of KEYS) ok(`${key} is not shared between the two`, a[key].toLowerCase() !== b[key].toLowerCase(), a[key]);
        ok('each tenant really made its own database file', existsSync(a.dbPath) && existsSync(b.dbPath));
    } finally {
        for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* a leftover temp dir is not a failure */ } }
    }
}

// `pathToFileURL`, never a hand-built `file:///${p}` — on POSIX an absolute path
// already starts with a slash, so the hand-built form yields `file:////home/…`
// and this suite would be the one thing in the repo that only runs on Windows.
function pathToUrl(p) {
    return pathToFileURL(p).href;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
