// Who am I, and is there a newer one? — the app's own identity, and the one
// optional outbound call in the whole product.
//
// Two separate jobs live here because they share the same question.
//
// IDENTITY. A bug report that says "latest" can mean a three-week-old clone or
// this morning's pull, and an update check has nothing to compare against
// without a version of its own. The version
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
 *
 * Prerelease fields compare one dot-separated field at a time, numbers as
 * numbers (semver §11). A nightly is `1.3.0-nightly.20261008.10`, and a plain
 * string compare puts that run BELOW `.9`, so the second nightly of a day with
 * double-digit runs would never be offered to anyone.
 */
export function compareVersions(a, b) {
    const parse = (v) => {
        const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v || '').trim());
        if (!m) return null;
        return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : null };
    };
    const pa = parse(a), pb = parse(b);
    if (!pa || !pb) return 0;                       // unparseable: never "newer"
    for (let i = 0; i < 3; i++) {
        if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] - pb.nums[i];
    }
    if (!pa.pre && !pb.pre) return 0;
    if (!pa.pre) return 1;                          // release beats its prerelease
    if (!pb.pre) return -1;
    const numeric = /^\d+$/;
    for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
        const x = pa.pre[i], y = pb.pre[i];
        if (x === undefined) return -1;             // fewer fields sort first
        if (y === undefined) return 1;
        if (x === y) continue;
        const xn = numeric.test(x), yn = numeric.test(y);
        if (xn && yn) return Number(x) - Number(y);
        if (xn) return -1;                          // a number sorts below a word
        if (yn) return 1;
        return x < y ? -1 : 1;
    }
    return 0;
}

// --- the check ---------------------------------------------------------------

/** How long a cached answer stands before the daily poll refreshes it. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** A failed check retries once, soon — a laptop's network is rarely up at boot. */
export const RETRY_DELAY_MS = 10 * 60 * 1000;

const FETCH_TIMEOUT_MS = 8000;

/**
 * Which releases an install is offered. `stable` is every full release and the
 * default. `nightly` adds the builds of main that .github/workflows/nightly.yml
 * publishes. A stored value that is neither reads as stable, so a typo can only
 * ever mean fewer offers, never more.
 */
export const UPDATE_CHANNELS = ['stable', 'nightly'];
export const updateChannel = (value) => (UPDATE_CHANNELS.includes(value) ? value : 'stable');

/** How many of the newest releases the nightly channel looks at: a week of
 *  nightlies at four a day, and the newest version is always among the newest
 *  created, because a nightly previews the next minor above every stable. */
const NIGHTLY_PAGE = 30;

/**
 * The newest release a nightly install can take: highest version among the
 * published full releases and nightlies. By version, not by date, so a stable
 * release promoted from an older nightly cannot make newer nightlies look old,
 * and a draft (never published) is never offered.
 *
 * Any other prerelease is skipped. `1.3.0-rc.1` sorts above every
 * `1.3.0-nightly.*` ("rc" > "nightly"), so an install that took it would be
 * stranded there, offered no nightly of 1.3.0 again; a hand-tagged candidate
 * stays what it always was here, published and installable but offered to no one.
 */
export function newestRelease(releases) {
    let best = null;
    for (const r of Array.isArray(releases) ? releases : []) {
        if (!r || r.draft || typeof r.tag_name !== 'string') continue;
        if (!/^v?\d+\.\d+\.\d+/.test(r.tag_name)) continue;      // not a version tag: never offered
        if (r.prerelease && !/-nightly\./.test(r.tag_name)) continue;
        if (!best || compareVersions(r.tag_name, best.tag_name) > 0) best = r;
    }
    return best;
}

/**
 * Where a release's manifest.json is, or null. Only an asset of THIS
 * repository's release downloads is accepted: the manifest is what the
 * desktop updater checks a download against, so an answer pointing anywhere
 * else is dropped rather than passed on.
 */
