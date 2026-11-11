// What an outside agent reads: the answers behind the MCP server's read tools
// (mcp/, served by server/routes/agent.js).
//
// An agent harness (Claude Code, Claude Desktop, Cursor) that the learner points
// at this app teaches in its own window and keeps nothing between sessions; the
// library is the memory it lacks. These are the in-app assistant's own readers
// (server/projectState.js, server/search.js, server/libraryReads.js,
// server/today.js) with the assistant's vocabulary taken out: no `[[open:…]]`
// markers, which only the app's own chat renders.
//
// Two differences from the assistant, both on purpose:
//
//   - The learner's private notes are never sent, nor searched (readTopic and
//     searchAll `notes: false`).
//     The assistant reads them because the learner chose that model in the
//     app; a program reading the library from elsewhere is the export
//     contract's case, and private notes are opt-in there.
//   - The learner's profile ("About you") is not part of get_due: it is a
//     description written for the app's own model, not a schedule.
//
// READ-ONLY, every one. The only write an agent has is a claim
// (server/claims.js).

import db from './database.js';
import { ambiguousProjectText, findProject, projectStateText } from './projectState.js';
import { searchAll } from './search.js';
import { projectsFor } from './aiTools.js';
import { findTopic, parseReadArg, readBudget, readTopic } from './libraryReads.js';
import { buildTodayBriefingContext } from './today.js';
import { checkMasteryEligibility, practiceCeiling } from './mastery.js';
import { getGateConfig } from './settingsStore.js';
import { claimSummary } from './claims.js';
import { missedOf, missedText, reviewItems } from './checkFeedback.js';
import { getSittingReview } from './sittingReview.js';
// A cycle (agentSittings reads topicFor from here); both sides call across it
// only inside functions, never while the modules load.
import { checkOpenOn } from './agentSittings.js';

const PROJECTS_LISTED = 40;
const RESOURCE_HITS = 2;
const RECENT_EVIDENCE = 5;
const NAME_CHARS = 120;

const cut = (s, n = NAME_CHARS) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));
const pct = (x) => `${Math.round(Math.max(0, Math.min(1, Number(x) || 0)) * 100)}%`;

/** Every project by id, active ones first, for an agent that has not picked one yet. */
function projectList() {
    const rows = db.prepare(`
        SELECT id, name, COALESCE(status, 'active') AS status, kind FROM projects
        ORDER BY CASE COALESCE(status, 'active') WHEN 'active' THEN 0 ELSE 1 END, position ASC, created_at ASC, id ASC
    `).all();
    const lines = rows.slice(0, PROJECTS_LISTED)
        .map(p => `- ${p.id} · ${cut(p.name)}${p.kind === 'deck' ? ' · card deck' : ''}${p.status !== 'active' ? ` · ${p.status}` : ''}`);
    if (rows.length > PROJECTS_LISTED) lines.push(`(${rows.length - PROJECTS_LISTED} more not listed: find_in_library finds any of them by name)`);
    return { rows, text: rows.length ? lines.join('\n') : '(the library has no projects yet)' };
}

/**
 * One project in depth, or the list of projects when none is named.
 * `{ text, projectId }`; `projectId` null unless exactly one project was read.
 */
export function agentProjectState(query) {
    const q = String(query ?? '').trim();
    if (!q) {
        const { text } = projectList();
        return { text: `The learner's projects (projectId · name):\n${text}\n\nCall project_state with a projectId or a name for one project in depth.`, projectId: null };
    }
    const { project, candidates } = findProject(q);
    if (candidates.length) return { text: ambiguousProjectText(q, candidates), projectId: null };
    if (!project) {
        return { text: `There is no project matching "${cut(q)}". The learner's projects (projectId · name):\n${projectList().text}`, projectId: null };
    }
    const state = projectStateText(project.id, { markers: false });
    return {
        text: `${state}\n\nEvery id above is real. Pass a topic's nodeId to topic_material, get_mastery or record_claim; never invent one.`,
        projectId: project.id,
    };
}

