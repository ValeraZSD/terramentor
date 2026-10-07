// /api/ai/create-project: AI project creation, its cancel and its status.
import { randomUUID } from 'node:crypto';
import db from '../database.js';
import {
    AI_PROMPTS, aiConcurrency, aiProvenance, checkOllamaHealth, generateResponse, getAISettings,
    streamProjectThinking,
} from '../ai.js';
import { parseJsonWithRepair } from '../agentic.js';
import { avgSettingKey, callAnnouncedBy, createCreationTracker, CREATION_OPS } from '../creationEta.js';
import { createSlotGate } from '../creationSlots.js';
import { readAverageMs, recordAverageMs } from '../durationAverages.js';
import { getLanguage, getUiLanguage, isSupportedLanguage, withLearning } from '../language.js';
import { findLearningLanguage } from '../learningLanguage.js';
import {
    addProvenanceFields, decideProjectIdentity, detectWrittenLanguage, languageFromAcceptHeader, resolveCreationLanguage,
} from '../projectIdentity.js';
import * as tasks from '../tasks.js';
import { scheduleNodeSync } from '../nodeEmbeddings.js';
import { getSetting } from '../settingsStore.js';
import { findResourcesForSubElement } from '../resourceSearch.js';
import { activeGenerations } from '../creationRuns.js';
import { claimStaged, loadStaged } from '../stagedDocuments.js';
import {
    briefBlock, coverTopLevel, creationSources, hasSources, languageCheckBlock, phaseBlock, planBlock, sectionRefs,
    sourceLanguageSample, sourceRanges, sourcesSummary, thinkBlock, topicsBlock, withoutSourceRefs,
} from '../sourceMaterial.js';
import { nextProjectPosition } from './projectRows.js';
import { routeTable } from './routeTable.js';

const app = routeTable('createProject');

// sanitizeResourceType comes from curriculumSchema.js along with the list it
// checks against — both had drifted into three copies (here, agentic.js, and
// the importer's own opinion) that disagreed about `course_link` and `link`.

const normalizeWhitespace = (text = '') =>
    String(text ?? '').replace(/\s+/g, ' ').trim();

const truncateWords = (text = '', count = 20) =>
    normalizeWhitespace(text).split(' ').filter(Boolean).slice(0, count).join(' ');

