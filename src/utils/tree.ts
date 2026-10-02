import { Node, TreeNode, GanttItem, CalendarDay, CalendarViewMode, WeekStartDay, CardPlanSection } from '../types';

/**
 * A node's *structural* children — the ones that represent work.
 *
 * Notes are material attached to a topic, not sub-work: they're never
 * scheduled, never carry a status, and the feed teaches a node's note children
 * as that node's own lesson material. So a topic whose only children are notes
 * is still a leaf, and it is the topic — not its notes — that gets proven.
 *
 * Mirrors LEAF_NODE in server/today.js. Both sides must agree, or the UI hides
 * work the feed keeps serving.
 */
export function structuralChildren(node: TreeNode): TreeNode[] {
    return node.children.filter(c => !c.is_note);
}

/** Leaf = a real (non-note) node with no structural children. */
export function isLeafNode(node: TreeNode): boolean {
    return !node.is_note && structuralChildren(node).length === 0;
}

/**
 * A leaf that is a unit of WORK — something the learner can finish.
 *
 * A stage the Anki importer cut out of card order is a container for cards:
 * it is taught by nothing, proven by nothing and completed by nobody, so
 * counting one made a taught import's progress read 0 / 57 when it had 32 real
 * topics. Mirrors WORK_LEAF in server/today.js.
 */
export function isWorkLeaf(node: TreeNode): boolean {
    return isLeafNode(node) && node.role !== 'pagination';
}

/**
 * How much of one topic is done, 0–1. Mirrors `topicFraction` in
 * server/progress.js, and must keep mirroring it: a closed topic is 1, a topic
 * whose content is cards is the share of them met, anything else is 0.
 *
 * A topic is only *completed* when somebody says so — this is the other
 * question, the one a deck-shaped topic can actually answer.
 */
export function topicDone(node: Pick<Node, 'status' | 'cards' | 'seen'>): number {
    if (node.status === 'completed' || node.status === 'skipped') return 1;
    const cards = node.cards ?? 0;
    if (cards <= 0) return 0;
    return Math.min(1, (node.seen ?? 0) / cards);
}

/**
 * What a topic contributes to the percentage above it: its cards, or 1 when it
 * has none. Mirrors `topicWeight` in server/progress.js — a 2,004-card subdeck
 * is more of its deck than an 86-card one, and a written course, where every
 * topic weighs 1, is exactly the count it always was.
 */
export function topicWeight(node: Pick<Node, 'cards' | 'taught'>): number {
    // A TAUGHT topic is one unit of its course, whatever it carries: a language
    // course's listening topic with sixty clips is not sixty times the topic
    // beside it. Only a topic that is nothing but its cards weighs its cards.
    if (node.taught) return 1;
    return Math.max(1, node.cards ?? 0);
}

/**
 * Derive the effective status of a node.
 * For leaf nodes, returns the node's own status.
 * For parent nodes, derives from children's progress:
 * - 100% → 'completed'
 * - >0%  → 'in_progress'
 * - 0%   → 'not_started'
 */
export function getEffectiveStatus(node: TreeNode): 'not_started' | 'in_progress' | 'completed' | 'skipped' {
    if (node.is_note) return 'not_started';

    // A leaf is what its status says — except that a stored `not_started` on a
    // leaf with cards MET is not true: nobody sets a deck section's status, and
    // it read "Not started" beside 86 of 86 cards met. Work under way is
    // in_progress. Never promoted to completed here: a topic is completed only
    // when somebody says so (`topicDone` is the other question).
    if (isLeafNode(node)) {
        return node.status === 'not_started' && (node.seen ?? 0) > 0 ? 'in_progress' : node.status;
    }

    const percentage = node.progress?.percentage ?? 0;
    if (percentage === 100) return 'completed';
    if (percentage > 0) return 'in_progress';
    return 'not_started';
}

// CORE TREE BUILDING

