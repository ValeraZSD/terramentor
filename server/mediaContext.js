// server/mediaContext.js — a card's pictures and audio, as words for a prompt.
//
// Split out of `mediaDescribe.js` on purpose: `ai.js` needs this, and
// `mediaDescribe.js` needs `ai.js` to call the vision model. Reading the
// database is the half with no dependencies, so it is the half that moves.

import db from './database.js';

/**
 * The pictures and clips on this topic's cards, as a block of prose for
 * `buildNodeContext`.
 *
 * Undescribed images are LISTED, not hidden. "the card shows a picture (not
 * described)" is a true statement the model can work with — it can say it does
 * not know what the picture shows — where silence makes the card look like a
 * card with nothing on it, and the model confidently answers about the text
 * alone. Audio is named for the same reason: a listening card is not a card
 * with a blank question.
 */
export function mediaContextForNode(nodeId, { max = 25 } = {}) {
    let rows;
    try {
        rows = db.prepare(
            'SELECT media FROM flashcards WHERE node_id = ? AND media IS NOT NULL'
        ).all(nodeId);
    } catch { return ''; }
    if (!rows.length) return '';

    const hashes = new Set();
    for (const r of rows) {
        try {
            const m = JSON.parse(r.media);
            for (const side of ['front', 'back']) for (const x of m[side] ?? []) hashes.add(x.hash);
        } catch { /* a malformed row is a card without media, not an error */ }
    }
    if (!hashes.size) return '';

    const list = [...hashes].slice(0, max);
    const placeholders = list.map(() => '?').join(',');
    const files = db.prepare(
        `SELECT hash, kind, filename, description FROM media_files WHERE hash IN (${placeholders})`
    ).all(...list);

    const images = files.filter(f => f.kind === 'image');
    const audio = files.filter(f => f.kind === 'audio');
    const described = images.filter(f => f.description);

    const parts = [];
    if (described.length) {
        parts.push(described.map(f => `- ${f.description}`).join('\n'));
    }
    const undescribed = images.length - described.length;
    if (undescribed) {
        parts.push(`- ${undescribed} further picture${undescribed === 1 ? '' : 's'} on these cards ${undescribed === 1 ? 'has' : 'have'} not been described, so you cannot know what ${undescribed === 1 ? 'it shows' : 'they show'}. Say so rather than guessing.`);
    }
    if (audio.length) {
        parts.push(`- ${audio.length} audio clip${audio.length === 1 ? '' : 's'} (you cannot hear ${audio.length === 1 ? 'it' : 'them'}).`);
    }
    if (!parts.length) return '';

    const more = hashes.size > list.length ? `\n(${hashes.size - list.length} more not listed.)` : '';
    return `\nPictures and audio attached to this topic's cards:\n${parts.join('\n')}${more}\n`;
}
