// The parts of a desktop update that decide something: which release may be
// installed, which files changed, where those files sit inside the zip on
// GitHub, whether what arrived is what the release says, and how one app
// folder is traded for another and back.
//
// Two programs use it, and they trust it for different things:
//   * the SERVER (server/appUpdate.js) downloads and stages the next version
//     under `<app>/.update/next`. It never touches the app's own files.
//   * the UPDATER (desktop/updater.js) runs after the app has exited, from a
//     copy outside the folders it moves, checks the staged tree again, swaps it
//     in, starts it, and puts the old one back if it does not come up.
//
// Node built-ins only. The updater runs from `.update/runner/` with nothing
// beside it but this file, and the Docker image ships no `desktop/` at all, so
// the server imports this lazily and only on a desktop install.
//
// What the checks rest on. A release's manifest.json names, per platform, the
// zip and the SHA-256 of `files.json` inside it; files.json names the SHA-256
// of every file in the app. So a file taken out of the zip by itself, without
// the rest of the zip, is still checked against the release: manifest →
// files.json → file. The manifest proves the bytes are the release's; that the
// release is THIS repository's is the URL it came from (`assertManifest`), the
// same trust as downloading the zip by hand.

import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

/** Where an install keeps everything an update needs, inside its own folder:
 *  the same volume as the app, so the swap is a handful of renames and an
 *  unchanged file can be a hard link instead of a copy. */
export const UPDATE_DIR = '.update';

/** Top-level names a swap never moves, whatever a file list claims. `data/` is
 *  a portable copy's library and `library-location.txt` points at one; moving
 *  either would make the next start open an empty library. */
export const NEVER_MOVED = new Set([UPDATE_DIR, 'data', 'library-location.txt']);

/** A path from a file list or a zip, made safe to join under a folder: forward
 *  slashes, no empty, `.` or `..` segment, no drive or root, nothing hidden in
 *  a backslash. Returns null for anything else, and the caller refuses it. */
export function safeRelPath(p) {
    if (typeof p !== 'string' || !p || p.length > 400) return null;
    if (p.includes('\\') || p.includes('\0') || p.startsWith('/') || /^[A-Za-z]:/.test(p)) return null;
    const parts = p.split('/');
    if (parts.some((s) => !s || s === '.' || s === '..')) return null;
    return parts.join('/');
}

// --- which release ------------------------------------------------------------

/**
 * `url` if it is one file of release `tag` of this repository, else null.
 * Judged as it will be fetched: the URL must already be in normal form (no `.`
 * or `..` segment, backslash or percent-escape the parser would rewrite), have
 * the prefix's exact origin and no user, query or fragment, and be the prefix's
 * path plus the tag plus ONE plain file name, exactly `name` when given. A
 * prefix test on the raw string passes a URL that normalises into another
 * repository.
 * server/version.js keeps a copy (the Docker image ships no desktop/);
 * app-update-gates checks the two agree.
 */
export function releaseAssetUrl(url, { downloadPrefix, tag, name: want }) {
    if (typeof url !== 'string' || typeof tag !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(tag)) return null;
    if (/%2e|%2f|%5c|\\/i.test(url)) return null;
    let u, base;
    try { u = new URL(url); base = new URL(downloadPrefix); } catch { return null; }
    if (u.href !== url || u.origin !== base.origin || u.username || u.password || u.search || u.hash) return null;
    const folder = `${base.pathname.replace(/\/*$/, '/')}${tag}/`;
    if (!u.pathname.startsWith(folder)) return null;
    const name = u.pathname.slice(folder.length);
    if (want !== undefined && name !== want) return null;
    return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.includes('..') ? url : null;
}

/**
 * A manifest is used only if it is the one the update check pointed at, for the
 * version it offered, and every URL in it is a download of THIS repository's
 * release with that tag. Returns the platform's asset or throws a reason a
 * person can read. `downloadPrefix` is `<repo>/releases/download/`.
 */