/** The whole library searched for a word or two: projects, topics, documents, saved links. */
export function agentFind(query) {
    const q = String(query ?? '').trim();
    if (!q) return { text: 'Say what to look for: a word or two.', count: 0 };
    const res = searchAll(q, { limit: 5, notes: false });
    const lines = [];
    for (const p of projectsFor(q, res, { notes: false })) lines.push(`Project "${cut(p.title)}" (projectId ${p.projectId})`);
    for (const n of res.nodes) {
        lines.push(`Topic "${cut(n.title)}" (nodeId ${n.nodeId}, projectId ${n.projectId})${n.projectName ? ` in project "${cut(n.projectName)}"` : ''}${n.status ? `, ${n.status}` : ''}${n.snippet ? `: ${n.snippet}` : ''}`);
    }
    for (const d of res.documents) {
        lines.push(`Document "${cut(d.title || 'Untitled')}"${d.projectName ? ` (project "${cut(d.projectName)}")` : ''}${d.snippet ? `: ${d.snippet}` : ''}`);
    }
    const seenUrls = new Set();
    for (const r of res.resources) {
        if (r.url && seenUrls.has(r.url)) continue;
        if (r.url) seenUrls.add(r.url);
        if (seenUrls.size > RESOURCE_HITS) break;
        lines.push(`Saved link "${cut(r.title)}"${r.url ? ` (${r.url})` : ''}${r.nodeTitle ? ` on topic "${cut(r.nodeTitle)}"` : ''}`);
    }
    if (!lines.length) {
        return {
            text: `Nothing in the library matches "${cut(q)}": no project name, topic title, saved link or document. The search covers the whole library, so the learner has nothing on this yet.`,
            count: 0,
        };
    }
    return { text: `In the learner's library, matching "${cut(q)}":\n${lines.join('\n')}`, count: lines.length };
}

/**
 * What is due today across every active project: overdue and planned topics,
 * cards due, deadlines and pace — the snapshot the app's own daily briefing
 * reads, without the learner's profile. Structured, and the same as text.
 */
export function agentDue() {
    const { learnerProfile: _profile, ...due } = buildTodayBriefingContext({
        decayDays: getGateConfig().decayDays,
        projectTool: 'project_state',
    });
    const text = `Today is ${due.date} for the learner. What is due, most urgent project first `
        + '(overdue and today are topics with their nodeId; dueFlashcards counts cards due for review in the app):\n'
        + JSON.stringify(due, null, 1);
    return { text, due };
}

/** One topic's own text: Overview, Material, the topics under it. Never the private notes. */
export function agentTopic(topic, from) {
    // Resolved here first, so a title and an offset never meet inside one
    // string (parseReadArg reads "Notes from 2023" as a title, rightly).
    const node = topicFor(topic);
    if (!node) return { text: noTopicText(topic), found: false };
    const offset = Number.isInteger(from) && from > 0 ? ` from ${from}` : '';
    const read = readTopic(`${node.id}${offset}`, {
        budget: readBudget(),
        notes: false,
        next: (id, to) => `call topic_material with topic "${id}" and from ${to}`,
    });
    return { text: read.context, found: read.count > 0 };
}

/** What an agent is told when a topic reference names nothing. */
export function noTopicText(topic) {
    const ref = String(topic ?? '').trim();
    return ref
        ? `No topic matches "${cut(ref)}". Use project_state or find_in_library for the real nodeIds; never guess one.`
        : 'Say which topic: a nodeId from project_state or find_in_library, or its title.';
}

/** The topic a reference names, or null. A nodeId, or a title (exact, then the shortest containing it). */
export function topicFor(topic) {
    if (Number.isInteger(topic)) return findTopic({ id: topic });
    const ref = parseReadArg(String(topic ?? '').trim());
    if (ref.id == null && !ref.title) return null;
    return findTopic(ref);
}

const EVIDENCE_NAMES = {
    quiz: 'quiz', mastery_check: 'mastery check', paper: 'paper exercise', drill: 'drill',
    flashcard: 'card reviews', placement: 'placement probe',
};

/**
 * The topic's newest mastery check, read back from the review the app kept
 * of it (server/sittingReview.js): its score and each question the learner
 * missed, with the answer given and the right one. Only a GRADED check is
 * kept, so nothing of one still open is here. Null when the newest check
 * kept no review (one taken before reviews were kept).
 */
function lastCheck(nodeId, checkPass) {
    const row = db.prepare(`
        SELECT id FROM mastery_evidence WHERE node_id = ? AND evidence_type = 'mastery_check' ORDER BY id DESC LIMIT 1
    `).get(nodeId);
    const review = row ? getSittingReview(row.id) : null;
    if (!review || !review.total) return null;
    // A check open on the topic may draw these very questions again.
    const held = checkOpenOn(nodeId);
    const missed = held ? [] : missedOf(reviewItems(review));
    return {
        at: review.at,
        score: review.score,
        total: review.total,
        passed: review.score / review.total >= checkPass,
        missed,
        held,
    };
}

