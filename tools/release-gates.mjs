// tools/release-gates.mjs — the nightly and stable release channels: which
// version a nightly gets, when one is published at all, which commit a stable
// release promotes, and the files an updater will trust (SHA256SUMS and the
// per-release manifest).
//
// Run:  node tools/release-gates.mjs
//
// Why these are asserted rather than trusted to the workflow:
//
//  * A NIGHTLY VERSION THAT SORTS BELOW THE LAST ONE IS NEVER OFFERED. The
//    next nightly after a stable release has to be ABOVE it, and a patch
//    release must not pull nightlies back below what nightly installs run.
//    (How versions compare is tools/update-channel-gates.mjs.)
//
//  * THE SCHEDULE RUNS EVERY HOUR. The gate that turns most of those runs into
//    nothing (no new commits, or under six hours since the last nightly) is
//    the difference between one nightly a day and twenty-four of them.
//
//  * PROMOTION PUBLISHES TO EVERYONE. A stable release made from the wrong
//    commit, at a version the changelog does not describe, or at one that is
//    not newer than the last, cannot be taken back from the installs that
//    already took it.
//
//  * THE MANIFEST IS WHAT A DOWNLOAD IS CHECKED AGAINST. A hash that does not
//    match its file, or a URL that names another file, turns the updater's one
//    safety check into a false alarm or a false pass.
//
// No network: the GitHub API is a stub here, and git runs only in a scratch
// repository this suite builds.

import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(join(tmpdir(), 'release-gates-'));

let pass = 0, fail = 0;
const check = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    ok ? pass++ : fail++;
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};
const ok = (name, cond, detail = '') => check(name + (detail ? ` — ${detail}` : ''), !!cond, true);
const throwsWith = (name, fn, pattern) => {
    let message = null;
    try { fn(); } catch (e) { message = e.message; }
    ok(name, message !== null && pattern.test(message), message ?? 'did not throw');
};

const {
    nightlyBase, nightlyVersion, highestStable, nextMinor, latestNightly, nightlyDecision,
    promotion, assetPlatform, buildManifest, sha256sums, nightlyNotes, checkBuildVersion,
    stampedPackage, releasePlan, releaseBody, draftProblems, NIGHTLY_GAP_MS,
} = await import('./lib/releaseChannel.mjs');

// ---------------------------------------------------------------------------
// 1. Which version a nightly gets
// ---------------------------------------------------------------------------
console.log('\n--- nightly base: the next minor after the newest stable ---');

check('highest stable ignores prereleases and nightlies',
    highestStable(['v1.0.0', 'v1.1.0', 'v1.2.0-rc.1', 'v1.3.0-nightly.20261008.1', 'other']), '1.1.0');
check('highest stable compares numerically', highestStable(['v1.9.0', 'v1.10.0']), '1.10.0');
check('no stable tag at all', highestStable(['v1.0.0-nightly.20261008.1']), null);
check('next minor resets the patch', nextMinor('1.2.3'), '1.3.0');

// Today: v1.1.0 was tagged and never published, package.json says 1.1.0.
check('after a stable tag, nightlies preview the next minor',
    nightlyBase({ packageVersion: '1.1.0', tags: ['v1.0.0', 'v1.1.0'] }), '1.2.0');
// A release PR has bumped package.json, and its tag is not cut yet.
check('a release commit not yet tagged previews itself',
    nightlyBase({ packageVersion: '1.2.0', tags: ['v1.0.0', 'v1.1.0'] }), '1.2.0');
check('a major bump in package.json is not pulled back to the next minor',
    nightlyBase({ packageVersion: '2.0.0', tags: ['v1.3.0'] }), '2.0.0');
// A patch release in flight: nightlies already preview 1.4.0, and must not
// drop below what nightly installs already run.
check('a patch release commit keeps nightlies on the next minor',
    nightlyBase({ packageVersion: '1.3.1', tags: ['v1.3.0'] }), '1.4.0');
check('no stable tag yet: package.json is the base',
    nightlyBase({ packageVersion: '0.4.0', tags: [] }), '0.4.0');
check('a prerelease package.json contributes its numbers only',
    nightlyBase({ packageVersion: '1.2.0-rc.1', tags: ['v1.1.0'] }), '1.2.0');

console.log('\n--- nightly run number: per day, never reused ---');
check('the first nightly of a day is .1',
    nightlyVersion({ base: '1.2.0', date: '20261008', tags: ['v1.2.0-nightly.20261007.3'] }), '1.2.0-nightly.20261008.1');
