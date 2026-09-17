// tools/version-gates.mjs — the release plumbing: version identity, the update
// check, the pre-migration snapshot, and the issue forms the app links to.
//
// Run:  node tools/version-gates.mjs
//
// Why these particular things are asserted rather than eyeballed:
//
//  * VERSION COMPARISON decides whether an install is told it is out of date.
//    Get it wrong in one direction and nobody ever hears about a release; wrong
//    in the other and every install nags forever. `0.10.0 > 0.9.0` is the
//    classic, and a string compare gets it backwards.
//
//  * A FAILED CHECK MUST NOT READ AS "UP TO DATE". Every model-dependent gate in
//    this project already fails toward doing less; the same rule applies to a
//    network answer that never arrived. `available` may only be true when a
//    newer version was actually seen.
//
//  * THE PACKED-REFS BRANCH of the commit reader fires on a fresh `git clone`
//    and on nothing else — never on a development machine, so it is exactly the
//    code that would ship broken. Driven here against a synthetic `.git`.
//
//  * THE PRE-MIGRATION SNAPSHOT is the only thing standing between a bad release
//    and somebody's library. Asserted against a real scratch database: once per
//    version change, never on a fresh install, never twice for the same upgrade.
//
//  * THE ISSUE FORMS are addressed by filename and field id from inside the app
//    (src/utils/report.ts). A renamed field does not error — it silently drops
//    the diagnostics out of every report filed through the button, which is the
//    whole reason the button exists.
//
//  * THE DOCKERFILE'S line continuations. An inline `#` is not a comment there,
//    and one swallowed the `\` on an ENV line, leaving the image unable to build
//    at all. Nothing in CI built the image, so nothing caught it.
//
// No model, no network, no dependency on the learner's own library.

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const scratch = mkdtempSync(join(tmpdir(), 'version-gates-'));

let pass = 0, fail = 0;
const check = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    ok ? pass++ : fail++;
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};
const ok = (name, cond, detail = '') => check(name + (detail ? ` — ${detail}` : ''), !!cond, true);

// A generated file that is missing is a FAILED ASSERTION, not a crash: the rest
// of the suite still has something to say, and the summary stays honest. Memoized
// so a file read twice reports its absence once.
const REGEN = {
    'CHANGELOG.md': 'write the section by hand — see "Releasing" in CONTRIBUTING.md',
};
const generated = new Map();
const readGenerated = (rel) => {
    if (!generated.has(rel)) {
        const p = join(repoRoot, rel);
        if (existsSync(p)) generated.set(rel, readFileSync(p, 'utf8'));
        else {
            ok(`${rel} exists`, false, `regenerate it with: ${REGEN[rel]}`);
            generated.set(rel, null);
        }
    }
    return generated.get(rel);
};
const git = (...args) => spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });

const B = new URL('../server/', import.meta.url).href;
const {
    compareVersions, updateStatus, repoSlug, updateCommand, deployment,
    fetchLatestRelease, readGitCommit, appVersion, REPO_URL,
} = await import(B + 'version.js');

// ---------------------------------------------------------------------------
// 1. Version ordering
// ---------------------------------------------------------------------------
console.log('\n--- compareVersions ---');

const newer = (a, b) => compareVersions(a, b) > 0;

check('0.9.1 is newer than 0.9.0', newer('0.9.1', '0.9.0'), true);
check('0.9.0 is not newer than 0.9.1', newer('0.9.0', '0.9.1'), false);
check('equal versions are neither', compareVersions('0.9.0', '0.9.0'), 0);
// The classic: a string compare says "0.10.0" < "0.9.0" because '1' < '9'.
check('0.10.0 is newer than 0.9.0 (numeric, not lexical)', newer('0.10.0', '0.9.0'), true);
check('1.0.0 is newer than 0.99.99', newer('1.0.0', '0.99.99'), true);
check('0.10.0 vs 0.10.0 with a v prefix is equal', compareVersions('v0.10.0', '0.10.0'), 0);
check('a leading v on both sides is ignored', compareVersions('v1.2.3', 'v1.2.3'), 0);
check('minor beats patch', newer('0.10.0', '0.9.99'), true);

