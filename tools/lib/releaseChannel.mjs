// The decisions behind the nightly and stable release channels, as plain
// functions of their inputs (tags, releases, package.json, the clock), so
// tools/release-gates.mjs can drive every branch without GitHub or git.
// tools/release.mjs gathers the inputs and is the only caller.
//
// The model is T3 Code's: a schedule publishes main as a prerelease when there
// is something new and the last one is at least six hours old, and a stable
// release PROMOTES the commit of the latest nightly, so what reaches everyone is
// a build nightly users already ran. One difference: the stable version is not
// stamped on at release time. It is the version package.json carries at that
// commit, written by an ordinary release pull request with its CHANGELOG line,
// so main, the tag and the running app never disagree about what 1.2.0 is.

import { compareVersions } from '../../server/version.js';

/** The schedule never publishes twice inside this window. */
export const NIGHTLY_GAP_MS = 6 * 60 * 60 * 1000;

const STABLE_TAG = /^v(\d+\.\d+\.\d+)$/;
const NIGHTLY_TAG = /^v(\d+\.\d+\.\d+)-nightly\.(\d{8})\.(\d+)$/;
const NIGHTLY_VERSION = /^(\d+\.\d+\.\d+)-nightly\.\d{8}\.\d+$/;
const CORE = /^v?(\d+)\.(\d+)\.(\d+)/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const maxVersion = (a, b) => (compareVersions(a, b) >= 0 ? a : b);

/** `1.2.3-rc.1` → `1.2.3`; null for anything that is not X.Y.Z-shaped. */
export function versionCore(v) {
    const m = CORE.exec(String(v || ''));
    return m ? `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}` : null;
}

export const isSemver = (v) => SEMVER.test(String(v || ''));

/** The newest plain `vX.Y.Z` tag, as `X.Y.Z`. A tag counts even without a
 *  release behind it: v1.1.0 failed its build and published nothing, and a
 *  nightly that previewed "1.1.0" afterwards would preview a number that can
 *  never ship. */
export function highestStable(tags) {
    let best = null;
    for (const t of tags) {
        const m = STABLE_TAG.exec(t);
        if (m && (!best || compareVersions(m[1], best) > 0)) best = m[1];
    }
    return best;
}

export function nextMinor(core) {
    const [maj, min] = versionCore(core).split('.').map(Number);
    return `${maj}.${min + 1}.0`;
}

/**
 * The X.Y.Z a nightly previews: the next minor after the newest stable tag,
 * unless package.json is already further ahead (a release pull request has
 * merged and its tag is not cut yet, or a major is coming).
 *
 * Never below the next minor, even when package.json says otherwise: a patch
 * release commit (1.3.1 after 1.3.0) must not pull nightlies back from the
 * 1.4.0 previews nightly installs already run, or they would be "ahead" of
 * every nightly that follows.
 */
export function nightlyBase({ packageVersion, tags }) {
    const pkg = versionCore(packageVersion);
    if (!pkg) throw new Error(`package.json version "${packageVersion}" is not X.Y.Z`);
    const stable = highestStable(tags);
    return stable ? maxVersion(pkg, nextMinor(stable)) : pkg;
}

/** `<base>-nightly.<YYYYMMDD>.<N>`, N counting that day's nightlies whatever
 *  their base, from the highest one seen, so a version is never reused even
 *  when a release pull request moves the base mid-day. */
export function nightlyVersion({ base, date, tags }) {
    let n = 0;
    for (const t of tags) {
        const m = NIGHTLY_TAG.exec(t);
        if (m && m[2] === date) n = Math.max(n, Number(m[3]));
    }
    return `${base}-nightly.${date}.${n + 1}`;
}

/** `YYYYMMDD` in UTC — the date in a nightly's version is GitHub's, not a time zone's. */
export const utcDate = (ms) => new Date(ms).toISOString().slice(0, 10).replaceAll('-', '');

