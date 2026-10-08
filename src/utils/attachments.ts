/**
 * Files attached to the assistant chat — the client half of
 * server/chatAttachments.js.
 *
 * Two things live here because they must be decided the same way wherever they
 * are asked, and are testable without a browser
 * (tools/chat-attachments-gates.mjs):
 *
 *   - what the composer refuses BEFORE uploading anything, with the reason the
 *     learner sees: a file over the cap, one too many, a HEIC photo copied off
 *     a phone (the browser cannot draw it and no model is sent it), a video, a
 *     sound, an archive or a program. Everything else is uploaded and the
 *     SERVER decides by the bytes — this list only saves a learner waiting for
 *     an upload whose answer is already known;
 *   - the `[[img:ID#PART]]` marker an answer uses to show a part of an attached
 *     picture, parsed into pieces so the picture is drawn WHERE the answer put
 *     it, between its paragraphs.
 */

/** Files one message may carry. Mirrors `ATTACH_MAX_FILES` on the server. */
export const ATTACH_MAX_FILES = 10;
/** One file. Mirrors `ATTACH_MAX_BYTES` (the vault's per-file cap). */
export const ATTACH_MAX_BYTES = 25 * 1024 * 1024;

export type RefusalReason = 'too_many' | 'too_large' | 'heic' | 'unsupported' | 'empty';

export interface FileLike { name: string; size: number; type: string }

/** Pictures a model is sent, by MIME type and by extension. */
const PICTURE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const PICTURE_EXT = /\.(jpe?g|png|webp|gif)$/i;
const HEIC = /\.(heic|heif)$/i;
/** What no reader here takes: sound, video, archives, programs, disk images. */
const NEVER_EXT = /\.(mp4|mov|m4v|avi|mkv|webm|wmv|flv|3gp|mp3|m4a|wav|ogg|oga|flac|aac|opus|wma|zip|rar|7z|tar|gz|tgz|bz2|xz|exe|msi|dll|dmg|pkg|apk|ipa|iso|bin|jar)$/i;
const NEVER_TYPE = /^(video|audio)\/|^application\/(zip|x-zip-compressed|x-rar-compressed|vnd\.rar|x-7z-compressed|x-tar|gzip|x-msdownload|x-msi|x-apple-diskimage|vnd\.android\.package-archive|java-archive)$/i;

/** Is this file a picture (as far as its name and type can say)? */
export function isPicture(file: Pick<FileLike, 'name' | 'type'>): boolean {
    return PICTURE_TYPES.has((file.type || '').toLowerCase()) || PICTURE_EXT.test(file.name || '');
}

/** Is this a HEIC/HEIF photo (what an iPhone keeps)? */
export function isHeicFile(file: Pick<FileLike, 'name' | 'type'>): boolean {
    const type = (file.type || '').toLowerCase();
    return HEIC.test(file.name || '') || type === 'image/heic' || type === 'image/heif';
}

/**
 * Why this one file can't be attached, or null when it may be uploaded.
 * `convertHeic`: the caller will try to redraw a HEIC photo as a JPEG
 * (src/utils/attachImage.ts) and refuse it itself if the browser cannot.
 */
export function refusalFor(file: FileLike, { convertHeic = false } = {}): RefusalReason | null {
    const type = (file.type || '').toLowerCase();
    if (isHeicFile(file)) {
        if (!convertHeic) return 'heic';
    } else if (NEVER_EXT.test(file.name || '') || NEVER_TYPE.test(type)) {
        return 'unsupported';
    }
    if (!file.size) return 'empty';
    // A HEIC photo is measured AFTER it is redrawn, which makes it smaller.
    if (file.size > ATTACH_MAX_BYTES && !(convertHeic && isHeicFile(file))) return 'too_large';
    return null;
}

/**
 * Split picked files into what may be uploaded and what is refused, with each
 * refusal's reason. `already` is how many files the composer holds.
 */
export function preflightFiles<F extends FileLike>(files: F[], already: number, opts: { convertHeic?: boolean } = {}): {
    accepted: F[];
    refused: { name: string; reason: RefusalReason }[];
} {
    const accepted: F[] = [];
    const refused: { name: string; reason: RefusalReason }[] = [];
    for (const f of files) {
        const reason = refusalFor(f, opts);
        if (reason) { refused.push({ name: f.name, reason }); continue; }
        if (already + accepted.length >= ATTACH_MAX_FILES) { refused.push({ name: f.name, reason: 'too_many' }); continue; }
        accepted.push(f);
    }
    return { accepted, refused };
}

// ---- paste and drop ---------------------------------------------------------------

interface ClipboardLike {
    files?: ArrayLike<File> | null;
    items?: ArrayLike<{ kind: string; getAsFile(): File | null }> | null;
}

/**
 * The files a paste carries: a screenshot, or a file copied in Explorer or
 * Finder. Chromium and Firefox list them in `files`; an older WebKit only as a
 * `kind: 'file'` item. Text on the clipboard yields nothing, so the paste stays
 * a text paste.
 */
