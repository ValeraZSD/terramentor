// "This is wrong" on one item, the client half (server/itemReports.js).
//
// A ref names the item the way the server resolves it — the client says WHICH
// item, never what it says:
//   fi:<feedItemId>        a feed row (question, lesson, paper exercise)
//   q:<uuid>               a bank question, wherever it is asked
//   card:<id>              a flashcard
//   probe:<probeId>:<i>    a placement question
//   drill:<node>:<drill>:<item>   one item of a drill

/** The fixed reasons, in the order the dialog lists them. The server's REPORT_REASONS. */
export const REPORT_REASONS = ['wrong', 'unclear', 'off_topic', 'other'] as const;
export type ReportReason = typeof REPORT_REASONS[number];

export const REPORT_NOTE_MAX = 1000;

/** Where a report was sent from: the server's closed REPORT_SURFACES. */
export type ReportSurface =
    | 'feed' | 'quiz' | 'mastery_check' | 'placement' | 'drill' | 'review' | 'lesson' | 'paper' | 'topic' | 'assistant';

export type ReportKind = 'question' | 'lesson' | 'paper' | 'card' | 'drill' | 'probe';

export interface ItemReport {
    id: number;
    ref: string;
    kind: ReportKind;
    nodeId: number | null;
    projectId: number | null;
    reason: ReportReason;
    note: string | null;
    surface: ReportSurface | null;
    createdAt: string;
    undoneAt: string | null;
    /** The item as it was when reported. */
    item: Record<string, unknown> | null;
    /** The learner's own card: offered for editing instead of a rewrite. */
    editable: boolean;
    canRewrite: boolean;
    rewrite: { state: 'requested' | 'running' | 'done' | 'failed' | 'edited'; at?: string; taskId?: string } | null;
}

export interface ItemReportTarget {
    ref: string;
    kind: ReportKind;
    nodeId: number | null;
    projectId: number | null;
    item: Record<string, unknown> | null;
    report: ItemReport | null;
    canRewrite: boolean;
    editable: boolean;
}

const REF = /^(?:fi:\d{1,12}|q:[A-Za-z0-9-]{8,64}|card:\d{1,12}|probe:\d{1,12}:\d{1,3}|drill:\d{1,12}:(?:f[0-9a-f]{8}|cards):(?:i[0-9a-f]{8}|c\d{1,12}))$/;

/** Is this a ref the server can resolve? The same shapes as `parseRef` there. */
export function isItemRef(ref: unknown): ref is string {
    return typeof ref === 'string' && REF.test(ref.trim());
}

/** A bank question by its uuid, else the feed row it was served from. */
export function questionRef(q: { uuid?: string | null } | null | undefined, feedItemId?: number | null): string | null {
    if (q?.uuid && isItemRef(`q:${q.uuid}`)) return `q:${q.uuid}`;
    if (Number.isInteger(feedItemId) && (feedItemId as number) > 0) return `fi:${feedItemId}`;
    return null;
}

export const feedRowRef = (feedItemId: number | null | undefined): string | null =>
    Number.isInteger(feedItemId) && (feedItemId as number) > 0 ? `fi:${feedItemId}` : null;

export const cardRef = (cardId: number | null | undefined): string | null =>
    Number.isInteger(cardId) && (cardId as number) > 0 ? `card:${cardId}` : null;

export const probeRef = (probeId: number | null | undefined, index: number): string | null =>
    Number.isInteger(probeId) && Number.isInteger(index) ? `probe:${probeId}:${index}` : null;

export const drillRef = (nodeId: number | null | undefined, drillKey: string | null | undefined, itemKey: string): string | null => {
    const ref = `drill:${nodeId}:${drillKey}:${itemKey}`;
    return isItemRef(ref) ? ref : null;
};

/**
 * What the item on the learner's screen was, for the assistant: its ref and
 * what the screen showed (their answer, right or wrong). The server reads the
 * item's own text; nothing else here is quoted to the model as fact.
 */
export interface ScreenItem {
    ref: string;
    answer?: string;
    correct?: boolean;
    /** Whether the item's key is on the screen (a card turned over, a drill
     *  item's feedback). Until it is, or an answer is, the server keeps the key
     *  from the assistant. */
    keyShown?: boolean;
}

/**
 * Where a flashcard in the feed stands. `feedDone` is the feed's own mark and
 * outlives the card (leaving the feed and coming back mounts it again with
 * nothing local); `rated` and `setAsideHere` are this mount's: a rating made
 * here, and a report seen holding the card here. `holds` is a report standing
 * on it that is not settled by an edit.
 *
 * A card the feed marked done is done, so a rated card never offers its
 * ratings twice; the one exception is a card this mount set aside for a
 * report that no longer holds (undone, or the learner fixed their card),
 * which is open to rate until it is rated. A report filed from the assistant
 * never marks the feed, so a holding report shuts the ratings by itself:
 * `locked` is what the rating buttons and the flip go by.
 */
export function feedCardLock({ feedDone, rated, holds, deleted, setAsideHere }: {
    feedDone: boolean; rated: boolean; holds: boolean; deleted: boolean; setAsideHere: boolean;
}): { done: boolean; locked: boolean } {
    const done = feedDone && (!setAsideHere || rated || holds || deleted);
    return { done, locked: done || holds || deleted };
}