/** The newest published nightly in a `GET /releases` page, by publication time. */
export function latestNightly(releases) {
    const nightlies = (releases || [])
        .filter((r) => r && !r.draft && r.published_at && NIGHTLY_TAG.test(r.tag_name || ''))
        .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
    if (!nightlies.length) return null;
    return { tag: nightlies[0].tag_name, publishedAt: nightlies[0].published_at };
}

/**
 * Whether the schedule publishes now. `last` is the latest nightly with its
 * commit, `lastIsAncestor` whether main contains that commit.
 *
 * "Nothing new" is checked before "too soon": a run that would skip either way
 * should say the reason that does not go away by waiting. `force` (a manual
 * run) skips the wait and nothing else; an unchanged commit is never
 * published twice, whoever asks.
 */
export function nightlyDecision({ last, headSha, lastIsAncestor, now, force = false }) {
    if (!last) return { publish: true, reason: 'No nightly has been published yet.' };
    if (last.sha === headSha) return { publish: false, reason: `main has nothing new since ${last.tag}.` };
    if (!lastIsAncestor) {
        return { publish: false, reason: `main does not contain ${last.tag}'s commit, so there is no "since" to publish. Look at main's history.` };
    }
    const due = Date.parse(last.publishedAt) + NIGHTLY_GAP_MS;
    if (now < due && !force) {
        return { publish: false, reason: `${last.tag} is under six hours old; the next nightly is due after ${new Date(due).toISOString()}.` };
    }
    return { publish: true, reason: `main has new commits since ${last.tag}${force && now < due ? ' (manual run, the six-hour wait skipped)' : ''}.` };
}

/**
 * The stable release the latest nightly becomes, or an Error saying why not.
 *
 * Its version is package.json's at THAT commit: a release pull request (version
 * bump plus its CHANGELOG line) has to have merged and been built by a nightly
 * before there is anything to promote. The refusals are written to be read in
 * the Actions log by the person who pressed the button.
 */
export function promotion({ nightly, onMain, packageVersion, tags, changelog }) {
    if (!nightly) throw new Error('No nightly has been published, so there is no build to promote. Run the Nightly workflow first.');
    if (!onMain) throw new Error(`${nightly.tag}'s commit ${nightly.sha} is not on main; only main is released.`);
    const v = String(packageVersion || '');
    if (!/^\d+\.\d+\.\d+$/.test(v)) {
        throw new Error(`package.json at ${nightly.tag} says "${v}"; a stable release needs a plain X.Y.Z.`);
    }
    const stable = highestStable(tags);
    if (stable && compareVersions(v, stable) <= 0) {
        throw new Error(
            `package.json at ${nightly.tag} says ${v}, which is not newer than the latest stable ${stable}. `
            + 'Merge a release pull request first (the version in package.json and its CHANGELOG.md line), '
            + 'let a nightly build it (or run Nightly by hand), then promote.');
    }
    if (tags.includes(`v${v}`)) throw new Error(`The tag v${v} already exists.`);
    if (!String(changelog || '').includes(`## [${v}]`)) {
        throw new Error(`CHANGELOG.md at ${nightly.tag} has no "## [${v}]" section; the release notes are that section.`);
    }
    return { version: v, tag: `v${v}`, sha: nightly.sha, from: nightly.tag };
}

/**
 * What release.yml builds, from how it was started: called by nightly.yml with
 * `input`, a pull request (a dry run, versioned by `dry`, the `plan` answer for
 * that commit), or a pushed tag. Only a plain stable X.Y.Z becomes the
 * repository's Latest release and moves the `latest` image; a nightly or a
 * suffixed tag (v1.3.0-rc.1) is a prerelease.
 */
export function releasePlan({ event, refName, sha, input = {}, dry = {} }) {
    let channel, version, ref, previous, publish;
    if (input.version) {
        ({ channel, version, ref } = input);
        previous = input.previous || '';
        publish = true;
    } else if (event === 'pull_request') {
        channel = 'nightly'; version = dry.version; ref = sha; previous = dry.previous || ''; publish = false;
    } else {
        channel = 'stable'; version = String(refName || '').replace(/^v/, ''); ref = sha; previous = ''; publish = true;
    }
    if (channel !== 'stable' && channel !== 'nightly') throw new Error(`Unknown channel: ${channel}`);
    if (!isSemver(version)) throw new Error(`"${version}" is not a version to release`);
    if (!/^[0-9a-f]{40}$/.test(ref || '')) throw new Error(`"${ref}" is not a commit`);
    const prerelease = channel === 'nightly' || version.includes('-');
    return {
        channel, version, tag: `v${version}`, ref, previous, publish, prerelease,
        latest: channel === 'stable' && !prerelease,
        minor: version.split('.').slice(0, 2).join('.'),
    };
}