const stripCodeFences = (text = '') =>
    String(text ?? '').replace(/```json/gi, '```').replace(/```/g, '').trim();

const buildProjectDescription = (summary = '') => {
    const clean = truncateWords(stripCodeFences(summary), 24) || 'AI-generated learning project';
    return clean;
};

// AI validation helpers

function cleanSummary(text) {
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
async function generateStructure(promptPair, validate, { signal, minItems = 1 } = {}) {
    let best = [];
    for (let attempt = 0; attempt < 3; attempt++) {
        if (signal?.aborted) throw new Error('Cancelled');
        const resp = await generateResponse(promptPair.user, promptPair.system, [], {
            signal, temperature: 0.2 + attempt * 0.15, top_p: 0.8, operation: 'structure',
        });
        const data = validate(parseJsonWithRepair(resp));
        if (data.length > best.length) best = data;
        if (data.length >= minItems) return data;
    }
    return best;
}

function setGeneratingFlag(projectId, value) {
    if (!projectId) return;
    db.prepare('UPDATE projects SET ai_generating = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(value ? 1 : 0, projectId);
}

function upsertUnfinishedNotice(projectId, reason) {
    if (!projectId) return;
    const projectExists = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
    if (!projectExists) {
        console.log('[upsertUnfinishedNotice] Project not found, skipping notice insertion');
        return;
    }
    const title = 'AI generation failed';
    const body = `${reason}\n\nThis project was partially generated by AI and may be incomplete.\nYou can continue editing it manually.`;
    const existing = db.prepare(`
        SELECT id FROM nodes
        WHERE project_id = ? AND is_note = 1 AND title = ?
        LIMIT 1
    `).get(projectId, title);
    if (existing) {
        db.prepare(`
            UPDATE nodes
            SET description = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(body, body, existing.id);
        return;
    }
    const maxPos = db.prepare(`
        SELECT COALESCE(MAX(position), -1) + 1 as pos
        FROM nodes
        WHERE project_id = ? AND parent_id IS NULL
    `).get(projectId);
    db.prepare(`
        INSERT INTO nodes (project_id, parent_id, title, description, notes, status, is_note, position)
        VALUES (?, NULL, ?, ?, ?, 'not_started', 1, ?)
    `).run(projectId, title, body, body, maxPos.pos);
}

function markProjectAsUnfinished(projectId, reason) {
    upsertUnfinishedNotice(projectId, reason);
}

// A settled run stays readable for a few minutes, so a reloaded page (or a
// second device) learns HOW it ended — complete, cancelled, failed — instead of
// guessing from the project row. Keyed by the run id.
const recentGenerations = new Map();
const RECENT_GENERATION_TTL_MS = 5 * 60 * 1000;

// Several creations may be started at once; each takes a model slot for its
// whole length (server/creationSlots.js), so on a one-slot local server the
// second waits in line and says so, and on a hosted API up to three run side
// by side.
const creationSlots = createSlotGate(aiConcurrency);

/** What earlier runs on this machine measured per kind of call — the seed of a live ETA. */
function creationSeeds() {
    return Object.fromEntries(CREATION_OPS.map(kind => [kind, readAverageMs(avgSettingKey(kind))]));
}

app.post('/api/ai/create-project', (req, res) => {
    // `name` and `description` are reassigned once the identity step below has
    // judged them, so every later prompt reads the final pair.
    let { name, description, summary, color, icon, content_language, documentIds } = req.body;
    // The learner's files, read when they were dropped into the dialog
    // (stagedDocuments.js) and in hand before the first model call: with them
    // the course is built FROM the files (sourceMaterial.js), and a name is no
    // longer required — the files can name it.
    const stagedRows = loadStaged(Array.isArray(documentIds) ? documentIds.slice(0, 100) : []);
    const src = creationSources(stagedRows);
    if (!name && !hasSources(src)) return res.status(400).json({ error: 'Project name is required' });
    const learnerName = String(name || '');
    // What the run is called until the identity step has named it.
    const runName = learnerName.trim() || src.docs[0]?.suggested || learnerName;
    const learnerDescription = typeof description === 'string' ? description : '';
    description = learnerDescription;

    const projectColor = color || '#3B82F6';
    const projectIcon = icon || 'folder';
    // A NEW project has no material to "follow", so an unset language is
    // resolved here, once, and stored: explicit choice, else the language the
    // learner wrote in, else the language of their files, else the interface
    // language, else English. Resolved from the catalog, not the DB: the project
    // row does not exist yet when the first call runs. (server/projectIdentity.js)
    //
    // A course may also TEACH a language, and no field asks which: one the
    // name or goal says is being learned decides it at once
    // (learningLanguage.js) and is never what the course is explained in; one
    // the files are written in, when that is not the course's language, or one
    // the name merely mentions, is put to the identity call below to confirm,
    // so a Dutch physics book stays a physics course.
    const uiLanguage = getUiLanguage() || languageFromAcceptHeader(req.headers['accept-language']);
    const sourceSample = sourceLanguageSample(src);
    const typed = findLearningLanguage({ name: learnerName, description: learnerDescription });
    const languageChoice = resolveCreationLanguage({
        explicit: isSupportedLanguage(content_language) ? (content_language || '') : '',
        name: learnerName,
        description: learnerDescription,
        sourceSample,
        uiLanguage,
        learning: typed.named,
    });
    const projectLanguage = languageChoice.code;
    const filesLanguage = sourceSample ? detectWrittenLanguage(sourceSample, uiLanguage) : null;
    const learningCandidates = typed.named ? [] : [...new Set([filesLanguage, ...typed.mentioned])]
        .filter(code => code && code !== projectLanguage)
        .map(getLanguage)
        .filter(Boolean)
        .slice(0, 3);
    // Reassigned once the identity call has confirmed a candidate, before any
    // prompt that writes the course reads it.
    let learningLanguage = typed.named && typed.named !== projectLanguage ? typed.named : '';
    let creationLang = withLearning(languageChoice.lang, getLanguage(learningLanguage));

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    req.setTimeout(0);
    res.setTimeout(0);
    if (res.socket) res.socket.setTimeout(0);

    let keepAlive = setInterval(() => {
        if (keepAlive && !res.writableEnded) {
            res.write(': keepalive\n\n');
        }
    }, 15000);

    const clearKeepAlive = () => {
        if (keepAlive) {
            clearInterval(keepAlive);
            keepAlive = null;
        }
    };

    let userCancelled = false;
    let completed = false;
    const abortController = new AbortController();
    // Hoisted to the outer scope so the `res.on('close', ...)` handler below
    // can reference it for logging. The inner async IIFE assigns to it once
    // the project shell is inserted into the DB.
    let projectId = null;

    // Registered in `activeGenerations` immediately (keyed by a temp id, not
    // projectId — the project row doesn't exist yet during the thinking phase)
    // so POST /api/ai/cancel-creation can actually stop a run before the client
    // knows the real projectId. Re-keyed to projectId once it's known. Without
    // this, cancelling during "Analyzing project scope..." only dropped the
    // client's SSE connection while the server kept generating in the background.
    const pendingGenKey = `pending-${randomUUID()}`;
    // Per-leaf resource curation is opt-out (Settings → AI & Models). Read
    // once, at the start, so flipping the setting mid-run can't desync the
    // progress estimate from the work actually being done.
    const curateResources = getSetting('creation_find_resources', 'true') !== 'false';
    // Where the run is and how long it has left (server/creationEta.js). Every
    // non-chunk frame carries its snapshot as `track`.
    const tracker = createCreationTracker({ seeds: creationSeeds(), curate: curateResources });
    const cancelHandle = {
        cancel: () => {
            userCancelled = true;
            abortController.abort();
        },
        // The run's own id, known before the project row exists: the client
        // cancels and reattaches by it, so two runs never answer to one name.
        runId: pendingGenKey,
        tracker,
        projectId: null,
        name: runName,
        startedAt: Date.now(),
        // Live snapshot for GET /api/ai/creation-status: `send` folds every
        // frame into it, so a page reload reattaches from the run's real
        // current state instead of a stale "will update on completion" notice.
        status: {
            phase: 'thinking',
            messageKey: null,
            params: null,
            overallProgress: 0,
            summary: '',
            model: null,
            thinking: '',
            thinkingVersion: 0,
            currentCategory: null,
            currentElement: null,
            currentSubElement: null,
            currentCategoryIndex: null,
            currentElementIndex: null,
            currentSubElementIndex: null,
            error: null,
            queuePosition: null,
            track: null,
        },
    };
    activeGenerations.set(pendingGenKey, cancelHandle);

    // Mirror this creation into the background-task registry so the global
    // task dock shows its progress and can cancel it. Creation long predates
    // the task queue and manages its own pipeline, so it registers as an
    // *external* task (runs alongside queued tasks, not through them).
    const mirrorTask = tasks.registerExternal({
        kind: 'create_project',
        label: runName,
        origin: { surface: 'projects' },
        projectColor,
        cancel: () => {
            userCancelled = true;
            abortController.abort();
        },
    });

    const send = (data) => {
        // Fold the frame into the reattach snapshot. Only fields the frame
        // actually carries land — a chunk frame has no progress, a progress
        // frame no message — so the snapshot never regresses to a default.
        const s = cancelHandle.status;
        if (data.projectId !== undefined && data.projectId !== null) cancelHandle.projectId = data.projectId;
        if (typeof data.phase === 'string') s.phase = data.phase;
        if (typeof data.messageKey === 'string') s.messageKey = data.messageKey;
        s.params = data.params || null;
        if (typeof data.overallProgress === 'number') s.overallProgress = data.overallProgress;
        if (typeof data.summary === 'string') s.summary = data.summary;
        if (typeof data.model === 'string') s.model = data.model;
        if (typeof data.error === 'string') s.error = data.error;
        if (typeof data.currentCategory === 'string') s.currentCategory = data.currentCategory;
        if (typeof data.currentElement === 'string') s.currentElement = data.currentElement;
        if (typeof data.currentSubElement === 'string') s.currentSubElement = data.currentSubElement;
        if (typeof data.categoryIndex === 'number') s.currentCategoryIndex = data.categoryIndex;
        if (typeof data.elementIndex === 'number') s.currentElementIndex = data.elementIndex;
        if (typeof data.subElementIndex === 'number') s.currentSubElementIndex = data.subElementIndex;
        if (typeof data.thinkingChunk === 'string' && data.thinkingChunk) {
            s.thinking += data.thinkingChunk;
            s.thinkingVersion = s.thinking.length;
        }
        s.queuePosition = typeof data.queuePosition === 'number' ? data.queuePosition : null;
        // Where the run is and what is left, on every frame that is not a
        // streamed chunk (those arrive per token and carry nothing new).
        const now = Date.now();
        if (typeof data.phase === 'string') tracker.phase(data.phase, now);
        // A frame that announces a call puts it in flight now, so this very
        // frame's floor already excludes it (creationEta.callAnnouncedBy).
        const announced = callAnnouncedBy(data);
        if (announced) tracker.begin(announced, now);
        const isChunk = typeof data.thinkingChunk === 'string' || typeof data.contentChunk === 'string';
        const track = isChunk ? null : tracker.snapshot(now);
        if (track) s.track = track;
        mirrorTask.update({
            percent: typeof data.overallProgress === 'number' ? data.overallProgress : undefined,
            message: typeof data.message === 'string' ? data.message : undefined,
            phase: typeof data.phase === 'string' ? data.phase : undefined,
            // The run's own estimate, so the dock shows the same "~x left" as
            // the creation view; null withdraws a stale one.
            ...(track ? { etaMs: track.etaMs } : {}),
        });
        if (res.writableEnded) return false;
        const frame = track ? { runId: pendingGenKey, ...data, track } : { runId: pendingGenKey, ...data };
        res.write(`data: ${JSON.stringify(frame)}\n\n`);
        return true;
    };

    // Time one model call of `kind`: the tracker learns it for this run's ETA,
    // and the settings keep a rolling average as the next run's seed.
    const startCall = (kind) => tracker.begin(kind, Date.now());
    const endCall = (kind) => {
        const ms = tracker.end(kind, Date.now());
        if (ms != null) recordAverageMs(avgSettingKey(kind), ms);
    };

    // Listen on `res`, not `req`: `req` 'close' fires as soon as the POST body is
    // consumed by body-parser (≈1ms in), which would clear the keepalive and log a
    // bogus "client disconnected" on every creation. `res` 'close' fires on a real
    // connection close; `writableEnded` guards against our own `res.end()`.
    res.on('close', () => {
        if (completed || res.writableEnded) return;

        // ✅ Client disconnected (e.g. Vite HMR, page reload, or navigation).
        // Do NOT abort the generation. Let it continue in the background.
        // The frontend's completion polling will detect when it finishes.
        // The `send()` and `finish()` helpers already guard on `res.writableEnded`,
        // so SSE writes to a dead socket are silently dropped without crashing.
        clearKeepAlive(); // Stop sending keepalive pings to a dead connection

        console.log(
            `[AI Creation] Client disconnected` +
            (projectId ? ` for project ${projectId}` : ' (no projectId yet)') +
            `. Generation continuing in background.`
        );
    });

    const isCancelled = () => userCancelled && abortController.signal.aborted;

    let releaseSlot = null;

    const finish = (finalData) => {
        completed = true;
        clearKeepAlive();
        releaseSlot?.();
        releaseSlot = null;
        activeGenerations.delete(pendingGenKey);
        if (projectId) activeGenerations.delete(projectId);
        // Keep the settled run readable for a while, with its outcome.
        tracker.abandon();
        cancelHandle.outcome = finalData ? 'complete' : userCancelled ? 'cancelled' : 'error';
        cancelHandle.finishedAt = Date.now();
        cancelHandle.status.queuePosition = null;
        recentGenerations.set(pendingGenKey, cancelHandle);
        setTimeout(() => recentGenerations.delete(pendingGenKey), RECENT_GENERATION_TTL_MS).unref?.();
        // Settle the mirror task (no-ops if the catch below already settled it
        // with a more specific error/cancelled state).
        if (finalData) mirrorTask.finish();
        else if (userCancelled) mirrorTask.cancelled();
        else mirrorTask.fail('AI creation failed');
        if (!res.writableEnded) {
            if (finalData) send({ ...finalData, done: true });
            res.end();
        }
    };

    (async () => {
        // `projectId` is intentionally NOT redeclared here — it is hoisted
        // to the outer scope (next to `userCancelled` and `completed`) so the
        // `res.on('close', ...)` handler can also reference it for logging.
        let projectSummary = '';
        let thinkingText = '';
        let totalCategories = 0;
        // Actual counts, accumulated as each level is really written. Kept
        // strictly apart from the `est*` figures below: those exist only to
        // size the progress bar before anything is generated, and mixing the
        // two made the final `stats` report a guess (and, for resources, an
        // estimate plus the real count on top of it).
        let totalElements = 0;
        let totalSubElements = 0;
        let totalResources = 0;
        let estElements = 0;
        let estSubElements = 0;
        let overallProgress = 0;

        const W_CAT = 10, W_EL = 5, W_SE = 3, W_RES = 1;
        // `curateResources` is read once, above, beside the tracker it sizes.
        const EST_EL_PER_CAT = 4, EST_SE_PER_EL = 4, EST_RES_PER_SE = curateResources ? 2 : 0;

        let totalWorkUnits = 0;
        let completedWorkUnits = 0;

        const aiSettings = getAISettings();

        try {
            // Wait for a model slot (server/creationSlots.js). Free at once in
            // the common case; otherwise the run says where it is in line, and
            // a cancel while it waits rejects here like any other abort.
            releaseSlot = await creationSlots.acquire(abortController.signal, (position) => send({
                phase: 'queued',
                message: `Waiting for another generation to finish (#${position})`,
                queuePosition: position,
            }));
            if (completed) { releaseSlot(); releaseSlot = null; return; }

            // What the course is being built from, said once at the start.
            if (hasSources(src)) {
                send({
                    phase: 'sources',
                    message: `Reading ${src.docs.length} file(s)`,
                    messageKey: 'Reading {{count}} files',
                    params: { count: src.docs.length },
                    sources: sourcesSummary(src),
                });
            }

            send({
                phase: 'thinking',
                message: 'Analyzing project scope...',
                messageKey: 'Analyzing project scope',
            });

            // Judge what the learner typed: a good name or description is kept
            // verbatim and only what is not good is rewritten. One short call that
            // never fails or blocks creation (server/projectIdentity.js); it runs
            // first so the notes, summary and every phase read the final pair.
            const identity = await decideProjectIdentity({
                name: learnerName,
                description: learnerDescription,
                lang: creationLang,
                // With a language to confirm, the files' own words as well as
                // their headings (sourceMaterial.js languageCheckBlock).
                sources: learningCandidates.length ? languageCheckBlock(src) : briefBlock(src),
                learningCandidates,
                signal: abortController.signal,
            });
            // A course from files whose name the model could not write takes
            // the first file's own title.
            name = identity.name || learnerName.trim() || runName;
            description = identity.description;
            if (identity.teachesLanguage) {
                learningLanguage = identity.teachesLanguage;
                creationLang = withLearning(languageChoice.lang, getLanguage(learningLanguage));
            }

            try {
                startCall('thinking');
                // Reuses outer-scope `thinkingText` so the value survives past this try block.
                for await (const part of streamProjectThinking(
                    name, description, abortController.signal, { lang: creationLang, sources: thinkBlock(src) }
                )) {
                    if (part.type === 'thinking') {
                        thinkingText += part.content;
                        send({ phase: 'thinking', thinkingChunk: part.content });
                    } else if (part.type === 'content') {
                        thinkingText += part.content;
                        send({ phase: 'thinking', contentChunk: part.content });
                    }
                }
                endCall('thinking');
                send({ phase: 'thinking_done' });
            } catch (thinkingError) {
                tracker.abandon();
                console.log('[AI] Thinking phase failed:', thinkingError.message);
                if (abortController.signal.aborted) throw thinkingError;
            }

            send({
                phase: 'init',
                message: 'Checking AI model availability...',
                messageKey: 'Checking the AI model...',
            });

            const healthCheck = await checkOllamaHealth();
            if (!healthCheck.available) {
                throw new Error(`AI provider is not available: ${healthCheck.error}`);
            }

            const availableModels = healthCheck.models.map(m => m.name);
            // No built-in default model anymore — an unselected model is a clean
            // "pick one" error for either provider, not a confusing "" lookup.
            if (!aiSettings.model) {
                throw new Error('No model selected — choose or install one in Settings → AI & Models');
            }
            // Strict only for Ollama — OpenAI-compatible servers may accept
            // aliases that /v1/models doesn't list (llama-swap's `aliases:`),
            // so there a mismatch is the provider's problem, not a hard stop.
            if (aiSettings.provider === 'ollama' && !availableModels.includes(aiSettings.model)) {
                throw new Error(
                    `Model "${aiSettings.model}" is not installed. ` +
                    `Available: ${availableModels.length > 0 ? availableModels.join(', ') : 'none'}`
                );
            }

            send({
                phase: 'init',
                message: `Model "${aiSettings.model}" is available.`,
                messageKey: 'Model "{{model}}" is ready.',
                params: { model: aiSettings.model },
                model: aiSettings.model,
            });

            const projectResult = db.prepare(
                'INSERT INTO projects (name, description, color, icon, position, content_language, learning_language, ai_generating, generated_by) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)'
            ).run(
                name.substring(0, 500),
                (description || name).substring(0, 5000),
                projectColor,
                projectIcon,
                nextProjectPosition(),
                projectLanguage,
                learningLanguage,
                addProvenanceFields(null, [identity.nameFromAI && 'name', identity.descriptionFromAI && 'description'])
            );
            projectId = projectResult.lastInsertRowid;
            // The files move into the new project's vault now, so a run that is
            // cancelled or fails from here on keeps them; their document ids are
            // what every topic's source rows point at.
            // Every staged file goes, a scan with no text layer included (PDF
            // recovery may read it later); only the ones with text shaped the run.
            const claimedDocs = stagedRows.length ? claimStaged(stagedRows.map(row => row.id), projectId) : new Map();
            const documentIdOf = (n) => claimedDocs.get(src.docs[n - 1]?.stagedId) ?? null;
            const insertSource = db.prepare(`
                INSERT INTO node_sources (node_id, document_id, page_from, page_to, char_from, char_to)
                VALUES (?, ?, ?, ?, ?, ?)
            `);
            const recordSources = (nodeId, ids) => {
                if (!ids?.length) return;
                for (const r of sourceRanges(src, ids, documentIdOf)) {
                    insertSource.run(nodeId, r.documentId, r.pageFrom, r.pageTo, r.charFrom, r.charTo);
                }
            };
            // The description is the learner's (or the identity step's) and
            // stays unless there is none, in which case the summary below fills
            // it in. Every later write is compare-and-set against what THIS run
            // last wrote, so a description the learner edits while the tree is
            // generating is never overwritten.
            let writtenDescription = (description || name).substring(0, 5000);
            const writeDescriptionIfUntouched = (text) => {
                const r = db.prepare('UPDATE projects SET description = ? WHERE id = ? AND description = ?')
                    .run(text, projectId, writtenDescription);
                if (r.changes > 0) writtenDescription = text;
                return r.changes > 0;
            };
            const stampProvenance = (fields) => {
                try {
                    const row = db.prepare('SELECT generated_by FROM projects WHERE id = ?').get(projectId);
                    const next = addProvenanceFields(row?.generated_by, fields);
                    if (next) db.prepare('UPDATE projects SET generated_by = ? WHERE id = ?').run(next, projectId);
                } catch (e) { console.log('[AI] Project provenance stamp failed:', e.message); }
            };
            mirrorTask.setProject(Number(projectId), name.substring(0, 500), projectColor);

            // Re-key the cancel handle from the temp pending id to the now-known
            // projectId so POST /api/ai/cancel-creation can target it by projectId too.
            // The handle carries the id ITSELF as well — the reattach snapshot
            // (GET /api/ai/creation-status) and the per-node resource counts are
            // both keyed off handle.projectId, which stayed null before: a
            // reloaded page reattached by name only, got no tree rebuild and no
            // counts for the whole rest of the run.
            cancelHandle.projectId = projectId;
            activeGenerations.delete(pendingGenKey);
            activeGenerations.set(projectId, cancelHandle);

            send({
                phase: 'init',
                message: 'Project shell created.',
                messageKey: 'Creating project…',
                projectId,
                // The name the identity step settled on: a course from files
                // may have been started with none.
                projectName: name.substring(0, 500),
            });

            send({
                phase: 'summary',
                message: 'Generating project summary...',
                messageKey: 'Generating project summary…',
            });

            try {
                const { system: sumSys, user: sumUser } = AI_PROMPTS.summarizeProjectDescription(name, description, { lang: creationLang, sources: briefBlock(src) });
                startCall('summary');
                const summaryResult = await generateResponse(sumUser, sumSys, [], { signal: abortController.signal, temperature: 0.2, top_p: 0.8, operation: 'summary' });
                endCall('summary');
                projectSummary = cleanSummary(summaryResult);
                db.prepare('UPDATE projects SET summary = ? WHERE id = ?')
                    .run(projectSummary, projectId);
                const summaryFields = ['summary'];
                if (!description && writeDescriptionIfUntouched(buildProjectDescription(projectSummary))) {
                    summaryFields.push('description');
                }
                stampProvenance(summaryFields);

                send({
                    phase: 'summary',
                    summary: projectSummary,
                });
            } catch (summaryError) {
                tracker.abandon();
                console.log('[AI] Summary failed:', summaryError.message);
                projectSummary = name;
            }

            send({
                phase: 'generating_categories',
                message: `Generating category structure for "${name}"...`,
                messageKey: 'Generating phases…',
            });

            startCall('phases');
            const categories = await generateStructure(
                AI_PROMPTS.generate_categories(name, description || 'No description provided', thinkingText.substring(0, 2000), projectSummary, { lang: creationLang, sources: planBlock(src) }),
                validateCategories,
                { signal: abortController.signal, minItems: 1 }
            );
            totalCategories = categories.length;
            endCall('phases');
            tracker.phasesPlanned(totalCategories);
            // Which parts of the files each phase covers, every top-level part
            // that teaches the subject in some phase: one the model left out
            // goes to the phase beside it, one it called front or back matter
            // goes nowhere.
            if (hasSources(src)) {
                const skip = sectionRefs(categories.skip, src).filter(id => src.byId.get(id).depth === 0);
                const { claims } = coverTopLevel(src, categories.map(c => sectionRefs(c.sections, src)), skip);
                categories.forEach((c, i) => { c.sections = claims[i]; });
                cleanSourceRefs(categories, src);
            }

            estElements = totalCategories * EST_EL_PER_CAT;
            estSubElements = estElements * EST_SE_PER_EL;
            totalWorkUnits =
                totalCategories * W_CAT +
                estElements * W_EL +
                estSubElements * W_SE +
                estSubElements * EST_RES_PER_SE * W_RES;

            completedWorkUnits += totalCategories * W_CAT;
            overallProgress = Math.round((completedWorkUnits / totalWorkUnits) * 100);

            send({
                phase: 'categories_generated',
                categories: categories.map((c, i) => ({
                    index: i,
                    title: c.title,
                    description: c.description,
                })),
                overallProgress,
            });

            // Every node this pipeline writes carries an AI-authored Overview
            // (`description`), so the whole tree is stamped — one identity taken
            // once, since a creation run is a single generation session.
            const creationProvenance = aiProvenance();
            const insertNode = db.prepare(`
                INSERT INTO nodes (project_id, parent_id, title, description, notes, status, is_note, position, generated_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);

            const categoryIds = [];
            const catTransaction = db.transaction(() => {
                categories.forEach((cat, idx) => {
                    const result = insertNode.run(
                        projectId, null, cat.title, cat.description,
                        '', 'not_started', 0, idx, creationProvenance
                    );
                    categoryIds.push(result.lastInsertRowid);
                    if (hasSources(src)) recordSources(result.lastInsertRowid, cat.sections);
                });
            });
            catTransaction();

            await new Promise(resolve => setImmediate(resolve));

            for (let catIdx = 0; catIdx < categories.length; catIdx++) {
                if (isCancelled()) throw new Error('Cancelled');

                const category = categories[catIdx];
                const categoryId = categoryIds[catIdx];
                tracker.phaseStarted(catIdx);

                send({
                    phase: 'generating_elements',
                    message: `Generating elements for ${category.title}...`,
                    messageKey: 'Generating topics for "{{category}}"…',
                    params: { category: category.title },
                    currentCategory: category.title,
                    categoryIndex: catIdx,
                    totalCategories,
                });

                startCall('sections');
                const elements = await generateStructure(
                    AI_PROMPTS.generate_elements(name, projectSummary, category.title, category.description, { lang: creationLang, sources: phaseBlock(src, category.sections) }),
                    validateElements,
                    { signal: abortController.signal, minItems: 1 }
                );
                endCall('sections');
                elements.forEach(e => { e.sections = sectionRefs(e.sections, src); });
                cleanSourceRefs(elements, src);
                tracker.sectionsPlanned(catIdx, elements.length);

                totalElements += elements.length;
                completedWorkUnits += elements.length * W_EL;
                overallProgress = Math.round((completedWorkUnits / totalWorkUnits) * 100);

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
                    overallProgress,
                });

                const elementIds = [];
                const elTransaction = db.transaction(() => {
                    elements.forEach((el, idx) => {
                        const result = insertNode.run(
                            projectId, categoryId, el.title, el.description,
                            '', 'not_started', 0, idx, creationProvenance
                        );
                        elementIds.push(result.lastInsertRowid);
                        if (hasSources(src)) recordSources(result.lastInsertRowid, el.sections);
                    });
                });
                elTransaction();

                await new Promise(resolve => setImmediate(resolve));

                // Phase: Sub-elements
                //
                // One batched call expands the whole phase. Creation used to
                // pay a full round trip (prefill + a possible model warm-up)
                // PER element, which is the single biggest fixed cost in the
                // pipeline; a 5-element phase now costs one request instead of
                // five. Skipped for a 1-element phase (nothing to batch) and
                // for an unusually wide one (the response would risk
                // truncation) — and any element the batch misses still gets its
                // own call below, so quality never depends on the batch landing.
                let batchedSubs = new Map();
                if (elements.length >= 2 && elements.length <= 10) {
                    send({
                        phase: 'generating_sub_elements',
                        message: `Expanding ${elements.length} topics in ${category.title}...`,
                        messageKey: 'Expanding "{{title}}"…',
                        params: { title: category.title },
                        currentCategory: category.title,
                    });
                    try {
                        const batchPrompt = AI_PROMPTS.generate_sub_elements_batch(
                            name, projectSummary, description || '',
                            category.title, category.description, elements,
                            { lang: creationLang, sources: topicsBlock(src, elements) }
                        );
                        startCall('topics_batch');
                        const raw = await generateResponse(batchPrompt.user, batchPrompt.system, [], {
                            signal: abortController.signal, temperature: 0.2, top_p: 0.8, operation: 'structure',
                        });
                        endCall('topics_batch');
                        batchedSubs = validateSubElementBatch(parseJsonWithRepair(raw), elements);
                    } catch (batchErr) {
                        tracker.abandon();
                        if (abortController.signal.aborted) throw batchErr;
                        console.log('[AI] Batched sub-elements failed, falling back per topic:', batchErr.message);
                    }
                    // Close the step the client opened above: without it the
                    // batch is logged as started and never as finished, and the
                    // activity log keeps a spinner running for the rest of the
                    // build.
                    tracker.batchTried(catIdx);
                    for (const [idx, subs] of batchedSubs) tracker.topicsPlanned(catIdx, idx, subs.length);
                    send({
                        phase: 'sub_elements_batched',
                        currentCategory: category.title,
                        batched: batchedSubs.size,
                        message: batchedSubs.size > 0
                            ? `${category.title}: ${batchedSubs.size} topics expanded`
                            : `${category.title}: expanding topics one by one`,
                    });
                }

                for (let elIdx = 0; elIdx < elements.length; elIdx++) {
                    if (isCancelled()) throw new Error('Cancelled');

                    const element = elements[elIdx];
                    const elementId = elementIds[elIdx];

                    let subElements = batchedSubs.get(elIdx) || [];
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

                        const allElementTitles = elements.map(e => e.title).join(', ');
                        startCall('topics');
                        subElements = await generateStructure(
                            AI_PROMPTS.generate_sub_elements(name, projectSummary, description || '', category.title, category.description, allElementTitles, element.title, element.description, { lang: creationLang, sources: topicsBlock(src, [element]) }),
                            validateSubElements,
                            { signal: abortController.signal, minItems: 1 }
                        );
                        endCall('topics');
                    }
                    subElements.forEach(s => { s.sections = sectionRefs(s.sections, src); });
                    cleanSourceRefs(subElements, src);
                    tracker.topicsPlanned(catIdx, elIdx, subElements.length);

                    totalSubElements += subElements.length;
                    completedWorkUnits += subElements.length * W_SE;
                    overallProgress = Math.round((completedWorkUnits / totalWorkUnits) * 100);

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
                        overallProgress,
                    });

                    const seIds = [];
                    const seTransaction = db.transaction(() => {
                        subElements.forEach((se, idx) => {
                            const result = insertNode.run(
                                projectId, elementId, se.title, se.description,
                                '', 'not_started', 0, idx, creationProvenance
                            );
                            seIds.push(result.lastInsertRowid);
                            if (hasSources(src)) recordSources(result.lastInsertRowid, se.sections);
                        });

                        // NOTE: sibling order is captured by `position` and nothing
                        // else. The generator used to also write hard dependency
                        // edges between siblings; those silently locked topics the
                        // learner may already know, which is why both the edges and
                        // the whole dependency layer are gone (2026-09-04).
                    });
                    seTransaction();

                    await new Promise(resolve => setImmediate(resolve));

                    // Phase: Resources
                    //
                    // The most expensive phase by far: a web search plus a
                    // curation call PER leaf, so a 700-leaf curriculum spends
                    // 700 model round trips on links before the learner has
                    // read a word. With `creation_find_resources` off it is
                    // skipped entirely and resources are fetched on demand from
                    // the node itself (POST /api/ai/nodes/:id/find-resources) —
                    // paying the cost only for the topic actually being studied.

                    for (let seIdx = 0; seIdx < subElements.length; seIdx++) {
                        if (isCancelled()) throw new Error('Cancelled');

                        const subElement = subElements[seIdx];
                        const subElementId = seIds[seIdx];

                        if (curateResources) send({
                            phase: 'finding_resources',
                            message: `Finding resources for ${subElement.title}...`,
                            messageKey: 'Finding links for "{{title}}"…',
                            params: { title: subElement.title },
                            currentSubElement: subElement.title,
                            currentElement: element.title,
                            currentCategory: category.title,
                        });

                        let resources = [];
                        try {
                            if (curateResources) {
                                startCall('links');
                                resources = await findResourcesForSubElement(
                                    name, category.title, element.title,
                                    subElement.title, subElement.description,
                                    abortController.signal, projectSummary, creationLang
                                );
                                // Timed even when it found nothing: a search that
                                // comes back empty still cost what it cost.
                                if (!abortController.signal.aborted) endCall('links');
                            }
                        } catch (e) {
                            tracker.abandon();
                            console.log(`[Resources] Failed:`, e.message);
                        }
                        tracker.topicDone(catIdx, elIdx);

                        totalResources += resources.length;

                        if (resources.length > 0) {
                            const insertResource = db.prepare(`
                                INSERT INTO resources (node_id, title, url, type, completed, position, generated_by)
                                VALUES (?, ?, ?, ?, ?, ?, ?)
                            `);
                            const rTransaction = db.transaction(() => {
                                resources.forEach((r, rIdx) => {
                                    insertResource.run(
                                        subElementId, r.title, r.url, r.type, 0, rIdx, creationProvenance
                                    );
                                });
                            });
                            rTransaction();
                        }

                        completedWorkUnits += resources.length * W_RES;
                        overallProgress = Math.round((completedWorkUnits / totalWorkUnits) * 100);

                        // The client keys its live tree off these coordinates —
                        // without them a leaf never leaves "pending", so the
                        // finished project reported "4 / 94 cards" (only the
                        // phases) no matter how much had really been written.
                        send({
                            phase: 'resources_saved',
                            nodeId: subElementId,
                            nodeTitle: subElement.title,
                            categoryIndex: catIdx,
                            elementIndex: elIdx,
                            subElementIndex: seIdx,
                            currentCategory: category.title,
                            currentElement: element.title,
                            currentSubElement: subElement.title,
                            // With resource hunting off no search ran, so this
                            // event exists only to advance the tree — the client
                            // must not log a "resources checked" row per leaf.
                            curated: curateResources,
                            resourceCount: resources.length,
                            totalResources,
                            overallProgress,
                        });

                        await new Promise(resolve => setImmediate(resolve));
                    }
                }
            }

            // Completion

            db.prepare(
                'UPDATE projects SET ai_generating = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
            ).run(projectId);
            // Only a project with NO description of its own takes the summary's.
            if (!description) writeDescriptionIfUntouched(buildProjectDescription(projectSummary));

            // A whole curriculum just landed; map it once the writes settle.
            scheduleNodeSync();

            return finish({
                phase: 'complete',
                projectId,
                message: 'Project created successfully!',
                stats: {
                    categories: totalCategories,
                    elements: totalElements,
                    subElements: totalSubElements,
                    resources: totalResources,
                },
            });

        } catch (error) {
            console.error(`[AI Creation] Error:`, error.message);

            const wasCancelled =
                userCancelled || error.name === 'AbortError';

            if (projectId) {
                try {
                    setGeneratingFlag(projectId, false);
                    markProjectAsUnfinished(
                        projectId,
                        wasCancelled
                            ? 'AI creation was cancelled.'
                            : `AI creation failed: ${error.message}`
                    );
                } catch (cleanupError) {
                    console.error('[Cleanup] Failed:', cleanupError);
                }
            }

            if (!wasCancelled) {
                send({ phase: 'error', error: error.message, projectId });
                mirrorTask.fail(error.message);
            } else {
                // Said on the stream too: a run cancelled from the task dock or
                // another tab must not look, to this page, like a dropped socket.
                send({ phase: 'cancelled', cancelled: true, projectId });
            }

            return finish();
        }
    })();
});

// Cancel an in-flight AI project creation. With a projectId, stops that one
// run; without one, stops every active run (covers the pre-init window where
// the client doesn't yet know the projectId). Cancellation aborts the Ollama
// request and breaks the generation loop; partial content is preserved and
// ai_generating is cleared by the generation's own error/cleanup path.
app.post('/api/ai/cancel-creation', (req, res) => {
    const { projectId, runId } = req.body || {};

    // By the run's own id — the only handle that exists before the project row
    // does, and the only one that tells two runs apart while both are unnamed.
    if (typeof runId === 'string' && runId) {
        const gen = [...activeGenerations.values()].find(h => h.runId === runId);
        if (gen) {
            gen.cancel();
            return res.json({ success: true, runId, projectId: gen.projectId ?? null, message: 'Cancellation requested' });
        }
        return res.json({ success: false, runId, projectId: null, message: 'No active generation found for that run' });
    }

    if (projectId !== undefined && projectId !== null) {
        const gen = activeGenerations.get(Number(projectId));
        if (gen) {
            gen.cancel();
            return res.json({ success: true, projectId: Number(projectId), message: 'Cancellation requested' });
        }
        return res.json({ success: false, projectId: Number(projectId), message: 'No active generation found for that project' });
    }

    if (activeGenerations.size === 0) {
        return res.json({ success: false, projectId: null, message: 'No active generation to cancel' });
    }
    for (const gen of activeGenerations.values()) gen.cancel();
    res.json({ success: true, projectId: null, message: 'All active generations cancelled' });
});

// Live snapshot of every in-flight AI project creation. A page reload
// reattaches from here — the run's real phase, its progress, the model and the
// thinking so far — instead of the static "will update on completion" notice
// the restored modal used to show. The per-node link counts come from the DB
// (one aggregate query per run), so the rebuilt tree paints the same resource
// dots the live stream did.
app.get('/api/ai/creation-status', (req, res) => {
    const resourceCountsStmt = db.prepare(`
        SELECT r.node_id, COUNT(*) AS c
        FROM resources r JOIN nodes n ON n.id = r.node_id
        WHERE n.project_id = ?
        GROUP BY r.node_id
    `);
    const generations = [];
    const now = Date.now();
    for (const handle of [...activeGenerations.values(), ...recentGenerations.values()]) {
        if (!handle.status) continue;
        let resourceCounts = {};
        let resourceTotal = 0;
        if (handle.projectId) {
            try {
                const rows = resourceCountsStmt.all(handle.projectId);
                resourceCounts = Object.fromEntries(rows.map(row => [row.node_id, row.c]));
                resourceTotal = rows.reduce((sum, row) => sum + row.c, 0);
            } catch (err) {
                console.error('[AI Creation] resource counts failed:', err.message);
            }
        }
        generations.push({
            projectId: handle.projectId,
            name: handle.name,
            startedAt: handle.startedAt,
            resourceCounts,
            resourceTotal,
            ...handle.status,
            runId: handle.runId,
            // 'running' until it settles; then how it ended, for a few minutes.
            outcome: handle.outcome || 'running',
            finishedAt: handle.finishedAt || null,
            // Recomputed NOW rather than at the last frame, so a reattached
            // page counts down from the present.
            track: handle.outcome ? handle.status.track : handle.tracker.snapshot(now),
        });
    }
    res.json({ generations });
});

export const routes = app.takeRoutes();
