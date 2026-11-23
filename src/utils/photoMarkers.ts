/**
 * Where a lesson places a photo of a topic learned by sight: `[[photo:<uuid>]]`
 * on a line of its own, written by the server from the model's numbered pick
 * (server/topicPhotos.js `placePhotoMarkers`). The lesson card draws the photo
 * there; every other renderer drops the line.
 */

const MARKER_LINE = /^[ \t]*\[\[photo:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]\][ \t]*$/gm;

/** The text with every stored photo marker line taken out. */
export function stripPhotoMarkers(markdown: string): string {
    if (!markdown.includes('[[photo:')) return markdown;
    return markdown.replace(MARKER_LINE, '').replace(/\n{3,}/g, '\n\n');
}

export type PhotoSegment = { text: string } | { photo: string };

/** A lesson's text cut at its photo markers, in order. */
export function photoSegments(markdown: string): PhotoSegment[] {
    if (!markdown.includes('[[photo:')) return [{ text: markdown }];
    const out: PhotoSegment[] = [];
    let last = 0;
    for (const m of markdown.matchAll(MARKER_LINE)) {
        const text = markdown.slice(last, m.index);
        if (text.trim()) out.push({ text });
        out.push({ photo: m[1] });
        last = (m.index ?? 0) + m[0].length;
    }
    const tail = markdown.slice(last);
    if (tail.trim()) out.push({ text: tail });
    return out;
}