/** Null when the build may carry `version`; otherwise the reason it may not. */
export function checkBuildVersion({ channel, version, packageVersion }) {
    if (channel === 'stable') {
        return version === packageVersion
            ? null
            : `Release version ${version} does not match package.json version ${packageVersion}.`;
    }
    const m = NIGHTLY_VERSION.exec(version);
    if (!m) return `${version} is not a nightly version (X.Y.Z-nightly.YYYYMMDD.N).`;
    if (compareVersions(m[1], versionCore(packageVersion)) < 0) {
        return `Nightly ${version} would sort below package.json version ${packageVersion}.`;
    }
    return null;
}

/** package.json and package-lock.json text with the version replaced and
 *  nothing else touched. Both files are npm's own `JSON.stringify(_, null, 2)`
 *  output, so a parse and re-serialise keeps every other byte. */
export function stampedPackage({ packageJson, packageLock, version }) {
    const pkg = JSON.parse(packageJson);
    pkg.version = version;
    const lock = JSON.parse(packageLock);
    lock.version = version;
    if (lock.packages?.['']) lock.packages[''].version = version;
    return {
        packageJson: `${JSON.stringify(pkg, null, 2)}\n`,
        packageLock: `${JSON.stringify(lock, null, 2)}\n`,
    };
}

/** `Terramentor-<version>-<platform>-<arch>.zip` → `<platform>-<arch>`. Read
 *  from the prefix, since a nightly version has dashes of its own. */
export function assetPlatform(name, version) {
    const prefix = `Terramentor-${version}-`;
    if (!name.startsWith(prefix) || !name.endsWith('.zip')) return null;
    const rest = name.slice(prefix.length, -'.zip'.length);
    return /^[a-z0-9]+-[a-z0-9]+$/.test(rest) ? rest : null;
}

/**
 * manifest.json, attached to every release. What an updater needs and nothing
 * it would have to scrape: which channel and version this is, and for each
 * platform the one file to download with the size and SHA-256 it must match.
 * `schema` moves when a field changes meaning, so a reader can refuse a shape
 * it does not know rather than guess.
 */
export function buildManifest({ repo, channel, version, commit, builtAt, files }) {
    const tag = `v${version}`;
    const assets = {};
    for (const f of files) {
        const platform = assetPlatform(f.name, version);
        if (!platform) throw new Error(`${f.name} is not a desktop package for ${version}`);
        if (assets[platform]) throw new Error(`Two packages for ${platform}; the manifest names one file per platform twice`);
        if (!/^[0-9a-f]{64}$/.test(f.sha256)) throw new Error(`${f.name}: "${f.sha256}" is not a sha256 hex digest`);
        assets[platform] = {
            name: f.name,
            url: `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(f.name)}`,
            size: f.size,
            sha256: f.sha256,
        };
    }
    return {
        schema: 1,
        app: 'Terramentor',
        channel,
        version,
        tag,
        commit,
        builtAt,
        releaseUrl: `https://github.com/${repo}/releases/tag/${encodeURIComponent(tag)}`,
        image: `ghcr.io/${repo.toLowerCase()}:${version}`,
        assets,
    };
}

/** The `sha256sum -c` file: `<hex>  <name>`, sorted by name. */
export function sha256sums(files) {
    return [...files]
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .map((f) => `${f.sha256}  ${f.name}\n`)
        .join('');
}