check('the next one that day counts up',
    nightlyVersion({ base: '1.2.0', date: '20261008', tags: ['v1.2.0-nightly.20261008.1', 'v1.2.0-nightly.20261008.2'] }),
    '1.2.0-nightly.20261008.3');
check('the count is per day across bases, so a version is never reused',
    nightlyVersion({ base: '1.3.0', date: '20261008', tags: ['v1.2.0-nightly.20261008.2'] }), '1.3.0-nightly.20261008.3');
check('the count follows the highest, not the number of tags',
    nightlyVersion({ base: '1.2.0', date: '20261008', tags: ['v1.2.0-nightly.20261008.9'] }), '1.2.0-nightly.20261008.10');

// ---------------------------------------------------------------------------
// 2. When the schedule publishes
// ---------------------------------------------------------------------------
console.log('\n--- the six-hour, new-commits gate ---');

const HOUR = 3600 * 1000;
const T0 = Date.parse('2026-10-08T12:00:00Z');
const last = { tag: 'v1.2.0-nightly.20261008.1', sha: 'a'.repeat(40), publishedAt: new Date(T0).toISOString() };

check('six hours is the gap', NIGHTLY_GAP_MS, 6 * HOUR);
check('no nightly yet: publish',
    nightlyDecision({ last: null, headSha: 'b'.repeat(40), lastIsAncestor: false, now: T0 }).publish, true);
check('the same commit as the last nightly: skip, however long ago',
    nightlyDecision({ last, headSha: last.sha, lastIsAncestor: true, now: T0 + 48 * HOUR }).publish, false);
check('new commits but only five hours: skip',
    nightlyDecision({ last, headSha: 'b'.repeat(40), lastIsAncestor: true, now: T0 + 5 * HOUR }).publish, false);
check('new commits and six hours: publish',
    nightlyDecision({ last, headSha: 'b'.repeat(40), lastIsAncestor: true, now: T0 + 6 * HOUR }).publish, true);
check('a manual run skips the wait',
    nightlyDecision({ last, headSha: 'b'.repeat(40), lastIsAncestor: true, now: T0 + HOUR, force: true }).publish, true);
check('…but never republishes an unchanged commit',
    nightlyDecision({ last, headSha: last.sha, lastIsAncestor: true, now: T0 + HOUR, force: true }).publish, false);
const rewritten = nightlyDecision({ last, headSha: 'b'.repeat(40), lastIsAncestor: false, now: T0 + 7 * HOUR });
check('main not ahead of the last nightly (history rewritten): no publish, and the run fails loudly',
    [rewritten.publish, rewritten.stuck], [false, true]);
const failed = 'https://github.com/o/r/actions/runs/1 at 2026-10-08T19:23:00Z';
check('a commit whose nightly already failed is not retried by the schedule',
    nightlyDecision({ last, headSha: 'b'.repeat(40), lastIsAncestor: true, now: T0 + 8 * HOUR, failedOnHead: failed }).publish, false);
check('…nor when it was the very first nightly that failed',
    nightlyDecision({ last: null, headSha: 'b'.repeat(40), lastIsAncestor: false, now: T0, failedOnHead: failed }).publish, false);
check('…but a run by hand retries it',
    nightlyDecision({ last, headSha: 'b'.repeat(40), lastIsAncestor: true, now: T0 + 8 * HOUR, failedOnHead: failed, force: true }).publish, true);
ok('a skip says when the next one is due',
    /2026-10-08T18:00/.test(nightlyDecision({ last, headSha: 'b'.repeat(40), lastIsAncestor: true, now: T0 + 2 * HOUR }).reason));

console.log('\n--- the latest nightly, from the releases API ---');
const releases = [
    { tag_name: 'v1.2.0-nightly.20261008.2', draft: true, published_at: null, prerelease: true },
    { tag_name: 'v1.2.0-nightly.20261008.1', draft: false, published_at: '2026-10-08T06:00:00Z', prerelease: true },
    { tag_name: 'v1.1.0', draft: false, published_at: '2026-10-08T09:00:00Z', prerelease: false },
    { tag_name: 'v1.2.0-nightly.20261007.4', draft: false, published_at: '2026-10-07T20:00:00Z', prerelease: true },
];
check('the newest PUBLISHED nightly, not a draft and not a stable release',
    latestNightly(releases)?.tag, 'v1.2.0-nightly.20261008.1');
check('none published', latestNightly([releases[0], releases[2]]), null);

