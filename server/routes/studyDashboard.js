// /api/projects/:projectId/study-dashboard.
import db from '../database.js';
import { calculatePace, daysBetween } from '../scheduling.js';
import { structuralChildren, workLeaves } from '../today.js';
import { deckCounts, reviewDue } from '../decks.js';
import { isPagination, TOPIC_NODE } from '../nodeRole.js';
import { projectProgress, topicFraction, topicWeight } from '../progress.js';
import { routeTable } from './routeTable.js';

const app = routeTable('studyDashboard');

// STUDY DASHBOARD

app.get('/api/projects/:projectId/study-dashboard', (req, res) => {
    const { projectId } = req.params;
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    try {
        const todayDate = new Date().toISOString().split('T')[0];
        const allNodes = db.prepare(`
            SELECT id, parent_id, title, status, is_note,
                   scheduled_start, scheduled_end
            FROM nodes WHERE project_id = ? AND is_note = 0
            ORDER BY position
        `).all(projectId);

        const todaySchedule = [];
        const overdueTopics = [];

        // Only leaves are schedulable work. `allNodes` already excludes notes,
        // so a row is a leaf iff no other row lists it as parent_id — which is
        // the "no non-note children" rule, decided once instead of per node.
        const scheduleParentIds = new Set(allNodes.map(n => n.parent_id).filter(id => id != null));

        for (const node of allNodes) {
            if (node.status === 'completed' || node.status === 'skipped') continue;
            if (!node.scheduled_start || !node.scheduled_end) continue;
            if (scheduleParentIds.has(node.id)) continue;

            if (node.scheduled_end < todayDate) {
                const daysOverdue = daysBetween(node.scheduled_end, todayDate);
                overdueTopics.push({
                    id: node.id,
                    title: node.title,
                    status: node.status,
                    scheduled_end: node.scheduled_end,
                    parent_id: node.parent_id,
                    daysOverdue,
                });
            } else if (node.scheduled_start <= todayDate && node.scheduled_end >= todayDate) {
                todaySchedule.push({
                    id: node.id,
                    title: node.title,
                    status: node.status,
                    scheduled_start: node.scheduled_start,
                    scheduled_end: node.scheduled_end,
                    parent_id: node.parent_id,
                });
            }
        }

        const flashcardStats = db.prepare(`
            SELECT
                COUNT(*) as totalCards,
                SUM(CASE WHEN ${reviewDue('f')} THEN 1 ELSE 0 END) as dueCount,
                SUM(CASE WHEN f.difficulty >= 3 THEN 1 ELSE 0 END) as weakCount,
                SUM(CASE WHEN f.last_interval > 0 THEN 1 ELSE 0 END) as reviewedCount,
                SUM(CASE WHEN f.last_interval > 0 AND f.difficulty < 3 THEN 1 ELSE 0 END) as retainedCount
            FROM flashcards f
            JOIN nodes n ON n.id = f.node_id
            WHERE n.project_id = ?
        `).get(projectId);

        // One deck per top-level category, counting flashcards attached to the
        // category itself or ANY descendant (the tree nests arbitrarily deep —
        // a fixed three-level join silently dropped cards at other depths).
        const deckRows = db.prepare(`
            WITH RECURSIVE subtree AS (
                SELECT id, id as root_id FROM nodes
                WHERE project_id = ? AND parent_id IS NULL AND is_note = 0
                UNION ALL
                SELECT n.id, s.root_id FROM nodes n
                JOIN subtree s ON n.parent_id = s.id
            )
            SELECT
                cat.id as categoryId,
                cat.title as categoryTitle,
                COUNT(f.id) as totalCards,
                SUM(CASE WHEN ${reviewDue('f')} THEN 1 ELSE 0 END) as dueCount,
                SUM(CASE WHEN f.difficulty >= 3 THEN 1 ELSE 0 END) as weakCount
            FROM subtree s
            JOIN nodes cat ON cat.id = s.root_id
            JOIN flashcards f ON f.node_id = s.id
            GROUP BY cat.id
            HAVING totalCards > 0
            ORDER BY cat.position
        `).all(projectId);

        // Retention = share of *reviewed* cards that are still in good standing
        // (difficulty < 3). Null until at least one card has been reviewed, so we
        // don't imply 100% retention on a brand-new, never-reviewed deck.
        const reviewedCount = flashcardStats?.reviewedCount || 0;
        // The same counts the card panel draws, from the same function the
        // session is served by (server/decks.js). `dueCount` is reviews OWED,
        // and `newAvailable` is how many unseen cards today's allowance still
        // permits — two numbers, because they are two kinds of work. Merging
        // them was the "1,483 due" headline; dropping the second one would
        // leave a project with 600 written cards and nothing owed reading "0
        // due" beside a disabled Review button.
        const queueCounts = deckCounts(projectId);
        const flashcardSummary = {
            totalCards: flashcardStats?.totalCards || 0,
            dueCount: queueCounts.dueReviews,
            newAvailable: queueCounts.newAvailable,
            newPerDay: queueCounts.newPerDay,
            introducedToday: queueCounts.introducedToday,
            weakCount: flashcardStats?.weakCount || 0,
            retention: reviewedCount > 0
                ? Math.round(((flashcardStats?.retainedCount || 0) / reviewedCount) * 100)
                : null,
            decks: deckRows,
        };

        const weakTopics = db.prepare(`
            SELECT
                n.id as node_id,
                n.title,
                ROUND(AVG(qa.score * 100.0 / qa.total)) as avg_score,
                COUNT(*) as attempt_count
            FROM quiz_attempts qa
            JOIN quizzes q ON q.id = qa.quiz_id
            JOIN nodes n ON n.id = q.node_id
            WHERE n.project_id = ?
            GROUP BY q.node_id
            HAVING avg_score < 70
            ORDER BY avg_score ASC
            LIMIT 10
        `).all(projectId);

        const recentAttempts = db.prepare(`
            SELECT
                qa.score,
                qa.total,
                n.title as node_title,
                q.title as quiz_title,
                qa.created_at
            FROM quiz_attempts qa
            JOIN quizzes q ON q.id = qa.quiz_id
            JOIN nodes n ON n.id = q.node_id
            WHERE n.project_id = ?
            ORDER BY qa.created_at DESC
            LIMIT 10
        `).all(projectId);

        const quizStats = db.prepare(`
            SELECT 
                COUNT(DISTINCT q.id) as totalQuizzes,
                ROUND(AVG(qa.score * 100.0 / qa.total)) as averageScore
            FROM quizzes q
            JOIN nodes n ON n.id = q.node_id
            LEFT JOIN quiz_attempts qa ON qa.quiz_id = q.id
            WHERE n.project_id = ?
        `).get(projectId);

        const quizSummary = {
            totalQuizzes: quizStats?.totalQuizzes || 0,
            averageScore: quizStats?.averageScore ?? null,
            weakTopics,
            recentAttempts,
        };

        let pace = null;
        if (project.start_date && project.deadline) {
            pace = calculatePace(projectId);
        }

        const allProjectNodes = db.prepare('SELECT * FROM nodes WHERE project_id = ? AND is_note = 0').all(projectId);
        // Progress is measured over WORK LEAVES only (a topic that gets proven),
        // never branch/category nodes and never a slice of an imported deck's
        // card order — otherwise this "% complete" diverges from the project
        // card and pace, which count the same set (`workLeaves`, today.js).
        const leafNodes = workLeaves(allProjectNodes);
        // Closed = verified completed OR consciously skipped; both advance progress.
        const completedNodes = leafNodes.filter(n => n.status === 'completed' || n.status === 'skipped').length;
        const totalNodes = leafNodes.length;
        // The COUNT stays a count of topics somebody closed; the PERCENTAGE is
        // the shared one (server/progress.js), which also credits a topic held
        // in cards for the cards met on it. The project card and pace read the
        // same function, so the three cannot drift.
        const progressPercent = Math.round(projectProgress(projectId).fraction * 100);

        let daysUntilDeadline = null;
        if (project.deadline) {
            daysUntilDeadline = daysBetween(todayDate, project.deadline);
        }

        // Cap overdue topics to 3 to prevent overwhelm
        const cappedOverdueTopics = overdueTopics.slice(0, 3);

        // Calculate Hero Task (The single most important thing to do right now)
        let heroTask = null;
        if (overdueTopics.length > 0) {
            heroTask = overdueTopics[0];
        } else if (todaySchedule.length > 0) {
            heroTask = todaySchedule[0];
        } else {
            // Select the first incomplete LEAF node (child_count = 0).
            // We cannot rely on parent_id absence alone because a parent whose
            // children are all completed still has status != 'completed' in the DB
            // but is NOT an actionable item the user can tick off.
            const allNodesForHero = db.prepare(`
        SELECT n.id, n.title, n.status, n.scheduled_start, n.scheduled_end, n.parent_id,
               (SELECT COUNT(*) FROM nodes c WHERE c.parent_id = n.id AND c.is_note = 0) as child_count
        FROM nodes n
        WHERE n.project_id = ? AND n.is_note = 0 AND ${TOPIC_NODE}
          AND n.status NOT IN ('completed', 'skipped')
        ORDER BY n.position ASC
    `).all(projectId);
            const firstLeaf = allNodesForHero.find(n => n.child_count === 0);
            if (firstLeaf) {
                heroTask = firstLeaf;
            }
        }

        // Calculate Milestones (Top-level categories progress)
        const topCategories = db.prepare(`
    SELECT id, title FROM nodes
    WHERE project_id = ? AND parent_id IS NULL AND is_note = 0
    ORDER BY position ASC
`).all(projectId);

        const milestones = topCategories.map(cat => {
            // 1. Fetch the category and all its descendants
            const allSubNodes = db.prepare(`
        WITH RECURSIVE descendants AS (
            SELECT id, parent_id, status, is_note, role FROM nodes WHERE id = ?
            UNION ALL
            SELECT n.id, n.parent_id, n.status, n.is_note, n.role FROM nodes n
            JOIN descendants d ON n.parent_id = d.id
        )
        SELECT d.id, d.parent_id, d.status, d.is_note, d.role,
               -- …and what its cards say, because a topic whose content is
               -- cards is finished by meeting them, not by being ticked
               -- (server/progress.js).
               (SELECT COUNT(*) FROM flashcards f WHERE f.node_id = d.id) AS cards,
               (SELECT COUNT(*) FROM flashcards f WHERE f.node_id = d.id
                  AND f.review_count > 0 AND f.last_reviewed IS NOT NULL) AS seen
        FROM descendants d
    `).all(cat.id);

            const nodeMap = new Map();
            for (const n of allSubNodes) {
                nodeMap.set(n.id, { ...n, children: [] });
            }
            for (const n of allSubNodes) {
                if (n.parent_id && nodeMap.has(n.parent_id)) {
                    nodeMap.get(n.parent_id).children.push(nodeMap.get(n.id));
                }
            }

            // Mirrors the ROLLUP half of `calcProgress` in src/utils/tree.ts:
            // the same leaf rule and the same sums, but nothing here writes a
            // `progress` field back onto the node or walks its note children —
            // this only has to return the pair the milestone bar prints.
            function calcProgress(node) {
                // Notes contribute 0 and their children are ignored for progress
                if (node.is_note) {
                    return { total: 0, completed: 0, done: 0, weight: 0 };
                }
                // So does a slice of card order: it holds cards, and nobody
                // finishes it (server/nodeRole.js). Counting one is what kept a
                // taught import's bar below full however much was proven.
                if (isPagination(node)) {
                    return { total: 0, completed: 0, done: 0, weight: 0 };
                }
                // Leaf = a non-note node with no NON-NOTE children (the tree
                // convention, mirrored by `structuralChildren` in
                // src/utils/tree.ts). Testing `children.length` instead counted
                // a topic that has readings hanging off it as a parent, and
                // since every note contributes 0 its whole phase then reported
                // 0/0 — a phase's progress bar emptied itself the moment
                // material was added to it.
                const structural = structuralChildren(node);
                // A leaf counts as 1, and is DONE by the shared rule: closed by
                // hand, or the share of its cards met (`topicFraction`). The
                // count of closed topics and the share done are tracked
                // separately because the bar prints one and the caption the
                // other — a topic 60% through its cards has not been completed.
                if (structural.length === 0) {
                    const completed = (node.status === 'completed' || node.status === 'skipped') ? 1 : 0;
                    const weight = topicWeight(node);
                    return { total: 1, completed, done: topicFraction(node) * weight, weight };
                }
                // Parent nodes sum up their children's progress
                let total = 0;
                let completed = 0;
                let done = 0;
                let weight = 0;
                for (const child of structural) {
                    const p = calcProgress(child);
                    total += p.total;
                    completed += p.completed;
                    done += p.done;
                    weight += p.weight;
                }
                return { total, completed, done, weight };
            }

            const root = nodeMap.get(cat.id);
            const { total, completed, done, weight } = root
                ? calcProgress(root)
                : { total: 0, completed: 0, done: 0, weight: 0 };
            const percentage = weight > 0 ? Math.round((done / weight) * 100) : 0;

            // Collect leaf-node segments for the segmented progress bar
            const segments = [];
            const collectLeaves = (node) => {
                if (node.is_note) return;
                // Structural children only, like calcProgress above: testing
                // `children.length` recursed into a topic's notes and pushed no
                // segment for it, so the bar drew fewer segments than the leaf
                // count printed beside it.
                const structural = structuralChildren(node);
                if (structural.length === 0) {
                    segments.push({
                        id: node.id,
                        title: node.title,
                        completed: node.status === 'completed' || node.status === 'skipped',
                        skipped: node.status === 'skipped',
                    });
                } else {
                    structural.forEach(collectLeaves);
                }
            };
            if (root) collectLeaves(root);

            return {
                id: cat.id,
                title: cat.title,
                percentage,
                completed,
                total,
                segments
            };
        });

        res.json({
            todaySchedule,
            overdueTopics: cappedOverdueTopics,
            heroTask,
            milestones,
            flashcardSummary,
            quizSummary,
            insights: null,
            pace,
            stats: {
                totalNodes,
                completedNodes,
                progressPercent,
                daysUntilDeadline,
            },
        });
    } catch (err) {
        console.error('[StudyDashboard] Error:', err);
        res.status(500).json({ error: `Failed to load dashboard: ${err.message}` });
    }
});

export const routes = app.takeRoutes();