function manifestUrl(release, slug) {
    const prefix = `https://github.com/${slug}/releases/download/`;
    const asset = (Array.isArray(release.assets) ? release.assets : [])
        .find((a) => a && a.name === 'manifest.json' && typeof a.browser_download_url === 'string');
    return asset && asset.browser_download_url.startsWith(prefix) ? asset.browser_download_url : null;
}

/**
 * Ask GitHub for the newest release on `channel`. Returns `{ok:true, latest}` or
 * `{ok:false, error}` — it never throws, because every caller is either a
 * background timer or a button, and neither may take the process or the request
 * down over a network hiccup.
 *
 * Stable asks `/releases/latest`: GitHub excludes prereleases and drafts from
 * it, so "which one is stable" needs no rule of ours — marking a release as a
 * prerelease is the whole mechanism. Nightly asks for the newest releases and
 * picks the highest version itself (newestRelease), since GitHub has no "latest
 * prerelease". Either way it is ONE request to the same host.
 *
 * No downgrade, by construction: what is returned is only ever offered when it
 * compares NEWER than the running version (updateStatus). An install switched
 * from nightly to stable keeps its nightly until a stable release passes it.
 */
export async function fetchLatestRelease(fetchImpl = globalThis.fetch, { channel = 'stable' } = {}) {
    const slug = repoSlug();
    if (!slug) return { ok: false, error: 'No GitHub repository configured' };
    const nightly = updateChannel(channel) === 'nightly';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
        const url = nightly
            ? `https://api.github.com/repos/${slug}/releases?per_page=${NIGHTLY_PAGE}`
            : `https://api.github.com/repos/${slug}/releases/latest`;
        const res = await fetchImpl(url, {
            signal: ctrl.signal,
            headers: {
                // GitHub rejects an unidentified caller, and the version is the
                // only thing this sends — no install id, nothing that could be
                // counted as a distinct user across days.
                'User-Agent': `Terramentor/${readPackageVersion()}`,
                Accept: 'application/vnd.github+json',
            },
        });
        if (res.status === 404 && !nightly) {
            // No release published yet. An answer, not a failure — it must not
            // be retried every ten minutes for the life of the process. (The
            // list endpoint answers that with an empty list; a 404 there means
            // the repository is gone, which is a failure.)
            return { ok: true, latest: null };
        }
        if (!res.ok) return { ok: false, error: `GitHub responded ${res.status}` };
        const body = await res.json();
        if (nightly && !Array.isArray(body)) return { ok: false, error: 'Unexpected response' };
        const release = nightly ? newestRelease(body) : body;
        if (nightly && !release) return { ok: true, latest: null };
        if (!release || typeof release.tag_name !== 'string') return { ok: false, error: 'Unexpected response' };
        return {
            ok: true,
            latest: {
                version: release.tag_name.replace(/^v/, ''),
                tag: release.tag_name,
                name: typeof release.name === 'string' ? release.name : null,
                url: typeof release.html_url === 'string' ? release.html_url : `${REPO_URL}/releases`,
                publishedAt: typeof release.published_at === 'string' ? release.published_at : null,
                prerelease: release.prerelease === true,
                // Which question this answers, stored with it: an answer for one
                // channel must not be read back as the other's after a switch.
                channel: nightly ? 'nightly' : 'stable',
                manifestUrl: manifestUrl(release, slug),
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
 *
 * `ahead` is the other direction: this install runs something newer than the
 * newest release on its channel, which is where a nightly install lands when it
 * is switched to stable. Nothing is offered until a stable release passes it;
 * the flag lets the panel say so instead of "up to date".
 */
export function updateStatus({ current, latest, checkedAt, enabled, error, channel }) {
    const cmp = latest ? compareVersions(latest.version, current) : 0;
    return {
        enabled: !!enabled,
        channel: updateChannel(channel),
        current,
        latest: latest || null,
        available: cmp > 0,
        ahead: cmp < 0,
        checkedAt: checkedAt || null,
        error: error || null,
    };
}