// ---------------------------------------------------------------------------
// 3. Promoting the latest nightly to stable
// ---------------------------------------------------------------------------
console.log('\n--- stable from nightly ---');

const nightly = { tag: 'v1.2.0-nightly.20261008.1', sha: 'c'.repeat(40) };
const changelog = '# Changelog\n\n## [1.2.0] - 2026-10-08\n\n**Poster.** It fits.\n\n## [1.0.0] - 2026-10-02\n';
const good = { nightly, onMain: true, packageVersion: '1.2.0', tags: ['v1.0.0', 'v1.1.0', nightly.tag], changelog };

check('the release commit\'s nightly promotes to its package.json version',
    promotion(good), { version: '1.2.0', tag: 'v1.2.0', sha: nightly.sha, from: nightly.tag });
throwsWith('no nightly: refuse', () => promotion({ ...good, nightly: null }), /No nightly/);
throwsWith('a nightly commit that is not on main: refuse',
    () => promotion({ ...good, onMain: false }), /not on main/);
throwsWith('package.json not newer than the latest stable: refuse, and say what to do',
    () => promotion({ ...good, tags: ['v1.2.0'] }), /not newer than the latest stable 1\.2\.0.*release/s);
throwsWith('a prerelease package.json is not a stable version',
    () => promotion({ ...good, packageVersion: '1.2.0-rc.1' }), /plain/);
throwsWith('a changelog without the section: refuse',
    () => promotion({ ...good, changelog: '## [1.0.0]\n' }), /CHANGELOG\.md.*1\.2\.0/);
throwsWith('the stable tag already exists: refuse',
    () => promotion({ ...good, tags: [...good.tags, 'v1.2.0'] }), /not newer|exists/);

console.log('\n--- what release.yml builds, from how it started ---');

const SHA40 = 'f'.repeat(40);
const TAGS = ['v1.0.0', 'v1.1.0', 'v1.2.0-nightly.20261008.1'];
const fromTag = (refName, tags = [...TAGS, refName]) => releasePlan({ event: 'push', refName, sha: SHA40, tags, onMain: true });
check('a pushed plain tag: stable, published, Latest, moving latest and its minor line',
    (({ channel, version, publish, prerelease, latest, movingTags }) => ({ channel, version, publish, prerelease, latest, movingTags }))(fromTag('v1.2.0')),
    { channel: 'stable', version: '1.2.0', publish: true, prerelease: false, latest: true, movingTags: ['latest', '1.2'] });
check('a pushed suffixed tag: a prerelease, never Latest, moves no image tag',
    [fromTag('v1.3.0-rc.1').prerelease, fromTag('v1.3.0-rc.1').latest, fromTag('v1.3.0-rc.1').movingTags], [true, false, []]);
const hotfix = fromTag('v1.0.1', ['v1.0.0', 'v1.1.0', 'v1.0.1']);
check('a hotfix on an older line is published, but is not Latest and moves no image tag',
    [hotfix.publish, hotfix.latest, hotfix.movingTags], [true, false, []]);
check('re-running the newest stable tag keeps it Latest', fromTag('v1.1.0').latest, true);
const called = releasePlan({ event: 'schedule', refName: 'main', sha: 'e'.repeat(40), tags: TAGS, onMain: true,
    input: { channel: 'nightly', version: '1.3.0-nightly.20261008.1', ref: SHA40, previous: 'v1.2.0' } });
check('called for a nightly: that version, that commit (not the run\'s), never Latest, moves `nightly`',
    [called.version, called.ref, called.prerelease, called.latest, called.previous, called.movingTags],
    ['1.3.0-nightly.20261008.1', SHA40, true, false, 'v1.2.0', ['nightly']]);
const promoted = releasePlan({ event: 'workflow_dispatch', refName: 'main', sha: 'e'.repeat(40), tags: TAGS, onMain: true,
    input: { channel: 'stable', version: '1.3.0', ref: SHA40 } });
check('called for a promotion: Latest, on the nightly\'s commit', [promoted.latest, promoted.ref], [true, SHA40]);
throwsWith('a commit that is not on main is never published, by tag or by call',
    () => releasePlan({ event: 'push', refName: 'v1.3.0', sha: SHA40, tags: TAGS, onMain: false }), /not on main/);
