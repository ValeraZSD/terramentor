/**
 * What the assistant may WRITE, and only when the learner presses the button.
 *
 * The assistant proposes a card as a ```card block (src/utils/assistantWrites.ts);
 * the drawer shows it as a preview with an Add button, and this is what Add
 * calls. Nothing here runs on the model's say-so: the route is reached by a
 * press, and the model never learns an id it did not already read.
 *
 * A card, not a note: the conversation is where the learner works something
 * out, and a card is the one form of it the app already knows how to bring
 * back at the right time.
 */
import db from './database.js';
import { aiProvenance } from './ai.js';
import { LEAF_NODE } from './today.js';

/** A side longer than this is a paragraph, not a card. */
export const CARD_SIDE_MAX = 2000;

/**
 * Add one card to a topic. Returns the new id — or the existing one, with
 * `existed`, when that topic already has a card with the same front: a
 * re-read conversation still offers its Add button, and pressing it twice
 * must not make two cards.
 *
 * Throws on anything that is not a real topic or not a real card.
 */
export function addAssistantCard({ nodeId, front, back, extra = null }) {
    const f = String(front ?? '').trim();
    const b = String(back ?? '').trim();
    const x = extra == null ? null : String(extra).trim() || null;
    if (!f || !b) throw new Error('A card needs a front and a back.');
    if (f.length > CARD_SIDE_MAX || b.length > CARD_SIDE_MAX || (x && x.length > CARD_SIDE_MAX)) {
        throw new Error(`A card side is limited to ${CARD_SIDE_MAX} characters.`);
    }
    const node = db.prepare(`SELECT n.id, n.is_note, (${LEAF_NODE}) AS leaf FROM nodes n WHERE n.id = ?`).get(Number(nodeId));
    if (!node) throw new Error('That topic does not exist.');
    // A note is a topic's reading material; its cards belong to the topic.
    if (node.is_note) throw new Error('A card belongs to a topic, not to a note.');
    // A section is structure: its cards would count towards no topic's
    // progress and no topic's evidence. A deck's stage is a leaf and takes cards.
    if (!node.leaf) throw new Error('A card belongs to a topic, not to a section.');

    const same = db.prepare('SELECT id FROM flashcards WHERE node_id = ? AND lower(trim(front)) = lower(?)').get(node.id, f);
    if (same) return { id: same.id, existed: true };

    // Every card starts NEW (next_review NULL): the scheduler decides when it
    // is first shown, like any other card the learner did not write.
    const info = db.prepare('INSERT INTO flashcards (node_id, front, back, extra, generated_by) VALUES (?, ?, ?, ?, ?)')
        .run(node.id, f, b, x, aiProvenance());
    return { id: Number(info.lastInsertRowid), existed: false };
}

/**
 * The Undo under an added card. Undo exists for "I did not mean to add that",
 * so it removes the card only while that is still what it is: a card nobody
 * has studied. Once the learner has reviewed it, the card has a history the
 * scheduler and the topic's evidence are built on, and a button labelled Undo
 * next to a chat message is not where that should be thrown away — the card is
 * KEPT and the answer says why; deleting it is the card editor's job, like any
 * other card. Returns `{ removed }`, `{ kept, reviews }`, or `{ gone }` when the
 * card was already deleted elsewhere.
 */
export function undoAssistantCard(cardId) {
    const id = Number(cardId);
    if (!Number.isInteger(id)) throw new Error('Invalid card id.');
    const card = db.prepare('SELECT id FROM flashcards WHERE id = ?').get(id);
    if (!card) return { gone: true };
    const reviews = db.prepare('SELECT COUNT(*) AS n FROM review_log WHERE card_id = ?').get(id).n;
    if (reviews > 0) return { kept: true, reviews };
    db.prepare('DELETE FROM flashcards WHERE id = ?').run(id);
    return { removed: true };
}