// Prereleases: this is the whole stable/unstable mechanism, so it has to hold.
check('0.9.0 release beats its own rc', newer('0.9.0', '0.9.0-rc.1'), true);
check('0.9.0-rc.1 does not beat 0.9.0', newer('0.9.0-rc.1', '0.9.0'), false);
check('0.9.0-rc.2 beats 0.9.0-rc.1', newer('0.9.0-rc.2', '0.9.0-rc.1'), true);
check('a prerelease of a HIGHER version still beats the lower release',
    newer('0.10.0-rc.1', '0.9.0'), true);

// Anything unreadable must be inert, never "newer" — an install told it is
// behind by a parse accident nags forever and nobody can see why.
check('garbage is never newer', compareVersions('banana', '0.9.0'), 0);
check('an empty string is never newer', compareVersions('', '0.9.0'), 0);
check('null is never newer', compareVersions(null, '0.9.0'), 0);
check('a two-part version is never newer', compareVersions('1.2', '0.9.0'), 0);
check('nothing is newer than garbage', compareVersions('0.9.0', 'banana'), 0);

// ---------------------------------------------------------------------------
// 2. The verdict the banner reads
// ---------------------------------------------------------------------------
console.log('\n--- updateStatus: available may only be true when it is TRUE ---');

const rel = (v) => ({ version: v, tag: `v${v}`, name: null, url: 'https://x/y', publishedAt: null });

check('never checked → not available',
    updateStatus({ current: '0.9.0', latest: null, checkedAt: null, enabled: false }).available, false);
check('checked, no release published → not available',
    updateStatus({ current: '0.9.0', latest: null, checkedAt: 'now', enabled: true }).available, false);
check('same version → not available',
    updateStatus({ current: '0.9.0', latest: rel('0.9.0'), checkedAt: 'now', enabled: true }).available, false);
check('older release on the server → not available',
    updateStatus({ current: '0.9.1', latest: rel('0.9.0'), checkedAt: 'now', enabled: true }).available, false);
check('newer release → available',
    updateStatus({ current: '0.9.0', latest: rel('0.9.1'), checkedAt: 'now', enabled: true }).available, true);
// A failed check must not erase what was already known, and must not invent an
// answer either — the same rule the vision probe learned the hard way.
check('an error alongside a known newer release still reports it',
    updateStatus({ current: '0.9.0', latest: rel('0.9.1'), checkedAt: 'y', enabled: true, error: 'Timed out' }).available, true);
check('an error with nothing known reports nothing available',
    updateStatus({ current: '0.9.0', latest: null, checkedAt: null, enabled: true, error: 'Timed out' }).available, false);
check('the error is carried through for the UI to say so',
    updateStatus({ current: '0.9.0', latest: null, checkedAt: null, enabled: true, error: 'Timed out' }).error, 'Timed out');
check('a prerelease on the server does not make a release look old',
    updateStatus({ current: '0.9.0', latest: rel('0.9.0-rc.3'), checkedAt: 'now', enabled: true }).available, false);
check('enabled is reported as a boolean, not the raw setting',
    updateStatus({ current: '0.9.0', latest: null, checkedAt: null, enabled: 'on' }).enabled, true);

// ---------------------------------------------------------------------------
// 3. Repository identity and the update command
// ---------------------------------------------------------------------------
console.log('\n--- repo slug and update command ---');

check('slug is derived from the source URL', repoSlug(), 'ValeraZSD/terramentor');
ok('REPO_URL is https', /^https:\/\//.test(REPO_URL));
check('docker installs get the compose command',
    updateCommand('docker'), 'docker compose pull && docker compose up -d');
check('git checkouts get a pull, install and build',
    updateCommand('git'), 'git pull && npm install && npm run build');
// No command is an honest answer for an unpacked copy: there is no command that
// would work, and printing a git one to someone with no repository is worse.
check('an unpacked copy gets no command', updateCommand('source'), null);
check('a desktop build gets no command either — it is replaced by the next download', updateCommand('desktop'), null);
ok('deployment() answers one of the four kinds', ['docker', 'git', 'source', 'desktop'].includes(deployment()));

const me = appVersion();
ok('appVersion reports a semver-shaped version', /^\d+\.\d+\.\d+/.test(me.version), me.version);
ok('appVersion reports the Node it runs on', /^\d+\./.test(me.node));
check('appVersion carries the repo URL so the client needs no second copy', me.repoUrl, REPO_URL);
ok('appVersion never invents a commit', me.commit === null || /^[0-9a-f]{40}$/.test(me.commit));
check('the short commit is the first 7 of the long one',
    me.commit ? me.commitShort === me.commit.slice(0, 7) : me.commitShort === null, true);

// ---------------------------------------------------------------------------
// 4. Reading the commit out of .git, including the branch that only a fresh
//    clone takes
// ---------------------------------------------------------------------------
console.log('\n--- readGitCommit against synthetic repositories ---');

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const OTHER = '00112233445566778899aabbccddeeff00112233';

const mkGit = (name, files) => {
    const root = join(scratch, name);
    mkdirSync(join(root, '.git'), { recursive: true });
    for (const [rel, body] of Object.entries(files)) {
        const p = join(root, '.git', rel);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, body);
    }
    return root;
};

