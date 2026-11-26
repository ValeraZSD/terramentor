// A course carried inside a link.
//
// A course file is JSON (`{ project, nodes }`). Packed with the browser's own
// deflate and written in URL-safe base64, it fits in the part of an address
// after `#`: a 160 KB word course becomes a 22 KB link. That part is never sent
// in a request, so the page that opens the link reads the course and the
// server that served the page never sees it. No upload, no host, no account.
//
// A link is `<page>#course=1.<data>`. The `1.` names this packing, so a later
// one can be told apart instead of read as damage.
//
// Reading is bounded twice: the link's length before anything is unpacked, and
// the unpacked bytes while they stream, so a small link that inflates to
// gigabytes stops at the cap.

export const COURSE_LINK_PARAM = 'course';
const FORMAT = '1';

/** Longest `data` part read (characters). Far above any course a link is meant for. */
export const MAX_LINK_CHARS = 2_000_000;
/** Largest course a link may unpack to (bytes), far above any course a link is meant for. */
export const MAX_COURSE_BYTES = 8 * 1024 * 1024;

export type CourseLinkProblem = 'not-a-link' | 'newer-format' | 'too-large' | 'damaged' | 'not-a-course' | 'unsupported';

/** Why a link could not be read; `problem` is what the screen says. */
export class CourseLinkError extends Error {
    constructor(public problem: CourseLinkProblem) {
        super(problem);
        this.name = 'CourseLinkError';
    }
}

/** The fields a course file must have before it is worth handing to the importer. */
export function looksLikeCourse(data: unknown): data is { project: { name: string }; nodes: unknown[] } {
    const d = data as any;
    return !!d && typeof d === 'object' && typeof d.project?.name === 'string' && d.project.name.trim() !== '' && Array.isArray(d.nodes);
}

function toBase64Url(bytes: Uint8Array): string {
    let binary = '';
    // In slices: one String.fromCharCode over 100k arguments overflows the stack.
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
    const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

async function readAll(stream: ReadableStream<Uint8Array>, cap: number): Promise<Uint8Array> {
    const reader = stream.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > cap) {
            await reader.cancel().catch(() => {});
            throw new CourseLinkError('too-large');
        }
        parts.push(value);
    }
    const out = new Uint8Array(size);
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.byteLength; }
    return out;
}

/** The `1.<data>` part for a course file, ready to put after `#course=`. */
export async function packCourse(data: unknown): Promise<string> {
    if (!looksLikeCourse(data)) throw new CourseLinkError('not-a-course');
    const json = new TextEncoder().encode(JSON.stringify(data));
    const packed = new Blob([json]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return `${FORMAT}.${toBase64Url(await readAll(packed, Infinity))}`;
}

/** A whole link: `page` with any old `#…` replaced by the course. */
export function courseLinkFor(page: string, packed: string): string {
    return `${page.replace(/#.*$/, '')}#${COURSE_LINK_PARAM}=${packed}`;
}

/** Ways to read the packed course out of `text`, likeliest first; empty when it holds none. */
export function packedCourseReadings(text: string): string[] {
    // An app that escaped the link writes `course%3D`; a wrapped one may break
    // the name itself over two lines.
    const s = String(text || '').replace(/%3D/gi, '=');
    const name = COURSE_LINK_PARAM.split('').join('\\s*');
    const at = new RegExp(`(?:^|[#&?\\s])${name}\\s*=`).exec(s);
    if (!at) return [];
    const rest = s.slice(at.index + at[0].length);
    const head = /^\s*(\d+)\s*\.\s*/.exec(rest);
    if (!head) {
        const bare = /^[^\s&#]+/.exec(rest);
        return bare ? [bare[0]] : [];
    }
    // The data is a run of URL-safe base64 that messaging apps break over
    // lines. It ends at the first character no link carries (`!`, `>`, a
    // sentence's last `.`), at `&` or `#`, or where the line breaks stop.
    const runs: string[] = [];
    let tail = rest.slice(head[0].length);
    let size = 0;
    for (;;) {
        const run = /^([A-Za-z0-9_-]+)\s*/.exec(tail);
        if (!run) break;
        runs.push(run[1]);
        size += run[1].length;
        tail = tail.slice(run[0].length);
        if (size > MAX_LINK_CHARS) break;
    }
    if (runs.length === 0) return [`${head[1]}.`];
    // A word typed after the link ("…xyz thanks") looks like one more line of
    // it, so readings that leave the last few runs off follow the whole one.
    const readings: string[] = [];
    for (let n = runs.length; n >= Math.max(1, runs.length - 3); n--) readings.push(`${head[1]}.${runs.slice(0, n).join('')}`);
    return readings;
}

/**
 * The packed course inside whatever was pasted or opened: a full link, the
 * part after `#`, or `course=…` alone, with any line breaks a messaging app
 * put in it dropped. Null when there is none.
 */
export function packedCourseIn(text: string): string | null {
    return packedCourseReadings(text)[0] ?? null;
}

/** Whether this browser can unpack a link at all (deflate-raw: Safari 16.4+, Chrome 103+, Firefox 113+). */
export function canUnpackLinks(): boolean {
    try {
        new DecompressionStream('deflate-raw');
        return true;
    } catch {
        return false;
    }
}

/**
 * The course in pasted or opened text, trying each reading of it in turn.
 * Throws `CourseLinkError` with the reason the likeliest reading failed.
 */
export async function courseFromText(text: string): Promise<{ project: { name: string }; nodes: unknown[] }> {
    const readings = packedCourseReadings(text);
    if (readings.length === 0) throw new CourseLinkError('not-a-link');
    if (!canUnpackLinks()) throw new CourseLinkError('unsupported');
    let first: unknown = null;
    for (const packed of readings) {
        try {
            return await unpackCourse(packed);
        } catch (e) {
            first ??= e;
        }
    }
    throw first;
}

/** The course file a link carries. Throws `CourseLinkError` with the reason. */
export async function unpackCourse(packed: string): Promise<{ project: { name: string }; nodes: unknown[] }> {
    const dot = packed.indexOf('.');
    if (dot < 1) throw new CourseLinkError('not-a-link');
    const format = packed.slice(0, dot);
    const data = packed.slice(dot + 1);
    if (format !== FORMAT) throw new CourseLinkError(/^\d+$/.test(format) ? 'newer-format' : 'not-a-link');
    if (data.length > MAX_LINK_CHARS) throw new CourseLinkError('too-large');
    if (!/^[A-Za-z0-9_-]+$/.test(data)) throw new CourseLinkError('damaged');
    let bytes: Uint8Array;
    try {
        bytes = fromBase64Url(data);
    } catch {
        throw new CourseLinkError('damaged');
    }
    let json: Uint8Array;
    try {
        json = await readAll(new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw')), MAX_COURSE_BYTES);
    } catch (e) {
        if (e instanceof CourseLinkError) throw e;
        // A link cut short by a messaging app ends mid-stream.
        throw new CourseLinkError('damaged');
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(json));
    } catch {
        throw new CourseLinkError('damaged');
    }
    if (!looksLikeCourse(parsed)) throw new CourseLinkError('not-a-course');
    return parsed;
}
