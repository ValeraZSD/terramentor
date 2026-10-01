/**
 * Every AI project creation this page knows about, and the one being looked at.
 *
 * WHY THIS IS NOT THE GRID'S STATE. Held as `useState`s inside ProjectsGrid, a
 * creation is one run owned by one component, with the "New project" dialog
 * doubling as its progress screen: while a project generates there is no form
 * (no empty project, no import, no second generation), and leaving the page
 * aborts the stream. So a run is a record here, keyed by the client, with its
 * stream consumed in this module — any number of runs can be live at once,
 * the form is always a form, and a run survives the page that started it.
 *
 * The server paces the runs (server/creationSlots.js: one at a time on a local
 * model server, three on a hosted API); a run that waits in line says so.
 *
 * A reloaded page reattaches from GET /api/ai/creation-status, which also keeps
 * a settled run for a few minutes WITH its outcome, so "how did it end" is read,
 * never guessed from the project row.
 */
import { create } from 'zustand';
import { api, type AIProjectProgress, type CreationTrack } from '../../api';
import type { AITaskSummary } from '../../types';
import i18n from '../../i18n';
import { useStore } from '../../store';
import {
    type LiveNode, addCategories, addElements, addSubElements, markSubElementDone,
    markAllCreated, markCategoryGenerating, markElementGenerating, markAllRemainingCancelled,
    buildLiveTreeFromDB,
} from './liveTree';
import { type LogEntry, eventToLogEntry } from './creationLog';

export type CreationStatus = 'starting' | 'live' | 'reattached' | 'complete' | 'cancelled' | 'error';

export interface CreationInput {
    name: string;
    description: string;
    color: string;
    icon: string;
    language: string;
    files: File[];
}

export interface CreationRun {
    key: string;
    runId: string | null;
    input: Omit<CreationInput, 'files'>;
    name: string;
    color: string;
    projectId: number | null;
    status: CreationStatus;
    /** The last frame's pipeline phase, and what it said (a key, never prose). */
    phase: string;
    messageKey: string | null;
    params: Record<string, unknown> | null;
    currentCategory: string | null;
    currentElement: string | null;
    currentSubElement: string | null;
    queuePosition: number | null;
    track: CreationTrack | null;
    /** Client clock when `track` arrived — the countdown runs from here. */
    trackAt: number;
    tree: LiveNode[];
    log: LogEntry[];
    model: string;
    summary: string;
    thinking: string;
    totalResources: number;
    error: string | null;
    /** Client clock. */
    startedAt: number;
    finishedAt: number | null;
}

interface RunsState {
    runs: Record<string, CreationRun>;
    order: string[];
    /** The run whose screen is open, or null. */
    viewing: string | null;
    /** A form to reopen with what a failed run was started from ("Back"). */
    draft: CreationInput | null;
}

export const useCreationRuns = create<RunsState>(() => ({ runs: {}, order: [], viewing: null, draft: null }));

const LIVE: ReadonlySet<CreationStatus> = new Set(['starting', 'live', 'reattached']);
export const isRunLive = (run: CreationRun | undefined | null) => !!run && LIVE.has(run.status);

// ---- internal plumbing -----------------------------------------------------

const controllers = new Map<string, AbortController>();
const pendingFiles = new Map<string, File[]>();
const treeSig = new Map<string, string>();
const thinkingVersion = new Map<string, number>();
let pollTimer: number | null = null;

const patch = (key: string, fn: (run: CreationRun) => Partial<CreationRun>) => {
    useCreationRuns.setState(s => {
        const run = s.runs[key];
        if (!run) return s;
        return { runs: { ...s.runs, [key]: { ...run, ...fn(run) } } };
    });
};

const upsertLog = (log: LogEntry[], entry: LogEntry | null): LogEntry[] => {
    if (!entry) return log;
    const i = log.findIndex(e => e.id === entry.id);
    if (i < 0) return [...log, entry];
    const next = log.slice();
    next[i] = entry;
    return next;
};

const settleLog = (log: LogEntry[], status: LogEntry['status']): LogEntry[] =>
    log.some(e => e.status === 'running') ? log.map(e => (e.status === 'running' ? { ...e, status } : e)) : log;