const dryRun = releasePlan({ event: 'pull_request', refName: '37/merge', sha: SHA40, dry: { version: '1.3.0-nightly.20261008.1' } });
check('a pull request publishes nothing (and is not on main, which is fine for a dry run)', [dryRun.publish, dryRun.channel], [false, 'nightly']);
throwsWith('an unknown channel is refused',
    () => releasePlan({ event: 'workflow_dispatch', sha: SHA40, onMain: true, input: { channel: 'beta', version: '1.0.0', ref: SHA40 } }), /channel/);
throwsWith('a tag that is not a version is refused', () => fromTag('vbanana'), /not a version/);

console.log('\n--- a draft is published only when its files are the ones built ---');
const built = [
    { name: 'a.zip', size: 10, sha256: 'a'.repeat(64) },
    { name: 'manifest.json', size: 2, sha256: 'b'.repeat(64) },
];
const asset = (f, extra = {}) => ({ name: f.name, size: f.size, state: 'uploaded', digest: `sha256:${f.sha256}`, ...extra });
check('every file there, at its size and hash: publish', draftProblems({ release: { draft: true, assets: built.map((f) => asset(f)) }, files: built }), []);
ok('a file missing: refuse', draftProblems({ release: { draft: true, assets: [asset(built[0])] }, files: built }).some((p) => /manifest\.json was not uploaded/.test(p)));
ok('a truncated upload: refuse', draftProblems({ release: { draft: true, assets: [asset(built[0], { size: 9 }), asset(built[1])] }, files: built }).length === 1);
ok('different bytes: refuse', draftProblems({ release: { draft: true, assets: [asset(built[0], { digest: `sha256:${'c'.repeat(64)}` }), asset(built[1])] }, files: built }).length === 1);
ok('an upload still in progress: refuse', draftProblems({ release: { draft: true, assets: [asset(built[0], { state: 'starter' }), asset(built[1])] }, files: built }).length === 1);
ok('an extra file nobody built: refuse', draftProblems({ release: { draft: true, assets: [...built.map((f) => asset(f)), { name: 'x.exe', size: 1 }] }, files: built }).length === 1);
ok('already public: refuse', draftProblems({ release: { draft: false, assets: built.map((f) => asset(f)) }, files: built }).length === 1);
check('no digest from GitHub yet: size and name still decide', draftProblems({ release: { draft: true, assets: built.map((f) => asset(f, { digest: undefined })) }, files: built }), []);

console.log('\n--- the version a build carries ---');
check('a stable build must equal package.json', checkBuildVersion({ channel: 'stable', version: '1.2.0', packageVersion: '1.2.0' }), null);
ok('a stable build that disagrees is refused, naming both',
    /1\.2\.1.*1\.2\.0/.test(checkBuildVersion({ channel: 'stable', version: '1.2.1', packageVersion: '1.2.0' }) || ''));
check('a nightly ahead of package.json is fine',
    checkBuildVersion({ channel: 'nightly', version: '1.3.0-nightly.20261008.1', packageVersion: '1.2.0' }), null);
ok('a nightly BELOW package.json is refused',
    checkBuildVersion({ channel: 'nightly', version: '1.1.0-nightly.20261008.1', packageVersion: '1.2.0' }) !== null);
ok('a nightly without the nightly shape is refused',
    checkBuildVersion({ channel: 'nightly', version: '1.3.0', packageVersion: '1.2.0' }) !== null);

const pkgText = '{\n  "name": "terramentor",\n  "version": "1.2.0",\n  "type": "module"\n}\n';
const lockText = JSON.stringify({ name: 'terramentor', version: '1.2.0', lockfileVersion: 3, packages: { '': { name: 'terramentor', version: '1.2.0' }, 'node_modules/x': { version: '1.2.0' } } }, null, 2) + '\n';
const stamped = stampedPackage({ packageJson: pkgText, packageLock: lockText, version: '1.3.0-nightly.20261008.1' });
check('stamping sets package.json\'s version', JSON.parse(stamped.packageJson).version, '1.3.0-nightly.20261008.1');
check('…and the lockfile\'s root, both places', [JSON.parse(stamped.packageLock).version, JSON.parse(stamped.packageLock).packages[''].version],
    ['1.3.0-nightly.20261008.1', '1.3.0-nightly.20261008.1']);
check('…and nothing else in the lockfile', JSON.parse(stamped.packageLock).packages['node_modules/x'].version, '1.2.0');
check('…keeping the field order', Object.keys(JSON.parse(stamped.packageJson)), ['name', 'version', 'type']);

// ---------------------------------------------------------------------------
// 4. What an updater reads: SHA256SUMS and manifest.json
// ---------------------------------------------------------------------------
console.log('\n--- the manifest and the checksums ---');

