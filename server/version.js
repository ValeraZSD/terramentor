// Who am I, and is there a newer one? — the app's own identity, and the one
// optional outbound call in the whole product.
//
// Two separate jobs live here because they share the same question.
//
// IDENTITY. Nothing in the app used to say what it was running: a bug report
// said "latest" and could mean a three-week-old clone or this morning's pull,
// and an update check has nothing to compare against without it. The version
// comes from package.json; the commit comes from `.git` (read directly, so no
// git binary is needed) or, in a container where there is no `.git`, from the
// GIT_SHA build argument the release workflow passes in.
//
// UPDATE CHECK. SECURITY.md makes a falsifiable promise — start the app, sit
// idle, capture the traffic, see nothing. That promise is why this is built the
// way it is:
//   * The manual check is a BUTTON. A press is not a ping, and an idle app that
//     is never pressed still makes zero connections, so the published
//     verification procedure stays true word for word.
//   * The daily poll is OPT-IN and ships OFF. Turning it on is the user
//     accepting one outbound call a day, and SECURITY.md now names it.
//   * The check is done by the SERVER, once, cached — not by each page load.
//     Otherwise a phone, a laptop and three open tabs are four calls for one
//     answer, and the count a packet capture shows would depend on how many
//     devices happened to be awake.
//   * It reads GitHub's public releases API and nothing else. No endpoint of
//     ours, so there is no server anywhere that learns an install exists.
//
// What it deliberately does NOT do is update anything. Three install shapes
// need three different commands, and an endpoint that runs `git pull &&
// npm install` on request is remote code execution wearing a helpful hat in an
// app whose whole pitch is a verifiable security posture. `updateCommand()`
// returns the right line for how THIS instance was installed, and a person runs
// it.

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

/** Where the Corresponding Source lives. Also the update-check target, and the
 *  "Get the source code" link AGPL §13 requires. One definition: the client
 *  reads it off /api/version rather than holding a second copy that can drift. */
export const REPO_URL = process.env.UPDATE_REPO_URL || 'https://github.com/ValeraZSD/terramentor';