// A reloaded page keeps what the stream wrote to the log: the server's
// snapshot rebuilds the tree, the phase and the thinking, but not the lines.
const LOG_STORE = 'ai-creation-logs';
const LOG_TTL_MS = 24 * 60 * 60 * 1000;
function readSavedLogs(): Record<string, { log: LogEntry[]; savedAt: number }> {
    try { return JSON.parse(localStorage.getItem(LOG_STORE) || '{}') || {}; } catch { return {}; }
}
let saveTimer: number | null = null;
function saveLogsSoon() {
    if (saveTimer) return;
    saveTimer = window.setTimeout(() => {
        saveTimer = null;
        try {
            const saved = readSavedLogs();
            const now = Date.now();
            for (const [id, v] of Object.entries(saved)) if (now - v.savedAt > LOG_TTL_MS) delete saved[id];
            for (const run of Object.values(useCreationRuns.getState().runs)) {
                if (run.runId && run.log.length) saved[run.runId] = { log: run.log.slice(-300), savedAt: now };
            }
            localStorage.setItem(LOG_STORE, JSON.stringify(saved));
        } catch { /* a full or blocked storage costs the log, never the run */ }
    }, 2000);
}
function forgetSavedLog(runId: string | null) {
    if (!runId) return;
    try {
        const saved = readSavedLogs();
        delete saved[runId];
        localStorage.setItem(LOG_STORE, JSON.stringify(saved));
    } catch { /* see above */ }
}

function newRun(key: string, input: Omit<CreationInput, 'files'>, over: Partial<CreationRun> = {}): CreationRun {
    return {
        key, runId: null, input, name: input.name, color: input.color, projectId: null,
        status: 'starting', phase: '', messageKey: null, params: null,
        currentCategory: null, currentElement: null, currentSubElement: null,
        queuePosition: null, track: null, trackAt: Date.now(),
        tree: [], log: [], model: '', summary: '', thinking: '', totalResources: 0,
        error: null, startedAt: Date.now(), finishedAt: null,
        ...over,
    };
}

/** Reference files staged in the form go to the project the moment it exists —
 *  a cancelled or failed run keeps them too. Best-effort, like before. */
async function uploadStaged(key: string, projectId: number) {
    const files = pendingFiles.get(key);
    pendingFiles.delete(key);
    if (!files || files.length === 0) return;
    const { addToast } = useStore.getState();
    try {
        const { documents } = await api.uploadDocumentFiles(files, { projectId });
        const failed = documents.filter(d => !d.ok);
        if (failed.length) {
            addToast('error', i18n.t("{{count}} files couldn't be read", { count: failed.length }), failed.map(f => f.title).join(', '));
        }
    } catch (e: any) {
        addToast('error', i18n.t("Some vault files failed to upload"), e?.message);
    }
}

