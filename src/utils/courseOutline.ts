// src/utils/courseOutline.ts
// What a course FILE holds, read before it is imported: the counts and topics
// a screen shows so the learner can tell it is the right course.

export interface CourseOutline {
    cards: number;
    questions: number;
    /** Topics in course order: a leaf that is not a note, with its card count. */
    topics: { title: string; cards: number }[];
    /** The first card in course order, front and back, or null when there is none. */
    firstCard: { front: string; back: string } | null;
}

/** Text from someone else's file a screen can show: a string, without control
 *  or direction-override characters (which could reorder a name), trimmed and capped. */
// eslint-disable-next-line no-control-regex
const UNSHOWN = /[\u0000-\u0008\u000B-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g;
export const shown = (v: unknown, max: number): string =>
    typeof v === 'string' ? Array.from(v.replace(UNSHOWN, '').trim()).slice(0, max).join('') : '';

/** A course read from a link, as the file every import door takes: the
 *  edition check, the importer's notes and the toasts then stay one path. */
export function courseFileOf(data: { project: { name: string } }): File {
    const safeName = Array.from(shown(data.project.name, 200).replace(/[\\/:*?"<>|\p{C}]+/gu, ' ')).slice(0, 80).join('').trim();
    return new File([JSON.stringify(data)], `${safeName || 'course'}.json`, { type: 'application/json' });
}

export function outlineOf(nodes: unknown[]): CourseOutline {
    const out: CourseOutline = { cards: 0, questions: 0, topics: [], firstCard: null };
    const walk = (list: unknown[]) => list.forEach((n: any) => {
        if (!n || typeof n !== 'object') return;
        const cards = Array.isArray(n.flashcards) ? n.flashcards : [];
        out.cards += cards.length;
        if (Array.isArray(n.questions)) out.questions += n.questions.length;
        const children = Array.isArray(n.children) ? n.children : [];
        // The app's work-leaf rule (`isWorkLeaf`): a note is never a topic, a
        // node whose children are all notes is still a leaf, and a page of an
        // imported deck is a container for cards, not a topic.
        if (!n.is_note && n.role !== 'pagination' && !children.some((c: any) => c && !c.is_note)) {
            out.topics.push({ title: shown(n.title, 200), cards: cards.length });
        }
        if (!out.firstCard) {
            // A cloze card's front is its {{c1::…}} source, not what a learner sees.
            const card = cards.find((c: any) => shown(c?.front, 1) !== '' && !c.cloze && !/\{\{c\d+::/.test(c.front));
            if (card) out.firstCard = { front: shown(card.front, 300), back: shown(card.back, 300) };
        }
        walk(children);
    });
    walk(nodes);
    return out;
}
