/**
 * `[[src:N]]` — the grounding marker the tutor and the assistant write when a
 * sentence came from one of the learner's own documents (see
 * server/citations.js, which resolves it into the document's real title).
 *
 * The server does the resolving, because only the server knows which documents
 * were retrieved and because the resolved form has to be what gets STORED — a
 * conversation reopened next week still says where its answer came from.
 *
 * This file exists for the gap in the middle: the answer streams in token by
 * token, so the markers reach the screen long before the turn is finished and
 * the server can resolve them. Left alone they would be read as scaffolding —
 * the same rule every other marker in this app follows: an instruction to the
 * app must never survive into the text a learner reads, or into a Copy.
 *
 * So a streaming surface strips them, and adopts the server's resolved text
 * when the terminal event arrives. Deliberately tolerant of a half-written
 * marker: mid-stream the text can end in `[[sr`, and a partial marker must not
 * flash on screen for a frame either.
 */

/** A complete marker, plus the whitespace before it (which it was written after). */
const MARKER = /\s*\[\[src:\s*\d+\s*\]\]/g;
/** A marker still arriving at the very end of the streamed text. */
const PARTIAL = /\s*\[\[(?:s(?:r(?:c(?::\s*\d*)?)?)?)?$/;

/** Remove citation markers, complete or half-arrived, from text being rendered. */
export function stripCitationMarkers(text: string): string {
    if (typeof text !== 'string' || !text.includes('[[')) return text;
    return text.replace(MARKER, '').replace(PARTIAL, '');
}
