import type { TreeNode } from '../types';
import { addDays, isLeafNode, isWorkLeaf, leafStatus, topicDone } from './tree';

/**
 * Which branches of a course's outline start open.
 *
 * Every branch used to start open, so a course of a thousand topics drew all
 * of them and put the learner's place somewhere among hundreds of finished
 * and far-off ones. So from `COLLAPSE_FROM_TOPICS` study items up, a branch
 * starts open only when it holds one in front of the learner now
 * (`activeTopicIds`). A finished branch, one not reached yet and one holding
 * only notes start closed. A smaller course opens everything, as it always did.
 *
 * The learner's own open or close of a branch (`ExpansionChoice`) is kept
 * while the rule's answer for that branch stays what it was when they chose.
 * A category they closed while studying it stays closed. Once that category
 * is finished, or a later one they opened becomes the one they study, the
 * rule decides again, so the outline follows them through the course instead
 * of freezing where they once clicked.
 *
 * Pure: no store, no storage, no clock (`today` is passed in).
 */

/**
 * From this many study items up, a course opens only where the learner is.
 * Below it the whole course is short enough to read at a glance.
 */
export const COLLAPSE_FROM_TOPICS = 150;

/** "Now" on the plan: today and the six days after it. The pace is judged
 *  per week (`server/paceModel.js`), so a week is its unit of "now". */
const PLAN_DAYS_AHEAD = 6;

/** A learner's own open or close of one branch, and the rule's answer when they made it. */
export interface ExpansionChoice {
    open: boolean;
    rule: boolean;
}
export type ExpansionChoices = Record<number, ExpansionChoice>;

/**
 * What the learner works through: every work topic, and every stage an import
 * cut out of card order (`role = 'pagination'`) that holds cards. A stage is
 * no topic (nothing finishes it), but a deck made only of stages is still
 * studied stage by stage, and its outline has to open at the one being met.
 */
const isStudyItem = (n: TreeNode) => isWorkLeaf(n) || (isLeafNode(n) && (n.cards ?? 0) > 0);
/** Done is `topicDone`, the share the progress bars show: a deck topic whose
 *  cards are all met counts as finished here before anyone marks it, where
 *  the server's "Next up" waits for the stored status. */
const isOpenItem = (n: TreeNode) => topicDone(n) < 1;
const isDated = (t: TreeNode) => !!t.scheduled_start && !!t.scheduled_end;

/** Every study item in outline order. */
function studyItems(nodes: TreeNode[], out: TreeNode[] = []): TreeNode[] {
    for (const n of nodes) {
        if (isStudyItem(n)) out.push(n);
        studyItems(n.children, out);
    }
    return out;
}

/**
 * The topic "Next up" names (`server/routes/studyDashboard.js`): the oldest
 * day of the plan left unfinished when the learner is behind it, else the
 * order the feed serves in when nothing is due (soonest start first, then
 * undated topics in creation order, `getFocusNodes`).
 */
function nextTopic(open: TreeNode[], today: string): TreeNode | null {
    let best: TreeNode | null = null;
    for (const t of open) {
        if (!isDated(t) || t.scheduled_end! >= today) continue;
        if (!best || t.scheduled_end! < best.scheduled_end!) best = t;
    }
    if (best) return best;
    const key = (t: TreeNode): [number, string, number] => [isDated(t) ? 0 : 1, t.scheduled_start ?? '', t.id];
    for (const t of open) {
        if (!best) { best = t; continue; }
        const [a, b] = [key(t), key(best)];
        if (a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] < b[1] : a[2] < b[2]) best = t;
    }
    return best;
}

/**
 * The open topics in front of the learner now: the one "Next up" names, the
 * ones the plan puts in this week, and the ones already under way. Empty when
 * nothing is open.
 */
export function activeTopicIds(tree: TreeNode[], today: string): Set<number> {
    const open = studyItems(tree).filter(isOpenItem);
    const weekEnd = addDays(today, PLAN_DAYS_AHEAD);
    const active = new Set<number>();
    for (const t of open) {
        const thisWeek = isDated(t) && t.scheduled_start! <= weekEnd && t.scheduled_end! >= today;
        if (thisWeek || leafStatus(t) === 'in_progress') active.add(t.id);
    }
    const next = nextTopic(open, today);
    if (next) active.add(next.id);
    return active;
}

/**
 * The rule's answer for every node that has children: open or closed. A node
 * with none is not in the map (nothing to open).
 */
export function ruleExpansion(tree: TreeNode[], today: string): Record<number, boolean> {
    const rule: Record<number, boolean> = {};
    const active = studyItems(tree).length >= COLLAPSE_FROM_TOPICS ? activeTopicIds(tree, today) : null;
    const walk = (n: TreeNode): boolean => {
        let holds = active?.has(n.id) ?? false;
        for (const c of n.children) if (walk(c)) holds = true;
        if (n.children.length > 0) rule[n.id] = active ? holds : true;
        return holds;
    };
    tree.forEach(walk);
    return rule;
}

/**
 * What the outline shows: the rule, except where the learner chose otherwise
 * and the rule still says what it said then. A choice the rule has moved past
 * is dropped from the returned `choices`; choices about nodes outside this
 * course are kept as they are.
 */
export function applyChoices(
    rule: Record<number, boolean>,
    choices: ExpansionChoices,
): { expanded: Record<number, boolean>; choices: ExpansionChoices } {
    const expanded = { ...rule };
    let kept = choices;
    for (const key of Object.keys(rule)) {
        const id = Number(key);
        const choice = choices[id];
        if (!choice) continue;
        if (choice.rule === rule[id]) {
            expanded[id] = choice.open;
        } else {
            if (kept === choices) kept = { ...choices };
            delete kept[id];
        }
    }
    return { expanded, choices: kept };
}

/** Record the learner opening or closing a branch. Agreeing with the rule is no choice to keep. */
export function withChoice(choices: ExpansionChoices, id: number, open: boolean, ruleOpen: boolean): ExpansionChoices {
    const next = { ...choices };
    if (open === ruleOpen) delete next[id];
    else next[id] = { open, rule: ruleOpen };
    return next;
}

const parse = (text: string | null): unknown => {
    if (text === null) return null;
    try { return JSON.parse(text); } catch { return null; }
};
const entries = (value: unknown): [number, unknown][] =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
        ? Object.entries(value).map(([key, v]) => [Number(key), v] as [number, unknown]).filter(([id]) => Number.isInteger(id) && id > 0)
        : [];

/** The choices as stored (`terramentor-expansion-choices`). Storage is
 *  anyone's to write, so whatever is not a well-formed choice is dropped. */
export function choicesFromStorage(text: string | null): ExpansionChoices {
    const choices: ExpansionChoices = {};
    for (const [id, c] of entries(parse(text))) {
        const { open, rule } = (c ?? {}) as Partial<ExpansionChoice>;
        if (typeof open === 'boolean' && typeof rule === 'boolean') choices[id] = { open, rule };
    }
    return choices;
}

/**
 * The map kept before this rule (`terramentor-expansion`) saved every
 * branch's state, and every default was open. So only a closed branch there
 * was the learner's own doing, a choice made while the rule said open.
 */
export function choicesFromLegacy(text: string | null): ExpansionChoices {
    const choices: ExpansionChoices = {};
    for (const [id, value] of entries(parse(text))) {
        if (value === false) choices[id] = { open: false, rule: true };
    }
    return choices;
}
