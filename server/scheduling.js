import db from './database.js';
import { isPagination } from './nodeRole.js';
import { projectProgress, projectCountsInCards } from './progress.js';
import { headStartsForProject, scheduleShare } from './headStart.js';

// Constants

const DEPTH_DISCOUNT_FACTOR = 0.85;
// Floor on a leaf's scheduling weight, so a very deep topic still claims a
// share of the calendar. It was `MIN_HOURS_PER_TOPIC / hoursPerDay`, i.e. 0.25
// at the default 2 h/day — this constant IS that value, which is why removing
// the hours input reproduces every existing schedule exactly (measured: 0 of
// 3050 scheduled nodes move, across projects set to 1, 1.5, 2 and 5 h/day).
const MIN_LEAF_WEIGHT = 0.25;

// Date Utilities

/**
 * Parse a date string (YYYY-MM-DD) into a Date at midnight UTC.
 */
function parseDate(dateStr) {
    if (!dateStr) return null;
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d));
}

/**
 * Format a Date to YYYY-MM-DD.
 */
function formatDate(date) {
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, '0');
    const d = String(date.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

/**
 * Add days to a date string.
 */
function addDays(dateStr, days) {
    const d = parseDate(dateStr);
    d.setUTCDate(d.getUTCDate() + days);
    return formatDate(d);
}

/**
 * Get the ISO day-of-week (1=Mon, 7=Sun) for a date string.
 */
function getISODay(dateStr) {
    const d = parseDate(dateStr);
    const jsDay = d.getUTCDay(); // 0=Sun
    return jsDay === 0 ? 7 : jsDay;
}

/**
 * Calculate the number of days between two date strings.
 */
export function daysBetween(startDate, endDate) {
    const s = parseDate(startDate);
    const e = parseDate(endDate);
    return Math.round((e - s) / (1000 * 60 * 60 * 24));
}

/**
 * Calendar days from today to `dateStr`: 0 means the date IS today, negative
 * means it has passed. THE one definition of "days left" in this app — the feed
 * header, the checkpoint card and the assistant's snapshot all read from here,
 * so a deadline can never be 3 days away on one screen and 4 on another.
 */
export function daysUntil(dateStr, today = new Date().toISOString().split('T')[0]) {
    if (!dateStr) return null;
    const n = daysBetween(today, dateStr);
    return Number.isFinite(n) ? n : null;
}

/** Mon–Fri, the study week a project has until somebody says otherwise. */
export const DEFAULT_STUDY_DAYS = [1, 2, 3, 4, 5];

/**
 * `projects.study_days` as an array of ISO weekdays, whatever is in the column.
 *
 * ONE reader, because two of them had already drifted: `today.js` wrapped the
 * parse in a try/catch and checked the result was a non-empty array, and this
 * module called `JSON.parse` bare and then read `.length` off it. The column is
 * free TEXT that `PUT /api/projects/:id` writes verbatim when the client sends a
 * string, so "it is always valid JSON" is not something either of them gets to
 * assume — and the bare one is the only reader that cannot survive being wrong,
 * which meant a single bad value made recalibrating that project throw for ever.
 *
 * Anything unreadable, empty, or not a list of weekdays falls back to the
 * default rather than failing: the study week is a preference, and refusing to
 * schedule is a worse answer than scheduling Monday to Friday.
 */
export function readStudyDays(raw) {
    let parsed;
    try { parsed = JSON.parse(raw || JSON.stringify(DEFAULT_STUDY_DAYS)); } catch { return [...DEFAULT_STUDY_DAYS]; }
    if (!Array.isArray(parsed)) return [...DEFAULT_STUDY_DAYS];
    const days = [...new Set(parsed.map(Number).filter(d => Number.isInteger(d) && d >= 1 && d <= 7))];
    return days.length ? days.sort((a, b) => a - b) : [...DEFAULT_STUDY_DAYS];
}

/**
 * The longest window a schedule may span: twenty years. Every date list in
 * this module is built a day at a time, and the dates arrive from a request —
 * a deadline in the year 99999 was 36 million iterations, about 37 s with the
 * whole server blocked (better-sqlite3 and this loop share the one thread).
 */
export const MAX_SCHEDULE_DAYS = 366 * 20;

/**
 * A real calendar date written `YYYY-MM-DD` (2026-02-30 is not one), in the
 * years 1900–2199 — so even a date judged alone, with no start beside it,
 * bounds the loops that walk up to it from today.
 */
export function isScheduleDate(value) {
    if (typeof value !== 'string' || !/^(19|20|21)\d{2}-\d{2}-\d{2}$/.test(value)) return false;
    const d = parseDate(value);
    return !Number.isNaN(d.getTime()) && formatDate(d) === value;
}

/**
 * Why a start/deadline pair cannot be scheduled, or null when it can. The one
 * check behind every door that writes or schedules a window.
 */
export function scheduleWindowError(startDate, deadline) {
    if (!isScheduleDate(startDate)) return 'Start date must be a date written YYYY-MM-DD.';
    if (!isScheduleDate(deadline)) return 'Deadline must be a date written YYYY-MM-DD.';
    if (startDate > deadline) return 'Start date must be before deadline.';
    if (daysBetween(startDate, deadline) > MAX_SCHEDULE_DAYS) return 'A schedule can span at most 20 years.';
    return null;
}

/**
 * How many study days fall between two dates, inclusive — counted by whole
 * weeks, so it costs the same for a week as for a century (the home page asks
 * this for every project with a deadline, on every load).
 */
export function countStudyDays(startDate, endDate, studyDays) {
    if (!isScheduleDate(startDate) || !isScheduleDate(endDate) || startDate > endDate) return 0;
    const span = daysBetween(startDate, endDate) + 1;
    const weeks = Math.floor(span / 7);
    let count = weeks * new Set(studyDays).size;
    const cursor = parseDate(startDate);
    cursor.setUTCDate(cursor.getUTCDate() + weeks * 7);
    for (let i = 0; i < span % 7; i++) {
        if (studyDays.includes(getISODay(formatDate(cursor)))) count++;
        cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return count;
}

/**
 * How much of a window's study time has passed by the END of `todayStr`, 0–1:
 * study days from the start through today over study days in the whole window.
 * The plan of a project measured in cards is exactly this line (see
 * `calculatePace`), because its queue meets cards a day at a time. A window
 * with no study day in it at all falls back to calendar time.
 */
export function studyDayShare(startDate, endDate, todayStr, studyDays) {
    if (todayStr < startDate) return 0;
    if (todayStr >= endDate) return 1;
    const total = countStudyDays(startDate, endDate, studyDays);
    if (total <= 0) {
        const span = daysBetween(startDate, endDate);
        return span > 0 ? Math.min(1, Math.max(0, daysBetween(startDate, todayStr) / span)) : 1;
    }
    return countStudyDays(startDate, todayStr, studyDays) / total;
}

/**
 * Get all valid study dates between start and deadline.
 * studyDays is an array of ISO days: [1,2,3,4,5] = Mon-Fri
 *
 * Throws on a window longer than MAX_SCHEDULE_DAYS: the routes refuse one
 * first, so reaching this with one means a stored row predates that check.
 */
export function getValidStudyDates(startDate, endDate, studyDays) {
    const dates = [];
    const current = parseDate(startDate);
    const end = parseDate(endDate);
    if (current && end && (end - current) / 86400000 > MAX_SCHEDULE_DAYS) {
        throw new RangeError('A schedule can span at most 20 years.');
    }

    while (current <= end) {
        const dateStr = formatDate(current);
        const isoDay = getISODay(dateStr);
        if (studyDays.includes(isoDay)) {
            dates.push(dateStr);
        }
        current.setUTCDate(current.getUTCDate() + 1);
    }

    return dates;
}

/**
 * Get today's date as YYYY-MM-DD.
 */
function today() {
    return formatDate(new Date());
}

// Tree Utilities

/**
 * Get all actionable (non-note) nodes for a project as a flat list.
 */
function getProjectNodes(projectId) {
    return db.prepare(`
        SELECT id, parent_id, title, description, status, position, is_note, role,
               estimated_weight, scheduled_start, scheduled_end, completed_at
        FROM nodes
        WHERE project_id = ?
        ORDER BY position ASC
    `).all(projectId);
}

/**
 * Build a map from node id to its children (ordered by position).
 */
function buildChildrenMap(nodes) {
    const map = new Map();
    nodes.forEach(n => {
        if (n.parent_id !== null) {
            if (!map.has(n.parent_id)) map.set(n.parent_id, []);
            map.get(n.parent_id).push(n);
        }
    });
    // Sort each child list by position
    for (const [_, children] of map) {
        children.sort((a, b) => a.position - b.position);
    }
    return map;
}

/**
 * Get root nodes (parent_id = null).
 */
function getRootNodes(nodes) {
    return nodes.filter(n => n.parent_id === null).sort((a, b) => a.position - b.position);
}

/**
 * Calculate depth of a node given a parent_id → node map.
 */
function getNodeDepth(nodeId, nodeMap) {
    let depth = 0;
    let current = nodeMap.get(nodeId);
    while (current && current.parent_id !== null) {
        depth++;
        current = nodeMap.get(current.parent_id);
        if (!current) break;
    }
    return depth;
}

/**
 * Extract leaf nodes in sequential left-to-right order.
 * A leaf is a non-note node with no children.
 */
function getLeafNodesSequential(projectId) {
    const nodes = getProjectNodes(projectId);
    const nodeMap = new Map();
    nodes.forEach(n => nodeMap.set(n.id, n));

    const childrenMap = buildChildrenMap(nodes);
    const leaves = [];

    // Leaf = non-note node with no *non-note* children. Notes are attached
    // material, never structure — a topic whose only children are notes is
    // still a leaf. This must match LEAF_NODE (server/today.js) and isLeafNode
    // (src/utils/tree.ts); counting note children as structural here silently
    // dropped such topics from pace/allocation and desynced the schedule
    // progress % from the project card's leaf count.
    const structuralChildren = (id) => (childrenMap.get(id) || []).filter(c => !c.is_note);

    // …and a leaf only gets a date if it is WORK. A stage the importer cut out
    // of an imported deck's card order holds cards, which the queue rations by
    // day on its own; giving it a slot of its own would spend study days on a
    // container nobody can finish and dilute every topic's share.
    const isWork = (node) => !isPagination(node);

    const traverse = (parentId) => {
        const kids = childrenMap.get(parentId) || [];
        for (const kid of kids) {
            if (kid.is_note) continue;
            if (structuralChildren(kid.id).length === 0) {
                if (isWork(kid)) leaves.push(kid);
            } else {
                traverse(kid.id);
            }
        }
    };

    // Start from virtual root (null parent)
    const roots = getRootNodes(nodes);
    for (const root of roots) {
        if (root.is_note) continue;
        if (structuralChildren(root.id).length === 0) {
            // Root itself is a leaf
            if (isWork(root)) leaves.push(root);
        } else {
            traverse(root.id);
        }
    }

    return { leaves, nodeMap };
}

/**
 * Find the root-level ancestor (Category/Phase) for a given node.
 * Walks up the parent_id chain until it finds a node with parent_id === null.
 */
function findRootAncestor(nodeId, nodeMap) {
    let current = nodeMap.get(nodeId);
    if (!current) return null;
    while (current.parent_id !== null) {
        const parent = nodeMap.get(current.parent_id);
        if (!parent) return current;
        current = parent;
    }
    return current;
}

/**
 * Group leaf nodes by their root-level ancestor (Category/Phase).
 * Returns an array of { root, leaves } objects in root position order.
 */
function groupLeavesByPhase(leaves, nodeMap) {
    const phaseMap = new Map(); // rootId → { root, leaves[] }

    for (const leaf of leaves) {
        const root = findRootAncestor(leaf.id, nodeMap);
        const rootId = root ? root.id : leaf.id;
        const rootObj = root || leaf;

        if (!phaseMap.has(rootId)) {
            phaseMap.set(rootId, { root: rootObj, leaves: [] });
        }
        phaseMap.get(rootId).leaves.push(leaf);
    }

    // Return phases in root position order
    return Array.from(phaseMap.values()).sort((a, b) => a.root.position - b.root.position);
}

/**
 * Effective scheduling weight for a leaf: explicit user override, else a
 * depth-discounted default with a per-topic floor.
 *
 * A topic with a head start (placement or transfer, `headStart.js`) is taught
 * as a short review, so it is given the share of a cold topic's time that its
 * estimate says is still unknown — a correct placement answer (0.41) leaves it
 * 59%. The floor still applies, and a learner's own weight still wins.
 */
function computeLeafWeight(leaf, nodeMap, headStarts = null) {
    if (leaf.estimated_weight !== null && leaf.estimated_weight > 0) {
        return leaf.estimated_weight;
    }
    const depth = getNodeDepth(leaf.id, nodeMap);
    const discountDepth = Math.max(0, depth - 1);
    const weight = 1.0 * Math.pow(DEPTH_DISCOUNT_FACTOR, discountDepth)
        * scheduleShare(headStarts?.get(leaf.id) ?? null);
    return Math.max(MIN_LEAF_WEIGHT, weight);
}

/**
 * Core phase-aware allocator shared by initial scheduling and recalibration.
 * Groups leaves (each carrying `effectiveWeight`) by root phase, lays phases out
 * sequentially across the given study dates, and distributes each phase's dates
 * proportionally by weight. Falls back to a flat proportional spread when there
 * are more phases than days. Returns leaf assignments only (parents derived later).
 *
 * The unit is a STUDY DAY, not hours: an hours/day input cancels itself out of
 * its own arithmetic — capacity is `days * hoursPerDay` and the cursor is
 * divided by `hoursPerDay` again to get back to a day index, so the setting
 * never reaches a date. Days are what the allocator actually distributes.
 */
function allocatePhaseAware(leavesWithWeight, nodeMap, validDates) {
    const phases = groupLeavesByPhase(leavesWithWeight, nodeMap);
    const totalWeight = leavesWithWeight.reduce((sum, l) => sum + l.effectiveWeight, 0);
    const assignments = new Map();
    const warnings = [];

    const canFitSequentially = phases.length <= validDates.length;

    const dayToDate = (day, dates) => {
        const clamped = Math.max(0, Math.min(Math.floor(day), dates.length - 1));
        return dates[clamped];
    };

    const placeLeaf = (leaf, startDay, cumulativeDays, dates) => {
        const scheduled_start = dayToDate(startDay, dates);
        let scheduled_end = dayToDate(Math.max(startDay, cumulativeDays - 0.001), dates);
        if (scheduled_end < scheduled_start) scheduled_end = scheduled_start;
        assignments.set(leaf.id, {
            scheduled_start,
            scheduled_end,
            weight: leaf.effectiveWeight,
            allocatedDays: Math.round((cumulativeDays - startDay) * 100) / 100,
        });
    };

    if (canFitSequentially) {
        // Partition validDates into contiguous, non-overlapping runs, one per phase,
        // via cumulative-weight boundaries. Cumulative rounding (rather than rounding
        // each phase's day count independently) guarantees the boundaries are
        // monotonic and land exactly on [0, validDates.length] — so no phase can ever
        // be pushed past the end and collapse to an empty date range (which used to
        // happen with skewed weights on a tight schedule: a small trailing phase could
        // round down to 0 remaining days while still being forced to "claim" 1).
        const dayCount = validDates.length;
        const boundaries = [0];
        let cumulativeWeight = 0;
        phases.forEach((phase, i) => {
            const phaseWeight = phase.leaves.reduce((sum, l) => sum + l.effectiveWeight, 0);
            cumulativeWeight += phaseWeight;
            const fraction = totalWeight > 0 ? cumulativeWeight / totalWeight : (i + 1) / phases.length;
            const minBoundary = boundaries[i] + 1;
            const maxBoundary = dayCount - (phases.length - 1 - i);
            const boundary = Math.max(minBoundary, Math.min(Math.round(fraction * dayCount), maxBoundary));
            boundaries.push(boundary);
        });

        for (let i = 0; i < phases.length; i++) {
            const phase = phases[i];
            const phaseWeight = phase.leaves.reduce((sum, l) => sum + l.effectiveWeight, 0);
            const phaseDates = validDates.slice(boundaries[i], boundaries[i + 1]);

            const daysPerWeightUnit = phaseWeight > 0 ? phaseDates.length / phaseWeight : 0;

            let cumulativeDays = 0;
            for (const leaf of phase.leaves) {
                const startDay = cumulativeDays;
                cumulativeDays += leaf.effectiveWeight * daysPerWeightUnit;
                placeLeaf(leaf, startDay, cumulativeDays, phaseDates);
            }
        }
    } else {
        warnings.push(`Deadline is tight: distributing ${leavesWithWeight.length} topics across ${validDates.length} study days. Some phases will overlap.`);
        const daysPerWeightUnit = totalWeight > 0 ? validDates.length / totalWeight : 0;

        let cumulativeDays = 0;
        for (const leaf of leavesWithWeight) {
            const startDay = cumulativeDays;
            cumulativeDays += leaf.effectiveWeight * daysPerWeightUnit;
            placeLeaf(leaf, startDay, cumulativeDays, validDates);
        }
    }

    return { assignments, warnings, totalWeight, phaseCount: phases.length };
}

/**
 * Derive parent (and ancestor) date ranges from leaf assignments by spanning
 * the min start / max end of descendants. Optionally seeds the date map with the
 * preserved dates of already-closed (completed/skipped) leaves so recalibration
 * keeps historical bars intact. Mutates `assignments` to add parent rows.
 */
function deriveParentDates(projectId, assignments, { preserveClosed = false } = {}) {
    const allNodes = getProjectNodes(projectId);
    const childrenMap = buildChildrenMap(allNodes);
    const dateMap = new Map();

    if (preserveClosed) {
        allNodes.forEach(n => {
            if ((n.status === 'completed' || n.status === 'skipped') && n.scheduled_start && n.scheduled_end) {
                dateMap.set(n.id, { start: n.scheduled_start, end: n.scheduled_end });
            }
        });
    }

    for (const [id, data] of assignments) {
        dateMap.set(id, { start: data.scheduled_start, end: data.scheduled_end });
    }

    const deriveDates = (nodeId) => {
        if (dateMap.has(nodeId)) return dateMap.get(nodeId);
        const children = childrenMap.get(nodeId) || [];
        if (children.length === 0) return null;
        const childDates = children.map(c => deriveDates(c.id)).filter(Boolean);
        if (childDates.length === 0) return null;
        const start = childDates.reduce((min, d) => d.start < min ? d.start : min, childDates[0].start);
        const end = childDates.reduce((max, d) => d.end > max ? d.end : max, childDates[0].end);
        dateMap.set(nodeId, { start, end });
        return { start, end };
    };

    getRootNodes(allNodes).forEach(r => deriveDates(r.id));

    for (const [nodeId, dates] of dateMap) {
        if (!assignments.has(nodeId)) {
            assignments.set(nodeId, {
                scheduled_start: dates.start,
                scheduled_end: dates.end,
                weight: null,
                allocatedDays: null,
            });
        }
    }
}

// Algorithm A: Phase-Aware Depth-Discounted Proportional Allocation

/**
 * Main scheduling algorithm — Phase-Aware version.
 * 
 * Groups leaf nodes by their root-level ancestor (Phase/Category),
 * allocates date ranges sequentially per phase, then distributes
 * tasks within each phase proportionally by weight.
 *
 * @param {number} projectId
 * @param {string} startDate  - YYYY-MM-DD
 * @param {string} deadline   - YYYY-MM-DD
 * @param {number[]} studyDays - Array of ISO days [1..7]
 * @returns {{ success, assignments, warnings?, stats }}
 */
export function allocateSchedule(projectId, startDate, deadline, studyDays) {
    // A project measured in cards has no topics to lay out: its plan is the
    // window itself, a straight line of cards met per study day.
    if (projectCountsInCards(projectId)) return allocateCardWindow(projectId, startDate, deadline, studyDays);

    const { leaves, nodeMap } = getLeafNodesSequential(projectId);

    if (leaves.length === 0) {
        return { success: false, error: 'No actionable items to schedule. Add topics first.' };
    }

    const windowError = scheduleWindowError(startDate, deadline);
    if (windowError) return { success: false, error: windowError };

    const validDates = getValidStudyDates(startDate, deadline, studyDays);

    if (validDates.length === 0) {
        return { success: false, error: 'No valid study days between start date and deadline.' };
    }

    // Step 1: Weight every leaf (user override or depth-discounted default,
    // lightened by a head start), then run the SAME shared phase-aware
    // allocator recalibration uses — previously this function carried its own
    // inline copy of that logic.
    const headStarts = headStartsForProject(projectId);
    const leavesWithWeight = leaves.map(leaf => ({
        ...leaf,
        effectiveWeight: computeLeafWeight(leaf, nodeMap, headStarts),
    }));

    const { assignments, warnings, totalWeight, phaseCount } =
        allocatePhaseAware(leavesWithWeight, nodeMap, validDates);

    // Step 2: Derive parent/ancestor date ranges from the leaf assignments.
    deriveParentDates(projectId, assignments);

    // Step 3: Detect additional warnings
    const topicsPerDay = leaves.length / validDates.length;
    if (topicsPerDay > 3) {
        const suggestedDeadline = addDays(startDate, Math.ceil(leaves.length / 1.5) * (7 / studyDays.length));
        warnings.push(`Pace is very intense (${topicsPerDay.toFixed(1)} topics/day). Consider extending deadline to ${suggestedDeadline}.`);
    } else if (topicsPerDay > 2) {
        warnings.push(`Pace is moderate (${topicsPerDay.toFixed(1)} topics/day). Manageable but requires consistency.`);
    }

    if (phaseCount > 1) {
        warnings.push(`Schedule is phase-aware: ${phaseCount} sequential phases allocated.`);
    }

    // Step 4: Build baseline snapshot
    const baselineSnapshot = {
        generated_at: new Date().toISOString(),
        config: { start_date: startDate, deadline, study_days: studyDays },
        leaf_count: leaves.length,
        total_weight: Math.round(totalWeight * 100) / 100,
        topics_per_day: Math.round(topicsPerDay * 100) / 100,
        valid_study_days: validDates.length,
        phase_count: phaseCount,
        nodes: {},
    };

    for (const [id, data] of assignments) {
        baselineSnapshot.nodes[id] = {
            scheduled_start: data.scheduled_start,
            scheduled_end: data.scheduled_end,
            weight: data.weight,
        };
    }

    return {
        success: true,
        assignments,
        baselineSnapshot,
        warnings,
        stats: {
            leafCount: leaves.length,
            validDays: validDates.length,
            totalWeight: Math.round(totalWeight * 100) / 100,
            topicsPerDay: Math.round(topicsPerDay * 10) / 10,
            phaseCount,
        },
    };
}

let cardTotalsStmt = null;
/** Cards on a project and how many are met — the deck screen's "met" rule. */
function cardTotals(projectId) {
    if (!cardTotalsStmt) {
        cardTotalsStmt = db.prepare(`
            SELECT COUNT(*) AS cards,
                   COALESCE(SUM(CASE WHEN f.review_count > 0 AND f.last_reviewed IS NOT NULL THEN 1 ELSE 0 END), 0) AS seen
            FROM flashcards f JOIN nodes n ON n.id = f.node_id
            WHERE n.project_id = ?
        `);
    }
    const row = cardTotalsStmt.get(projectId) || {};
    return { cards: Number(row.cards) || 0, seen: Number(row.seen) || 0 };
}

/**
 * The schedule of a project measured in CARDS (`countsInCards`): a window and
 * nothing else.
 *
 * Its sections are never dated. A deck's queue meets cards front to back, a day's
 * allowance at a time, so the plan is a straight line from the start to the
 * deadline — and a date stored on a stage would only make the feed's urgency call
 * thirty containers overdue by next week (the reason decks get a standing slot
 * rather than a schedule). Where a section falls on that line is worked out when
 * something asks (`cardPlan`), from the cards themselves.
 *
 * Returns the same shape as `allocateSchedule` with no assignments, so
 * `persistSchedule` clears any date a node still carries and writes the window.
 */
function allocateCardWindow(projectId, startDate, deadline, studyDays) {
    const windowError = scheduleWindowError(startDate, deadline);
    if (windowError) return { success: false, error: windowError };
    const validDays = countStudyDays(startDate, deadline, studyDays);
    if (validDays === 0) {
        return { success: false, error: 'No valid study days between start date and deadline.' };
    }
    const { cards } = cardTotals(projectId);
    const cardsPerDay = Math.round((cards / validDays) * 10) / 10;
    return {
        success: true,
        assignments: new Map(),
        warnings: [],
        baselineSnapshot: {
            generated_at: new Date().toISOString(),
            config: { start_date: startDate, deadline, study_days: studyDays },
            basis: 'cards',
            leaf_count: 0,
            card_count: cards,
            cards_per_day: cardsPerDay,
            valid_study_days: validDays,
            nodes: {},
        },
        stats: { basis: 'cards', leafCount: 0, cardCount: cards, cardsPerDay, validDays },
    };
}

/**
 * Persist a computed schedule to the database.
 */
export function persistSchedule(projectId, assignments, baselineSnapshot, config) {
    const { startDate, deadline, studyDays } = config;

    const updateNodeSchedule = db.prepare(`
        UPDATE nodes
        SET scheduled_start = ?, scheduled_end = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `);

    const updateProjectConfig = db.prepare(`
        UPDATE projects
        SET start_date = ?, deadline = ?, study_days = ?,
            baseline_schedule = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `);

    // Notes are reference material, not work items: they must never carry a
    // schedule (otherwise they leak into the calendar / pace / daily plan as
    // phantom tasks). Guard the write so a derived date can never land on a note.
    const noteIds = new Set(
        db.prepare('SELECT id FROM nodes WHERE project_id = ? AND is_note = 1').all(projectId).map(r => r.id)
    );

    const transaction = db.transaction(() => {
        // Clear all existing schedule data for this project
        db.prepare(`
            UPDATE nodes SET scheduled_start = NULL, scheduled_end = NULL, updated_at = CURRENT_TIMESTAMP
            WHERE project_id = ?
        `).run(projectId);

        for (const [nodeId, data] of assignments) {
            if (noteIds.has(nodeId)) continue; // never schedule a note
            if (data.scheduled_start && data.scheduled_end) {
                updateNodeSchedule.run(data.scheduled_start, data.scheduled_end, nodeId);
            }
        }

        updateProjectConfig.run(
            startDate,
            deadline,
            JSON.stringify(studyDays),
            JSON.stringify(baselineSnapshot),
            projectId
        );
    });

    transaction();
}

// Algorithm B: Recalibration Engine

/**
 * Recalibrate the schedule for incomplete nodes only.
 * Pushes remaining work forward from today to the deadline.
 *
 * @param {number} projectId
 * @returns {{ success, assignments, warnings?, stats, unchanged? }}
 */
export function recalibrateSchedule(projectId) {
    const project = db.prepare(`
        SELECT start_date, deadline, study_days, baseline_schedule
        FROM projects WHERE id = ?
    `).get(projectId);

    if (!project || !project.deadline) {
        return { success: false, error: 'No schedule exists for this project. Create one first.' };
    }
    // Its plan is the window, and there are no topic dates to move — the clock
    // cannot be spread again, only the window changed.
    if (projectCountsInCards(projectId)) {
        return { success: false, error: 'This project is measured in cards and has no topics to reschedule. Change its dates instead.' };
    }

    const studyDays = readStudyDays(project.study_days);
    const startDate = today(); // Start from today
    const deadline = project.deadline;

    if (startDate > deadline) {
        // Deadline has passed — suggest new deadline
        const { leaves } = getLeafNodesSequential(projectId);
        const incompleteLeaves = leaves.filter(l => l.status !== 'completed' && l.status !== 'skipped');
        const neededDays = Math.ceil(incompleteLeaves.length / 1.5) * (7 / studyDays.length);
        const suggestedDeadline = addDays(startDate, Math.ceil(neededDays));
        return {
            success: false,
            error: `Deadline (${deadline}) has already passed.`,
            suggestedDeadline,
        };
    }

    // Get only open (not completed and not skipped) leaf nodes
    const { leaves, nodeMap } = getLeafNodesSequential(projectId);
    const incompleteLeaves = leaves.filter(l => l.status !== 'completed' && l.status !== 'skipped');

    if (incompleteLeaves.length === 0) {
        return { success: true, assignments: new Map(), stats: { message: 'All tasks completed!' }, unchanged: true };
    }

    // Today to the stored deadline: a row written before the routes checked
    // windows may hold anything, and must fail here rather than loop.
    const windowError = scheduleWindowError(startDate, deadline);
    if (windowError) return { success: false, error: windowError };

    const validDates = getValidStudyDates(startDate, deadline, studyDays);

    if (validDates.length === 0) {
        return { success: false, error: 'No valid study days remaining between today and deadline.' };
    }

    // Calculate weights for open leaves only, then run the SAME phase-aware
    // allocator used for initial scheduling so recalibration preserves phase
    // ordering instead of flattening every remaining topic into one stream.
    const headStarts = headStartsForProject(projectId);
    const leavesWithWeight = incompleteLeaves.map(leaf => ({
        ...leaf,
        effectiveWeight: computeLeafWeight(leaf, nodeMap, headStarts),
    }));

    const { assignments, warnings } = allocatePhaseAware(
        leavesWithWeight, nodeMap, validDates
    );

    // Derive parent dates, preserving the historical bars of already-closed leaves.
    deriveParentDates(projectId, assignments, { preserveClosed: true });

    const topicsPerDay = incompleteLeaves.length / validDates.length;
    if (topicsPerDay > 3) {
        const suggestedDeadline = addDays(startDate, Math.ceil(incompleteLeaves.length / 1.5) * (7 / studyDays.length));
        warnings.push(`Intense pace ahead (${topicsPerDay.toFixed(1)} topics/day). Consider extending deadline to ${suggestedDeadline}.`);
    }

    const stats = {
        incompleteLeaves: incompleteLeaves.length,
        completedLeaves: leaves.length - incompleteLeaves.length,
        validDays: validDates.length,
        topicsPerDay: Math.round(topicsPerDay * 10) / 10,
        recalibratedFrom: startDate,
    };

    return { success: true, assignments, warnings, stats };
}

// Pace Calculation

/**
 * Calculate the pace / drift of a project.
 * Compares elapsed time vs completed work.
 *
 * @param {number} projectId
 * @returns {{ onTrack, expectedProgress, actualProgress, daysBehind, paceStatus, message }}
 */
export function calculatePace(projectId) {
    const project = db.prepare(`
        SELECT start_date, deadline, study_days, baseline_schedule
        FROM projects WHERE id = ?
    `).get(projectId);

    if (!project || !project.start_date || !project.deadline) {
        return {
            hasSchedule: false,
            onTrack: true,
            expectedProgress: 0,
            actualProgress: 0,
            daysBehind: 0,
            paceStatus: 'no_schedule',
            message: 'No schedule set',
        };
    }

    const { leaves } = getLeafNodesSequential(projectId);
    // Measured in cards (the Projects grid's rule): the plan is a line through the
    // window's study days, so a deck with no topics at all — thirty slices of card
    // order — still has a pace. It used to fall into `no_tasks` here, and every
    // screen drew a window over an empty bar and said "Not started" beside 116
    // cards met.
    const cardsBasis = projectCountsInCards(projectId);

    if (leaves.length === 0 && !cardsBasis) {
        return {
            hasSchedule: true,
            onTrack: true,
            expectedProgress: 0,
            actualProgress: 0,
            daysBehind: 0,
            paceStatus: 'no_tasks',
            message: 'No tasks to track',
        };
    }

    const startDate = project.start_date;
    const deadline = project.deadline;
    const todayStr = today();

    const totalSpan = daysBetween(startDate, deadline);
    const elapsedSpan = daysBetween(startDate, todayStr);

    let elapsedFraction;
    if (elapsedSpan <= 0) {
        elapsedFraction = 0; // Haven't started yet
    } else if (elapsedSpan >= totalSpan) {
        elapsedFraction = 1; // Past deadline
    } else {
        elapsedFraction = elapsedSpan / totalSpan;
    }

    // Actual + schedule-aware expected progress, both as a fraction of leaf
    // TOPICS (not effort-weight). This deliberately matches the project card
    // and the study dashboard so the app never shows two disagreeing
    // "progress" numbers for the same project — the earlier weighted actual
    // drifted ~1pt from the card's count and read as a bug. The depth-discount
    // weighting still governs date allocation (allocatePhaseAware); it just no
    // longer leaks into the reported percentage.
    //   actual   = `projectProgress` (server/progress.js): a closed topic is 1,
    //              an open one with cards is the share of them met, and the
    //              topics are weighted equally. A deck-shaped project can
    //              therefore be behind schedule without a single tick, which is
    //              the only honest reading of one.
    //   expected = leaves the plan says should be done BEFORE today
    //              (scheduled_end < today): behind means something is overdue,
    //              the feed's own word for it. Counting today's topics too
    //              called every new plan "behind, recalibrate" on the day it
    //              was made, before there had been a chance to study. Still the honest "where the plan
    //              puts you" — front-loaded phases and study-day gaps included —
    //              rather than a naive linear sweep of calendar time. We fall
    //              back to the linear elapsed fraction only when no leaf has a
    //              scheduled_end (e.g. a schedule was set but never allocated).
    let totalLeaves = 0;
    let completedLeaves = 0;
    let scheduledExpectedLeaves = 0;
    let anyScheduled = false;

    for (const leaf of leaves) {
        totalLeaves += 1;
        if (leaf.status === 'completed' || leaf.status === 'skipped') {
            completedLeaves += 1;
        }
        // (`completedLeaves` stays a COUNT — it is reported as one. The
        // percentage below comes from server/progress.js, which also gives a
        // topic held in cards the credit its cards have earned.)
        if (leaf.scheduled_end) {
            anyScheduled = true;
            if (leaf.scheduled_end < todayStr) scheduledExpectedLeaves += 1;
        }
    }

    //   …unless the project is measured in CARDS. Then `actual` is cards met
    //   (the same `projectProgress`), and `expected` is the same kind of number:
    //   the share of the window's study days gone by today, since the queue meets
    //   cards a day at a time and nothing in such a project carries a date of its
    //   own (`allocateCardWindow`). A course is untouched by this branch — its
    //   expected position is still counted in topics, as it always was.
    const expectedProgress = cardsBasis
        // Through YESTERDAY, the same "before today" as the topics above: a new
        // deck window was "critical, 1 day behind" on the day it was made.
        ? Math.round(studyDayShare(startDate, deadline, addDays(todayStr, -1), readStudyDays(project.study_days)) * 100)
        : anyScheduled
            ? (totalLeaves > 0 ? Math.round((scheduledExpectedLeaves / totalLeaves) * 100) : 0)
            : Math.round(elapsedFraction * 100);
    const actualProgress = Math.round(projectProgress(projectId).fraction * 100);
    const drift = expectedProgress - actualProgress;

    // Convert drift to "days behind"
    const daysBehind = totalSpan > 0 ? Math.round((drift / 100) * totalSpan) : 0;

    // Status thresholds are capped in absolute days, not just percentage: a 5%
    // drift on a 365-day plan is ~18 real days, which reads as "behind" no
    // matter how small the percentage is — so long projects use the tighter
    // of the two. Short projects are unaffected (the day cap only binds once
    // totalSpan is large enough that day-cap% < the flat 5%/15%).
    const ON_TRACK_DAY_CAP = 7;
    const FALLING_BEHIND_DAY_CAP = 21;
    const onTrackThreshold = totalSpan > 0 ? Math.min(5, (ON_TRACK_DAY_CAP / totalSpan) * 100) : 5;
    const fallingBehindThreshold = totalSpan > 0 ? Math.min(15, (FALLING_BEHIND_DAY_CAP / totalSpan) * 100) : 15;

    let paceStatus;
    let message;
    if (drift <= -onTrackThreshold) {
        paceStatus = 'ahead';
        const days = Math.abs(daysBehind);
        message = `${days} day${days === 1 ? '' : 's'} ahead of schedule`;
    } else if (drift <= onTrackThreshold) {
        paceStatus = 'on_track';
        message = 'On track';
    } else if (drift <= fallingBehindThreshold) {
        paceStatus = 'falling_behind';
        const days = daysBehind;
        message = `${days} day${days === 1 ? '' : 's'} behind schedule`;
    } else {
        paceStatus = 'critical';
        const days = daysBehind;
        message = `${days} day${days === 1 ? '' : 's'} behind — consider recalibrating`;
    }

    return {
        hasSchedule: true,
        onTrack: drift <= fallingBehindThreshold,
        expectedProgress,
        actualProgress,
        drift,
        daysBehind: Math.max(0, daysBehind),
        paceStatus,
        message,
        startDate,
        deadline,
        totalDays: totalSpan,
        elapsedDays: Math.max(0, elapsedSpan),
        completedLeaves,
        totalLeaves,
        // What both percentages are counted in, so a screen can say "cards".
        basis: cardsBasis ? 'cards' : 'topics',
    };
}

/**
 * Get schedule summary for a project (lightweight, for project list view).
 */
export function getScheduleSummary(projectId) {
    const project = db.prepare(`
        SELECT start_date, deadline, study_days
        FROM projects WHERE id = ?
    `).get(projectId);

    if (!project || !project.start_date || !project.deadline) {
        return { hasSchedule: false };
    }

    const pace = calculatePace(projectId);
    return {
        hasSchedule: true,
        startDate: project.start_date,
        deadline: project.deadline,
        paceStatus: pace.paceStatus,
        expectedProgress: pace.expectedProgress,
        actualProgress: pace.actualProgress,
        message: pace.message,
    };
}

/**
 * Take a project's schedule away, all of it: the window, every date the engine
 * wrote on its nodes (topics AND the sections derived above them), and the
 * baseline recalibration measures drift against. A window removed while a topic
 * kept its dates would leave a half-schedule on the calendar and the timeline,
 * and keep the feed calling those topics overdue.
 *
 * The study WEEK stays. It is the learner's answer to "which days do I study",
 * not part of the plan, and keeping it is what makes setting the same two dates
 * again reproduce the same plan (the engine is deterministic given the tree, the
 * window and the week). Progress, mastery and cards are not touched.
 *
 * @returns {{ nodesCleared: number }}
 */
export function removeSchedule(projectId) {
    const clearNodes = db.prepare(`
        UPDATE nodes SET scheduled_start = NULL, scheduled_end = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE project_id = ? AND (scheduled_start IS NOT NULL OR scheduled_end IS NOT NULL)
    `);
    const clearProject = db.prepare(`
        UPDATE projects SET start_date = NULL, deadline = NULL, baseline_schedule = NULL,
               updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `);
    let nodesCleared = 0;
    db.transaction(() => {
        nodesCleared = clearNodes.run(projectId).changes;
        clearProject.run(projectId);
    })();
    return { nodesCleared };
}

/**
 * Where each SECTION of a project measured in cards falls on its plan — what the
 * Timeline draws as rows and the Calendar as chips, since nothing in such a
 * project carries a stored date (`allocateCardWindow`).
 *
 * The plan is the pace line: cards met at an even rate over the window's study
 * days, front to back in deck order. A section holding cards k..k+c of N sits on
 * the study days where that stretch of the line falls, so the section that
 * contains today is the one the notch on the pace bar is inside. Consecutive
 * sections may share a day (a day's quota can finish one and start the next).
 *
 * @returns {null | Array<{ nodeId, start, end, cards, seen }>} null when the
 *   project has no window or is not measured in cards; sections in tree order.
 */
export function cardPlan(projectId) {
    const project = db.prepare('SELECT start_date, deadline, study_days FROM projects WHERE id = ?').get(projectId);
    if (!project?.start_date || !project?.deadline) return null;
    if (scheduleWindowError(project.start_date, project.deadline)) return null;
    if (!projectCountsInCards(projectId)) return null;

    const nodes = getProjectNodes(projectId);
    const counts = new Map(db.prepare(`
        SELECT f.node_id AS id, COUNT(*) AS cards,
               SUM(CASE WHEN f.review_count > 0 AND f.last_reviewed IS NOT NULL THEN 1 ELSE 0 END) AS seen
        FROM flashcards f JOIN nodes n ON n.id = f.node_id
        WHERE n.project_id = ? GROUP BY f.node_id
    `).all(projectId).map(r => [r.id, r]));

    // Deck order: the tree walked by position, every node that holds cards (a
    // stage, a named subdeck, or a root that holds them all). Notes hold none.
    const children = buildChildrenMap(nodes);
    const sections = [];
    const walk = (list) => {
        for (const node of list) {
            if (node.is_note) continue;
            const c = counts.get(node.id);
            if (c?.cards > 0) sections.push({ nodeId: node.id, cards: Number(c.cards), seen: Number(c.seen) || 0 });
            walk(children.get(node.id) || []);
        }
    };
    walk(getRootNodes(nodes));

    const total = sections.reduce((s, x) => s + x.cards, 0);
    const dates = getValidStudyDates(project.start_date, project.deadline, readStudyDays(project.study_days));
    if (total === 0 || dates.length === 0) return [];

    const last = dates.length - 1;
    let before = 0;
    return sections.map(s => {
        const first = Math.min(last, Math.floor((before / total) * dates.length));
        const end = Math.min(last, Math.max(first, Math.ceil(((before + s.cards) / total) * dates.length) - 1));
        before += s.cards;
        return { ...s, start: dates[first], end: dates[end] };
    });
}