/**
 * Convert a flat list of nodes (as stored in the DB) into a hierarchical
 * tree structure. Also computes depth, progress, and effective status
 * for every node in a single pass.
 *
 * Side effects: each TreeNode is mutated to add `children`, `depth`,
 * `progress`, and `effectiveStatus` fields.
 *
 * @timeComplexity O(n) where n is the number of nodes
 */
export function buildTree(nodes: Node[]): TreeNode[] {
    const map = new Map<number, TreeNode>();
    const roots: TreeNode[] = [];

    nodes.forEach(n => {
        map.set(n.id, { ...n, children: [], depth: 0 });
    });

    nodes.forEach(n => {
        const node = map.get(n.id)!;
        if (n.parent_id === null) {
            roots.push(node);
        } else {
            const parent = map.get(n.parent_id);
            if (parent) {
                parent.children.push(node);
            }
        }
    });

    const setDepthAndSort = (items: TreeNode[], depth: number) => {
        items.sort((a, b) => a.position - b.position);
        items.forEach(item => {
            item.depth = depth;
            setDepthAndSort(item.children, depth + 1);
        });
    };
    setDepthAndSort(roots, 0);

    type Rollup = { total: number; completed: number; done: number; weight: number; cards: number; seen: number };
    const calcProgress = (node: TreeNode): Rollup => {
        if (node.is_note) {
            node.progress = { total: 0, completed: 0, percentage: 0, cards: 0, seen: 0 };
            node.children.forEach(calcProgress);
            return { total: 0, completed: 0, done: 0, weight: 0, cards: 0, seen: 0 };
        }
        const ownCards = node.cards ?? 0;
        const ownSeen = Math.min(ownCards, node.seen ?? 0);

        if (isLeafNode(node)) {
            // Any children here are notes — material, not sub-work. Still walk
            // them so every node in the tree ends up with a progress object.
            node.children.forEach(calcProgress);
            // A slice of card order contributes nothing to a WEIGHTED rollup,
            // the same way a note does: its cards are rationed by the queue, and
            // it is not a thing that gets finished (isWorkLeaf). Its own
            // percentage is still its cards met, and its cards still count
            // toward a subtree that has nothing else (see below).
            if (node.role === 'pagination') {
                const pct = ownCards > 0 ? Math.round((ownSeen / ownCards) * 100) : 0;
                node.progress = { total: 0, completed: 0, percentage: pct, cards: ownCards, seen: ownSeen };
                return { total: 0, completed: 0, done: 0, weight: 0, cards: ownCards, seen: ownSeen };
            }
            // Skipped counts as closed for rollup, so parents/pace can advance;
            // the distinct icon (not the percentage) carries the honesty signal.
            const completed = (node.status === 'completed' || node.status === 'skipped') ? 1 : 0;
            // …and how much of it is DONE, which is not the same question once
            // a topic's content is cards: mirrors `topicFraction` in
            // server/progress.js, the one rule the card, the dashboard, the
            // phase bars and pace all read.
            const done = topicDone(node);
            const weight = topicWeight(node);
            node.progress = { total: 1, completed, percentage: Math.round(done * 100), cards: ownCards, seen: ownSeen };
            return { total: 1, completed, done: done * weight, weight, cards: ownCards, seen: ownSeen };
        }

        let total = 0;
        let completed = 0;
        let done = 0;
        let weight = 0;
        let cards = ownCards;
        let seen = ownSeen;
        for (const child of node.children) {
            const childProgress = calcProgress(child);
            total += childProgress.total;
            completed += childProgress.completed;
            done += childProgress.done;
            weight += childProgress.weight;
            cards += childProgress.cards;
            seen += childProgress.seen;
        }

        // No topics under it, only slices of card order: its share is the cards
        // met, as `cardsOnlyProgress` (server/progress.js) says of a whole
        // project like that — or the root of a 1,501-card deck reads 0%.
        const percentage = weight > 0
            ? Math.round((done / weight) * 100)
            : cards > 0 ? Math.round((seen / cards) * 100) : 0;
        node.progress = { total, completed, percentage, cards, seen };
        return { total, completed, done, weight, cards, seen };
    };

    const setEffectiveStatus = (node: TreeNode) => {
        node.effectiveStatus = getEffectiveStatus(node);
        node.children.forEach(setEffectiveStatus);
    };

    roots.forEach(root => {
        calcProgress(root);
        setEffectiveStatus(root);
    });
    return roots;
}