/** Fold one stream frame into the run: the same code for every run. */
function applyFrame(key: string, f: AIProjectProgress) {
    const now = Date.now();
    patch(key, run => {
        const next: Partial<CreationRun> = { phase: f.phase || run.phase };
        if (run.status === 'starting') next.status = 'live';
        if (f.runId && !run.runId) next.runId = f.runId;
        if (typeof f.messageKey === 'string') { next.messageKey = f.messageKey; next.params = (f.params as Record<string, unknown>) || null; }
        if (typeof f.currentCategory === 'string') next.currentCategory = f.currentCategory;
        if (typeof f.currentElement === 'string') next.currentElement = f.currentElement;
        if (typeof f.currentSubElement === 'string') next.currentSubElement = f.currentSubElement;
        if (f.phase === 'generating_elements' || f.phase === 'elements_generated') { next.currentElement = null; next.currentSubElement = null; }
        if (f.phase === 'generating_sub_elements' && !f.currentElement) { next.currentElement = null; next.currentSubElement = null; }
        next.queuePosition = typeof f.queuePosition === 'number' ? f.queuePosition : null;
        if (f.track) { next.track = f.track; next.trackAt = now; }
        if (f.projectId && !run.projectId) next.projectId = f.projectId;
        if (f.model) next.model = f.model;
        if (f.summary) next.summary = f.summary;
        if (f.thinkingChunk) next.thinking = run.thinking + f.thinkingChunk;

        let tree = run.tree;
        switch (f.phase) {
            case 'categories_generated':
                if (f.categories?.length) tree = addCategories(tree, f.categories);
                break;
            case 'generating_elements':
                if (f.categoryIndex !== undefined) tree = markCategoryGenerating(tree, f.categoryIndex);
                break;
            case 'elements_generated':
                if (f.categoryIndex !== undefined && f.elements?.length) tree = addElements(tree, f.categoryIndex, f.elements);
                break;
            case 'generating_sub_elements':
                if (f.categoryIndex !== undefined && f.elementIndex !== undefined) tree = markElementGenerating(tree, f.categoryIndex, f.elementIndex);
                break;
            case 'sub_elements_generated':
                if (f.categoryIndex !== undefined && f.elementIndex !== undefined && f.subElements?.length) {
                    tree = addSubElements(tree, f.categoryIndex, f.elementIndex, f.subElements);
                }
                break;
            case 'resources_saved': {
                const rc = f.resourceCount || 0;
                next.totalResources = run.totalResources + rc;
                if (f.categoryIndex !== undefined && f.elementIndex !== undefined && f.subElementIndex !== undefined) {
                    tree = markSubElementDone(tree, f.categoryIndex, f.elementIndex, f.subElementIndex, rc);
                }
                break;
            }
            case 'complete':
                tree = markAllCreated(tree);
                break;
            case 'cancelled':
                tree = markAllRemainingCancelled(tree);
                break;
        }
        if (tree !== run.tree) next.tree = tree;

        let log = run.log;
        if (f.phase !== 'thinking') log = upsertLog(log, eventToLogEntry(f));
        if (f.phase === 'complete') log = settleLog(log, 'success');
        if (f.phase === 'cancelled') log = settleLog(log, 'warning');
        if (f.error) { next.error = f.error; log = settleLog(log, 'error'); }
        if (log !== run.log) next.log = log;
        return next;
    });
    if (f.phase !== 'thinking') saveLogsSoon();
}

function settle(key: string, status: 'complete' | 'cancelled' | 'error', error: string | null = null) {
    // Once only: a local cancel and the server's own "cancelled" frame both
    // arrive here, and the toast must not.
    if (!isRunLive(useCreationRuns.getState().runs[key])) return;
    patch(key, run => ({
        status,
        finishedAt: run.finishedAt ?? Date.now(),
        error: error ?? run.error,
        tree: status === 'complete' ? markAllCreated(run.tree) : status === 'cancelled' ? markAllRemainingCancelled(run.tree) : run.tree,
        log: settleLog(run.log, status === 'complete' ? 'success' : status === 'cancelled' ? 'warning' : 'error'),
        queuePosition: null,
    }));
    controllers.delete(key);
    const run = useCreationRuns.getState().runs[key];
    forgetSavedLog(run?.runId ?? null);
    const { loadProjects, addToast } = useStore.getState();
    loadProjects({ silent: true });
    if (!run) return;
    if (status === 'complete') addToast('success', i18n.t("Project \"{{newName}}\" created with AI!", { newName: run.name }));
    else if (status === 'cancelled') addToast('info', i18n.t("AI creation cancelled"), run.projectId ? i18n.t("Partial project saved.") : i18n.t("No project was created."));
    else addToast('error', i18n.t("AI creation failed"), error ?? run.error ?? undefined);
}

// ---- starting and stopping -------------------------------------------------

/** Start a creation. Returns at once with the run's key; the stream runs here. */
export function startCreationRun(input: CreationInput): string {
    const key = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const { files, ...rest } = input;
    if (files.length) pendingFiles.set(key, files);
    useCreationRuns.setState(s => ({
        runs: { ...s.runs, [key]: newRun(key, rest) },
        order: [...s.order, key],
    }));
    void consume(key, input);
    return key;
}