export function assertManifest(manifest, { version, tag, platform, downloadPrefix }) {
    if (!manifest || typeof manifest !== 'object' || manifest.schema !== 1) throw new Error('The release manifest is not one this version can read.');
    if (manifest.app !== 'Terramentor') throw new Error('The release manifest is for another app.');
    if (manifest.version !== version || manifest.tag !== tag) {
        throw new Error(`The release manifest says ${manifest.version}, but the update check offered ${version}.`);
    }
    const asset = manifest.assets && manifest.assets[platform];
    if (!asset) throw new Error(`Release ${version} has no package for ${platform}.`);
    // The one file tools/release.mjs names for this version and platform; the
    // name also becomes the download's file name on disk.
    if (asset.name !== `Terramentor-${version}-${platform}.zip`) throw new Error('The release manifest does not name this version\'s package.');
    if (!releaseAssetUrl(asset.url, { downloadPrefix, tag })) {
        throw new Error('The release manifest points outside this repository\'s releases.');
    }
    if (!releaseAssetUrl(asset.url, { downloadPrefix, tag, name: asset.name })) {
        throw new Error('The release manifest points at another file than this version\'s package.');
    }
    if (!/^[0-9a-f]{64}$/.test(asset.sha256 || '') || !(asset.size > 0)) throw new Error('The release manifest has no checksum for the package.');
    if (asset.files !== undefined) {
        const f = asset.files;
        if (!f || safeRelPath(f.path) !== f.path || !/^[0-9a-f]{64}$/.test(f.sha256 || '') || !(f.size > 0)) {
            throw new Error('The release manifest describes its file list in a way this version cannot read.');
        }
    }
    return asset;
}

/**
 * files.json as build-desktop writes it: `{schema:1, version, files:[{path,
 * size, sha256, exec?}]}`. Paths are relative to the app folder. Throws on
 * anything malformed, a duplicate or a path that would escape the folder.
 */
export function parseFileList(text, { version } = {}) {
    let list;
    try { list = JSON.parse(text); } catch { throw new Error('The release\'s file list is not valid JSON.'); }
    if (!list || list.schema !== 1 || !Array.isArray(list.files)) throw new Error('The release\'s file list is not one this version can read.');
    if (version && list.version !== version) throw new Error(`The file list is for ${list.version}, not ${version}.`);
    const seen = new Set();
    const files = [];
    for (const f of list.files) {
        const path = safeRelPath(f && f.path);
        if (!path || seen.has(path.toLowerCase())) throw new Error(`The file list names "${f && f.path}" twice or unsafely.`);
        if (!/^[0-9a-f]{64}$/.test(f.sha256 || '') || !Number.isSafeInteger(f.size) || f.size < 0) throw new Error(`The file list has no checksum for ${path}.`);
        if (NEVER_MOVED.has(path.split('/')[0])) throw new Error(`The file list reaches into ${path.split('/')[0]}, which an update never touches.`);
        seen.add(path.toLowerCase());
        files.push({ path, size: f.size, sha256: f.sha256, exec: f.exec === true });
    }
    return { version: list.version, files };
}

// --- hashing --------------------------------------------------------------------

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export function sha256File(file) {
    return new Promise((resolve, reject) => {
        const h = createHash('sha256');
        createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
    });
}

// --- the zip, read from the far end ------------------------------------------------
//
// A zip ends with its table of contents (the central directory), and each
// entry there says where its bytes start. So the table and any one file can be
// read with HTTP Range requests without the rest of the archive: between two
// real releases 363 of 6,857 entries changed, 8.0 MB of a 119 MB zip.

const EOCD = 0x06054b50, EOCD64 = 0x06064b50, CDH = 0x02014b50, LFH = 0x04034b50;

/** How many bytes from the end hold the end record: 22 bytes, a comment of up
 *  to 64 KB, and a zip64 locator and record before it. */
export const TAIL_BYTES = 66000 + 98;

/** Where the central directory is, from the archive's last `tail` bytes. */
export function readEndRecord(tail, total) {
    for (let i = tail.length - 22; i >= 0; i--) {
        if (tail.readUInt32LE(i) !== EOCD) continue;
        let count = tail.readUInt16LE(i + 10);
        let size = tail.readUInt32LE(i + 12);
        let offset = tail.readUInt32LE(i + 16);
        if (offset === 0xffffffff || count === 0xffff) {
            const z = i - 20 - 56;
            if (z < 0 || tail.readUInt32LE(z) !== EOCD64) throw new Error('The package is a zip64 archive this version cannot read.');
            count = Number(tail.readBigUInt64LE(z + 32));
            size = Number(tail.readBigUInt64LE(z + 40));
            offset = Number(tail.readBigUInt64LE(z + 48));
        }
        if (offset + size > total) throw new Error('The package\'s table of contents points past its end.');
        return { count, size, offset };
    }
    throw new Error('The package is not a zip archive.');
}

/** Every entry of a central directory, with the byte range its data lies in
 *  (`start` to the next entry's start, or to the directory itself). */