/**
 * Flatten a tree into a depth-first array (preserves order).
 * Each entry includes its depth relative to the root.
 */
export function flattenTree(tree: TreeNode[]): TreeNode[] {
    const result: TreeNode[] = [];
    const walk = (nodes: TreeNode[], depth: number) => {
        nodes.forEach(node => {
            result.push({ ...node, depth });
            walk(node.children, depth + 1);
        });
    };
    walk(tree, 0);
    return result;
}

/**
 * Find a node by id anywhere in the tree.
 * @timeComplexity O(n) worst case
 */
export function findNode(tree: TreeNode[], id: number): TreeNode | null {
    for (const node of tree) {
        if (node.id === id) return node;
        const found = findNode(node.children, id);
        if (found) return found;
    }
    return null;
}

/**
 * Check whether a node has any children.
 */
export function hasChildren(tree: TreeNode[], id: number): boolean {
    const node = findNode(tree, id);
    return node ? node.children.length > 0 : false;
}

/**
 * Get the ancestor chain of a node, from the root down to the node itself.
 * Returns empty array if the node is not found.
 */
export function getNodePath(tree: TreeNode[], id: number): TreeNode[] {
    const path: TreeNode[] = [];
    const findPath = (nodes: TreeNode[], targetId: number): boolean => {
        for (const node of nodes) {
            if (node.id === targetId) {
                path.push(node);
                return true;
            }
            if (findPath(node.children, targetId)) {
                path.unshift(node);
                return true;
            }
        }
        return false;
    };
    findPath(tree, id);
    return path;
}

/**
 * Get all nodes that should be visible in the sidebar,
 * honoring the `expanded` map (collapsed parents hide their children).
 */
export function getVisibleNodes(tree: TreeNode[], expanded: Record<number, boolean>): TreeNode[] {
    const result: TreeNode[] = [];
    const walk = (nodes: TreeNode[]) => {
        nodes.forEach(node => {
            result.push(node);
            if (expanded[node.id] !== false && node.children.length > 0) {
                walk(node.children);
            }
        });
    };
    walk(tree);
    return result;
}

/**
 * Collect every leaf node (non-note with no structural children) from a tree.
 *
 * STRUCTURAL: a slice of an imported deck's card order is a leaf here, because
 * the tree, the sidebar and the calendar are about shape. Anything that counts,
 * plans or schedules WORK wants `getWorkLeaves` instead.
 */
export function getLeafNodes(tree: TreeNode[]): TreeNode[] {
    const leaves: TreeNode[] = [];
    const walk = (nodes: TreeNode[]) => {
        for (const node of nodes) {
            if (node.is_note) continue;
            if (isLeafNode(node)) {
                leaves.push(node);
            } else {
                walk(node.children);
            }
        }
    };
    walk(tree);
    return leaves;
}

/**
 * Collect every leaf that is a unit of WORK — the set the server dates.
 *
 * `server/scheduling.js` gives a date only to a leaf that is not pagination
 * (`isWork`, the fourth copy of this rule), so anything that tells a learner how
 * much there is to schedule must count the same nodes. Counting the structural
 * set instead is a promise the scheduler does not keep: on an imported deck the
 * schedule dialog priced 57 topics, the server dated 32, and every deadline it
 * recommended was too long. Mirrors `workLeaves` in server/today.js.
 */
export function getWorkLeaves(tree: TreeNode[]): TreeNode[] {
    return getLeafNodes(tree).filter(isWorkLeaf);
}

// DATE UTILITIES

export function parseDate(dateStr: string): Date {
    if (!dateStr) return new Date();
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d));
}