/**
 * Where a topic stands: the estimate, whether it has passed the mastery gate,
 * the evidence the app measured, the claims agents sent (counted apart,
 * because the app did not see those answers), and the newest mastery check's
 * missed questions.
 */
export function agentMastery(topic) {
    const node = topicFor(topic);
    if (!node) return null;
    const gate = getGateConfig();
    // checkMasteryEligibility makes the mastery row when there is none; a read
    // tool writes nothing, and a topic without a row has no evidence anyway.
    const hasRow = !!db.prepare('SELECT 1 FROM node_mastery WHERE node_id = ?').get(node.id);
    const e = hasRow
        ? checkMasteryEligibility(node.id, gate.threshold, gate.checkPass)
        : { eligible: false, mastery_score: 0, evidence_count: 0, has_evidence: false, passed_assessment: false, borrowed_estimate: false };
    const byType = Object.fromEntries(db.prepare(
        'SELECT evidence_type AS type, COUNT(*) AS n FROM mastery_evidence WHERE node_id = ? GROUP BY evidence_type',
    ).all(node.id).map(r => [r.type, r.n]));
    const recent = db.prepare(`
        SELECT evidence_type AS type, score, total, created_at FROM mastery_evidence
        WHERE node_id = ? ORDER BY id DESC LIMIT ${RECENT_EVIDENCE}
    `).all(node.id);
    const claims = claimSummary(node.id);
    const status = node.status || 'not_started';
    const cap = practiceCeiling(gate.threshold);
    const check = lastCheck(node.id, gate.checkPass);

    const lines = [`Topic "${cut(node.title)}" (nodeId ${node.id}) in project "${cut(node.project_name)}" — status ${status}.`];
    lines.push(e.has_evidence
        ? `Estimated mastery ${pct(e.mastery_score)} (the gate asks for ${pct(gate.threshold)}, or a check of 4+ questions at ${pct(gate.checkPass)}).`
        : `No evidence yet: the app has seen no answer on this topic.${hasRow && e.mastery_score > 0
            ? (claims.correct > 0 && !e.borrowed_estimate
                ? ` Agents' right claims alone put the estimate at ${pct(e.mastery_score)}.`
                : ` The estimate stands at ${pct(e.mastery_score)}.`)
            : ''}`);
    lines.push(e.eligible
        ? 'It has passed the mastery gate.'
        : `It has not passed the mastery gate. Only the app's own mastery check, quizzes or a paper exercise prove a topic; mastery_check opens the check for the learner, here where this host can show it or ask it as a form, otherwise in Terramentor.`);
    if (e.borrowed_estimate) lines.push('Part of the estimate is a head start borrowed from another course or a placement probe, so it cannot pass the gate on its own.');
    if (e.practice_lifted) lines.push('The estimate is over the line only because of card reviews and drills, which keep a topic fresh but never prove it.');
    if (recent.length) {
        lines.push('Most recent evidence:');
        for (const r of recent) lines.push(`- ${String(r.created_at).slice(0, 10)} ${EVIDENCE_NAMES[r.type] || r.type}: ${Math.round(r.score)}/${r.total}`);
    }
    if (check) {
        lines.push(`The last mastery check, on ${String(check.at).slice(0, 10)}: ${check.score}/${check.total}, `
            + `${check.passed ? 'passed' : 'not passed'}${check.held
                ? '. A new check on this topic is open, so the questions missed last time are not shown while it is open.'
                : check.missed.length ? '.' : ', nothing missed.'}`);
        if (check.missed.length) lines.push(missedText(check.missed));
    }
    lines.push(claims.total
        ? `Claims from agents: ${claims.total} (${claims.correct} right, ${claims.wrong} wrong), the last on ${claims.lastAt.slice(0, 10)}. `
            + `Right claims may lift the estimate a little, never past ${pct(cap)}, and the mastery gate never counts that lift; `
            + 'a wrong one may lower it.'
        : 'No claims from agents.');

    return {
        text: lines.join('\n'),
        mastery: {
            nodeId: node.id,
            title: node.title,
            projectId: node.project_id,
            status,
            mastery: Number(e.mastery_score) || 0,
            threshold: gate.threshold,
            passed: !!e.eligible,
            passedAssessment: !!e.passed_assessment,
            borrowedEstimate: !!e.borrowed_estimate,
            gateMode: gate.mode,
            evidence: { count: e.evidence_count, byType },
            claims,
            lastCheck: check,
        },
    };
}