const V = '1.3.0-nightly.20261008.2';
check('the platform is read from the END of the name, past the dashes in a nightly version',
    assetPlatform(`Terramentor-${V}-win32-x64.zip`, V), 'win32-x64');
check('a file for another version is not this release\'s', assetPlatform('Terramentor-1.2.0-win32-x64.zip', V), null);
check('a non-zip is not a desktop package', assetPlatform(`Terramentor-${V}-win32-x64.tar`, V), null);
check('a name with more after the arch is not a platform', assetPlatform(`Terramentor-${V}-win32-x64-debug.zip`, V), null);

const files = [
    { name: `Terramentor-${V}-win32-x64.zip`, size: 117, sha256: '1'.repeat(64) },
    { name: `Terramentor-${V}-darwin-arm64.zip`, size: 118, sha256: '2'.repeat(64) },
    { name: `Terramentor-${V}-linux-x64.zip`, size: 138, sha256: '3'.repeat(64) },
];
const manifest = buildManifest({
    repo: 'ValeraZSD/terramentor', channel: 'nightly', version: V, commit: 'd'.repeat(40),
    builtAt: '2026-10-08T18:23:00Z', files,
});
check('the manifest says which channel, version and tag', [manifest.channel, manifest.version, manifest.tag], ['nightly', V, `v${V}`]);
check('one entry per platform', Object.keys(manifest.assets).sort(), ['darwin-arm64', 'linux-x64', 'win32-x64']);
check('each entry carries the size and the hash it must match',
    manifest.assets['win32-x64'], {
        name: `Terramentor-${V}-win32-x64.zip`,
        url: `https://github.com/ValeraZSD/terramentor/releases/download/v${V}/Terramentor-${V}-win32-x64.zip`,
        size: 117, sha256: '1'.repeat(64),
    });
check('the image is named in lowercase, as a Docker reference must be',
    manifest.image, `ghcr.io/valerazsd/terramentor:${V}`);
throwsWith('two packages for one platform: refuse',
    () => buildManifest({ repo: 'o/r', channel: 'nightly', version: V, commit: 'd'.repeat(40), builtAt: 'x', files: [files[0], files[0]] }),
    /twice/);
throwsWith('a malformed hash: refuse',
    () => buildManifest({ repo: 'o/r', channel: 'nightly', version: V, commit: 'd'.repeat(40), builtAt: 'x', files: [{ ...files[0], sha256: 'zz' }] }),
    /sha256/);

const sums = sha256sums([...files, { name: 'manifest.json', size: 1, sha256: '4'.repeat(64) }]);
check('SHA256SUMS is `sha256sum -c` format, sorted by name', sums.split('\n'), [
    `${'2'.repeat(64)}  Terramentor-${V}-darwin-arm64.zip`,
    `${'3'.repeat(64)}  Terramentor-${V}-linux-x64.zip`,
    `${'1'.repeat(64)}  Terramentor-${V}-win32-x64.zip`,
    `${'4'.repeat(64)}  manifest.json`,
    '',
]);

const notes = nightlyNotes({
    version: V, sha: 'd'.repeat(40), since: 'v1.3.0-nightly.20261008.1',
    commits: [{ sha: 'e'.repeat(40), subject: 'Poster fits long values' }],
});
ok('nightly notes list the commits since the last one', notes.includes('Poster fits long values') && notes.includes('v1.3.0-nightly.20261008.1'));
ok('nightly notes say it is a nightly', /nightly/i.test(notes));
const huge = releaseBody({ channel: 'nightly', version: V, repo: 'o/r', changelog: '', nightlyText: 'x'.repeat(200000) });
ok(`a huge body is cut below GitHub's 125,000-character limit (${huge.length})`, huge.length < 125000);
ok('no commits still makes a body, never an empty one',
    nightlyNotes({ version: V, sha: 'd'.repeat(40), since: null, commits: [] }).trim().length > 0);

// ---------------------------------------------------------------------------
// 5. The CLI against real files and a real git repository
// ---------------------------------------------------------------------------
console.log('\n--- tools/release.mjs on a scratch repository ---');

const cli = (args, cwd, env = {}) => spawnSync(process.execPath, [join(repoRoot, 'tools', 'release.mjs'), ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: '', GITHUB_STEP_SUMMARY: '', ...env },
});