// GIT_SHA (the container case) wins over everything, so it must be clear for
// these — otherwise a CI runner that sets it would make every case below pass
// for the wrong reason.
const savedSha = process.env.GIT_SHA;
delete process.env.GIT_SHA;

check('a loose ref is read',
    readGitCommit(mkGit('loose', { HEAD: 'ref: refs/heads/main\n', 'refs/heads/main': `${SHA}\n` })), SHA);
check('a detached HEAD is read straight off HEAD',
    readGitCommit(mkGit('detached', { HEAD: `${SHA}\n` })), SHA);
// The one that only happens on a fresh clone.
check('a packed ref is found when no loose ref exists',
    readGitCommit(mkGit('packed', {
        HEAD: 'ref: refs/heads/main\n',
        'packed-refs': `# pack-refs with: peeled fully-peeled sorted \n${OTHER} refs/heads/other\n${SHA} refs/heads/main\n`,
    })), SHA);
check('a loose ref wins over a stale packed one',
    readGitCommit(mkGit('both', {
        HEAD: 'ref: refs/heads/main\n',
        'refs/heads/main': `${SHA}\n`,
        'packed-refs': `${OTHER} refs/heads/main\n`,
    })), SHA);
check('a packed file with no matching ref returns null, not another branch',
    readGitCommit(mkGit('nomatch', {
        HEAD: 'ref: refs/heads/main\n',
        'packed-refs': `${OTHER} refs/heads/somethingelse\n`,
    })), null);
check('no .git at all returns null', readGitCommit(join(scratch, 'nothing-here')), null);
check('an unreadable .git returns null rather than throwing',
    readGitCommit(mkGit('broken', {})), null);

process.env.GIT_SHA = SHA;
check('GIT_SHA overrides the filesystem (the container case)',
    readGitCommit(join(scratch, 'nothing-here')), SHA);
if (savedSha === undefined) delete process.env.GIT_SHA; else process.env.GIT_SHA = savedSha;

// ---------------------------------------------------------------------------
// 5. The network call, against a stub — every failure shape
// ---------------------------------------------------------------------------
console.log('\n--- fetchLatestRelease (stubbed fetch, no network) ---');

const stub = (impl) => fetchLatestRelease(impl);
const jsonRes = (status, body) => async () => ({
    status, ok: status >= 200 && status < 300, json: async () => body,
});

let r = await stub(jsonRes(200, { tag_name: 'v0.9.1', name: 'Release', html_url: 'https://h/1', published_at: '2026-09-01T00:00:00Z' }));
check('a normal release parses', r.ok && r.latest.version, '0.9.1');
check('the v prefix is stripped from the version but kept on the tag',
    r.ok && r.latest.tag, 'v0.9.1');
check('the release URL is carried through', r.ok && r.latest.url, 'https://h/1');

// 404 is an ANSWER — no release has been published yet. Treating it as a failure
// would retry it every ten minutes for the life of the process.
r = await stub(jsonRes(404, {}));
check('404 is "no release yet", not a failure', [r.ok, r.latest], [true, null]);

r = await stub(jsonRes(500, {}));
check('a 5xx is a failure', r.ok, false);
ok('a 5xx failure names the status', /500/.test(r.error || ''), r.error);

r = await stub(jsonRes(403, {}));
check('a rate limit is a failure, not an answer', r.ok, false);