/**
 * The CHANGELOG.md section for `version`: the lines under `## [version]` up to
 * the next `## ` heading, blank lines dropped. '' when there is none.
 *
 * The heading is matched as a literal prefix, never as a regex built from the
 * version: that reads `[1.0.0]` as a character class and matches nothing, and a
 * version string carries two kinds of regex metacharacter. Any `## ` line ends
 * the section, because the run-up heading ("## Before 1.0") has no brackets.
 */
export function changelogSection(text, version) {
    const lines = String(text || '').split(/\r?\n/);
    const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
    if (start === -1) return '';
    const after = lines.slice(start + 1);
    const end = after.findIndex((l) => l.startsWith('## '));
    return (end === -1 ? after : after.slice(0, end)).filter((l) => l.trim()).join('\n');
}

const NOTES_MAX = 60000;

/**
 * The GitHub Release body: the notes, then how to install this exact release.
 * A stable release's notes are its CHANGELOG section, and a missing section
 * says so in a sentence rather than shipping a blank release (a maintainer
 * notices the sentence, not the blank).
 */
export function releaseBody({ channel, version, repo, changelog, nightlyText }) {
    const tag = `v${version}`;
    const raw = `https://raw.githubusercontent.com/${repo}/${tag}/docker-compose.yml`;
    const image = `ghcr.io/${repo.toLowerCase()}`;
    // GitHub refuses a release body over 125,000 characters, and a refused
    // body fails the release after everything else has been built. The cap
    // leaves room for the install text below.
    const full = channel === 'nightly'
        ? nightlyText.trim()
        : changelogSection(changelog, version) || `No changelog entry for ${version}.`;
    const notes = full.length > NOTES_MAX ? `${full.slice(0, NOTES_MAX)}\n\n…` : full;
    const docker = channel === 'nightly'
        ? [
            '**Docker:** the image is `' + image + ':' + version + '`, and `' + image + ':nightly` always',
            'follows the newest nightly. To run nightlies, change `:latest` to `:nightly` in your',
            '`docker-compose.yml`, then `docker compose pull && docker compose up -d`.',
        ]
        : [
            '**Docker:**',
            '',
            '```bash',
            `curl -O ${raw}`,
            'docker compose up -d                          # then open http://127.0.0.1:3001',
            'docker compose pull && docker compose up -d   # to update',
            '```',
        ];
    return [
        notes,
        '',
        '---',
        '',
        '**Desktop app, nothing to install:** download the zip for your system',
        'below (`win32-x64` for Windows, `darwin-arm64` for a Mac with Apple',
        'Silicon, `linux-x64` for Linux), unpack it anywhere, and start',
        '`Terramentor.exe`, `Terramentor.app` (right-click → Open the first',
        'time) or `./terramentor.sh`. Your library lives in your user data',
        'folder, so updating is unpacking the next zip and deleting the old',
        `folder. Details: [docs/DESKTOP.md](https://github.com/${repo}/blob/${tag}/docs/DESKTOP.md).`,
        '`SHA256SUMS` lists the hash of every file here, and `manifest.json` gives',
        'the same for each platform in a form a program can read.',
        '',
        ...docker,
        '',
        '**From a git checkout:** `git pull && npm install && npm run build`.',
        '',
        'None of these touches your library. When a new version has to change',
        'the database, the app copies the file first, next to the original.',
        '',
    ].join('\n');
}

/** A nightly's release notes: what it is, and the commit subjects since the
 *  previous nightly (or the last stable tag when it is the first). */
export function nightlyNotes({ version, sha, since, commits }) {
    const lines = [
        `Nightly build ${version} of \`${sha.slice(0, 7)}\` on \`main\`, published automatically. `
        + 'It passed the same checks as every pull request and nothing more, so keep the latest stable '
        + 'release for a library you depend on. The update check offers nightlies only to installs set '
        + 'to the Nightly channel.',
        '',
    ];
    if (commits.length) {
        lines.push(since ? `Changes since ${since}:` : 'Changes:', '');
        for (const c of commits) lines.push(`- ${c.subject} (${c.sha.slice(0, 7)})`);
    } else {
        lines.push(since ? `No commits since ${since}.` : 'No commit list for this build.');
    }
    return `${lines.join('\n')}\n`;
}