export function formatDate(date: Date): string {
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, '0');
    const d = String(date.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

export function todayStr(): string {
    return formatDate(new Date());
}

export function addDays(dateStr: string, days: number): string {
    const d = parseDate(dateStr);
    d.setUTCDate(d.getUTCDate() + days);
    return formatDate(d);
}


// WEEK UTILITIES
//
// Month and weekday NAMES are not here: they are language, not tree maths, and
// as two hardcoded English arrays they printed "MON TUE WED" over Russian
// chrome where no coverage report could see them. They live in
// `utils/locale.ts` now, built from `Intl` and the interface language.

/** ISO 8601 week number (weeks start Monday, week 1 has the first Thursday) */
export function getISOWeekNumber(dateStr: string): number {
    const d = parseDate(dateStr);
    const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    target.setUTCDate(target.getUTCDate() + 3 - ((target.getUTCDay() + 6) % 7));
    const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
    return Math.ceil((((target.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

/**
 * Week number for display, respecting the user's week-start preference.
 * Uses Thursday's ISO week so the number is consistent regardless of weekStartDay.
 */
export function getWeekNumber(dateStr: string, weekStartDay: WeekStartDay = 1): number {
    const date = parseDate(dateStr);
    const dayOfWeek = date.getUTCDay();
    const offset = (dayOfWeek - weekStartDay + 7) % 7;
    const weekStart = new Date(date);
    weekStart.setUTCDate(weekStart.getUTCDate() - offset);

    const thursdayOffset = weekStartDay === 1 ? 3 : 4;
    const thursday = new Date(weekStart);
    thursday.setUTCDate(thursday.getUTCDate() + thursdayOffset);

    return getISOWeekNumber(formatDate(thursday));
}

/** YYYY-MM-DD of the first day of the week containing `dateStr` */
export function getWeekStartDate(dateStr: string, weekStartDay: WeekStartDay = 0): string {
    const date = parseDate(dateStr);
    const dayOfWeek = date.getUTCDay();
    const offset = (dayOfWeek - weekStartDay + 7) % 7;
    date.setUTCDate(date.getUTCDate() - offset);
    return formatDate(date);
}

// GANTT DATA BUILDER

/**
 * Flatten the tree into timeline rows: one per non-note node, in document
 * order, carrying its depth, its scheduled DATES and a status colour.
 *
 * It used to return `leftPercent`/`widthPercent` — geometry measured against
 * the project window as a percentage of whatever width the chart happened to
 * get. That is exactly why the timeline was unusable on a phone: a three-year
 * plan squeezed into the ~150px left over after the label column makes a
 * two-week topic sub-pixel, and a percentage cannot be zoomed. Positions are
 * now computed from the dates against a shared px/day axis (`scheduleAxis.ts`),
 * the same one the schedule board uses, so both gantts zoom and scroll alike.
 *
 * `cardPlan` is for a project measured in CARDS, which stores no topic dates
 * (`allocateCardWindow`): its sections take their dates from the plan instead
 * (`cardPlan` in server/scheduling.js), a parent spans its sections, and a
 * section is DONE when all of its cards are met — nobody closes one by hand.
 */
export function buildGanttData(tree: TreeNode[], cardPlan: CardPlanSection[] | null = null): GanttItem[] {
    const items: GanttItem[] = [];
    const todayDate = todayStr();
    const planSpan = cardPlanSpans(tree, cardPlan);

    const walk = (
        nodes: TreeNode[],
        depth: number,
        parentNodeId: number | null,
        rootPhaseId: number | null,
        rootPhaseTitle: string | null
    ) => {
        for (const node of nodes) {
            if (node.is_note) continue;

            // Structural children only: a topic with just notes under it is a
            // task bar, not a washed-out summary bar. Its note children are
            // skipped by the guard above anyway, so nothing is lost by not
            // recursing into them.
            const hasKids = structuralChildren(node).length > 0;

            const isRootPhase = node.parent_id === null;
            const currentRootId = isRootPhase ? node.id : rootPhaseId;
            const currentRootTitle = isRootPhase ? node.title : rootPhaseTitle;

            const span = planSpan ? planSpan.get(node.id) ?? null : null;
            const start = planSpan ? span?.start ?? null : node.scheduled_start;
            const end = planSpan ? span?.end ?? null : node.scheduled_end;
            // On a card plan, a section whose every card is met is done.
            const effectiveStatus = planSpan && cardsAllMet(node)
                ? 'completed'
                : node.effectiveStatus || node.status;

            let colorClass = 'bg-blue-400 dark:bg-blue-500';
            let isOverdue = false;

            if (effectiveStatus === 'completed') {
                colorClass = 'bg-emerald-400 dark:bg-emerald-500';
            } else if (effectiveStatus === 'skipped') {
                colorClass = 'bg-slate-300 dark:bg-slate-500';
            } else if (end && end < todayDate) {
                colorClass = 'bg-red-400 dark:bg-red-500';
                isOverdue = true;
            } else if (start && start <= todayDate && effectiveStatus === 'in_progress') {
                colorClass = 'bg-amber-400 dark:bg-amber-500';
            }
            // Overdue is `end < today` — the rule the feed, the dashboard and the
            // detail panel all use. A not-started topic whose window opens TODAY
            // (or is still open) is on time; it was painted red on day one.

            if (hasKids && effectiveStatus !== 'completed' && !isOverdue) {
                colorClass = 'bg-blue-300 dark:bg-blue-400/60';
            }

            items.push({
                id: node.id,
                title: node.title,
                depth,
                status: effectiveStatus,
                isNote: !!node.is_note,
                scheduledStart: start,
                scheduledEnd: end,
                hasChildren: hasKids,
                parentId: parentNodeId,
                rootPhaseId: currentRootId,
                rootPhaseTitle: currentRootTitle,
                colorClass,
                isOverdue,
            });

            if (hasKids) {
                walk(node.children, depth + 1, node.id, currentRootId, currentRootTitle);
            }
        }
    };

    walk(tree, 0, null, null, null);
    return items;
}

/** Every card on this node and under it met (`progress` is filled by buildTree). */
function cardsAllMet(node: TreeNode): boolean {
    const cards = node.progress?.cards ?? node.cards ?? 0;
    const seen = node.progress?.seen ?? node.seen ?? 0;
    return cards > 0 && seen >= cards;
}

/**
 * The dates a card plan gives each node: a section its own, an ancestor the span
 * of what is under it. Null when there is no plan — the tree's stored dates
 * are then the whole story.
 */
function cardPlanSpans(tree: TreeNode[], cardPlan: CardPlanSection[] | null): Map<number, { start: string; end: string }> | null {
    if (!cardPlan) return null;
    const own = new Map(cardPlan.map(s => [s.nodeId, s]));
    const spans = new Map<number, { start: string; end: string }>();
    const visit = (node: TreeNode): { start: string; end: string } | null => {
        let span: { start: string; end: string } | null = null;
        const mine = own.get(node.id);
        if (mine) span = { start: mine.start, end: mine.end };
        for (const child of node.children) {
            if (child.is_note) continue;
            const s = visit(child);
            if (!s) continue;
            span = span
                ? { start: s.start < span.start ? s.start : span.start, end: s.end > span.end ? s.end : span.end }
                : s;
        }
        if (span) spans.set(node.id, span);
        return span;
    };
    tree.forEach(visit);
    return spans;
}

/**
 * A card plan as calendar chips: one per section, across the study days its
 * cards fall on. Status is read off the cards (all met = done, some = under
 * way), since nothing closes a section by hand.
 */
export function cardPlanCalendarTasks(tree: TreeNode[], cardPlan: CardPlanSection[], projectColor = '#3B82F6'): CalendarTaskInput[] {
    return cardPlan.map(s => ({
        nodeId: s.nodeId,
        title: findNode(tree, s.nodeId)?.title ?? '',
        status: s.cards > 0 && s.seen >= s.cards ? 'completed' : s.seen > 0 ? 'in_progress' : 'not_started',
        color: projectColor,
        scheduled_start: s.start,
        scheduled_end: s.end,
    }));
}

// CALENDAR DATA BUILDER

export interface CalendarBuildOptions {
    mode?: CalendarViewMode;
    weekStartDay?: WeekStartDay;
    /** For week mode: any date within the week to display (YYYY-MM-DD) */
    weekRefDate?: string;
}

/** A schedulable task in calendar-friendly form — the common denominator
 *  between the per-project tree (leaf TreeNodes) and the global calendar feed
 *  (GET /api/calendar rows). `color` is the pending-state colour; status
 *  overrides (completed/skipped/in-progress) are applied in assignTasksToDays. */
export interface CalendarTaskInput {
    nodeId: number;
    title: string;
    status: string;
    color: string;
    scheduled_start: string;
    scheduled_end: string;
}

/** Build the empty day-cell grid for a month (42 cells) / week (7) / day (1). */
export function buildCalendarScaffold(
    year: number,
    month: number,          // 0-indexed (0 = January)
    studyDays: number[],    // ISO days [1..7]
    options?: CalendarBuildOptions
): CalendarDay[] {
    const mode: CalendarViewMode = options?.mode || 'month';
    const weekStartDay: WeekStartDay = options?.weekStartDay ?? 0;
    const todayDate = todayStr();
    const days: CalendarDay[] = [];

    if (mode === 'day') {
        // Single-day view: just the reference date.
        const refDate = options?.weekRefDate || todayDate;
        const d = parseDate(refDate);
        const dayOfWeek = d.getUTCDay();
        const isoDay = dayOfWeek === 0 ? 7 : dayOfWeek;
        days.push({
            date: refDate,
            dayOfWeek,
            isToday: refDate === todayDate,
            isStudyDay: studyDays.includes(isoDay),
            isCurrentMonth: d.getUTCMonth() === month && d.getUTCFullYear() === year,
            tasks: [],
        });
    } else if (mode === 'week') {
        const refDate = options?.weekRefDate || todayDate;
        const refParsed = parseDate(refDate);
        const refDayOfWeek = refParsed.getUTCDay();
        const offset = (refDayOfWeek - weekStartDay + 7) % 7;

        const weekStart = new Date(refParsed);
        weekStart.setUTCDate(weekStart.getUTCDate() - offset);

        for (let i = 0; i < 7; i++) {
            const d = new Date(weekStart);
            d.setUTCDate(d.getUTCDate() + i);

            const dateStr = formatDate(d);
            const dayOfWeek = d.getUTCDay();
            const isoDay = dayOfWeek === 0 ? 7 : dayOfWeek;

            days.push({
                date: dateStr,
                dayOfWeek,
                isToday: dateStr === todayDate,
                isStudyDay: studyDays.includes(isoDay),
                isCurrentMonth: d.getUTCMonth() === month && d.getUTCFullYear() === year,
                tasks: [],
            });
        }
    } else {
        // Month mode: 42 cells (6 rows × 7 columns)
        const firstDay = new Date(Date.UTC(year, month, 1));
        const lastDay = new Date(Date.UTC(year, month + 1, 0));
        const daysInMonth = lastDay.getUTCDate();

        const firstDayOfWeek = firstDay.getUTCDay();
        const leadingOffset = (firstDayOfWeek - weekStartDay + 7) % 7;

        // Previous-month padding days
        const prevMonthLastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
        for (let i = leadingOffset - 1; i >= 0; i--) {
            const day = prevMonthLastDay - i;
            const prevMonth = month - 1 < 0 ? 11 : month - 1;
            const prevYear = month - 1 < 0 ? year - 1 : year;
            const dateStr = `${prevYear}-${String(prevMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            const d = new Date(Date.UTC(prevYear, prevMonth, day));
            const dayOfWeek = d.getUTCDay();
            const isoDay = dayOfWeek === 0 ? 7 : dayOfWeek;

            days.push({
                date: dateStr,
                dayOfWeek,
                isToday: dateStr === todayDate,
                isStudyDay: studyDays.includes(isoDay),
                isCurrentMonth: false,
                tasks: [],
            });
        }

        // Current-month days
        for (let d = 1; d <= daysInMonth; d++) {
            const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
            const dayDate = new Date(Date.UTC(year, month, d));
            const dayOfWeek = dayDate.getUTCDay();
            const isoDay = dayOfWeek === 0 ? 7 : dayOfWeek;

            days.push({
                date: dateStr,
                dayOfWeek,
                isToday: dateStr === todayDate,
                isStudyDay: studyDays.includes(isoDay),
                isCurrentMonth: true,
                tasks: [],
            });
        }

        // Next-month padding to fill 42 cells
        const remaining = 42 - days.length;
        for (let d = 1; d <= remaining; d++) {
            const nextMonth = month + 1 > 11 ? 0 : month + 1;
            const nextYear = month + 1 > 11 ? year + 1 : year;
            const dateStr = `${nextYear}-${String(nextMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
            const dayDate = new Date(Date.UTC(nextYear, nextMonth, d));
            const dayOfWeek = dayDate.getUTCDay();
            const isoDay = dayOfWeek === 0 ? 7 : dayOfWeek;

            days.push({
                date: dateStr,
                dayOfWeek,
                isToday: dateStr === todayDate,
                isStudyDay: studyDays.includes(isoDay),
                isCurrentMonth: false,
                tasks: [],
            });
        }
    }

    return days;
}

/**
 * Place tasks onto scaffold days, applying the shared status colour overrides.
 *
 * ONE CHIP PER TASK, on the first day of its span that this period shows.
 * Drawing a topic on every day it spans makes the plan look like far more work
 * than it is: a week of six topics scheduled five days each read as thirty
 * things to do, the same six titles over and over. Anchoring to
 * `scheduled_start` alone would instead HIDE work already under way whenever a
 * span began before the period on screen — a topic running Thursday to
 * Wednesday would vanish from the week it is actually being studied in. So the
 * anchor is the first day of the span this period contains: every period shows
 * exactly the tasks that touch it, once each, and the chip carries its own
 * dates for the days it does not sit on.
 */
export function assignTasksToDays(days: CalendarDay[], tasks: CalendarTaskInput[]): CalendarDay[] {
    for (const task of tasks) {
        const start = parseDate(task.scheduled_start);
        const end = parseDate(task.scheduled_end);

        const day = days.find(d => {
            const dayDate = parseDate(d.date);
            return dayDate >= start && dayDate <= end;
        });
        if (!day) continue;

        day.tasks.push({
            nodeId: task.nodeId,
            title: task.title,
            // The API feed types status as plain string; the calendar only
            // styles the known values and renders the rest neutrally.
            status: task.status as CalendarDay['tasks'][number]['status'],
            // Always the PROJECT's colour. Status is the chip's body
            // (CalendarView `chipClass`): recolouring the dot by status made a
            // done topic the physics course's emerald and an under-way one the
            // Dutch course's orange, so one colour meant three things.
            color: task.color,
            start: task.scheduled_start,
            end: task.scheduled_end,
        });
    }
    return days;
}

/**
 * The scheduled leaves of one project's in-memory tree, in the same shape the
 * global calendar's fetched rows arrive in — so both scopes of `CalendarView`
 * feed the identical `assignTasksToDays`. Reading the tree rather than the API
 * is what makes a status change recolour the grid immediately.
 */
export function leafCalendarTasks(tree: TreeNode[], projectColor = '#3B82F6'): CalendarTaskInput[] {
    return getLeafNodes(tree)
        .filter(n => n.scheduled_start && n.scheduled_end)
        .map(n => ({
            nodeId: n.id,
            title: n.title,
            status: n.effectiveStatus || n.status,
            color: projectColor,
            scheduled_start: n.scheduled_start!,
            scheduled_end: n.scheduled_end!,
        }));
}