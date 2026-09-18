import { Node, TreeNode, GanttItem, CalendarDay, CalendarViewMode, WeekStartDay } from '../types';

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
export function topicWeight(node: Pick<Node, 'cards'>): number {
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

    if (isLeafNode(node)) return node.status;

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

    const calcProgress = (node: TreeNode): { total: number; completed: number; done: number; weight: number } => {
        if (node.is_note) {
            node.progress = { total: 0, completed: 0, percentage: 0 };
            node.children.forEach(calcProgress);
            return { total: 0, completed: 0, done: 0, weight: 0 };
        }

        if (isLeafNode(node)) {
            // Any children here are notes — material, not sub-work. Still walk
            // them so every node in the tree ends up with a progress object.
            node.children.forEach(calcProgress);
            // A slice of card order contributes nothing, the same way a note
            // does: its cards are rationed by the queue, and it is not a thing
            // that gets finished (isWorkLeaf).
            if (node.role === 'pagination') {
                node.progress = { total: 0, completed: 0, percentage: 0 };
                return { total: 0, completed: 0, done: 0, weight: 0 };
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
            node.progress = { total: 1, completed, percentage: Math.round(done * 100) };
            return { total: 1, completed, done: done * weight, weight };
        }

        let total = 0;
        let completed = 0;
        let done = 0;
        let weight = 0;
        for (const child of node.children) {
            const childProgress = calcProgress(child);
            total += childProgress.total;
            completed += childProgress.completed;
            done += childProgress.done;
            weight += childProgress.weight;
        }

        const percentage = weight > 0 ? Math.round((done / weight) * 100) : 0;
        node.progress = { total, completed, percentage };
        return { total, completed, done, weight };
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
 */
export function buildGanttData(tree: TreeNode[]): GanttItem[] {
    const items: GanttItem[] = [];
    const todayDate = todayStr();

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

            const effectiveStatus = node.effectiveStatus || node.status;

            let colorClass = 'bg-blue-400 dark:bg-blue-500';
            let isOverdue = false;

            if (effectiveStatus === 'completed') {
                colorClass = 'bg-emerald-400 dark:bg-emerald-500';
            } else if (effectiveStatus === 'skipped') {
                colorClass = 'bg-slate-300 dark:bg-slate-500';
            } else if (node.scheduled_end && node.scheduled_end < todayDate) {
                colorClass = 'bg-red-400 dark:bg-red-500';
                isOverdue = true;
            } else if (node.scheduled_start && node.scheduled_start <= todayDate && effectiveStatus === 'in_progress') {
                colorClass = 'bg-amber-400 dark:bg-amber-500';
            } else if (node.scheduled_start && node.scheduled_start <= todayDate && effectiveStatus === 'not_started') {
                colorClass = 'bg-red-300 dark:bg-red-400';
                isOverdue = true;
            }

            if (hasKids && effectiveStatus !== 'completed' && !isOverdue) {
                colorClass = 'bg-blue-200 dark:bg-blue-400/50';
            }

            items.push({
                id: node.id,
                title: node.title,
                depth,
                status: effectiveStatus,
                isNote: !!node.is_note,
                scheduledStart: node.scheduled_start,
                scheduledEnd: node.scheduled_end,
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

/** Place tasks onto scaffold days, applying the shared status colour overrides. */
export function assignTasksToDays(days: CalendarDay[], tasks: CalendarTaskInput[]): CalendarDay[] {
    for (const task of tasks) {
        const start = parseDate(task.scheduled_start);
        const end = parseDate(task.scheduled_end);

        for (const day of days) {
            const dayDate = parseDate(day.date);
            if (dayDate >= start && dayDate <= end) {
                day.tasks.push({
                    nodeId: task.nodeId,
                    title: task.title,
                    // The API feed types status as plain string; the calendar only
                    // colour-codes the known values and renders the rest neutrally.
                    status: task.status as CalendarDay['tasks'][number]['status'],
                    color: task.status === 'completed' ? '#10b981' :
                        task.status === 'skipped' ? '#94a3b8' :
                            task.status === 'in_progress' ? '#f59e0b' : task.color,
                    isStart: day.date === task.scheduled_start,
                    isEnd: day.date === task.scheduled_end,
                });
            }
        }
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