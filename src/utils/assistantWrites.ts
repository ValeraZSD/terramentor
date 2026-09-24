/**
 * Three things the global assistant may PREPARE, which the learner presses.
 *
 *   [[check:PROJECT_ID:NODE_ID]]   open the app's own mastery check on a topic
 *   ```card  topic/front/back ```  preview a flashcard, with an Add button
 *   ```capture  text ```           preview a note, with a Save-to-Inbox button
 *
 * Same contract as every other marker (tutorActions.ts): the model names ids
 * and writes content, the APP resolves the ids through /api/nodes/labels and
 * supplies every word on the buttons, and anything malformed is stripped and
 * draws nothing. What is different is that these WRITE, so none of them applies
 * on its own — unlike `[[set:…]]`, whose changes are visible the instant they
 * land and undone in one tap, a card or a note changes what the learner will be
 * asked later, and they should see it before it exists.
 *
 * A card is a FENCE rather than a `[[…]]` marker because a card carries
 * content: `$|x|$`, a `]]`, several lines. A marker's one-line grammar cannot
 * hold that, and a fence can. The fence never reaches the markdown renderer —
 * it is split out here, and a half-arrived one is hidden while it streams.
 */

export interface CheckTarget {
    projectId: number;
    nodeId: number;
}

export interface CardProposal {
    projectId: number;
    nodeId: number;
    front: string;
    back: string;
    extra: string | null;
}

/** Matches the server's `CARD_SIDE_MAX` (server/assistantWrites.js). */
const SIDE_MAX = 2000;
const MAX_CHECKS = 2;
const MAX_CARDS = 3;
const MAX_CAPTURES = 1;

const asId = (raw: string): number | null => {
    const n = Number(String(raw).trim());
    return Number.isInteger(n) && n > 0 ? n : null;
};

const tidy = (s: string) => s.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').replace(/^\s+|\s+$/g, '');