// `assets` hashes the real bytes. Asserted against an independent hash so the
// suite does not grade the CLI with its own function.
const dist = join(scratch, 'release');
mkdirSync(dist, { recursive: true });
const zipName = `Terramentor-${V}-linux-x64.zip`;
writeFileSync(join(dist, zipName), 'not really a zip, but bytes are bytes');
writeFileSync(join(dist, `Terramentor-${V}-win32-x64.zip`), 'other bytes');
let r = cli(['assets', '--dir', dist, '--channel', 'nightly', '--version', V, '--commit', 'd'.repeat(40), '--repo', 'ValeraZSD/terramentor'], scratch);
check('assets exits 0', r.status, 0);
const written = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
const expectHash = createHash('sha256').update('not really a zip, but bytes are bytes').digest('hex');
check('the manifest hash is the file\'s real SHA-256', written.assets['linux-x64'].sha256, expectHash);
check('the manifest size is the file\'s real size', written.assets['linux-x64'].size, 37);
const sumsFile = readFileSync(join(dist, 'SHA256SUMS'), 'utf8');
ok('SHA256SUMS covers the zip', sumsFile.includes(`${expectHash}  ${zipName}`));
const manifestHash = createHash('sha256').update(readFileSync(join(dist, 'manifest.json'))).digest('hex');
ok('SHA256SUMS covers the manifest too', sumsFile.includes(`${manifestHash}  manifest.json`));

