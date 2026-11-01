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

/**
 * A complete marker, plus the whitespace before it (which it was written after),
 * in every spelling the server resolves (CITATION_MARKER in server/citations.js):
 * a list or range (`[[src:1,2]]`, `[[src:1-3]]`), capitals and padding
 * (`[[ SRC : 2 ]]`), a closing bracket short. The two must agree, or a spelling
 * the server resolves flashes on screen until the terminal frame;
 * tools/citation-gates.mjs runs one table of spellings through both.
 */
const MARKER = /\s*\[\[\s*src(?![a-z])[^[\]\n]*\]\]?/gi;
/** A marker still arriving at the very end of the streamed text, in any of those spellings. */
const PARTIAL = /\s*\[\[\s*(?:s(?:r(?:c(?![a-z])[^[\]\n]*\]?)?)?)?$/i;

/**
 * The tail the server appends once the markers are resolved (SOURCES_TAIL in
 * server/citations.js): a rule, then one `Sources: …` line at the very end.
 */
const SOURCES_TAIL = /(\n+---\n)Sources: ([^\n]*\s*)$/;

/**
 * One entry of a stored Sources line. A web page was written as a markdown link
 * and is opened where it lives; a document from the learner's library was
 * written as its title (plus ", page N" where the answer read a page), and
 * `entry` is that text exactly as stored, which is what the server looks the
 * document up by (`GET /api/documents/cited`).
 */
export type SourceEntry =
    | { kind: 'web'; label: string; href: string }
    | { kind: 'doc'; entry: string; label: string };

/** `inertTitle` (server/citations.js) escapes brackets; the reader sees them plain. */
const unescapeTitle = (s: string) => s.replace(/\\([[\]])/g, '$1');
/** A web entry: `[label](url)`, the label's brackets escaped, the URL percent-encoded by `inertUrl`. */
const WEB_ENTRY = /^\[((?:\\.|[^\]\\])*)\]\((https?:\/\/[^\s()]+)\)/i;
const SEPARATOR = ' · ';

/** The entries of a stored Sources line, in order. */
export function parseSourcesLine(line: string): SourceEntry[] {
    const out: SourceEntry[] = [];
    let rest = String(line ?? '').trim();
    while (rest) {
        const web = WEB_ENTRY.exec(rest);
        if (web) {
            out.push({ kind: 'web', label: unescapeTitle(web[1]), href: web[2] });
            rest = rest.slice(web[0].length);
        } else {
            // A title holding " · " itself is read as two entries; neither then
            // finds its document, and both stay text, as every entry was before.
            const at = rest.indexOf(SEPARATOR);
            const entry = (at < 0 ? rest : rest.slice(0, at)).trim();
            if (entry) out.push({ kind: 'doc', entry, label: unescapeTitle(entry) });
            rest = at < 0 ? '' : rest.slice(at);
        }
        if (rest.startsWith(SEPARATOR)) rest = rest.slice(SEPARATOR.length);
    }
    return out;
}

/**
 * The answer and the Sources line the server appended to it, apart, so the
 * line can be drawn as something to open rather than a sentence. Only the
 * server's tail is taken, never a line of an answer that merely begins
 * "Sources:". The STORED line stays English, because the server finds its own
 * tail again by that word; the label is translated where it is drawn.
 */
export function splitSourcesTail(text: string): { body: string; sources: SourceEntry[] } {
    if (typeof text !== 'string' || !text.includes('Sources: ')) return { body: text, sources: [] };
    const m = SOURCES_TAIL.exec(text);
    if (!m) return { body: text, sources: [] };
    const sources = parseSourcesLine(m[2]);
    if (!sources.length) return { body: text, sources: [] };
    return { body: text.slice(0, m.index).trimEnd(), sources };
}

/** Remove citation markers, complete or half-arrived, from text being rendered. */
export function stripCitationMarkers(text: string): string {
    if (typeof text !== 'string' || !text.includes('[[')) return text;
    return text.replace(MARKER, '').replace(PARTIAL, '');
}