export function readCentralDirectory(cd, cdOffset) {
    const entries = [];
    let p = 0;
    while (p + 46 <= cd.length && cd.readUInt32LE(p) === CDH) {
        const nlen = cd.readUInt16LE(p + 28), xlen = cd.readUInt16LE(p + 30), clen = cd.readUInt16LE(p + 32);
        entries.push({
            name: cd.toString('utf8', p + 46, p + 46 + nlen),
            method: cd.readUInt16LE(p + 10),
            crc: cd.readUInt32LE(p + 16),
            csize: cd.readUInt32LE(p + 20),
            usize: cd.readUInt32LE(p + 24),
            start: cd.readUInt32LE(p + 42),
        });
        p += 46 + nlen + xlen + clen;
    }
    const byStart = [...entries].sort((a, b) => a.start - b.start);
    for (let i = 0; i < byStart.length; i++) byStart[i].end = i + 1 < byStart.length ? byStart[i + 1].start : cdOffset;
    return entries;
}

/** The archive's single top folder (`Terramentor-1.4.0-win32-x64/`), which
 *  every path in files.json leaves out. */
export function topFolder(entries) {
    const first = entries.find((e) => e.name.includes('/'));
    const top = first ? first.name.slice(0, first.name.indexOf('/') + 1) : '';
    return top && entries.every((e) => e.name.startsWith(top)) ? top : '';
}

/** One entry's file bytes out of a buffer that starts at its local header. */
export function entryBytes(entry, buf) {
    if (buf.length < 30 || buf.readUInt32LE(0) !== LFH) throw new Error(`The package is damaged at ${entry.name}.`);
    const at = 30 + buf.readUInt16LE(26) + buf.readUInt16LE(28);
    const raw = buf.subarray(at, at + entry.csize);
    if (raw.length !== entry.csize) throw new Error(`The package is cut short at ${entry.name}.`);
    let out;
    if (entry.method === 0) out = raw;
    // Inflated to the size the table of contents states and no further, so a
    // small entry that would inflate to gigabytes is refused, not held.
    else if (entry.method === 8) {
        try { out = inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.usize) }); } catch { out = null; }
    } else throw new Error(`${entry.name} is compressed in a way this version cannot read.`);
    if (!out || out.length !== entry.usize) throw new Error(`The package is damaged at ${entry.name}.`);
    return out;
}

/**
 * Merge entry ranges into as few requests as is sensible: two ranges become one
 * when the bytes between them cost less than another round trip would
 * (`gap`), and no request grows past `max` so a failure loses little.
 */
export function coalesce(entries, { gap = 256 * 1024, max = 16 * 1024 * 1024 } = {}) {
    const sorted = [...entries].sort((a, b) => a.start - b.start);
    const groups = [];
    for (const e of sorted) {
        const g = groups[groups.length - 1];
        if (g && e.start - g.end <= gap && e.end - g.start <= max) {
            g.end = Math.max(g.end, e.end);
            g.entries.push(e);
        } else {
            groups.push({ start: e.start, end: e.end, entries: [e] });
        }
    }
    return groups;
}

// --- what to fetch -------------------------------------------------------------------

/**
 * Split the next version's files into those the install already has and those
 * that must be downloaded. `installed` is the running version's own file list
 * (or null), and it is only a HINT: a file it claims unchanged is hashed on
 * disk before it is reused (`reuse`), because a damaged install must not be
 * carried forward into the next one.
 */
export function planFiles(next, installed) {
    const have = new Map((installed?.files || []).map((f) => [f.path, f]));
    const reuse = [], fetch = [];
    for (const f of next.files) {
        const h = have.get(f.path);
        (h && h.sha256 === f.sha256 && h.size === f.size ? reuse : fetch).push(f);
    }
    return { reuse, fetch, fetchBytes: fetch.reduce((n, f) => n + f.size, 0) };
}

// --- the swap ---------------------------------------------------------------------

/** Which top-level names belong to the app: everything either version's file
 *  list names, nothing the swap must leave alone. */
export function appTopLevel(...lists) {
    // files.json belongs to the app too, though no list can name itself.
    const names = new Set(['files.json']);
    for (const list of lists) for (const f of list?.files || []) names.add(f.path.split('/')[0]);
    for (const n of NEVER_MOVED) names.delete(n);
    return [...names].sort();
}

/**
 * Rename with patience. On Windows a file the antivirus or the indexer has
 * just opened refuses a rename for a moment (EBUSY/EPERM/EACCES), and the
 * process that held the app's files can take a beat to let go after it exits.
 */
