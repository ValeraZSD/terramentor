/**
 * A whole library as ONE file: a zip of per-project `.studyvault` bundles.
 *
 * The bundle format holds exactly one project (one manifest, one `media/`
 * folder, one `blobs/` folder), and the door that reads it is the only parser
 * there is. So a library is not a second format; it is the existing bundles
 * laid side by side, with a small `library.json` saying which they are. Reading
 * one back hands each inner bundle to the very same importer, so nothing about
 * a course (its media, its uuids, its bounds) is decided twice.
 *
 *   library.json                       { kind, exported_at, projects: [{file, name}] }
 *   projects/001-<name>.studyvault     a complete bundle, stored (already deflated)
 *
 * The app no longer WRITES one: its export route had no caller left and was
 * removed. It still READS them, so a library exported by an earlier build
 * imports.
 */
export const LIBRARY_MANIFEST = 'library.json';
export const LIBRARY_KIND = 'terramentor-library';
/** More projects than anyone holds; a bound on the loop, not a product limit. */
export const MAX_LIBRARY_PROJECTS = 1000;
/** Where an inner bundle may live. One level, no separators in the name, so a
 *  crafted entry name can never name a path. */
const ENTRY_RE = /^projects\/[^/\\]+\.studyvault$/;

export class LibraryError extends Error {}

/**
 * Read `library.json`. Valid JSON is not yet a library: anything that is not
 * the marker plus a list of well-named entries is refused, and the list is the
 * only thing the importer will open, so an entry the manifest does not name is
 * never read.
 *
 * @returns {{ file: string, name: string }[]}
 */
export function parseLibraryManifest(raw) {
    let manifest;
    try { manifest = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)); }
    catch { throw new LibraryError('library.json is not valid JSON'); }
    if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest) || manifest.kind !== LIBRARY_KIND) {
        throw new LibraryError('library.json is not a Terramentor library manifest');
    }
    if (!Array.isArray(manifest.projects)) throw new LibraryError('"projects" in library.json must be a list');
    if (manifest.projects.length > MAX_LIBRARY_PROJECTS) {
        throw new LibraryError(`this library lists more than ${MAX_LIBRARY_PROJECTS} projects`);
    }
    const seen = new Set();
    const out = [];
    for (const p of manifest.projects) {
        const file = p && typeof p === 'object' ? p.file : null;
        if (typeof file !== 'string' || !ENTRY_RE.test(file)) throw new LibraryError('library.json names a file that is not a project bundle');
        if (seen.has(file)) continue;
        seen.add(file);
        out.push({ file, name: typeof p.name === 'string' && p.name.trim() ? p.name.trim().slice(0, 200) : file });
    }
    return out;
}
