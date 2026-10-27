// The stages of an AI course creation, each one able to run against a project
// that already exists: plan the phases, write a phase's sections, write a
// section's topics (one batched call per phase, or one call per section), and
// hunt a topic's links. A fresh run (POST /api/ai/create-project) calls them
// in order over an empty project; a continued one (POST
// /api/ai/continue-creation) calls only the ones whose level is missing.
//
// Every stage talks to its run through one context object (`ctx`, built by
// routes/createProject.js): the frame sender, the abort signal, the timing
// tracker, the project, the language and the learner's files, and the counts
// the progress bar and the final `stats` are made of. The frames a stage sends
// are the ones the run screen has always drawn; their indices are the
// positions the nodes are written at, which is also how a reloaded page
// rebuilds the tree (src/components/creation/liveTree.ts).
import db from './database.js';
import { AI_PROMPTS } from './ai.js';
import { parseJsonWithRepair } from './agentic.js';
import { structureCall } from './creationCalls.js';
import { BATCH_MAX, BATCH_MIN } from './creationEta.js';
import { findResourcesForSubElement, planSectionQueries } from './resourceSearch.js';
import { buildSourceMap } from './sourceMap.js';
import {
    coverTopLevel, creationSources, hasSources, phaseBlock, planBlock, sectionRefs, subtree, topicsBlock,
    withoutSourceRefs,
} from './sourceMaterial.js';

let planQueries = planSectionQueries;
let findLinks = findResourcesForSubElement;
/**
 * Gates only: stand in for a section's query plan and a topic's link search
 * (`find(topicTitle, signal)` → links), which reach the web. Null restores both.
 */
export function setLinkSearchForTest(find, plan = null) {
    findLinks = find ? (_n, _c, _e, title, _d, signal) => find(title, signal) : findResourcesForSubElement;
    planQueries = find ? (plan || (async () => null)) : planSectionQueries;
}

/** Work units per node of each level and per link: the progress bar's weights. */
export const WORK = { CAT: 10, EL: 5, SE: 3, RES: 1 };

// ---- reading the model's answers --------------------------------------------------

const normalizeWhitespace = (text = '') =>
    String(text ?? '').replace(/\s+/g, ' ').trim();

const truncateWords = (text = '', count = 20) =>
    normalizeWhitespace(text).split(' ').filter(Boolean).slice(0, count).join(' ');