/** `[[check:3:41]]`, matched loosely and validated after, like `[[open:…]]`. */
const CHECK_RE = /\[\[\s*check\s*:\s*([^\]:]*?)\s*:\s*([^\]:]*?)\s*\]\]/gi;
const PARTIAL_MARKER_RE = /\[\[[a-z0-9:-]*\]?$/i;

export function splitChecks(content: string, streaming = false): { body: string; checks: CheckTarget[] } {
    if (!content.includes('[[')) return { body: content, checks: [] };
    const checks: CheckTarget[] = [];
    let body = content.replace(CHECK_RE, (_m, pid: string, nid: string) => {
        const projectId = asId(pid);
        const nodeId = asId(nid);
        if (projectId !== null && nodeId !== null && checks.length < MAX_CHECKS && !checks.some(c => c.nodeId === nodeId)) {
            checks.push({ projectId, nodeId });
        }
        return '';
    });
    if (streaming) body = body.replace(PARTIAL_MARKER_RE, '');
    return { body: body === content ? content : tidy(body), checks };
}

/** A complete ```card / ```capture block, on lines of its own. */
const BLOCK_RE = /(^|\n)[ \t]*```[ \t]*(card|capture)[ \t]*\n([\s\S]*?)\n?[ \t]*```[ \t]*(?=\n|$)/gi;
/** An opener with no closer after it: still arriving, or never closed. */
const OPEN_BLOCK_RE = /(^|\n)[ \t]*```[ \t]*(card|capture)[ \t]*(?:\n([\s\S]*))?$/i;
/** A fence opener still being typed at the very end of a stream (`` ``ca ``). */
const PARTIAL_OPENER_RE = /(^|\n)[ \t]*`{1,3}[a-z]*$/i;

const FIELD_RE = /^[ \t]*(topic|front|back|extra)[ \t]*:[ \t]?(.*)$/i;

function parseCard(text: string): CardProposal | null {
    const fields: Record<string, string[]> = {};
    let current: string | null = null;
    for (const line of text.split('\n')) {
        const m = line.match(FIELD_RE);
        if (m && !(m[1].toLowerCase() in fields)) {
            current = m[1].toLowerCase();
            fields[current] = [m[2]];
        } else if (current) {
            fields[current].push(line);
        }
    }
    const value = (k: string) => (fields[k] ? fields[k].join('\n').trim() : '');
    const ids = value('topic').match(/^(\d+)\s*:\s*(\d+)$/);
    const front = value('front');
    const back = value('back');
    if (!ids || !front || !back || front.length > SIDE_MAX || back.length > SIDE_MAX) return null;
    const projectId = asId(ids[1]);
    const nodeId = asId(ids[2]);
    if (projectId === null || nodeId === null) return null;
    return { projectId, nodeId, front, back, extra: value('extra') || null };
}

/**
 * Split card and capture blocks out of an assistant message.
 *
 * Every block comes OUT, valid or not, so no fence source is ever drawn. While
 * streaming, an unclosed block is hidden and proposes nothing yet; once the
 * turn has settled, a block the model forgot to close runs to the end of the
 * message and is read like any other.
 */
export function splitWriteBlocks(content: string, streaming = false): { body: string; cards: CardProposal[]; captures: string[] } {
    if (!content.includes('`')) return { body: content, cards: [], captures: [] };
    const cards: CardProposal[] = [];
    const captures: string[] = [];
    const take = (kind: string, inner: string) => {
        if (kind.toLowerCase() === 'card') {
            const card = parseCard(inner);
            if (card && cards.length < MAX_CARDS) cards.push(card);
        } else {
            const note = inner.trim();
            if (note && note.length <= SIDE_MAX && captures.length < MAX_CAPTURES) captures.push(note);
        }
    };
    let body = content.replace(BLOCK_RE, (_m, lead: string, kind: string, inner: string) => { take(kind, inner); return lead; });
    body = body.replace(OPEN_BLOCK_RE, (_m, lead: string, kind: string, inner = '') => {
        if (!streaming) take(kind, inner);
        return lead;
    });
    if (streaming) body = body.replace(PARTIAL_OPENER_RE, '$1');
    // Tidied only where something came out: a blank line inside someone's
    // code block is theirs.
    return { body: body === content ? content : tidy(body), cards, captures };
}

const words = (s: string) => new Set((s.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || []));

/**
 * The learner's own card closest to a proposed front, when one is close enough
 * to be the same question. The model cannot see the topic's cards, so it
 * rewords one the learner already has ("which frequency changes?" came back as
 * "which frequency changes — the source's or the observed one?"), and the
 * server's exact-front check lets that through. Close = at least three-quarters
 * of the shorter front's words appear in the other; a hint, never a refusal.
 */
export function similarFront(proposed: string, existing: string[]): string | null {
    const mine = words(proposed);
    let best: string | null = null, bestScore = 0;
    for (const front of existing) {
        const theirs = words(front);
        const small = Math.min(mine.size, theirs.size);
        if (small < 3) continue;
        let shared = 0;
        for (const w of mine) if (theirs.has(w)) shared++;
        const score = shared / small;
        if (score >= 0.75 && score > bestScore) { best = front; bestScore = score; }
    }
    return best;
}

/**
 * The blocks as a person would paste them: a card as its two sides, a note as
 * its text. The preview shows them, so a Copy of the answer carries them — and
 * the topic line is the app's id, which means nothing anywhere else.
 */
export function writeBlocksAsText(content: string): string {
    if (!content.includes('`')) return content;
    const asText = (kind: string, inner: string) => {
        if (kind.toLowerCase() === 'card') {
            const card = parseCard(inner);
            return card ? `Q: ${card.front}\nA: ${card.back}` : '';
        }
        return inner.trim();
    };
    const out = content
        .replace(BLOCK_RE, (_m, lead: string, kind: string, inner: string) => `${lead}${asText(kind, inner)}`)
        .replace(OPEN_BLOCK_RE, (_m, lead: string, kind: string, inner = '') => `${lead}${asText(kind, inner)}`);
    return out === content ? content : tidy(out);
}