export async function renameWithRetry(from, to, { tries = 40, delayMs = 250, rename = renameSync } = {}) {
    for (let i = 1; ; i++) {
        try { rename(from, to); return; } catch (e) {
            if (i >= tries || !['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(e.code)) throw e;
            await new Promise((r) => setTimeout(r, delayMs));
        }
    }
}

/**
 * Trade the app's top-level entries for the staged ones. Every rename is
 * written to `journal` BEFORE it is made, so a swap cut short (power, a kill)
 * can be undone by `undoSwap` from the journal alone. Returns the journal.
 * Throws after undoing what it did if a rename keeps failing.
 */
export async function swapIn({ appRoot, nextDir, previousDir, names, journalFile, rename }) {
    const journal = { moves: [] };
    const save = () => writeFileSync(journalFile, JSON.stringify(journal));
    rmSync(previousDir, { recursive: true, force: true });
    mkdirSync(previousDir, { recursive: true });
    save();
    try {
        for (const n of names) {
            if (!existsSync(join(appRoot, n))) continue;
            journal.moves.push({ from: join(appRoot, n), to: join(previousDir, n) });
            save();
            await renameWithRetry(join(appRoot, n), join(previousDir, n), { rename });
        }
        for (const n of readdirSync(nextDir)) {
            if (NEVER_MOVED.has(n)) continue;
            // Anything still standing where this goes is set aside first, never
            // overwritten: a rename onto a file replaces it with no trace in the
            // journal, and the undo would then leave nothing there at all (it
            // did to files.json, which turned one-click updates off after a
            // rollback).
            if (existsSync(join(appRoot, n))) {
                journal.moves.push({ from: join(appRoot, n), to: join(previousDir, n) });
                save();
                await renameWithRetry(join(appRoot, n), join(previousDir, n), { rename });
            }
            journal.moves.push({ from: join(nextDir, n), to: join(appRoot, n) });
            save();
            await renameWithRetry(join(nextDir, n), join(appRoot, n), { rename });
        }
    } catch (e) {
        await undoSwap({ journal, journalFile, rename });
        throw e;
    }
    return journal;
}

/** Undo a swap from its journal, last move first. A move that never happened
 *  (its target absent) is skipped, so it is safe on a swap cut short anywhere.
 *  The staged files go back to `nextDir`, which a failed version keeps for the
 *  report and a retry. */
export async function undoSwap({ journal, journalFile, rename }) {
    for (const m of [...journal.moves].reverse()) {
        if (!existsSync(m.to)) continue;
        // Moves are undone newest first, so nothing should stand where this one
        // goes back to. If something does, it is set aside rather than deleted:
        // an undo must never be the step that destroys a file.
        if (existsSync(m.from)) await renameWithRetry(m.from, `${m.from}.stray-${Date.now()}`, { rename });
        mkdirSync(dirname(m.from), { recursive: true });
        await renameWithRetry(m.to, m.from, { rename });
    }
    if (journalFile) rmSync(journalFile, { force: true });
}

/** Check a staged tree against its file list: every file present, the right
 *  size and hash, nothing extra but `allow` (the list itself, which cannot name
 *  its own hash). Returns the first problem or null. */
export async function verifyTree(dir, list, { allow = ['files.json'], linkedFrom = null } = {}) {
    const want = new Map(list.files.map((f) => [f.path, f]));
    for (const a of allow) want.set(a, null);
    for (const f of list.files) {
        const p = join(dir, ...f.path.split('/'));
        if (allow.includes(f.path)) continue;
        let st;
        try { st = statSync(p, { bigint: true }); } catch { return `${f.path} is missing`; }
        if (!st.isFile() || st.size !== BigInt(f.size)) return `${f.path} has the wrong size`;
        // A staged file that is still a hard link to the installed copy was
        // hashed against this list when it was staged, and is the same file on
        // disk now: reading it again would only cost time (on a hard disk,
        // ~40 s for 6,000 files cold), and the restart is when the person waits.
        if (linkedFrom && sameFile(st, join(linkedFrom, ...f.path.split('/')))) continue;
        if (await sha256File(p) !== f.sha256) return `${f.path} does not match the release`;
    }
    const walk = (rel) => {
        for (const d of readdirSync(join(dir, ...rel.split('/').filter(Boolean)), { withFileTypes: true })) {
            const r = rel ? `${rel}/${d.name}` : d.name;
            if (d.isDirectory()) { const extra = walk(r); if (extra) return extra; }
            else if (!want.has(r)) return `${r} is not part of the release`;
        }
        return null;
    };
    return walk('');
}

/** Whether `other` is the very file `st` describes: same volume, same file id. */
function sameFile(st, other) {
    try {
        const o = statSync(other, { bigint: true });
        return o.ino !== 0n && o.ino === st.ino && o.dev === st.dev;
    } catch {
        return false;
    }
}

export const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