r = await stub(jsonRes(200, { note: 'no tag_name here' }));
check('a response with no tag is a failure, not a null release', r.ok, false);

r = await stub(async () => { throw new Error('fetch failed'); });
check('a transport error is caught, never thrown', r.ok, false);
check('a transport error keeps its message', r.error, 'fetch failed');

r = await stub(async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; });
check('a timeout says so in words', r.error, 'Timed out');

// The header GitHub requires, and the assertion that nothing else is sent: no
// install id, no machine name, nothing that could count one user across days.
let seenInit = null;
await stub(async (_url, init) => { seenInit = init; return { status: 404, ok: false, json: async () => ({}) }; });
ok('a User-Agent is sent (GitHub rejects requests without one)',
    /^Terramentor\//.test(seenInit?.headers?.['User-Agent'] || ''));
check('the request carries no body', seenInit?.body, undefined);
check('the request sends exactly two headers and no identifiers',
    Object.keys(seenInit?.headers || {}).sort(), ['Accept', 'User-Agent']);

let seenUrl = null;
await stub(async (url) => { seenUrl = url; return { status: 404, ok: false, json: async () => ({}) }; });
check('it asks for /releases/latest, which excludes prereleases',
    seenUrl, 'https://api.github.com/repos/ValeraZSD/terramentor/releases/latest');
ok('it talks to api.github.com and nowhere else', seenUrl.startsWith('https://api.github.com/'));

// ---------------------------------------------------------------------------
// 6. The pre-migration snapshot, against a real database
// ---------------------------------------------------------------------------
console.log('\n--- pre-migration snapshot ---');

const dbDir = join(scratch, 'dbtest');
mkdirSync(dbDir, { recursive: true });
const dbPath = join(dbDir, 'lib.db');
const openDb = () => spawnSync(process.execPath, ['-e',
    "import('./server/database.js').then(m => { m.default.close(); });"],
    {
        cwd: repoRoot, encoding: 'utf8',
        env: { ...process.env, DB_PATH: dbPath, VAULT_ROOT: join(dbDir, 'vault') },
    });
const baks = () => readdirSync(dbDir).filter(f => f.endsWith('.bak')).sort();

openDb();
check('a brand-new database is not snapshotted (nothing to migrate from)', baks(), []);
openDb();
check('a restart at the same version does not snapshot again', baks(), []);

// Pretend the library was last opened by an older build.
const Db = require(join(repoRoot, 'node_modules', 'better-sqlite3'));
let h = new Db(dbPath);
h.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('app_version','0.8.0')").run();
h.close();

openDb();
check('a version change snapshots exactly once', baks().length, 1);
ok('the snapshot is named for the version it is a snapshot OF', baks()[0].includes('pre-0.8.0'), baks()[0]);

// A snapshot that cannot be opened is not a backup, it is a file.
h = new Db(join(dbDir, baks()[0]), { readonly: true });
const tables = h.prepare("SELECT count(*) c FROM sqlite_master WHERE type='table'").get().c;
const stamped = h.prepare("SELECT value FROM settings WHERE key='app_version'").get()?.value;
h.close();
ok('the snapshot is a readable database with the schema in it', tables > 20, `${tables} tables`);
check('the snapshot holds the PRE-upgrade state', stamped, '0.8.0');

openDb();
check('the stamp was rewritten, so the upgrade does not re-snapshot', baks().length, 1);

h = new Db(dbPath, { readonly: true });
check('the live database now records the current version',
    h.prepare("SELECT value FROM settings WHERE key='app_version'").get()?.value,
    JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version);
h.close();

// ---------------------------------------------------------------------------
// 7. The issue forms the app links to
// ---------------------------------------------------------------------------
console.log('\n--- issue forms ---');

const tplDir = join(repoRoot, '.github', 'ISSUE_TEMPLATE');
const reportSrc = readFileSync(join(repoRoot, 'src', 'utils', 'report.ts'), 'utf8');

// Every filename report.ts names must exist. A typo here is a 404 for a user who
// pressed "Report a problem" and has no idea what went wrong.
const named = [...reportSrc.matchAll(/'([a-z_]+\.yml)'/g)].map(m => m[1]);
ok('report.ts names three templates', named.length === 3, named.join(', '));
for (const f of named) {
    ok(`the form ${f} exists`, existsSync(join(tplDir, f)));
}

const forms = readdirSync(tplDir).filter(f => f.endsWith('.yml') && f !== 'config.yml');
for (const f of forms) {
    const y = readFileSync(join(tplDir, f), 'utf8');
    ok(`${f} declares a name`, /^name:\s*\S/m.test(y));
    ok(`${f} declares a description`, /^description:\s*\S/m.test(y));
    ok(`${f} declares a body`, /^body:/m.test(y));
    ok(`${f} labels its issues`, /^labels:/m.test(y));
}

// THE DRIFT THAT FAILS SILENTLY: the app pre-fills a field called `environment`
// through a URL parameter. GitHub ignores a parameter with no matching field, so
// renaming it does not error — it just quietly strips the version, the commit
// and the model out of every report filed through the button.
const prefilled = ['bug_report.yml', 'ai_content.yml'];
for (const f of prefilled) {
    ok(`${f} still has the id "environment" the app pre-fills`,
        /^\s+id:\s*environment\s*$/m.test(readFileSync(join(tplDir, f), 'utf8')));
}
ok('report.ts pre-fills a parameter named "environment"',
    /params\.set\('environment'/.test(reportSrc) || /environment:/.test(reportSrc));
// An idea is not about a build; sending a machine report with a feature request
// is noise, and its form has no such field.
ok('the idea form deliberately has no environment field',
    !/^\s+id:\s*environment\s*$/m.test(readFileSync(join(tplDir, 'feature_request.yml'), 'utf8')));

const cfg = readFileSync(join(tplDir, 'config.yml'), 'utf8');
ok('blank issues are off, so every report goes through a form',
    /blank_issues_enabled:\s*false/.test(cfg));
ok('config.yml offers somewhere to go for the things that are not issues',
    /contact_links:/.test(cfg));
ok('security reports are routed privately, not into the public tracker',
    /security\/advisories/.test(cfg));

// ---------------------------------------------------------------------------
// 8. The Dockerfile's line continuations
// ---------------------------------------------------------------------------
console.log('\n--- Dockerfile continuation rules ---');

// A `#` is a comment in a Dockerfile ONLY at the start of a line. One placed
// mid-line swallowed the `\` on an ENV continuation, the instruction ended
// early, and the next assignment was parsed as an unknown instruction — the
// image could not build at all, and nothing in CI builds it.
const dockerfile = readFileSync(join(repoRoot, 'Dockerfile'), 'utf8').split(/\r?\n/);
let inContinuation = false;
let inlineComments = 0, danglingContinuations = 0;
for (const line of dockerfile) {
    const isCommentLine = /^\s*#/.test(line);
    const continues = /\\\s*$/.test(line);
    if ((inContinuation || /^[A-Z]+\s/.test(line)) && !isCommentLine) {
        // Strip anything quoted before looking for a `#`, so a legitimate hash
        // inside a string value is not mistaken for a comment.
        const bare = line.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");
        const hash = bare.indexOf('#');
        if (hash > 0 && bare.slice(0, hash).trim()) inlineComments++;
        if (inContinuation && !continues && /^\s*[A-Za-z_][A-Za-z0-9_]*=/.test(line) === false) {
            // an instruction's last line: fine
        }
    }
    if (!isCommentLine) inContinuation = continues;
}
check('no instruction line carries an inline # (it is not a comment there)', inlineComments, 0);

// Directly: every assignment line inside the runtime ENV block but the last must
// end with a backslash.
const envStart = dockerfile.findIndex(l => /^ENV NODE_ENV=production/.test(l));
ok('the runtime ENV block is where it is expected', envStart >= 0);
const envLines = [];
for (let i = envStart; i < dockerfile.length; i++) {
    const l = dockerfile[i];
    if (/^\s*#/.test(l)) continue;
    envLines.push(l);
    if (!/\\\s*$/.test(l)) break;
}
danglingContinuations = envLines.slice(0, -1).filter(l => !/\\\s*$/.test(l)).length;
check('every ENV line but the last continues with a backslash', danglingContinuations, 0);
ok('the ENV block still sets VAULT_ROOT (the line the broken build dropped)',
    envLines.some(l => /VAULT_ROOT=/.test(l)));
ok('the ENV block still sets DB_PATH', envLines.some(l => /DB_PATH=/.test(l)));
ok('the image takes a GIT_SHA build arg, or a container cannot report its commit',
    /^ARG GIT_SHA/m.test(dockerfile.join('\n')));

// ---------------------------------------------------------------------------
// 10. Release bookkeeping
// ---------------------------------------------------------------------------
console.log('\n--- changelog and release workflow ---');

const pkgVersion = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;

// The changelog is meant to be TRACKED: release.yml lifts the release notes
// straight out of it and the README links to it. Ignored, it exists on one
// machine and nowhere else — which is the state that made this suite crash on a
// clean clone.
ok('CHANGELOG.md is not matched by .gitignore', git('check-ignore', '-q', 'CHANGELOG.md').status !== 0,
    'release.yml reads the changelog and the README links to it');

const changelog = readGenerated('CHANGELOG.md');
if (changelog) {
    ok(`CHANGELOG.md has a section for the version in package.json (${pkgVersion})`,
        changelog.includes(`## [${pkgVersion}]`));
}
// The release workflow lifts the notes out by that exact heading shape; a
// changed format ships a release with an empty body.
const workflow = readFileSync(join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8');
ok('the release workflow reads the notes out of CHANGELOG.md', /CHANGELOG\.md/.test(workflow));

// The `notes` step of release.yml, in JavaScript: find `## [version]`, keep
// every non-blank line until the next `## ` heading.
//
// A mirror rather than the real thing because this suite cannot spawn `awk` —
// on Windows it lives inside Git's POSIX toolset and is not on PATH from
// PowerShell, and a gate that skips itself on one platform is how the last
// clean-clone failure survived. So the mirror answers "is there a body", and
// the two assertions under it pin the workflow to a form that cannot silently
// stop finding one: the old expression built a regex out of the version
// (`$0 ~ "^## \\[" v "\\]"`), which gawk read as a character class and matched
// nothing at all, and the missing section produced an empty release body rather
// than the sentence its own comment promised.
const releaseNotes = (text, v) => {
    const lines = text.split('\n');
    const start = lines.findIndex((l) => l.startsWith(`## [${v}]`));
    if (start === -1) return '';
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((l) => l.startsWith('## '));
    return (end === -1 ? rest : rest.slice(0, end)).filter((l) => l.trim()).join('\n');
};
if (changelog) {
    const notes = releaseNotes(changelog, pkgVersion);
    ok(`the release notes for ${pkgVersion} come out non-empty (${notes.length} chars)`, notes.length > 0,
        'the GitHub Release for this tag would have a blank body');
    ok('the release notes stop at the next heading',
        !notes.split('\n').some((l) => l.startsWith('## ')));
}
const notesStep = workflow.slice(workflow.indexOf('- id: notes'));
ok('the release notes are matched literally, never by a regex built from the version',
    notesStep.length > 0 && !/\$0\s*~/.test(notesStep));
ok('a missing changelog section becomes a sentence, not an empty release body',
    /No changelog entry for/.test(notesStep));
ok('the release workflow refuses a tag that disagrees with package.json',
    /package\.json version/.test(workflow));
ok('a prerelease tag is flagged as one, so it never becomes "latest"',
    /prerelease:\s*\$\{\{\s*contains\(github\.ref_name, '-'\)/.test(workflow));
ok('the image and the desktop packages are built before the release is opened', /needs:\s*\[image, desktop\]/.test(workflow));
ok('the desktop packages are attached to the release', /files:\s*release\/\*\.zip/.test(workflow));
ok('nothing is published until the gates pass', /needs:\s*verify/.test(workflow));
// Without this, tools/no-ai-attribution.mjs has no range of commit messages to
// read and passes by looking at nothing: actions/checkout fetches a single
// commit by default.
ok('the release workflow checks out the full history', /fetch-depth:\s*0/.test(workflow));
ok('the gates workflow checks out the full history',
    /fetch-depth:\s*0/.test(readFileSync(join(repoRoot, '.github', 'workflows', 'gates.yml'), 'utf8')));

// Every version the changelog documents must be a real, ordered release.
if (changelog) {
    const documented = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+[^\]]*)\]/gm)].map(m => m[1]);
    ok('the changelog documents at least one version', documented.length > 0, documented.join(', '));
    let ordered = true;
    for (let i = 1; i < documented.length; i++) {
        if (compareVersions(documented[i - 1], documented[i]) <= 0) ordered = false;
    }
    check('changelog versions run newest first', ordered, true);
}

// ---------------------------------------------------------------------------
// 11. The diagnostics block — what a bug report is allowed to carry
// ---------------------------------------------------------------------------
console.log('\n--- report diagnostics (real src/utils/report.ts) ---');

const esbuild = require('esbuild');
const bundled = join(scratch, 'report.mjs');
await esbuild.build({
    // fileURLToPath, never `.pathname`: this repo's path contains a space, which
    // stays percent-encoded in a URL and esbuild cannot resolve it.
    entryPoints: [fileURLToPath(new URL('../src/utils/report.ts', import.meta.url))],
    bundle: true, format: 'esm', platform: 'node', outfile: bundled, logLevel: 'silent',
});
const { diagnostics, diagnosticsBlock, issueUrl } = await import(`file:///${bundled.replace(/\\/g, '/')}`);

const ctx = {
    version: {
        version: '0.9.0', commit: 'a'.repeat(40), commitShort: 'aaaaaaa', builtAt: null,
        node: '22.15.0', platform: 'linux-x64', deployment: 'docker',
        updateCommand: 'docker compose pull', repoUrl: 'https://github.com/o/r',
    },
    aiProvider: 'ollama', aiModel: 'qwen3:8b',
};
const d = diagnostics(ctx);
check('the block names the version', d.Version, '0.9.0');
check('the block names the commit', d.Commit, 'aaaaaaa');
check('the block names how it was installed', d.Install, 'docker');
check('the block names the model, which is the field an AI report turns on', d['AI model'], 'qwen3:8b');

// Absent facts are omitted, never guessed — the same rule `plainCause` follows.
const bare = diagnostics({ version: null, aiProvider: null, aiModel: null });
check('with no version known, no version fields are invented',
    Object.keys(bare).filter(k => ['Version', 'Commit', 'Install', 'Node'].includes(k)), []);
check('with no model configured, no model line is invented', bare['AI model'], undefined);

const block = diagnosticsBlock(ctx);
ok('the block is plain key: value lines', /^Version: 0\.9\.0$/m.test(block));
ok('a failure record is appended when one is offered',
    diagnosticsBlock({ ...ctx, failure: 'HTTP 500' }).includes('HTTP 500'));
ok('an over-long block is truncated rather than producing an unusable URL',
    diagnosticsBlock({ ...ctx, failure: 'x'.repeat(20000) }).length < 7000);

const url = issueUrl('https://github.com/o/r', 'bug', ctx);
ok('the issue URL targets the repo issue composer', url.startsWith('https://github.com/o/r/issues/new?'));
ok('the issue URL selects the bug FORM, not a blank issue', url.includes('template=bug_report.yml'));
// Read the parameter back the way a consumer does. `decodeURIComponent` alone
// is not enough: URLSearchParams encodes a space as `+`, so a naive decode
// yields "Version:+0.9.0" and the assertion fails while the code is correct.
ok('the issue URL carries the environment',
    (new URL(url).searchParams.get('environment') || '').includes('Version: 0.9.0'));
ok('the environment survives the round trip intact',
    (new URL(url).searchParams.get('environment') || '').includes('AI model: qwen3:8b'));
ok('a trailing slash on the repo URL does not double up',
    !issueUrl('https://github.com/o/r/', 'bug', ctx).includes('r//issues'));
ok('the AI-content form is reachable',
    issueUrl('https://github.com/o/r', 'content', ctx).includes('template=ai_content.yml'));
ok('an idea carries no machine report',
    !issueUrl('https://github.com/o/r', 'idea', ctx).includes('environment='));

// The privacy rule, asserted rather than trusted: nothing about what is being
// studied may reach a public issue tracker through this path.
const fields = Object.keys(diagnostics(ctx)).join(' ').toLowerCase();
for (const forbidden of ['project', 'topic', 'note', 'deck', 'path', 'file', 'user', 'name']) {
    ok(`no "${forbidden}" field in the diagnostics block`, !fields.includes(forbidden));
}

// ---------------------------------------------------------------------------

try { rmSync(scratch, { recursive: true, force: true }); } catch { /* Windows may hold the db */ }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