async function consume(key: string, input: CreationInput) {
    const controller = new AbortController();
    controllers.set(key, controller);
    let uploaded = false;
    try {
        for await (const frame of api.createProjectWithAI(
            input.name, input.description, input.color, input.icon || 'brain', controller.signal, input.language,
        )) {
            // The api client's own frame for a broken socket carries no runId
            // (every server frame does): the run is still going on the server,
            // so follow it there rather than fail it.
            if (frame.phase === 'error' && !frame.runId && useCreationRuns.getState().runs[key]?.runId) break;
            applyFrame(key, frame);
            const run = useCreationRuns.getState().runs[key];
            if (!uploaded && run?.projectId) {
                uploaded = true;
                void uploadStaged(key, run.projectId);
                useStore.getState().loadProjects({ silent: true });
            }
            if (frame.phase === 'complete' || frame.done) { settle(key, 'complete'); return; }
            if (frame.phase === 'cancelled') { settle(key, 'cancelled'); return; }
            if (frame.phase === 'error' || frame.error) { settle(key, 'error', frame.error || null); return; }
        }
        // The stream ended without an outcome: the socket dropped, not the run.
        // Follow it on the server's snapshot instead.
        const run = useCreationRuns.getState().runs[key];
        if (run && isRunLive(run)) {
            patch(key, () => ({ status: 'reattached' }));
            startPolling();
        }
    } catch (e: any) {
        const run = useCreationRuns.getState().runs[key];
        if (e?.name === 'AbortError' || e?.message === 'Request cancelled.') {
            // A local abort is a cancel we asked for (cancelCreationRun settles).
            if (run && isRunLive(run)) settle(key, 'cancelled');
            return;
        }
        settle(key, 'error', e?.message || 'Unknown AI creation error');
    } finally {
        controllers.delete(key);
    }
}

/** Stop one run on the server; whatever it wrote is kept. */
export async function cancelCreationRun(key: string) {
    const run = useCreationRuns.getState().runs[key];
    if (!run || !isRunLive(run)) return;
    try {
        await api.cancelProjectWithAI({ runId: run.runId, projectId: run.projectId });
    } catch { /* best effort — the local stop below still happens */ }
    controllers.get(key)?.abort();
    settle(key, 'cancelled');
}

/** Forget a SETTLED run (its screen was closed, or its project opened). */
export function dismissCreationRun(key: string) {
    const run = useCreationRuns.getState().runs[key];
    if (!run || isRunLive(run)) return;
    forgetSavedLog(run.runId);
    treeSig.delete(key);
    thinkingVersion.delete(key);
    useCreationRuns.setState(s => {
        const runs = { ...s.runs };
        delete runs[key];
        return { runs, order: s.order.filter(k => k !== key), viewing: s.viewing === key ? null : s.viewing };
    });
}

export const openCreationRun = (key: string) => useCreationRuns.setState({ viewing: key });

/** Close the run's screen. A live run keeps going; a settled one is done with. */
export function closeCreationView() {
    const key = useCreationRuns.getState().viewing;
    useCreationRuns.setState({ viewing: null });
    if (key) dismissCreationRun(key);
}

/** "Back" from a run that never made a project: the form, with what was typed. */
export function reopenFormFrom(key: string) {
    const run = useCreationRuns.getState().runs[key];
    if (!run) return;
    useCreationRuns.setState({ draft: { ...run.input, files: [] }, viewing: null });
    dismissCreationRun(key);
}
export const takeDraft = (): CreationInput | null => {
    const d = useCreationRuns.getState().draft;
    if (d) useCreationRuns.setState({ draft: null });
    return d;
};

/** The dock chip of a creation: open ITS run, found by project, else by name. */
export function openCreationRunForTask(task: AITaskSummary): boolean {
    const { runs, order } = useCreationRuns.getState();
    const list = order.map(k => runs[k]).filter(Boolean);
    const hit = (task.projectId != null && list.find(r => r.projectId === task.projectId))
        || list.find(r => r.name === task.label && isRunLive(r))
        || list.find(r => r.name === task.label);
    if (!hit) return false;
    openCreationRun(hit.key);
    return true;
}

/** Is a live run writing into this project? (The project row's flag says so too.) */
export function liveRunForProject(projectId: number): CreationRun | null {
    const { runs } = useCreationRuns.getState();
    return Object.values(runs).find(r => r.projectId === projectId && isRunLive(r)) ?? null;
}