const stripCodeFences = (text = '') =>
    String(text ?? '').replace(/```json/gi, '```').replace(/```/g, '').trim();

export const buildProjectDescription = (summary = '') => {
    const clean = truncateWords(stripCodeFences(summary), 24) || 'AI-generated learning project';
    return clean;
};

export function cleanSummary(text) {
    if (!text || typeof text !== 'string') return '';
    return text
        .replace(/```json?\s*\n?/gi, '')
        .replace(/```/g, '')
        .replace(/\*\*(.*?)\*\*/g, '$1')
        .replace(/\*(.*?)\*/g, '$1')
        .replace(/__(.*?)__/g, '$1')
        .replace(/_(.*?)_/g, '$1')
        .replace(/`(.*?)`/g, '$1')
        .replace(/\[(.*?)\]\(.*?\)/g, '$1')
        .replace(/^#+\s*/gm, '')
        .trim();
}

function validateCategories(data) {
    if (!data) return [];
    const arr = Array.isArray(data) ? data : (data.categories || []);
    if (!Array.isArray(arr)) return [];
    const out = arr
        .filter(c => c && typeof c === 'object' && c.title)
        .map(c => ({
            title: String(c.title).slice(0, 500),
            description: String(c.description || '').slice(0, 10000),
            // The § numbers of the learner's files this part covers, as the
            // model gave them; cleaned against the files by sectionRefs.
            sections: c.sections ?? null,
        }));
    // The parts the model judged front or back matter (sourceMaterial.js
    // planBlock), riding on the list so generateStructure hands it back.
    out.skip = Array.isArray(data) ? null : (data.skip ?? null);
    return out;
}

function validateElements(data) {
    if (!data) return [];
    const arr = Array.isArray(data) ? data : (data.elements || []);
    if (!Array.isArray(arr)) return [];
    return arr
        .filter(e => e && typeof e === 'object' && e.title)
        .map(e => ({
            title: String(e.title).slice(0, 500),
            description: String(e.description || '').slice(0, 10000),
            sections: e.sections ?? null,
        }));
}

function validateSubElements(data) {
    if (!data) return [];
    const arr = Array.isArray(data) ? data : (data.subElements || []);
    if (!Array.isArray(arr)) return [];
    return arr
        .filter(s => s && typeof s === 'object' && s.title)
        .map(s => ({
            title: String(s.title).slice(0, 500),
            description: String(s.description || '').slice(0, 10000),
            sections: s.sections ?? null,
        }));
}

// The § marks of the source block out of every title and description a model
// wrote (sourceMaterial.js withoutSourceRefs); a title left empty keeps its
// original rather than becoming a blank node. Nothing changes without files.
function cleanSourceRefs(items, src) {
    if (!hasSources(src)) return;
    for (const it of items) {
        it.title = withoutSourceRefs(it.title, src) || it.title;
        it.description = withoutSourceRefs(it.description, src);
    }
}

const normalizeTitle = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * Validate one BATCHED sub-element response — every topic of a phase expanded in
 * a single call — into `Map<elementIndex, subElements[]>`.
 *
 * Matching is by normalized title first; whatever is left over is assigned to
 * still-unmatched elements in order, because a model that lightly rewords a
 * title ("Ohm's Law" → "Ohms law basics") still emitted the groups in the order
 * it was given. Anything that can't be placed is simply dropped — the caller
 * falls back to the per-element prompt for elements that came back empty, so a
 * partial batch is a partial saving, never a hole in the tree.
 */
function validateSubElementBatch(data, elements) {
    const out = new Map();
    if (!data) return out;
    const groups = Array.isArray(data) ? data : (data.topics || data.elements || []);
    if (!Array.isArray(groups)) return out;

    const byTitle = new Map(elements.map((e, i) => [normalizeTitle(e.title), i]));
    const leftovers = [];

    for (const g of groups) {
        if (!g || typeof g !== 'object') continue;
        const subs = validateSubElements({ subElements: g.subElements || g.sub_elements || g.children });
        if (subs.length === 0) continue;
        const idx = byTitle.get(normalizeTitle(g.element || g.title || g.topic));
        if (idx != null && !out.has(idx)) out.set(idx, subs);
        else leftovers.push(subs);
    }

    for (let i = 0; i < elements.length && leftovers.length > 0; i++) {
        if (!out.has(i)) out.set(i, leftovers.shift());
    }
    return out;
}

// Generate → parse → validate one structure phase (categories / elements /
// sub-elements), retrying a couple of times when the model returns unusable
// JSON. Previously each phase was a single shot: a garbled response made the
// matching validate*() return [], silently leaving a category or element with
// no children. A cheap retry (with the temperature nudged up each attempt to
// escape a deterministic bad output) recovers most of those. The common case is
// unchanged — a valid first response returns immediately without extra calls.
// A call that does not answer in time is asked again inside `structureCall`
// (server/creationCalls.js) rather than ending the run.
async function generateStructure(promptPair, validate, { signal, minItems = 1, label } = {}) {
    let best = [];
    for (let attempt = 0; attempt < 3; attempt++) {
        if (signal?.aborted) throw new Error('Cancelled');
        const resp = await structureCall(promptPair, {
            signal, temperature: 0.2 + attempt * 0.15, label,
        });
        const data = validate(parseJsonWithRepair(resp));
        if (data.length > best.length) best = data;
        if (data.length >= minItems) return data;
    }
    return best;
}

// ---- the learner's files, for a run that continues ----------------------------------

/**
 * The files a project was built from, read again for a run that carries it on.
 *
 * A fresh run holds its files as staged rows with the map read when they were
 * dropped (PDF bookmarks included); once claimed they are the project's
 * documents, and the map is not kept. So the map is built again from the
 * stored text (printed contents or headings, never the bookmarks, which only
 * the original file had), and a node's parts are read back from the page or
 * character ranges its `node_sources` rows recorded: every section that
 * starts inside one, without the ones already under a section taken. The §
 * numbers differ from the first run's, which nothing outside this run ever
 * saw. A project with no documents gets no source blocks, the prompts a run
 * without files sends.
 */
export function projectSources(projectId) {
    const docs = db.prepare(`
        SELECT id, title, content, file_type, page_count, original_filename
        FROM documents WHERE project_id = ? AND node_id IS NULL ORDER BY id LIMIT 100
    `).all(projectId);
    const rows = docs.map(d => ({
        id: `doc-${d.id}`,
        title: d.title,
        file_type: d.file_type,
        content: d.content,
        page_count: d.page_count,
        map: buildSourceMap({ text: d.content, kind: d.file_type, meta: { pageCount: d.page_count }, filename: d.original_filename || d.title }),
    }));
    const src = creationSources(rows);
    const docN = new Map(src.docs.map(doc => [Number(doc.stagedId.slice(4)), doc.n]));
    const documentIdOf = (n) => {
        const doc = src.docs[n - 1];
        return doc ? Number(doc.stagedId.slice(4)) : null;
    };
    const rangesOf = db.prepare('SELECT document_id, page_from, page_to, char_from, char_to FROM node_sources WHERE node_id = ?');
    const sectionsOf = (nodeId) => {
        if (!hasSources(src)) return [];
        const hits = new Set();
        for (const r of rangesOf.all(nodeId)) {
            const n = docN.get(r.document_id);
            if (!n) continue;
            for (const id of src.docs[n - 1].sectionIds) {
                const s = src.byId.get(id);
                const inPages = r.page_from != null && s.from != null && s.from >= r.page_from && s.from <= (r.page_to ?? r.page_from);
                const inChars = r.char_from != null && s.start != null && s.start >= r.char_from && s.start < (r.char_to ?? r.char_from + 1);
                if (inPages || inChars) hits.add(id);
            }
        }
        const out = [];
        for (const id of [...hits].sort((a, b) => a - b)) {
            if (!out.some(top => subtree(src, top).includes(id))) out.push(id);
        }
        return out;
    };
    return { src, documentIdOf, sectionsOf };
}

// ---- writing ----------------------------------------------------------------------

const insertNodeStmt = db.prepare(`
    INSERT INTO nodes (project_id, parent_id, title, description, notes, status, is_note, position, generated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertResourceStmt = db.prepare(`
    INSERT INTO resources (node_id, title, url, type, completed, position, generated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
`);

/** Write `items` under `parentId` at positions 0…n-1, each with its file ranges; sets `item.id`. */
function insertLevel(ctx, parentId, items) {
    db.transaction(() => {
        items.forEach((it, idx) => {
            const result = insertNodeStmt.run(
                ctx.projectId, parentId, it.title, it.description,
                '', 'not_started', 0, idx, ctx.provenance
            );
            it.id = result.lastInsertRowid;
            if (hasSources(ctx.src)) ctx.recordSources(it.id, it.sections);
        });
        // NOTE: sibling order is captured by `position` and nothing else.
        // Hard dependency edges between siblings would silently lock topics
        // the learner may already know.
    })();
}

const tick = () => new Promise(resolve => setImmediate(resolve));
const progressOf = (ctx) => Math.round((ctx.work.done / ctx.work.total) * 100);
const checkCancelled = (ctx) => { if (ctx.isCancelled()) throw new Error('Cancelled'); };

/**
 * The phase list, planned in one call. Returns the phases, not yet written:
 * with files, each carries the § numbers it covers, every top-level part that
 * teaches the subject in some phase (one the model left out goes to the phase
 * beside it, one it called front or back matter goes nowhere).
 */
export async function planPhases(ctx, { thinkingText = '' } = {}) {
    const { send, src } = ctx;
    send({
        phase: 'generating_categories',
        message: `Generating category structure for "${ctx.name}"...`,
        messageKey: 'Generating phases…',
    });
    ctx.startCall('phases');
    const categories = await generateStructure(
        AI_PROMPTS.generate_categories(ctx.name, ctx.description || 'No description provided', thinkingText.substring(0, 2000), ctx.projectSummary, { lang: ctx.lang, sources: planBlock(src) }),
        validateCategories,
        { signal: ctx.signal, minItems: 1, label: 'Phases' }
    );
    ctx.endCall('phases');
    if (hasSources(src)) {
        const skip = sectionRefs(categories.skip, src).filter(id => src.byId.get(id).depth === 0);
        const { claims } = coverTopLevel(src, categories.map(c => sectionRefs(c.sections, src)), skip);
        categories.forEach((c, i) => { c.sections = claims[i]; });
        cleanSourceRefs(categories, src);
    }
    return categories;
}

/** Write planned phases at the top of the project; sets each one's `id`. */
export async function writePhases(ctx, categories) {
    insertLevel(ctx, null, categories);
    await tick();
}

/** One phase's sections: one call, written under the phase. Returns them, each with its `id`. */
export async function writeSections(ctx, catIdx, category) {
    const { send, src } = ctx;
    checkCancelled(ctx);
    send({
        phase: 'generating_elements',
        message: `Generating elements for ${category.title}...`,
        messageKey: 'Generating topics for "{{category}}"…',
        params: { category: category.title },
        currentCategory: category.title,
        categoryIndex: catIdx,
        totalCategories: ctx.counts.categories,
    });

    ctx.startCall('sections');
    const elements = await generateStructure(
        AI_PROMPTS.generate_elements(ctx.name, ctx.projectSummary, category.title, category.description, { lang: ctx.lang, sources: phaseBlock(src, category.sections) }),
        validateElements,
        { signal: ctx.signal, minItems: 1, label: 'Sections' }
    );
    ctx.endCall('sections');
    elements.forEach(e => { e.sections = sectionRefs(e.sections, src); });
    cleanSourceRefs(elements, src);
    ctx.tracker.sectionsPlanned(catIdx, elements.length);

    ctx.counts.elements += elements.length;
    ctx.work.done += elements.length * WORK.EL;

    send({
        phase: 'elements_generated',
        categoryIndex: catIdx,
        categoryTitle: category.title,
        currentCategory: category.title,
        elements: elements.map((e, i) => ({
            index: i,
            title: e.title,
            description: e.description,
        })),
        overallProgress: progressOf(ctx),
    });

    insertLevel(ctx, category.id, elements);
    await tick();
    return elements;
}

/**
 * The topics of several sections of one phase in ONE call, as
 * `Map<index in sections, topics[]>`. A call per section would pay a full round
 * trip (prefill + a possible model warm-up) each, the single biggest fixed cost
 * in the pipeline; a 5-section phase costs one request instead of five. Not
 * tried for one section (nothing to batch) or an unusually wide phase (the
 * answer would risk truncation), and any section it misses gets its own call
 * in `writeTopics`, so quality never depends on the batch landing. Null when
 * not tried; an empty map when tried and nothing could be placed.
 */
export async function batchTopics(ctx, catIdx, category, elements) {
    if (elements.length < BATCH_MIN || elements.length > BATCH_MAX) return null;
    let batchedSubs = new Map();
    const { send, src, signal } = ctx;
    send({
        phase: 'generating_sub_elements',
        message: `Expanding ${elements.length} topics in ${category.title}...`,
        messageKey: 'Expanding "{{title}}"…',
        params: { title: category.title },
        currentCategory: category.title,
    });
    try {
        const batchPrompt = AI_PROMPTS.generate_sub_elements_batch(
            ctx.name, ctx.projectSummary, ctx.description || '',
            category.title, category.description, elements,
            { lang: ctx.lang, sources: topicsBlock(src, elements) }
        );
        ctx.startCall('topics_batch');
        // A timeout is asked again before the per-topic fallback: one call
        // per topic is several times the wait, and one slow answer is no
        // reason to pay it.
        const raw = await structureCall(batchPrompt, { signal, label: 'Batched sub-elements' });
        ctx.endCall('topics_batch');
        batchedSubs = validateSubElementBatch(parseJsonWithRepair(raw), elements);
    } catch (batchErr) {
        ctx.tracker.abandon();
        if (signal.aborted) throw batchErr;
        console.log('[AI] Batched sub-elements failed, falling back per topic:', batchErr.message);
    }
    // Close the step the client opened above: without it the batch is logged
    // as started and never as finished, and the activity log keeps a spinner
    // running for the rest of the build.
    ctx.tracker.batchTried(catIdx);
    return batchedSubs;
}

/** The frame that closes a batch, said by the caller once it knows where each group lands. */
export function sendBatchDone(ctx, category, batched) {
    ctx.send({
        phase: 'sub_elements_batched',
        currentCategory: category.title,
        batched,
        message: batched > 0
            ? `${category.title}: ${batched} topics expanded`
            : `${category.title}: expanding topics one by one`,
    });
}

/**
 * One section's topics, written under it: the batch's group when it brought
 * one, else a call of their own. `siblings` are the phase's sections, named
 * in that call. Returns the topics, each with its `id`.
 */
export async function writeTopics(ctx, catIdx, elIdx, category, element, siblings, batched = []) {
    const { send, src } = ctx;
    checkCancelled(ctx);
    let subElements = batched;
    if (subElements.length === 0) {
        send({
            phase: 'generating_sub_elements',
            message: `Generating sub-elements for ${element.title}...`,
            messageKey: 'Generating details for "{{title}}"…',
            params: { title: element.title },
            currentElement: element.title,
            currentCategory: category.title,
            categoryIndex: catIdx,
            elementIndex: elIdx,
        });

        const allElementTitles = siblings.map(e => e.title).join(', ');
        ctx.startCall('topics');
        subElements = await generateStructure(
            AI_PROMPTS.generate_sub_elements(ctx.name, ctx.projectSummary, ctx.description || '', category.title, category.description, allElementTitles, element.title, element.description, { lang: ctx.lang, sources: topicsBlock(src, [element]) }),
            validateSubElements,
            { signal: ctx.signal, minItems: 1, label: 'Sub-elements' }
        );
        ctx.endCall('topics');
    }
    subElements.forEach(s => { s.sections = sectionRefs(s.sections, src); });
    cleanSourceRefs(subElements, src);
    ctx.tracker.topicsPlanned(catIdx, elIdx, subElements.length);

    ctx.counts.subElements += subElements.length;
    ctx.work.done += subElements.length * WORK.SE;

    send({
        phase: 'sub_elements_generated',
        categoryIndex: catIdx,
        elementIndex: elIdx,
        elementTitle: element.title,
        currentCategory: category.title,
        currentElement: element.title,
        subElements: subElements.map((s, i) => ({
            index: i,
            title: s.title,
            description: s.description,
        })),
        overallProgress: progressOf(ctx),
    });

    insertLevel(ctx, element.id, subElements);
    // Each waits for its link pass until `linkTopic` has run it to the end.
    for (const s of subElements) ctx.pendingLinks.add(s.id);
    await tick();
    return subElements;
}

/**
 * One topic's links, and the frame that marks it done in the run's tree.
 *
 * The most expensive stage by far: a web search plus a curation call PER
 * topic, so a 700-topic curriculum spends 700 model round trips on links
 * before the learner has read a word. With `creation_find_resources` off
 * (`ctx.curate`) no search runs and resources are fetched on demand from the
 * node itself (POST /api/ai/nodes/:id/find-resources), paying only for the
 * topic actually studied; the frame is still sent, because it is what moves
 * the tree on.
 *
 * The search queries of a section's topics are planned in one call, made
 * inside the first topic's timed window so the links average (and the time
 * left) includes it. `plan` is that section's: `{ topics, queries }`, where
 * `queries` stays undefined until the first topic plans it and is null when
 * planning failed (each topic then plans its own).
 */
export async function linkTopic(ctx, { catIdx, elIdx, seIdx, category, element }, topic, plan) {
    const { send, signal, curate } = ctx;
    checkCancelled(ctx);
    if (curate) send({
        phase: 'finding_resources',
        message: `Finding resources for ${topic.title}...`,
        messageKey: 'Finding links for "{{title}}"…',
        params: { title: topic.title },
        currentSubElement: topic.title,
        currentElement: element.title,
        currentCategory: category.title,
    });

    let resources = [];
    try {
        if (curate) {
            ctx.startCall('links');
            if (plan.queries === undefined) {
                plan.queries = await planQueries(element.title, plan.topics, signal, ctx.lang, ctx.name);
            }
            resources = await findLinks(
                ctx.name, category.title, element.title,
                topic.title, topic.description,
                signal, ctx.projectSummary, ctx.lang,
                plan.queries?.[seIdx] ?? null
            );
            // Timed even when it found nothing: a search that comes back
            // empty still cost what it cost.
            if (!signal.aborted) ctx.endCall('links');
        }
    } catch (e) {
        ctx.tracker.abandon();
        console.log(`[Resources] Failed:`, e.message);
    }
    ctx.tracker.topicDone(catIdx, elIdx);

    ctx.counts.resources += resources.length;

    if (resources.length > 0) {
        db.transaction(() => {
            resources.forEach((r, rIdx) => {
                insertResourceStmt.run(topic.id, r.title, r.url, r.type, 0, rIdx, ctx.provenance);
            });
        })();
    }

    ctx.work.done += resources.length * WORK.RES;
    // A search cut off by a cancel did not finish: the topic still waits.
    if (!signal.aborted) ctx.pendingLinks.delete(topic.id);

    // The client keys its live tree off these coordinates — without them a
    // leaf never leaves "pending", so the finished project reported "4 / 94
    // cards" (only the phases) no matter how much had really been written.
    send({
        phase: 'resources_saved',
        nodeId: topic.id,
        nodeTitle: topic.title,
        categoryIndex: catIdx,
        elementIndex: elIdx,
        subElementIndex: seIdx,
        currentCategory: category.title,
        currentElement: element.title,
        currentSubElement: topic.title,
        // With resource hunting off no search ran, so this event exists only
        // to advance the tree — the client must not log a "resources
        // checked" row per leaf.
        curated: curate,
        resourceCount: resources.length,
        totalResources: ctx.counts.resources,
        overallProgress: progressOf(ctx),
    });

    await tick();
}