// `publish` against a stand-in GitHub: it must check the draft's files
// against the ones above, delete a leftover draft of the same tag, and only
// then make the release public. Spawned asynchronously, so this process can
// answer for GitHub while the CLI waits.
const builtFiles = ['SHA256SUMS', 'manifest.json', zipName, `Terramentor-${V}-win32-x64.zip`].map((name) => {
    const bytes = readFileSync(join(dist, name));
    return { name, size: bytes.length, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, state: 'uploaded' };
});
const fakeGitHub = async (draftAssets, run) => {
    const seen = [];
    const server = createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            seen.push(`${req.method} ${req.url}${body ? ` ${body}` : ''}`);
            const send = (status, json) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(json === undefined ? '' : JSON.stringify(json)); };
            if (req.method === 'GET' && req.url === '/repos/o/r/releases/1') return send(200, { id: 1, draft: true, tag_name: `v${V}`, assets: draftAssets });
            if (req.method === 'GET' && req.url.startsWith('/repos/o/r/releases?')) {
                return send(200, [{ id: 1, draft: true, tag_name: `v${V}` }, { id: 2, draft: true, tag_name: `v${V}` }, { id: 3, draft: false, tag_name: 'v1.0.0' }]);
            }
            if (req.method === 'DELETE') return send(204);
            if (req.method === 'PATCH') return send(200, {});
            return send(404, {});
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        const child = spawn(process.execPath, [join(repoRoot, 'tools', 'release.mjs'), 'publish', '--dir', dist, '--version', V, '--release-id', '1', ...run], {
            env: { ...process.env, GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`, GITHUB_REPOSITORY: 'o/r', GITHUB_TOKEN: 'x', GITHUB_OUTPUT: '', GITHUB_STEP_SUMMARY: '' },
        });
        const status = await new Promise((resolve) => child.on('close', resolve));
        return { status, seen };
    } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
};
let pub = await fakeGitHub(builtFiles, ['--latest', 'false']);
check('publish exits 0 when every file is attached intact', pub.status, 0);
check('…deletes the leftover draft of the same tag, and only that one', pub.seen.filter((s) => s.startsWith('DELETE')), ['DELETE /repos/o/r/releases/2']);
check('…then makes it public, Latest as the plan says', pub.seen.filter((s) => s.startsWith('PATCH')),
    ['PATCH /repos/o/r/releases/1 {"draft":false,"make_latest":"false"}']);
pub = await fakeGitHub(builtFiles.filter((f) => f.name !== 'manifest.json'), ['--latest', 'true']);
ok('a draft missing its manifest is not published', pub.status !== 0 && !pub.seen.some((s) => /^(PATCH|DELETE)/.test(s)), pub.seen.join(' | '));
pub = await fakeGitHub(builtFiles.map((f) => (f.name === zipName ? { ...f, digest: `sha256:${'0'.repeat(64)}` } : f)), ['--latest', 'true']);
ok('a draft whose zip has other bytes is not published', pub.status !== 0 && !pub.seen.some((s) => /^PATCH/.test(s)));

// `stamp` rewrites the two files in the working tree it is run in.
const stampDir = join(scratch, 'stamp');
mkdirSync(stampDir);
writeFileSync(join(stampDir, 'package.json'), pkgText);
writeFileSync(join(stampDir, 'package-lock.json'), lockText);
r = cli(['stamp', '1.3.0-nightly.20261008.1'], stampDir);
check('stamp exits 0', r.status, 0);
check('stamp wrote package.json', JSON.parse(readFileSync(join(stampDir, 'package.json'), 'utf8')).version, '1.3.0-nightly.20261008.1');
r = cli(['stamp', 'banana'], stampDir);
ok('stamp refuses a version that is not semver', r.status !== 0);

// `promote` reads package.json and CHANGELOG.md AT the nightly's commit, not
// the working tree: main may have moved on since that nightly.
const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
const repo = join(scratch, 'repo');
mkdirSync(repo);
git(repo, 'init', '-q', '-b', 'main');
git(repo, 'config', 'user.email', 'gate@example.invalid');
git(repo, 'config', 'user.name', 'gate');
git(repo, 'config', 'commit.gpgsign', 'false');
const commit = (msg, files2) => {
    for (const [name, body] of Object.entries(files2)) writeFileSync(join(repo, name), body);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', msg);
    return git(repo, 'rev-parse', 'HEAD').stdout.trim();
};
commit('one', { 'package.json': '{"version":"1.1.0"}\n', 'CHANGELOG.md': '## [1.1.0]\n\nx\n' });
git(repo, 'tag', 'v1.1.0');
const releaseSha = commit('release', { 'package.json': '{"version":"1.2.0"}\n', 'CHANGELOG.md': '## [1.2.0]\n\ny\n\n## [1.1.0]\n\nx\n' });
git(repo, 'tag', 'v1.2.0-nightly.20261008.1');
// main has moved on to the NEXT release since: promoting must not read this.
commit('next release', { 'package.json': '{"version":"1.3.0"}\n', 'CHANGELOG.md': '## [1.3.0]\n\nw\n\n## [1.2.0]\n\ny\n\n## [1.1.0]\n\nx\n' });

const fakeApi = join(scratch, 'releases.json');
writeFileSync(fakeApi, JSON.stringify([
    { tag_name: 'v1.2.0-nightly.20261008.1', draft: false, prerelease: true, published_at: '2026-10-08T06:00:00Z' },
]));
r = cli(['promote', '--releases-file', fakeApi], repo);
check('promote exits 0 for a release commit\'s nightly', r.status, 0);
ok('promote names the nightly\'s commit, not main\'s head', r.stdout.includes(`ref=${releaseSha}`), r.stdout.trim().replace(/\n/g, ' · '));
ok('promote answers the version from that commit, not main\'s 1.3.0', /version=1\.2\.0\n/.test(r.stdout));

writeFileSync(fakeApi, JSON.stringify([]));
r = cli(['promote', '--releases-file', fakeApi], repo);
ok('promote with no nightly fails', r.status !== 0, (r.stderr || '').trim());

// `plan` on the same repository: nothing published yet, so a nightly is due,
// and main's package.json (1.3.0, ahead of the 1.1.0 tag) sets its numbers.
// Earlier runs of the workflow come from a saved answer too: no network here.
const fakeRuns = join(scratch, 'runs.json');
writeFileSync(fakeRuns, JSON.stringify({ total_count: 0, workflow_runs: [] }));
const plan = (...extra) => cli(['plan', '--releases-file', fakeApi, '--runs-file', fakeRuns, '--now', '2026-10-08T18:23:00Z', ...extra], repo);
r = plan();
check('plan exits 0', r.status, 0);
ok('plan publishes when there is no nightly yet', /publish=true/.test(r.stdout), r.stdout.trim().replace(/\n/g, ' · '));
ok('plan versions it from package.json and the tags', /version=1\.3\.0-nightly\.20261008\.2\b/.test(r.stdout));
writeFileSync(fakeRuns, JSON.stringify({ total_count: 1, workflow_runs: [{ html_url: 'https://github.com/o/r/actions/runs/7', created_at: '2026-10-08T17:23:00Z' }] }));
r = plan();
ok('plan backs off a commit whose nightly already failed, and links the run', /publish=false/.test(r.stdout) && /actions\/runs\/7/.test(r.stdout));
writeFileSync(fakeRuns, JSON.stringify({ total_count: 0, workflow_runs: [] }));

writeFileSync(fakeApi, JSON.stringify([
    { tag_name: 'v1.2.0-nightly.20261008.1', draft: false, prerelease: true, published_at: '2026-10-08T15:00:00Z' },
]));
r = plan();
ok('plan skips inside the six hours', /publish=false/.test(r.stdout), r.stdout.trim().replace(/\n/g, ' · '));
r = plan('--force');
ok('plan --force publishes the new commit anyway', /publish=true/.test(r.stdout));

// ---------------------------------------------------------------------------
// 6. The workflows say what this suite assumes
// ---------------------------------------------------------------------------
console.log('\n--- the workflows ---');

// LF whatever the checkout: a Windows clone has CRLF, and `.` stops at the `\r`.
const readYml = (name) => readFileSync(join(repoRoot, '.github', 'workflows', name), 'utf8').replace(/\r\n/g, '\n');
const nightlyYml = readYml('nightly.yml');
const releaseYml = readYml('release.yml');
ok('nightly runs on a schedule', /\n {2}schedule:\n(?: {4}#.*\n)* {4}- cron: '[^']+'/.test(nightlyYml));
ok('nightly runs are serialised and never cancelled mid-publish',
    /concurrency:[\s\S]*?cancel-in-progress:\s*false/.test(nightlyYml));
ok('nightly decides with this script, not inline YAML', /tools\/release\.mjs plan/.test(nightlyYml));
ok('the stable dispatch promotes with this script', /tools\/release\.mjs promote/.test(nightlyYml));
ok('nightly refuses to publish from a branch other than main', /refs\/heads\/main/.test(nightlyYml));
ok('a hand-pushed tag never builds a nightly (they come from the schedule only)',
    /'!v\*-nightly\.\*'/.test(releaseYml));
// The publish step's own `files:` block, not any mention elsewhere.
const publishStep = releaseYml.slice(releaseYml.indexOf('uses: softprops/action-gh-release'));
const filesBlock = (/files: \|\r?\n((?: {12}\S.*\r?\n)+)/.exec(publishStep)?.[1] || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
check('every release carries the zips, SHA256SUMS and the manifest',
    filesBlock, ['release/*.zip', 'release/SHA256SUMS', 'release/manifest.json']);
ok('the plan job decides with releasePlan', /tools\/release\.mjs resolve/.test(releaseYml));
const draftStep = releaseYml.slice(releaseYml.indexOf('uses: softprops/action-gh-release'), releaseYml.indexOf('tools/release.mjs publish'));
ok('the release is created as a draft', /\n\s*draft: true\n/.test(draftStep));
ok('…and published by the step that checks its files, with Latest from the plan',
    /tools\/release\.mjs publish --dir release --version "\$VERSION" --release-id "\$RELEASE_ID" --latest "\$LATEST"/.test(releaseYml)
    && /LATEST: \$\{\{ needs\.plan\.outputs\.latest \}\}/.test(releaseYml));
const imageJob = releaseYml.slice(releaseYml.indexOf('\n  image:'), releaseYml.indexOf('\n  desktop:'));
ok('the image build pushes only its exact version', /tags: \|\n\s*type=raw,value=\$\{\{ needs\.plan\.outputs\.version \}\}\n\n/.test(imageJob)
    && !/value=latest|value=nightly/.test(imageJob));
const tagsJob = releaseYml.slice(releaseYml.indexOf('\n  image-tags:'));
ok('the moving image tags move after the release is published, from the plan',
    /needs: \[plan, image, release\]/.test(tagsJob) && /needs\.release\.result == 'success'/.test(tagsJob)
    && /MOVING: \$\{\{ needs\.plan\.outputs\.moving_tags \}\}/.test(tagsJob));
ok('no checkout leaves the token in .git/config',
    (releaseYml.match(/uses: actions\/checkout@/g) || []).length === (releaseYml.match(/persist-credentials: false/g) || []).length
    && (nightlyYml.match(/uses: actions\/checkout@/g) || []).length === (nightlyYml.match(/persist-credentials: false/g) || []).length);
ok('nightly and stable queue separately, so a scheduled tick cannot replace a pending stable run',
    /group: release-\$\{\{ github\.event_name == 'schedule' && 'nightly' \|\| inputs\.channel \}\}/.test(nightlyYml));
ok('a build is stamped with its version before it is packaged',
    (releaseYml.match(/tools\/release\.mjs stamp/g) || []).length >= 2);

try { rmSync(scratch, { recursive: true, force: true }); } catch { /* Windows may hold a handle */ }

console.log(`\n${pass} passed, ${fail} failed`);
// exitCode, not exit(): the process ends when its last handle has closed
// rather than in the middle of one closing.
process.exitCode = fail ? 1 : 0;