export function pastedFiles(data: ClipboardLike | null | undefined): File[] {
    const files = Array.from(data?.files ?? []);
    if (files.length) return files;
    return Array.from(data?.items ?? [])
        .filter(item => item.kind === 'file')
        .map(item => item.getAsFile())
        .filter((f): f is File => !!f);
}

/** Does this drag carry files? Dragged text or a link must stay a text drag. */
export function isFileDrag(types: ArrayLike<string> | null | undefined): boolean {
    return Array.from(types ?? []).includes('Files');
}

/**
 * How deep a file drag is inside the panel: enter on a child fires before
 * leave on its parent, so the count stays above 0 while the pointer crosses the
 * panel and the overlay never flickers. A drop or a cancelled drag ends it.
 */
export function nextDragDepth(depth: number, event: 'enter' | 'leave' | 'drop' | 'end'): number {
    if (event === 'enter') return depth + 1;
    if (event === 'leave') return Math.max(0, depth - 1);
    return 0;
}

// ---- the picture marker ---------------------------------------------------------

export interface ImageMarker {
    attachmentId: number;
    /** The part to box, as fractions of the picture [x0, y0, x1, y1], or null for the whole picture. */
    box: [number, number, number, number] | null;
    /** The model's name for the part, drawn beside the box. */
    label: string | null;
}

export type AnswerSegment = { kind: 'text'; text: string } | ({ kind: 'image' } & ImageMarker);

const MARKER_RE = /\[\[\s*img\s*:([^\]\n]*)\]\]/gi;
const ID_RE = /^\s*#?(\d{1,9})\s*$/;
/** A marker still arriving at the end of a streaming answer. */
const PARTIAL_RE = /\[\[[^\]\n]*\]?$/;

/**
 * The box a marker names, in thousandths of the picture as the model is told
 * to write it, as fractions — or null for one that is not four numbers, is
 * empty or inverted. Clamped into the picture.
 */
export function markerBox(raw: string | undefined): [number, number, number, number] | null {
    const nums = String(raw ?? '').split(/[\s,]+/).filter(Boolean).map(Number);
    if (nums.length !== 4 || !nums.every(Number.isFinite)) return null;
    const scale = Math.max(...nums) <= 1 ? 1 : 1000;
    const [x0, y0, x1, y1] = nums.map(n => Math.min(1, Math.max(0, n / scale)));
    return x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : null;
}

/**
 * Pull `[[img:ID|x0,y0,x1,y1|label]]` markers out of an answer. Every marker
 * comes OUT, whatever is in it; only one naming an id becomes a picture, and a
 * box that does not hold up draws the whole picture unboxed. `segments` keeps
 * the order, so the picture is drawn where the answer put it.
 */
export function splitImageMarkers(content: string, streaming = false): {
    body: string;
    markers: ImageMarker[];
    segments: AnswerSegment[];
} {
    let text = typeof content === 'string' ? content : '';
    if (streaming) text = text.replace(PARTIAL_RE, '');
    // No marker at all: the text comes back exactly as it was.
    if (!/\[\[\s*img\s*:/i.test(text)) return { body: text, markers: [], segments: text ? [{ kind: 'text', text }] : [] };
    const markers: ImageMarker[] = [];
    const segments: AnswerSegment[] = [];
    // Text runs on across a marker that draws nothing, so it stays one piece.
    let pending = '';
    const flush = () => { if (pending.trim()) segments.push({ kind: 'text', text: pending }); pending = ''; };
    let last = 0;
    for (const m of text.matchAll(MARKER_RE)) {
        pending += text.slice(last, m.index);
        last = (m.index ?? 0) + m[0].length;
        const [idPart, boxPart, ...labelParts] = m[1].split('|');
        const id = ID_RE.exec(idPart ?? '');
        if (!id || markers.length >= 4) continue;
        const box = markerBox(boxPart);
        const label = box ? labelParts.join('|').replace(/\s+/g, ' ').trim().slice(0, 80) || null : null;
        const marker: ImageMarker = { attachmentId: Number(id[1]), box, label };
        markers.push(marker);
        flush();
        segments.push({ kind: 'image', ...marker });
    }
    pending += text.slice(last);
    flush();
    const body = segments.filter((s): s is { kind: 'text'; text: string } => s.kind === 'text')
        .map(s => s.text).join('\n\n')
        .replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
    return { body, markers, segments };
}

/**
 * A long file name cut in the MIDDLE, so the end that says what it is
 * ("…equations.pdf") stays: "Chapter 2 - equa…" said nothing a reader could use.
 */
export function shortName(name: string, max = 24): string {
    if (name.length <= max) return name;
    const dot = name.lastIndexOf('.');
    const tail = Math.min(12, Math.max(6, dot > 0 ? name.length - dot + 5 : 6));
    return `${name.slice(0, max - tail - 1).trimEnd()}…${name.slice(-tail)}`;
}

/** "2.4 MB" / "830 KB", for a chip. */
export function sizeLabel(bytes: number, num: (n: number, opts?: Intl.NumberFormatOptions) => string = n => String(n)): string {
    if (bytes >= 1024 * 1024) return `${num(Math.round(bytes / 1024 / 1024 * 10) / 10)} MB`;
    return `${num(Math.max(1, Math.round(bytes / 1024)))} KB`;
}
