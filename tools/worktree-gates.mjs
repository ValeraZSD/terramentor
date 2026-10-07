// tools/worktree-gates.mjs — one checkout per piece of work, each with its own
// dev servers and its own scratch library.
//
// Run:  node tools/worktree-gates.mjs
//
// WHY. Work runs in several git worktrees at once (one branch, one pull request
// each), and every checkout's `npm run dev` wanted the same two ports: Vite on
// 5173 and a proxy hard-wired to http://localhost:3001. Where an installed
// desktop app holds 3001 with a real library, a second checkout's server died
// on EADDRINUSE while its page went on talking to that library through the
// proxy. Three halves, each asserted here:
//
//   1. ONE PORT RULE (`tools/dev-ports.mjs`): the server's own
//      `Number(PORT) || 3001`, read from the environment then `.env` exactly as
//      `node --env-file` reads it — checked against Node itself, not against a
//      second copy of the rule. A worktree's pair comes from its path.
//   2. VITE FOLLOWS IT: the loaded config's page port, strict, and both proxy
//      targets — HEAD's config named localhost:3001 and fails this outright.
//   3. THE SETUP (`tools/worktree-setup.mjs`), end to end on a scratch
//      repository with two worktrees: refuses the main checkout, copies only
//      what `.worktreeinclude` names AND git ignores, writes a `.env` the two
//      halves agree with, moves off a taken pair, never touches a hand-written
//      `.env` or a node_modules that is a link, and keeps its ports on a re-run.
//   Plus `t3.json`, the file T3 Code reads to run the setup in a new worktree.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const ports = await import('./dev-ports.mjs');
const setup = await import('./worktree-setup.mjs');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const eq = (label, got, want) => check(label, JSON.stringify(got) === JSON.stringify(want),
    `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const section = (s) => console.log(`\n--- ${s} ---`);

// The real path: on Windows the temp folder can arrive as an 8.3 short name
// (VALERA~1) while git reports the long one, and the two never compare equal.
const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'worktree-gates-')));
const git = (cwd, ...args) => {
    // commit.gpgsign off: a contributor who signs every commit would otherwise be
    // asked for a passphrase, or fail, on the scratch repository's commit.
    const r = spawnSync('git', ['-c', 'user.name=gate', '-c', 'user.email=gate@example.invalid', '-c', 'init.defaultBranch=main',
        '-c', 'commit.gpgsign=false', ...args],
        { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
};

try {
    // ========================================================================
    section('1. one port rule');
    {
        const dir = join(scratch, 'env-rule');
        mkdirSync(dir);
        writeFileSync(join(dir, '.env'), 'PORT=4100\nVITE_PORT=5300\n');
        eq('.env names both ports (a chosen page port)', ports.devPorts({ root: dir, env: {} }), { api: 4100, web: 5300, webChosen: true });
        eq('the environment beats .env', ports.devPorts({ root: dir, env: { PORT: '4200' } }), { api: 4200, web: 5300, webChosen: true });
        eq('no .env, no environment: 3001 and 5173, the page port not chosen', ports.devPorts({ root: join(scratch, 'nowhere'), env: {} }),
            { api: 3001, web: 5173, webChosen: false });
        eq('a PORT that is not a number is the default', ports.devPorts({ root: join(scratch, 'nowhere'), env: { PORT: 'abc' } }).api, 3001);

        // The truth is Node's own --env-file plus the server's own expression,
        // so ask Node rather than restate the rule. An EMPTY variable in the
        // environment is the hard case: it is defined, so the file does not
        // replace it, and `Number('') || 3001` is 3001.
        const serverSays = (env) => {
            const r = spawnSync(process.execPath, ['--env-file=.env', '-e', 'process.stdout.write(String(Number(process.env.PORT) || 3001))'],
                { cwd: dir, encoding: 'utf8', env: { ...env, PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } });
            return Number(r.stdout);
        };
        for (const [label, env] of [['PORT unset', {}], ['PORT empty', { PORT: '' }], ['PORT set', { PORT: '4777' }]]) {
            eq(`the proxy's port is the server's, ${label}`, ports.devPorts({ root: dir, env }).api, serverSays(env));
        }
    }
    {
        const offsets = Array.from({ length: 300 }, (_, i) => ports.worktreePortOffset(`/srv/wt/${i}-${'x'.repeat(i % 17)}`, { platform: 'linux' }));
        check('an offset is always 1..span', offsets.every(o => Number.isInteger(o) && o >= 1 && o <= ports.WORKTREE_PORT_SPAN));
        check('…and spreads (300 paths, over 150 distinct)', new Set(offsets).size > 150, String(new Set(offsets).size));
        eq('the same path, the same offset', ports.worktreePortOffset('D:/wt/a'), ports.worktreePortOffset('D:/wt/a'));
        eq('Windows: case and separators do not matter',
            ports.worktreePortOffset('D:\\Worktrees\\X\\', { platform: 'win32' }), ports.worktreePortOffset('d:/worktrees/x', { platform: 'win32' }));
        const all = Array.from({ length: ports.WORKTREE_PORT_SPAN + 3 }, (_, i) => ports.portsForOffset(i + 1));
        check('worktree ports are never 3001 or 5173, and API and page ranges never meet',
            all.every(p => p.api !== 3001 && p.web !== 5173 && p.api > 3100 && p.api <= 3600 && p.web > 5200 && p.web <= 5700));
        eq('an offset past the span wraps to the start', ports.portsForOffset(ports.WORKTREE_PORT_SPAN + 1), ports.portsForOffset(1));
    }

    // ========================================================================
    section('2. Vite follows it');
    {
        const { loadConfigFromFile } = await import('vite');
        const load = async (env) => {
            const saved = { PORT: process.env.PORT, VITE_PORT: process.env.VITE_PORT };
            Object.assign(process.env, env);
            try {
                const r = await loadConfigFromFile({ command: 'serve', mode: 'development' }, join(repoRoot, 'vite.config.ts'), repoRoot, 'silent');
                return r.config.server;
            } finally {
                for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
            }
        };
        const server = await load({ PORT: '4321', VITE_PORT: '4322' });
        eq('the page port is VITE_PORT', server.port, 4322);
        check('…and strict, being chosen: a taken one stops Vite rather than moving it to another worktree\'s', server.strictPort === true);
        eq('/api goes to this checkout\'s server', server.proxy['/api'].target, 'http://127.0.0.1:4321');
        eq('…and so does the manifest', server.proxy['/manifest.webmanifest'].target, 'http://127.0.0.1:4321');
        check('/api keeps the browser\'s Host (the origin guard reads it)', server.proxy['/api'].changeOrigin === false);
        const plain = await load({ PORT: '', VITE_PORT: '' });
        eq('a plain checkout is 5173 → 3001, as before', [plain.port, plain.proxy['/api'].target], [5173, 'http://127.0.0.1:3001']);
        check('…and its default page port may move, as Vite\'s always has (another project on 5173 is not an error)', plain.strictPort === false);
        const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
        check('npm run dev stops the page when the server cannot start (no page proxying to someone else\'s server)',
            /concurrently\s+--kill-others-on-fail\b/.test(pkg.scripts.dev), pkg.scripts.dev);
    }

    // ========================================================================
    section('3. the setup, on a scratch repository');
    {
        const main = join(scratch, 'main');
        mkdirSync(main);
        git(main, 'init', '-q');
        writeFileSync(join(main, '.gitignore'), 'NOTES.md\n.notes/\n.env\ntemp/\n.worktreeinclude\n');
        writeFileSync(join(main, 'tracked.txt'), 'from the branch\n');
        git(main, 'add', '.');
        git(main, 'commit', '-q', '-m', 'init');
        writeFileSync(join(main, 'NOTES.md'), 'local notes\n');
        mkdirSync(join(main, '.notes'));
        writeFileSync(join(main, '.notes', 'a.md'), 'a\n');
        const mainEnv = 'DATA_DIR=/the/real/library\n';
        writeFileSync(join(main, '.env'), mainEnv);
        writeFileSync(join(main, '.worktreeinclude'), '# comment\n\nNOTES.md\n.notes/\ntracked.txt\nmissing.md\n../escape\n/abs/path\nC:/x\n.env\n');
        const w1 = join(scratch, 'w1'), w2 = join(scratch, 'w2');
        git(main, 'worktree', 'add', '-q', '-b', 'one', w1);
        git(main, 'worktree', 'add', '-q', '-b', 'two', w2);
        writeFileSync(join(w1, 'tracked.txt'), 'edited on the branch\n');

        let refused = null;
        try { await setup.setupWorktree({ root: main, installDeps: false, isFree: () => true }); } catch (e) { refused = e.message; }
        check('the main checkout is refused', /not a linked git worktree/.test(refused || ''), String(refused));
        eq('…and its .env is untouched', readFileSync(join(main, '.env'), 'utf8'), mainEnv);

        const r1 = await setup.setupWorktree({ root: w1, installDeps: false, isFree: () => true });
        eq('the main checkout is found from the worktree', resolve(r1.mainRoot), resolve(main));
        eq('copied: what is listed AND ignored', r1.copies.copied, ['NOTES.md', '.notes']);
        eq('…the file arrives', readFileSync(join(w1, '.notes', 'a.md'), 'utf8'), 'a\n');
        check('a tracked file is never copied over the branch\'s own',
            readFileSync(join(w1, 'tracked.txt'), 'utf8') === 'edited on the branch\n' && r1.copies.skipped.some(s => s.startsWith('tracked.txt')));
        eq('a path out of the checkout, absolute or with a drive, is refused', r1.copies.refused.slice(0, 3), ['../escape', '/abs/path', 'C:/x']);
        // The main checkout's .env is ignored there, so a list naming it would
        // pass every other test — and hand the worktree the REAL library.
        check('a listed .env is never copied', r1.copies.refused.some(s => s.startsWith('.env ')) && !r1.copies.copied.includes('.env'),
            JSON.stringify(r1.copies));
        check('…nor are .env.local, a nested .env or .certs',
            ['.env.local', 'config/.env', '.certs', '.certs/key.pem'].every(setup.neverCopied) && !setup.neverCopied('.envrc-notes/x.md'));
        const env1 = readFileSync(join(w1, '.env'), 'utf8');
        check('the .env says who wrote it', setup.isManagedEnv(env1));
        eq('its ports are the path\'s', [r1.env.api, r1.env.web], Object.values(ports.portsForOffset(ports.worktreePortOffset(w1))));
        eq('the two halves read the same pair from it', ports.devPorts({ root: w1, env: {} }), { api: r1.env.api, web: r1.env.web, webChosen: true });
        const dataDir = parseEnv(env1).DATA_DIR;
        check('its library is a scratch folder inside the worktree',
            resolve(dataDir).toLowerCase().startsWith(resolve(w1).toLowerCase() + (process.platform === 'win32' ? '\\' : '/')), dataDir);
        check('…not the main checkout\'s', !env1.includes('/the/real/library'));

        const taken = new Set([r1.env.api, r1.env.web]);
        const r2 = await setup.setupWorktree({ root: w2, installDeps: false, isFree: (p) => !taken.has(p) });
        check('a second worktree gets a different pair, even when its path would land on the first one\'s',
            r2.env.api !== r1.env.api && r2.env.web !== r1.env.web && !taken.has(r2.env.api) && !taken.has(r2.env.web),
            `${r1.env.api}/${r1.env.web} vs ${r2.env.api}/${r2.env.web}`);

        const again = await setup.setupWorktree({ root: w1, installDeps: false, isFree: () => false });
        check('a re-run keeps its .env (a running dev server holds those ports)',
            readFileSync(join(w1, '.env'), 'utf8') === env1 && !again.env.written && again.env.api === r1.env.api);
        writeFileSync(join(w2, '.env'), 'PORT=9999\n');
        await setup.setupWorktree({ root: w2, installDeps: false, refresh: true, isFree: () => true });
        eq('a hand-written .env is never rewritten, not even with --refresh', readFileSync(join(w2, '.env'), 'utf8'), 'PORT=9999\n');

        writeFileSync(join(w1, '.env'), `${env1}# my own\nAI_BASE_URL=http://127.0.0.1:9\n`);
        const moved = new Set([r1.env.api, r1.env.web]);
        const refreshed = await setup.setupWorktree({ root: w1, installDeps: false, refresh: true, isFree: (p) => !moved.has(p) });
        const env1b = readFileSync(join(w1, '.env'), 'utf8');
        check('--refresh picks new ports and keeps every line added below the generated ones',
            refreshed.env.written && refreshed.env.api !== r1.env.api && env1b.includes('# my own\nAI_BASE_URL=http://127.0.0.1:9')
            && (env1b.match(/^PORT=/gm) || []).length === 1, env1b);

        // An unquoted `#` starts a comment for `node --env-file`, so a folder
        // named "C# work" would have cut DATA_DIR short — onto some other folder.
        const hashDir = 'D:/C# work/wt/temp/dev-library';
        eq('a data folder with a # in its path reads back whole', parseEnv(setup.envFileFor({ api: 1, web: 2, dataDir: hashDir })).DATA_DIR, hashDir);

        // A bare repository's worktree has no checkout beside the shared .git to
        // copy from; reading the folder ABOVE `repo.git` as one is wrong.
        const bare = join(scratch, 'bare.git');
        git(scratch, 'clone', '-q', '--bare', main, bare);
        const wb = join(scratch, 'wb');
        git(bare, 'worktree', 'add', '-q', '-b', 'b1', wb, 'main');
        eq('a bare repository has no main checkout', setup.mainCheckoutOf(wb), null);
        eq('…a normal worktree finds its own', resolve(setup.mainCheckoutOf(w2)), resolve(main));

        // npm ci empties node_modules first; through a junction that is another
        // checkout's packages. The link points at a scratch folder with a
        // sentinel, so even a broken guard deletes nothing that matters.
        const target = join(scratch, 'linked-packages');
        mkdirSync(target);
        writeFileSync(join(target, 'sentinel'), 'x');
        symlinkSync(target, join(w1, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
        const deps = setup.install(w1);
        check('npm ci never runs over a node_modules that is a link', deps.ran === false && existsSync(join(target, 'sentinel')), JSON.stringify(deps));
        rmSync(join(w1, 'node_modules'), { force: true, recursive: false });
        check('…and the folder it points at survives the cleanup', existsSync(join(target, 'sentinel')));

        // The COMMAND, as T3 Code and the hand-off script run it: `node
        // tools/worktree-setup.mjs` from inside the worktree. T3's worktree folder
        // can be a junction, and a module's URL is its REAL path, so the script's
        // "am I being run?" test compared two spellings of one file and exited 0
        // having done nothing — two threads were launched with no install, no .env
        // and no notes on 7 Oct. A run that does nothing must fail here.
        for (const dir of [w1, main]) {
            mkdirSync(join(dir, 'tools'), { recursive: true });
            for (const f of ['worktree-setup.mjs', 'dev-ports.mjs']) {
                writeFileSync(join(dir, 'tools', f), readFileSync(join(repoRoot, 'tools', f)));
            }
        }
        const link = join(scratch, 'w1-through-a-link');
        symlinkSync(w1, link, process.platform === 'win32' ? 'junction' : 'dir');
        const cli = (cwd) => spawnSync(process.execPath, ['tools/worktree-setup.mjs', '--no-install'], { cwd, encoding: 'utf8' });
        const viaLink = cli(link);
        check('run through a junction, the command does the setup and says so',
            viaLink.status === 0 && /^worktree\s/m.test(viaLink.stdout) && /^ports\s+api \d+ · page \d+/m.test(viaLink.stdout),
            `exit ${viaLink.status}, stdout ${JSON.stringify(viaLink.stdout.slice(0, 120))}`);
        const inMain = cli(main);
        check('run in the main checkout, the command fails out loud', inMain.status === 1 && /not a linked git worktree/.test(inMain.stderr),
            `exit ${inMain.status}, stderr ${JSON.stringify(inMain.stderr.slice(0, 120))}`);
        rmSync(link, { force: true, recursive: false });
    }
    {
        const held = createServer();
        await new Promise(r => held.listen(0, '127.0.0.1', r));
        const port = held.address().port;
        check('a port someone listens on is not free', !(await setup.portIsFree(port)), String(port));
        await new Promise(r => held.close(r));
        check('…and is once they stop', await setup.portIsFree(port), String(port));
    }

    // ========================================================================
    section('4. t3.json');
    {
        const t3 = JSON.parse(readFileSync(join(repoRoot, 't3.json'), 'utf8'));
        const setups = (t3.scripts || []).filter(s => s.runOnWorktreeCreate);
        eq('exactly one script runs when T3 Code makes a worktree', setups.length, 1);
        eq('…and it is the setup', setups[0]?.command, 'node tools/worktree-setup.mjs');
        check('…holding the agent until the packages are there', setups[0]?.async === false);
        const icons = ['play', 'test', 'lint', 'configure', 'build', 'debug'];
        check('every icon is one T3 Code knows', t3.scripts.every(s => s.icon === undefined || icons.includes(s.icon)));
        check('the setup script exists where the command says', existsSync(join(repoRoot, 'tools', 'worktree-setup.mjs')));
    }
} finally {
    rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
