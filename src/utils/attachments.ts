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

/** Why this one file can't be attached, or null when it may be uploaded. */
export function refusalFor(file: FileLike): RefusalReason | null {
    const type = (file.type || '').toLowerCase();
    if (HEIC.test(file.name || '') || type === 'image/heic' || type === 'image/heif') return 'heic';
    if (NEVER_EXT.test(file.name || '') || NEVER_TYPE.test(type)) return 'unsupported';
    if (!file.size) return 'empty';
    if (file.size > ATTACH_MAX_BYTES) return 'too_large';
    return null;
}

/**
 * Split picked files into what may be uploaded and what is refused, with each
 * refusal's reason. `already` is how many files the composer holds.
 */
export function preflightFiles<F extends FileLike>(files: F[], already: number): {
    accepted: F[];
    refused: { name: string; reason: RefusalReason }[];
} {
    const accepted: F[] = [];
    const refused: { name: string; reason: RefusalReason }[] = [];
    for (const f of files) {
        const reason = refusalFor(f);
        if (reason) { refused.push({ name: f.name, reason }); continue; }
        if (already + accepted.length >= ATTACH_MAX_FILES) { refused.push({ name: f.name, reason: 'too_many' }); continue; }
        accepted.push(f);
    }
    return { accepted, refused };
}

// ---- the picture marker ---------------------------------------------------------

export interface ImageMarker {
    attachmentId: number;
    /** The part to box (`r1`…), or null for the whole picture. */
    regionId: string | null;
}

export type AnswerSegment = { kind: 'text'; text: string } | ({ kind: 'image' } & ImageMarker);

const MARKER_RE = /\[\[\s*img\s*:([^\]\n]*)\]\]/gi;
const VALID_RE = /^\s*(\d{1,9})\s*(?:#\s*(r\d{1,2}))?\s*$/i;
/** A marker still arriving at the end of a streaming answer. */
const PARTIAL_RE = /\[\[[a-z0-9:#\s-]*\]?$/i;

/**
 * Pull `[[img:ID#PART]]` markers out of an answer. Every marker comes OUT,
 * whatever is in it; only one of the exact shape becomes a picture. `segments`
 * keeps the order, so the picture is drawn where the answer put it.
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
    let last = 0;
    for (const m of text.matchAll(MARKER_RE)) {
        const before = text.slice(last, m.index);
        if (before.trim()) segments.push({ kind: 'text', text: before });
        last = (m.index ?? 0) + m[0].length;
        const v = VALID_RE.exec(m[1]);
        if (!v || markers.length >= 4) continue;
        const marker = { attachmentId: Number(v[1]), regionId: v[2] ? v[2].toLowerCase() : null };
        markers.push(marker);
        segments.push({ kind: 'image', ...marker });
    }
    const rest = text.slice(last);
    if (rest.trim()) segments.push({ kind: 'text', text: rest });
    const body = segments.filter((s): s is { kind: 'text'; text: string } => s.kind === 'text')
        .map(s => s.text).join('\n\n')
        .replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
    return { body, markers, segments };
}

/** "2.4 MB" / "830 KB", for a chip. */
export function sizeLabel(bytes: number, num: (n: number, opts?: Intl.NumberFormatOptions) => string = n => String(n)): string {
    if (bytes >= 1024 * 1024) return `${num(Math.round(bytes / 1024 / 1024 * 10) / 10)} MB`;
    return `${num(Math.max(1, Math.round(bytes / 1024)))} KB`;
}