// ---- reattaching after a reload --------------------------------------------

type Snapshot = Awaited<ReturnType<typeof api.getCreationStatus>>['generations'][number];

function applySnapshot(key: string, g: Snapshot) {
    const now = Date.now();
    patch(key, run => ({
        runId: g.runId,
        phase: g.phase,
        messageKey: g.messageKey,
        params: g.params,
        currentCategory: g.currentCategory,
        currentElement: g.currentElement,
        currentSubElement: g.currentSubElement,
        queuePosition: g.queuePosition,
        track: g.track ?? run.track,
        trackAt: g.track ? now : run.trackAt,
        projectId: g.projectId ?? run.projectId,
        model: g.model || run.model,
        summary: run.summary || g.summary,
        totalResources: g.resourceTotal || run.totalResources,
        error: g.error ?? run.error,
    }));
    if (thinkingVersion.get(key) !== g.thinkingVersion) {
        thinkingVersion.set(key, g.thinkingVersion);
        patch(key, () => ({ thinking: g.thinking || '' }));
    }
    // Rebuild the tree from the database only when the activity front moved.
    const sig = [g.phase, g.currentCategoryIndex, g.currentElementIndex, g.currentSubElementIndex, g.resourceTotal].join('|');
    if (g.projectId && sig !== treeSig.get(key)) {
        treeSig.set(key, sig);
        api.getNodes(g.projectId).then(nodes => {
            if (treeSig.get(key) !== sig) return; // a newer tick won
            const tree = buildLiveTreeFromDB(nodes as any, g);
            patch(key, () => ({ tree: g.outcome === 'complete' ? markAllCreated(tree) : tree }));
        }).catch(() => { /* the next tick retries */ });
    }
}

async function pollOnce() {
    let generations: Snapshot[];
    try {
        ({ generations } = await api.getCreationStatus());
    } catch { return; }
    const { runs } = useCreationRuns.getState();
    for (const run of Object.values(runs)) {
        if (run.status !== 'reattached') continue;
        const g = generations.find(x => x.runId === run.runId);
        if (!g) {
            // Neither running nor recently settled: the server restarted under it.
            settle(run.key, 'error', i18n.t("The generation stopped when the server restarted."));
            continue;
        }
        applySnapshot(run.key, g);
        if (g.outcome !== 'running') settle(run.key, g.outcome, g.error);
    }
    if (!Object.values(useCreationRuns.getState().runs).some(r => r.status === 'reattached')) stopPolling();
}

function startPolling() {
    if (pollTimer) return;
    pollTimer = window.setInterval(() => {
        if (document.visibilityState === 'hidden') return;
        void pollOnce();
    }, 2000);
}
function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

let reattached = false;
/**
 * Once per page: pick up every run the server is still working on (and any this
 * browser was watching that settled while it reloaded), so each has a chip, a
 * screen and a live ETA again.
 */
export async function reattachCreationRuns() {
    if (reattached) return;
    reattached = true;
    try { localStorage.removeItem('ai-creation-progress'); } catch { /* the single-run store this replaced */ }
    let generations: Snapshot[];
    try {
        ({ generations } = await api.getCreationStatus());
    } catch { return; }
    const saved = readSavedLogs();
    const known = new Set(Object.values(useCreationRuns.getState().runs).map(r => r.runId));
    for (const g of generations) {
        if (!g.runId || known.has(g.runId)) continue;
        const mine = saved[g.runId];
        if (g.outcome !== 'running' && !mine) continue; // settled, and never watched here
        const key = g.runId;
        const input = { name: g.name, description: '', color: '', icon: '', language: '' };
        useCreationRuns.setState(s => ({
            runs: { ...s.runs, [key]: newRun(key, input, {
                runId: g.runId, status: 'reattached', log: mine?.log ?? [],
                startedAt: g.startedAt || Date.now(),
            }) },
            order: [...s.order, key],
        }));
        applySnapshot(key, g);
        if (g.outcome !== 'running') settle(key, g.outcome, g.error);
    }
    if (Object.values(useCreationRuns.getState().runs).some(r => r.status === 'reattached')) startPolling();
}
