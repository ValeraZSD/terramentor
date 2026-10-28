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
 * The two ways that drifts: a module reading `VAULT_ROOT` itself and stopping
 * there (the desktop launcher's DATA_DIR then ignored), and a module pinning
 * a path beside its own source off `__dirname` (ignoring both). This suite is
 * what keeps either out.
 *
 * `desktop-gates.mjs` already asserts the precedence TABLE — that
 * `resolveDataPaths` answers correctly. This suite asserts the CALL SITES: that
 * every module asks it, and that two real processes on one machine touch
 * nothing in common.
 *
 *   node tools/tenancy-gates.mjs
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serverFiles, readServer } from './lib/serverSource.mjs';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const serverDir = join(repoRoot, 'server');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
    cond ? pass++ : fail++;
    console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${cond || !detail ? '' : `  (${detail})`}`);
};

// Every module under server/, routes/ included ('routes/documents.js').
const source = new Map(serverFiles().map((f) => [f, readServer(f)]));

// ---------------------------------------------------------------------------
console.log('--- paths.js is the only module that reads where the data lives ---');
{
    // Reading one of these directly skips the precedence table, so a module
    // can honour a scratch server and miss the desktop launcher — which is the
    // exact shape of the visualFeedback.js bug.
    const DATA_ENV = /process\.env\.(DB_PATH|VAULT_ROOT|DATA_DIR|SECRETS_PATH)\b/;
    for (const [file, text] of source) {
        if (file === 'paths.js') continue;
        const hit = text.split('\n').findIndex((l) => DATA_ENV.test(l) && !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'));
        ok(`${file} does not read DB_PATH/VAULT_ROOT/DATA_DIR/SECRETS_PATH itself`, hit === -1, `line ${hit + 1}`);
    }
    ok('…and paths.js reads all four', ['DB_PATH', 'VAULT_ROOT', 'DATA_DIR', 'SECRETS_PATH']
        .every((k) => source.get('paths.js').includes(`env.${k}`)));
}

// ---------------------------------------------------------------------------
console.log('\n--- one module opens the credentials file ---');
{
    // Keys, sign-ins and the password live in a file beside the library
    // (server/secrets.js). Its path comes from paths.js like every other, and
    // only secrets.js asks for it: a second reader is a second place a key can
    // be written where the next audit does not look.
    const NAMES_IT = /secretsPath|secretsFileFor|\.secrets\.json/;
    for (const [file, text] of source) {
        if (file === 'paths.js' || file === 'secrets.js') continue;
        const hit = text.split('\n').findIndex((l) => NAMES_IT.test(l) && !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'));
        ok(`${file} does not locate the credentials file itself`, hit === -1, `line ${hit + 1}`);
    }
    ok('secrets.js takes the path from paths.js', /from '\.\/paths\.js'/.test(source.get('secrets.js') || '')
        && /dataPaths\(\)\.secretsPath/.test(source.get('secrets.js') || ''));
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
    // `./paths.js` from server/, `../paths.js` from server/routes/.
    const VIA_PATHS = /from '(?:\.\.?\/)+(?:paths|vaultStorage)\.js'/;

    // A module writes outside the data directory only with a reason, stated
    // here — the `BESPOKE` convention from control-gates.mjs.
    const EXEMPT = new Map([
        ['desktop.js', 'the autostart entry belongs in the OS\'s own startup location (Startup folder, LaunchAgents, ~/.config/autostart) and the PowerShell helper is pid-suffixed in tmpdir and deleted on exit — neither is library data, and a hosted per-tenant process never calls either'],
        ['appUpdate.js', 'a desktop update is staged in `.update/` inside the APP folder, beside the files it replaces, never the library: the swap must be renames on one volume, and the library may live on another drive. Only a packaged desktop copy started by the launcher writes there (installSupport), so a hosted or Docker process never does'],
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
        const { secretsFile } = await import(${JSON.stringify(pathToUrl(join(serverDir, 'secrets.js')))});
        const p = dataPaths();
        console.log(JSON.stringify({
            pid: process.pid, dataDir: p.dataDir, source: p.source,
            vaultRoot: p.vaultRoot, dbPath: DB_PATH,
            visualFeedback: visualFeedbackPath(), ocr: ocrDataDir(), secrets: secretsFile(),
        }));
        process.exit(0);
    `;
    const dirs = [mkdtempSync(join(tmpdir(), 'tenancy-a-')), mkdtempSync(join(tmpdir(), 'tenancy-b-'))];
    const KEYS = ['vaultRoot', 'dbPath', 'visualFeedback', 'ocr', 'secrets'];
    const read = (dir) => {
        const env = { ...process.env, DATA_DIR: dir, PYTHONIOENCODING: 'utf-8' };
        delete env.DB_PATH;
        delete env.VAULT_ROOT;
        delete env.SECRETS_PATH;
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

// ---------------------------------------------------------------------------
console.log('\n--- the tools that read a library find it where the server does ---');
{
    // CONTRIBUTING's "tools that work on your own library" are run with the
    // same environment as the server (`node --env-file=.env tools/…`), so a
    // worktree's DATA_DIR or a container's DB_PATH must reach them too. A tool
    // that names `server/terramentor.db` itself cannot open any other library.
    const TOOLS = ['feed-audit.mjs', 'leaf-invariant.mjs'];
    for (const tool of TOOLS) {
        const text = readFileSync(join(here, tool), 'utf8');
        ok(`tools/${tool} takes the database path from paths.js`,
            /from '\.\.\/server\/paths\.js'/.test(text) && !/['"]terramentor\.db['"]/.test(text));
    }
    const dir = mkdtempSync(join(tmpdir(), 'tenancy-tools-'));
    try {
        const env = { ...process.env, DATA_DIR: dir, PYTHONIOENCODING: 'utf-8' };
        delete env.DB_PATH;
        delete env.VAULT_ROOT;
        delete env.SECRETS_PATH;
        // Opening the database through the server makes it, with its schema.
        const made = spawnSync(process.execPath, ['--input-type=module', '-e',
            `await import(${JSON.stringify(pathToUrl(join(serverDir, 'database.js')))}); process.exit(0);`],
        { encoding: 'utf8', cwd: repoRoot, timeout: 60_000, env });
        ok('a scratch library was made under DATA_DIR', made.status === 0 && existsSync(join(dir, 'terramentor.db')), (made.stderr || '').slice(0, 200));
        for (const tool of TOOLS) {
            const r = spawnSync(process.execPath, [join(here, tool)], { encoding: 'utf8', cwd: repoRoot, timeout: 60_000, env });
            ok(`tools/${tool} opens the library DATA_DIR names`, r.status === 0,
                `exit ${r.status}: ${(r.stderr || r.stdout || '').trim().split('\n').find((l) => /Error/.test(l)) || ''}`);
        }
    } finally {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* a leftover temp dir is not a failure */ }
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
