// src/utils/courseBundle.ts
// What a .studyvault file holds, read in the page before anything is imported:
// one course (`manifest.json`, the same `{ project, nodes }` a course file or
// link carries), or a whole library's list of courses (`library.json`).
// Formats: server/routes/bundle.js and server/libraryArchive.js.
//
// The file is someone else's, so it is read the way the server reads one: only
// the entry asked for, sliced out of the file (so a large file is never held in
// memory whole), and inflated against a ceiling while it streams, so an entry
// that claims a few bytes and inflates to gigabytes stops at the cap. This only
// SHOWS the file: the importer on the server reads and vets it again from the
// start.

import { CourseLinkError, canUnpackLinks, looksLikeCourse, readAll } from './courseLink';

/** The server's own ceilings for these two entries (server/bundleCourse.js, routes/bundle.js). */
export const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
export const MAX_LIBRARY_LIST_BYTES = 4 * 1024 * 1024;
/** The end record: 22 bytes, then a comment of at most 65,535. */
const END_RECORD = 22;
const END_SEARCH = END_RECORD + 0xffff;
/** Largest directory read: the server's 20,000 entries, with long names. */
const MAX_DIRECTORY_BYTES = 16 * 1024 * 1024;
/** Most courses a library lists, as on the server (MAX_LIBRARY_PROJECTS). */
const MAX_LIBRARY_COURSES = 1000;

export type BundleContents =
    | { kind: 'course'; data: { project: { name: string }; nodes: unknown[] } }
    | { kind: 'library'; count: number };

interface Entry { flags: number; method: number; compressed: number; size: number; local: number }

const damaged = () => new CourseLinkError('damaged');

async function bytesOf(file: Blob, start: number, end: number): Promise<{ bytes: Uint8Array; view: DataView }> {
    const bytes = new Uint8Array(await file.slice(start, end).arrayBuffer());
    return { bytes, view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
}

/** The directory's entries for `wanted`, by name. A name listed twice is
 *  refused: the importer would read one of the two, and this must show the
 *  one it reads. */
async function entriesNamed(file: Blob, wanted: string[]): Promise<Map<string, Entry>> {
    const tailStart = Math.max(0, file.size - END_SEARCH);
    const tail = await bytesOf(file, tailStart, file.size);
    let end = -1;
    for (let i = tail.bytes.length - END_RECORD; i >= 0; i--) {
        if (tail.view.getUint32(i, true) === 0x06054b50) { end = i; break; }
    }
    if (end < 0) throw damaged();
    const count = tail.view.getUint16(end + 10, true);
    const dirSize = tail.view.getUint32(end + 12, true);
    const dirStart = tail.view.getUint32(end + 16, true);
    // The 64-bit marks: nothing the app writes needs them.
    if (count === 0xffff || dirSize === 0xffffffff || dirStart === 0xffffffff) throw damaged();
    if (dirSize > MAX_DIRECTORY_BYTES || dirStart + dirSize > tailStart + end) throw damaged();

    const dir = await bytesOf(file, dirStart, dirStart + dirSize);
    const names = new TextDecoder();
    const found = new Map<string, Entry>();
    for (let at = 0, n = 0; n < count; n++) {
        if (at + 46 > dir.bytes.length || dir.view.getUint32(at, true) !== 0x02014b50) throw damaged();
        const nameLength = dir.view.getUint16(at + 28, true);
        const next = at + 46 + nameLength + dir.view.getUint16(at + 30, true) + dir.view.getUint16(at + 32, true);
        if (next > dir.bytes.length) throw damaged();
        const name = names.decode(dir.bytes.subarray(at + 46, at + 46 + nameLength));
        if (wanted.includes(name)) {
            if (found.has(name)) throw damaged();
            found.set(name, {
                flags: dir.view.getUint16(at + 8, true),
                method: dir.view.getUint16(at + 10, true),
                compressed: dir.view.getUint32(at + 20, true),
                size: dir.view.getUint32(at + 24, true),
                local: dir.view.getUint32(at + 42, true),
            });
        }
        at = next;
    }
    return found;
}

/** One entry's bytes, refused as 'too-large' past `cap`, whatever its header claims. */
async function contentOf(file: Blob, entry: Entry, cap: number): Promise<Uint8Array> {
    if (entry.flags & 1) throw damaged(); // encrypted
    if (entry.size > cap) throw new CourseLinkError('too-large');
    const head = await bytesOf(file, entry.local, entry.local + 30);
    if (head.bytes.length < 30 || head.view.getUint32(0, true) !== 0x04034b50) throw damaged();
    const start = entry.local + 30 + head.view.getUint16(26, true) + head.view.getUint16(28, true);
    const end = start + entry.compressed;
    if (end > file.size) throw damaged();
    const raw = file.slice(start, end);
    if (entry.method === 0) {
        if (entry.compressed > cap) throw new CourseLinkError('too-large');
        return new Uint8Array(await raw.arrayBuffer());
    }
    if (entry.method !== 8) throw damaged();
    if (!canUnpackLinks()) throw new CourseLinkError('unsupported');
    try {
        return await readAll(raw.stream().pipeThrough(new DecompressionStream('deflate-raw')), cap);
    } catch (e) {
        if (e instanceof CourseLinkError) throw e;
        throw damaged();
    }
}

function jsonOf(bytes: Uint8Array): unknown {
    try {
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
        throw damaged();
    }
}

/**
 * The course, or the library's list of courses, in a .studyvault file. Throws
 * `CourseLinkError`: 'damaged' (not a readable archive), 'too-large',
 * 'not-a-course' (an archive that holds neither) or 'unsupported'.
 */
export async function readCourseBundle(file: Blob): Promise<BundleContents> {
    const entries = await entriesNamed(file, ['manifest.json', 'library.json']);
    // The importer's order: a manifest makes the file one course (routes/bundle.js).
    const course = entries.get('manifest.json');
    if (course) {
        const data = jsonOf(await contentOf(file, course, MAX_MANIFEST_BYTES));
        if (!looksLikeCourse(data)) throw new CourseLinkError('not-a-course');
        return { kind: 'course', data };
    }
    const library = entries.get('library.json');
    if (library) {
        const list = jsonOf(await contentOf(file, library, MAX_LIBRARY_LIST_BYTES)) as any;
        if (list?.kind !== 'terramentor-library' || !Array.isArray(list.projects) || list.projects.length === 0) {
            throw new CourseLinkError('not-a-course');
        }
        // Each course once, as the importer counts them (libraryArchive.js).
        const files = new Set(list.projects.map((p: any) => (typeof p?.file === 'string' ? p.file : '')));
        return { kind: 'library', count: Math.min(files.size, MAX_LIBRARY_COURSES) };
    }
    throw new CourseLinkError('not-a-course');
}