/** owner/repo, derived — the releases API wants the slug, humans want the URL. */
export function repoSlug() {
    const m = /github\.com\/([^/]+)\/([^/#?]+)/.exec(REPO_URL);
    return m ? `${m[1]}/${m[2].replace(/\.git$/, '')}` : null;
}

// --- identity ---------------------------------------------------------------

let cached = null;

function readPackageVersion() {
    try {
        return JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version || '0.0.0';
    } catch {
        return '0.0.0';
    }
}

/**
 * The commit this is running, without shelling out to git.
 *
 * A clone has `.git/HEAD`, which is either a detached SHA or a `ref:` pointing
 * at a file under `.git/refs/`. A packed repository has no such file and the
 * ref lives in `.git/packed-refs` instead, which is the case for a fresh
 * `git clone` — so a reader that only knows loose refs reports "unknown" on
 * exactly the install everyone has.
 *
 * `root` is a parameter purely so the gates can drive it against a synthetic
 * `.git`: the packed-refs branch is the one that only fires on a fresh clone,
 * i.e. never on a development machine, which is precisely why it needs a test.
 */
export function readGitCommit(root = repoRoot) {
    if (process.env.GIT_SHA) return process.env.GIT_SHA.slice(0, 40);
    try {
        const gitDir = join(root, '.git');
        if (!existsSync(gitDir)) return null;
        const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
        if (/^[0-9a-f]{40}$/i.test(head)) return head;           // detached
        const ref = head.replace(/^ref:\s*/, '');
        const loose = join(gitDir, ref);
        if (existsSync(loose)) return readFileSync(loose, 'utf8').trim();
        const packed = join(gitDir, 'packed-refs');              // a fresh clone
        if (existsSync(packed)) {
            for (const line of readFileSync(packed, 'utf8').split('\n')) {
                const m = /^([0-9a-f]{40})\s+(.+)$/.exec(line.trim());
                if (m && m[2] === ref) return m[1];
            }
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * How this instance was installed — which is the only thing that decides what
 * "update" means. The explicit launcher marker is asked FIRST, because it is
 * the one signal a human set on purpose: inside a container that happens to
 * wrap a packaged desktop copy (CI sandboxes do), the container marker would
 * otherwise misreport it and the app would offer docker update advice.
 * Docker is then detected from the container marker rather than from an env
 * var we set ourselves, so it is still right when someone runs the image by
 * hand instead of through compose.
 */
export function deployment() {
    if (process.env.TERRAMENTOR_DESKTOP === '1') return 'desktop';
    if (existsSync('/.dockerenv') || process.env.TERRAMENTOR_DOCKER === '1') return 'docker';
    if (readBuildInfo()) return 'desktop';
    if (existsSync(join(repoRoot, '.git'))) return 'git';
    return 'source';
}

/**
 * The stamp `tools/build-desktop.mjs` writes into a packaged copy: which commit
 * the files came from and when, because a zip has no `.git` and "0.68.0" alone
 * does not distinguish a release build from a local build of the same tag plus
 * three commits. Absent everywhere else, and its absence is what marks a
 * checkout as a checkout.
 */
export function readBuildInfo(root = repoRoot) {
    try {
        const file = join(root, 'build.json');
        if (!existsSync(file)) return null;
        const info = JSON.parse(readFileSync(file, 'utf8'));
        return info && typeof info === 'object' ? info : null;
    } catch {
        return null;
    }
}

/** The command that actually updates THIS install. Shown, never run. */
export function updateCommand(kind = deployment()) {
    switch (kind) {
        case 'docker':
            return 'docker compose pull && docker compose up -d';
        case 'git':
            return 'git pull && npm install && npm run build';
        default:
            // A desktop build is replaced by downloading the next one (its data
            // lives outside the application folder, so replacing the folder is
            // the whole update); an unpacked copy likewise. Neither has a
            // command that would work, and printing a git one to someone with
            // no repository is worse than printing none.
            return null;
    }
}

/** Everything /api/version serves. Computed once — none of it changes at runtime. */
export function appVersion() {
    if (cached) return cached;
    const build = readBuildInfo();
    const commit = readGitCommit() || (build && /^[0-9a-f]{7,40}$/i.test(build.commit || '') ? build.commit : null);
    const kind = deployment();
    cached = {
        version: readPackageVersion(),
        commit: commit ? commit.slice(0, 40) : null,
        commitShort: commit ? commit.slice(0, 7) : null,
        builtAt: process.env.BUILD_TIME || build?.builtAt || null,
        node: process.versions.node,
        platform: `${process.platform}-${process.arch}`,
        deployment: kind,
        updateCommand: updateCommand(kind),
        repoUrl: REPO_URL,
    };
    return cached;
}

// --- version comparison ------------------------------------------------------

/**
 * Compare two release versions. Returns >0 when `a` is newer.
 *
 * Deliberately small rather than a dependency, and deliberately semver-shaped:
 * numeric fields compare as numbers (so 0.10.0 beats 0.9.0 — the string compare
 * that gets this wrong is the classic), and a PRERELEASE loses to the release of
 * the same numbers, which is the whole point of tagging `0.9.0-rc.1` for the
 * fast stuff and `0.9.0` for what you would point your own phone at.
 */
export function compareVersions(a, b) {
    const parse = (v) => {
        const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v || '').trim());
        if (!m) return null;
        return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || null };
    };
    const pa = parse(a), pb = parse(b);
    if (!pa || !pb) return 0;                       // unparseable: never "newer"
    for (let i = 0; i < 3; i++) {
        if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] - pb.nums[i];
    }
    if (pa.pre === pb.pre) return 0;
    if (!pa.pre) return 1;                          // release beats its prerelease
    if (!pb.pre) return -1;
    return pa.pre < pb.pre ? -1 : 1;
}

// --- the check ---------------------------------------------------------------

/** How long a cached answer stands before the daily poll refreshes it. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** A failed check retries once, soon — a laptop's network is rarely up at boot. */
export const RETRY_DELAY_MS = 10 * 60 * 1000;

const FETCH_TIMEOUT_MS = 8000;

/**
 * Ask GitHub for the newest published release. Returns `{ok:true, latest}` or
 * `{ok:false, error}` — it never throws, because every caller is either a
 * background timer or a button, and neither may take the process or the request
 * down over a network hiccup.
 *
 * `/releases/latest` is the right endpoint and not `/releases`: GitHub excludes
 * prereleases and drafts from it, so "which one is stable" needs no rule of ours
 * — tagging `0.9.0-rc.1` as a prerelease is the whole mechanism.
 */
export async function fetchLatestRelease(fetchImpl = globalThis.fetch) {
    const slug = repoSlug();
    if (!slug) return { ok: false, error: 'No GitHub repository configured' };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetchImpl(`https://api.github.com/repos/${slug}/releases/latest`, {
            signal: ctrl.signal,
            headers: {
                // GitHub rejects an unidentified caller, and the version is the
                // only thing this sends — no install id, nothing that could be
                // counted as a distinct user across days.
                'User-Agent': `Terramentor/${readPackageVersion()}`,
                Accept: 'application/vnd.github+json',
            },
        });
        if (res.status === 404) {
            // No release published yet. An answer, not a failure — it must not
            // be retried every ten minutes for the life of the process.
            return { ok: true, latest: null };
        }
        if (!res.ok) return { ok: false, error: `GitHub responded ${res.status}` };
        const body = await res.json();
        if (!body || typeof body.tag_name !== 'string') return { ok: false, error: 'Unexpected response' };
        return {
            ok: true,
            latest: {
                version: body.tag_name.replace(/^v/, ''),
                tag: body.tag_name,
                name: typeof body.name === 'string' ? body.name : null,
                url: typeof body.html_url === 'string' ? body.html_url : `${REPO_URL}/releases`,
                publishedAt: typeof body.published_at === 'string' ? body.published_at : null,
            },
        };
    } catch (e) {
        return { ok: false, error: e.name === 'AbortError' ? 'Timed out' : (e.message || 'Network error') };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Fold a stored check result and the running version into what the UI shows.
 *
 * `available` is false whenever there is nothing to compare — no check yet, no
 * release published, an unparseable version. A banner is a claim, and "I could
 * not tell" must never render as "you are behind".
 */
export function updateStatus({ current, latest, checkedAt, enabled, error }) {
    const newer = latest && compareVersions(latest.version, current) > 0;
    return {
        enabled: !!enabled,
        current,
        latest: latest || null,
        available: !!newer,
        checkedAt: checkedAt || null,
        error: error || null,
    };
}
