import type {
    FeedCard, FeedCheckpointCard, FeedFlashcardCard, FeedLessonCard, FeedLookBackCard,
    FeedNoticeCard, FeedPracticeCard, FeedQuestionCard, FeedRecallCard,
} from '../../types';

/** Cards that belong to a topic's own narrative, so they group into a chapter. */
export type ChapterCard = FeedLessonCard | FeedQuestionCard | FeedCheckpointCard | FeedPracticeCard;
export type StandaloneCard = FeedFlashcardCard | FeedRecallCard | FeedNoticeCard | FeedLookBackCard;

export type FeedGroup =
    | { type: 'chapter'; head: ChapterCard; cards: ChapterCard[]; continued: boolean }
    | { type: 'review'; cards: FeedRecallCard[] }
    | { type: 'single'; card: StandaloneCard };

export const isChapterCard = (card: FeedCard): card is ChapterCard =>
    card.kind === 'lesson' || card.kind === 'question'
    || card.kind === 'checkpoint' || card.kind === 'practice';

/** The course a card belongs to; a notice belongs to none. */
export function cardCourse(card: FeedCard): number | null {
    if (card.kind === 'notice') return null;
    if (card.kind === 'flashcard') return card.card.project_id ?? null;
    return card.projectId ?? null;
}

/**
 * Fold the flat card list into chapters. Order is never changed — the server's
 * interleave decides what comes when; this only draws a box around the runs
 * that already belong together. A topic the feed returns to later (after a
 * flashcard broke the run) opens a chapter marked "continued" rather than
 * silently repeating its title as if it were new.
 */
export function groupCards(cards: FeedCard[]): FeedGroup[] {
    const groups: FeedGroup[] = [];
    const seenNodes = new Set<number>();

    for (const card of cards) {
        // The review round: recall questions from several fading topics of
        // one course, under one line saying what they are. Two courses' rounds
        // side by side are two rounds.
        if (card.kind === 'recall' && card.review) {
            const last = groups[groups.length - 1];
            if (last?.type === 'review' && last.cards[0].projectId === card.projectId) last.cards.push(card);
            else groups.push({ type: 'review', cards: [card] });
            continue;
        }
        if (!isChapterCard(card)) {
            groups.push({ type: 'single', card });
            continue;
        }
        const last = groups[groups.length - 1];
        if (last?.type === 'chapter' && last.head.nodeId === card.nodeId) {
            last.cards.push(card);
            continue;
        }
        groups.push({
            type: 'chapter',
            head: card,
            cards: [card],
            continued: seenNodes.has(card.nodeId),
        });
        seenNodes.add(card.nodeId);
    }
    return groups;
}

const groupCourse = (group: FeedGroup): number | null =>
    group.type === 'chapter' ? group.head.projectId
        : group.type === 'review' ? group.cards[0].projectId
            : cardCourse(group.card);

/** The first card of a group: what a block takes its course's name and colour from. */
export const groupLead = (group: FeedGroup): FeedCard =>
    group.type === 'chapter' ? group.head : group.type === 'review' ? group.cards[0] : group.card;

export interface CourseBlock {
    /** null: a notice, which belongs to no course and gets no header. */
    course: number | null;
    groups: FeedGroup[];
    /** The stream already showed a block of this course higher up. */
    continued: boolean;
}

/**
 * Today as a run of course blocks: consecutive groups of one course under one
 * header. The server serves a course's share of the day in one run
 * (`composeFeed`), so a course comes back lower down only with work that
 * arrived after the stream moved on, and that block says "continued".
 */
export function courseBlocks(groups: FeedGroup[]): CourseBlock[] {
    const blocks: CourseBlock[] = [];
    const seen = new Set<number>();
    for (const group of groups) {
        const course = groupCourse(group);
        const last = blocks[blocks.length - 1];
        if (last && course != null && last.course === course) {
            last.groups.push(group);
            continue;
        }
        blocks.push({ course, groups: [group], continued: course != null && seen.has(course) });
        if (course != null) seen.add(course);
    }
    return blocks;
}

/**
 * Where a card put back into the stream (a flashcard rated Again) goes: after
 * the last card of the run of its course that holds card `at`, so it never
 * lands in the next course's block. Always below `at`: nothing above moves.
 */
export function blockEnd(cards: FeedCard[], at: number): number {
    const course = cardCourse(cards[at]);
    let end = at + 1;
    while (end < cards.length && cardCourse(cards[end]) === course) end++;
    return end;
}

/**
 * The course blocks a stream holds, in order (a course shown twice is named
 * twice): what the next page is composed after, so the block the reader is
 * in continues before the next course opens and no course's round opens twice.
 */
export function heldCourses(cards: FeedCard[]): number[] {
    const out: number[] = [];
    for (const card of cards) {
        const course = cardCourse(card);
        if (course != null && out[out.length - 1] !== course) out.push(course);
    }
    return out;
}
