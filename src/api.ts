import { SearchProvider } from './utils/searchProviders';
import type { RepairProgress } from './components/visuals/repairProgress';
import { Project, Node, Resource, ExportData, ImportResult, ChatMessage, AiAction, Quiz, QuizAttempt, Flashcard, Document, UploadedDocument, AIStatus, LearningInsights, ScheduleConfig, ScheduleResult, PaceData, DashboardData, ProjectFlashcard, ProjectQuiz, SearchResults, SearchSuggestion, GhostResult, DailyPlan, FeedResponse, FeedStats, FeedConsumeResult, GlobalDueFlashcard, GlobalCalendarData, TodayActivity, AITaskSummary, EmbeddingStatus, EmbeddingConfig, PaperRubricPoint, PaperGradeResponse, BulkCandidate, BulkEstimates, BulkJobStatus, BulkKind, ScheduleOverview, AtlasData, PlacementStatus, PlacementProbe, PlacementAnswerResult, PlacementSummary, AnkiPreview, AnkiImportResult, DeckData, OutlineBriefFields, AuthoringPhases, MaterialBrief, MaterialMergeResult, AppVersion, UpdateStatus, ActivityEvent, ActivityStats, ProjectCompletion } from './types';

const BASE = '/api';

// When a protected request comes back 401 (session expired or gate switched on),
// the app registers a handler here so it can flip to the locked/login state
// instead of surfacing a raw error. Login failures do NOT trigger this — only
// responses flagged `authRequired` by the server's requireAuth middleware.
let onAuthRequired: (() => void) | null = null;
export function setAuthRequiredHandler(fn: (() => void) | null) {
    onAuthRequired = fn;
}

// SSE streams go through the same relative `/api` as everything else. In dev
// that is the Vite proxy, which carries event streams (vite.config.ts disables
// the socket timeout on them); in standalone it is the same origin. The old
// dev-only shortcut to `http://<host>:3001` predates two changes it did not
// survive: Express now binds to 127.0.0.1 (so a phone on the LAN could not
// reach it at all in dev) and CORS is an origin allowlist rather than open.
const SSE_BASE = '/api';

async function request<T>(url: string, options?: RequestInit & { timeout?: number }): Promise<T> {
    const timeout = options?.timeout ?? 30000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const userSignal = options?.signal;
    if (userSignal) {
        userSignal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    try {
        const res = await fetch(`${BASE}${url}`, {
            headers: { 'Content-Type': 'application/json' },
            ...options,
            signal: controller.signal,
        });

        if (!res.ok) {
            let errorMessage = `API error: ${res.status}`;
            let errorData: any = {};

            try {
                errorData = await res.json();
                if (errorData.error) {
                    errorMessage = errorData.error;
                }
            } catch {
                // Response body is not JSON — fall back to the HTTP status
            }

            if (res.status === 401 && errorData.authRequired && onAuthRequired) {
                onAuthRequired();
            }

            const err = new Error(errorMessage) as any;
            err.data = errorData;
            err.rawResponse = errorData.rawResponse || errorData.raw_response || errorData.rawOutput || errorData.raw_output || errorData.raw;
            throw err;
        }

        return res.json();
    } finally {
        clearTimeout(timeoutId);
    }
}

export interface AnkiExportStats {
    project: string;
    notes: number;
    skipped: number;
    decks: number;
    mediaFiles: number;
    missingMedia: string[];
}

export interface OllamaModel {
    name: string;
    size: number;
    modified_at: string;
    digest: string;
}

export interface ModelsResponse {
    success: boolean;
    models: OllamaModel[];
    error?: string;
}

/** One machine that can serve the chosen model, as the endpoint reports it.
 *  `available: false` means this endpoint does not publish such a list — every
 *  local engine, and most hosted ones — and the panel hides the control. */
export interface ServingEndpoint {
    slug: string;
    name: string;
    /** Dollars per million tokens, in and out. 0 when the endpoint says nothing. */
    promptPrice: number;
    completionPrice: number;
    quantization: string | null;
    contextLength: number | null;
    /** Percent over the last half hour, or null when not reported. */
    uptime: number | null;
}

export interface EndpointsResponse {
    available: boolean;
    model?: string;
    endpoints: ServingEndpoint[];
}

export interface PullProgress {
    status: string;
    digest?: string;
    total?: number;
    completed?: number;
    done?: boolean;
    error?: string;
}

export interface SrsFitStats {
    cards: number;
    reviews: number;
    predicted: number;
    trainReviews: number;
    valReviews: number;
    trainDefault: number;
    valDefault: number;
    trainFitted: number | null;
    valFitted: number | null;
    steps: number;
    ms: number;
}
export interface SrsFitResult {
    accepted: boolean;
    w: number[];
    stats: SrsFitStats;
    reason: string | null;
}
export interface RetentionBin { lo: number; hi: number; n: number; predicted: number; observed: number }
export interface RetentionReport {
    reviews: number;
    recalled: number;
    /** Share of predicted reviews answered correctly — retention itself. */
    observed: number | null;
    /** Mean predicted recall over the same reviews — what the scheduler promised. */
    expected: number | null;
    bins: RetentionBin[];
}
export interface BktFitStats {
    topics: number; attempts: number; trainAttempts: number; valAttempts: number;
    trainDefault: number; valDefault: number; trainFitted: number | null; valFitted: number | null;
    evaluations: number; ms: number;
}
export interface BktFitResult { accepted: boolean; params: { p_T: number; p_S: number }; stats: BktFitStats; reason: string | null }
export interface MasteryModelStatus {
    attempts: number;
    topics: number;
    minAttempts: number;
    params: { p_T: number; p_S: number } | null;
    defaults: { p_T: number; p_S: number };
    meta: { at: string; stats: BktFitStats; source: string } | null;
}
export interface SrsStatus {
    log: { rows: number; cards: number; app: number; anki: number; first: string | null; last: string | null };
    retention: RetentionReport;
    /** Day-level reviews with a memory state before them — what a fit uses. */
    predicted: number;
    minReviews: number;
    params: number[] | null;
    meta: { at: string; stats: SrsFitStats; source: string } | null;
    defaults: number[];
    running: boolean;
}

export interface AnswerCheckResult {
    /** false when the AI grader was unreachable and the verdict is a bare string comparison. */
    graded?: boolean;
    /** The checker could not tell either way; `graded` is false alongside it. */
    unsure?: boolean;
    correct: boolean;
    explanation: string;
}

export type AIPlanNodeStatus = 'pending' | 'creating' | 'created' | 'cancelled' | 'error';

export interface AIProjectPlanNode {
    key: string;
    title: string;
    description?: string;
    depth: number;
    parentKey: string | null;
    phaseNumber?: number;
    hasResources: boolean;
    resourceCount: number;
    status?: AIPlanNodeStatus;
    children: AIProjectPlanNode[];
}

export interface AIProjectProgressCounts {
    plannedNodes: number;
    createdNodes: number;
    plannedResources: number;
    createdResources: number;
    phaseNodeTotal?: number;
    phaseNodeCreated?: number;
}

export interface LiveTreeNode {
    key: string;
    title: string;
    status: 'pending' | 'generating' | 'created' | 'error';
    children: LiveTreeNode[];
    resourceCount: number;
    resourcesCreated: number;
    depth: number;
}

export interface AIProjectProgress {
    phase: string;
    message: string;
    task?: string;
    model?: string;
    summary?: string;
    projectId?: number;
    overallProgress?: number;
    totalWorkUnits?: number;
    completedWorkUnits?: number;
    phaseNumber?: number;
    phaseTitle?: string;
    nodeKey?: string;
    nodeStatus?: AIPlanNodeStatus;
    plan?: AIProjectPlanNode[];
    counts?: AIProjectProgressCounts;
    currentCategory?: string;
    currentElement?: string;
    currentSubElement?: string;
    warning?: boolean;
    liveTree?: LiveTreeNode[];
    elements?: Array<{ title: string; description: string }>;
    subElements?: Array<{ title: string; description: string }>;
    node?: {
        id: number;
        title: string;
        parentId: number | null;
        depth: number;
        hasResources?: boolean;
        childCount?: number;
    };
    totalNodes?: number;
    totalCategories?: number;
    categoryIndex?: number;
    categoryTitle?: string;
    resourceCount?: number;
    project?: Project;
    stats?: {
        totalNodes: number;
        categories: number;
    };
    done?: boolean;
    cancelled?: boolean;
    error?: string;
    rawOutput?: string;
    tokensPerSecond?: number;
    thinkingChunk?: string;
    thinkingText?: string;

    // Delta event fields
    categories?: Array<{ index: number; title: string; description: string }>;
    elementIndex?: number;
    // Coordinates of the leaf a `resources_saved` event refers to. The live
    // tree is keyed by these, not by title — two phases may name a topic
    // identically.
    subElementIndex?: number;
    // False when resource hunting is off: the event still advances the tree,
    // but no search ran, so it is not an activity worth logging.
    curated?: boolean;
    // How many topics one batched sub-element call managed to expand.
    batched?: number;
    totalResources?: number;
    nodeId?: number;
    nodeTitle?: string;
}

// Dashboard-specific types for API responses

export interface DashboardFlashcardDeck {
    categoryId: number;
    categoryTitle: string;
    totalCards: number;
    dueCount: number;
    weakCount: number;
}

export interface DashboardWeakTopic {
    node_id: number;
    title: string;
    avg_score: number;
    attempt_count: number;
}

export interface DashboardQuizAttempt {
    score: number;
    total: number;
    node_title: string;
    quiz_title: string;
    created_at: string;
}

interface ChatStreamHandlers {
    signal?: AbortSignal;
    onDone?: (meta: { assistantMessageId: number | null; cancelled?: boolean; content?: string | null }) => void;
    onThinking?: (chars: number) => void;
    onThinkingChunk?: (text: string) => void;
    onTask?: (taskId: string) => void;
    /**
     * A short status line about what the turn is doing BEFORE the model starts
     * — today only "Searching the web…". Without it a web-enabled question is
     * several silent seconds longer than a normal one, which reads as a hang.
     */
    onNote?: (note: string) => void;
    /**
     * The lookups this turn is running, as a WHOLE LIST each time rather than a
     * delta - six rows at most, and the caller then never has to merge anything
     * or reason about the order two frames arrived in.
     */
    onActions?: (actions: AiAction[]) => void;
}

/**
 * A quiet SSE socket is a dead one.
 *
 * The server writes a keepalive comment every 15s on every task-backed stream
 * (startSseResponse), so nothing arriving for this long means the socket is
 * gone — and on a phone that happens without any error ever being raised: the
 * OS drops the connection when the app goes to the background and, on return,
 * `reader.read()` simply never resolves. Meanwhile the task finished on the
 * server. Every stream reader below races each read against this deadline;
 * a timer is suspended along with the page, so on foreground it fires at once
 * and the caller reconnects or re-reads the persisted state. The same rule
 * every large chat client applies: the socket is a view of the server's
 * state, never the state itself.
 */
export const SSE_STALE_MS = 50_000;

async function readOrStale<T>(reader: { read(): Promise<T>; cancel(): Promise<void> | void }): Promise<T> {
    let timer: number | undefined;
    const stale = new Promise<never>((_, reject) => {
        timer = window.setTimeout(() => {
            try { reader.cancel(); } catch { /* already closed */ }
            reject(Object.assign(new Error('the connection went quiet — reconnecting.'), { stale: true }));
        }, SSE_STALE_MS);
    });
    try {
        return await Promise.race([reader.read(), stale]);
    } finally {
        window.clearTimeout(timer);
    }
}

/**
 * One tutor turn over SSE, whatever the endpoint.
 *
 * The node tutor and the global assistant speak the identical protocol
 * (`taskId` first, then `chunk` / `thinking` / `thinkingChunk` deltas, then a
 * terminal `done` or `cancelled`), so they share this loop rather than keeping
 * two copies that drift — the previous single copy already carried four
 * separately-earned edge cases (non-2xx before any stream, abort mid-read,
 * partial JSON lines, cancel-persists-the-turn).
 */
async function* streamChatSse(
    url: string,
    payload: unknown,
    { signal, onDone, onThinking, onThinkingChunk, onTask, onNote, onActions }: ChatStreamHandlers,
): AsyncGenerator<string> {
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal,
    });

    // A non-2xx never carries an SSE stream (e.g. 409 while a previous turn
    // is still generating) — surface the server's JSON error instead of
    // silently finding no `data:` lines.
    if (!response.ok) {
        let msg = `Chat request failed (HTTP ${response.status})`;
        try { const d: any = await response.json(); if (d?.error) msg = d.error; } catch { /* non-JSON */ }
        throw new Error(msg);
    }

    const body = response.body;
    if (!body) throw new Error('No response body');

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
        while (true) {
            let chunk: ReadableStreamReadResult<Uint8Array>;
            try {
                chunk = await readOrStale(reader);
            } catch (e) {
                // User stopped the stream — end the generator cleanly so the
                // caller keeps whatever was produced so far.
                if (signal?.aborted || (e instanceof DOMException && e.name === 'AbortError')) return;
                throw e;
            }
            const { done, value } = chunk;
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                try {
                    const json = JSON.parse(line.slice(6));
                    // First frame of a task subscription — lets the caller
                    // remember the task id for Stop (server-side cancel) and
                    // later reattach.
                    if (typeof json.taskId === 'string') onTask?.(json.taskId);
                    if (json.chunk) yield json.chunk;
                    // Running reasoning-character count while the model thinks
                    // (before any content arrives) — drives the live
                    // "Thinking (N chars)…" indicator.
                    if (typeof json.thinking === 'number') onThinking?.(json.thinking);
                    // Raw reasoning text delta — accumulated by the caller into
                    // a collapsible "Reasoning" panel (not just its length).
                    if (typeof json.thinkingChunk === 'string') onThinkingChunk?.(json.thinkingChunk);
                    // Pre-model status ("Searching the web…").
                    if (typeof json.note === 'string') onNote?.(json.note);
                    // What the turn is looking up: announced before each lookup
                    // runs, and again when it lands.
                    if (Array.isArray(json.actions)) onActions?.(json.actions as AiAction[]);
                    if (json.error) throw new Error(json.error);
                    if (json.done || json.cancelled) {
                        // On cancel the server already persisted the partial
                        // turn (with reasoning) — same finalize path as done.
                        // `content` is the STORED answer: the streamed text with
                        // its `[[src:N]]` grounding markers resolved into the
                        // documents they named (server/citations.js). The caller
                        // swaps it in, so what stays on screen is what a reload
                        // would show.
                        onDone?.({
                            assistantMessageId: json.assistantMessageId ?? null,
                            cancelled: !!json.cancelled,
                            content: typeof json.content === 'string' ? json.content : null,
                        });
                        return;
                    }
                } catch (e) {
                    if (e instanceof SyntaxError) continue;
                    throw e;
                }
            }
        }
    } finally {
        try { reader.cancel(); } catch { }
    }
}

export const api = {
    /** Selectable study languages. Served from server/language.js so the catalog
     *  is defined once — the gates key off the same list. */
    getLanguages: () => request<{ code: string; name: string; endonym: string }[]>('/languages'),

    /** Search-provider manifests (server/searchProviders.js). Declarative data — never code. */
    getSearchProviders: () => request<{ providers: SearchProvider[]; kinds: string[]; icons: string[]; surfaces: string[] }>('/search-providers'),
    addSearchProvider: (manifest: unknown) => request<SearchProvider>('/search-providers', { method: 'POST', body: JSON.stringify(manifest) }),
    setSearchProviderEnabled: (id: string, enabled: boolean) => request<SearchProvider>(`/search-providers/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ enabled }) }),
    removeSearchProvider: (id: string) => request<{ success: boolean }>(`/search-providers/${encodeURIComponent(id)}`, { method: 'DELETE' }),

    // Projects
    getProjects: () => request<Project[]>('/projects'),

    /** Just the ids that are mid-generation. The whole project list is 333 kB on
     *  a real library and this answer is 17 bytes, which is the difference
     *  between a poll that is free and one that is not — see `NodeTree`. */
    getGenerationStatus: () => request<{ generating: { id: number; name: string; ai_generating: number }[] }>('/ai/generation-status'),
    getProject: (id: number) => request<Project>(`/projects/${id}`),
    createProject: (projectData: Partial<Project>) => request<Project>('/projects', { method: 'POST', body: JSON.stringify(projectData) }),
    updateProject: (id: number, updates: Partial<Project>) => request<Project>(`/projects/${id}`, { method: 'PUT', body: JSON.stringify(updates) }),
    deleteProject: (id: number) => request<{ success: boolean }>(`/projects/${id}`, { method: 'DELETE' }),
    reorderProjects: (projectIds: number[]) => request<Project[]>('/projects/reorder', { method: 'PUT', body: JSON.stringify({ projectIds }) }),

    // Nodes
    getNodes: (projectId: number) => request<Node[]>(`/projects/${projectId}/nodes`),
    createNode: (nodeData: Partial<Node>) => request<Node>('/nodes', { method: 'POST', body: JSON.stringify(nodeData) }),
    updateNode: (id: number, updates: Partial<Node> & { override?: boolean }) => request<Node>(`/nodes/${id}`, { method: 'PUT', body: JSON.stringify(updates) }),
    // Persist an in-progress tutor draft. `keepalive` lets the write survive a
    // page reload / tab close fired from `pagehide`/`visibilitychange` — the
    // browser completes it even as the document unloads (drafts are tiny, well
    // under the 64KB keepalive cap).
    saveChatDraft: (nodeId: number, draft: string, keepalive = false) =>
        request<Node>(`/nodes/${nodeId}`, { method: 'PUT', body: JSON.stringify({ chat_draft: draft }), keepalive }),
    deleteNode: (id: number) => request<{ success: boolean }>(`/nodes/${id}`, { method: 'DELETE' }),
    moveNode: (id: number, parent_id: number | null, position: number) =>
        request<Node[]>(`/nodes/${id}/move`, { method: 'PUT', body: JSON.stringify({ parent_id, position }) }),
    reorderNodes: (nodeIds: number[], parentId: number | null) =>
        request<{ success: boolean }>('/nodes/reorder', { method: 'PUT', body: JSON.stringify({ nodeIds, parentId }) }),

    // Resources
    getResources: (nodeId: number) => request<Resource[]>(`/nodes/${nodeId}/resources`),
    createResource: (resData: Partial<Resource>) => request<Resource>('/resources', { method: 'POST', body: JSON.stringify(resData) }),
    updateResource: (id: number, updates: Partial<Resource>) => request<Resource>(`/resources/${id}`, { method: 'PUT', body: JSON.stringify(updates) }),
    deleteResource: (id: number) => request<{ success: boolean }>(`/resources/${id}`, { method: 'DELETE' }),
    reorderResources: (resourceIds: number[]) => request<{ success: boolean }>('/resources/reorder', { method: 'PUT', body: JSON.stringify({ resourceIds }) }),

    // Version and updates. `checkUpdates` is the only one that reaches the
    // network, and only because a person pressed a button — see server/version.js.
    getVersion: () => request<AppVersion>('/version'),
    getUpdates: () => request<UpdateStatus>('/updates'),
    checkUpdates: () => request<UpdateStatus>('/updates/check', { method: 'POST' }),
    setAutoUpdateCheck: (enabled: boolean) =>
        request<UpdateStatus>('/updates/auto', { method: 'PUT', body: JSON.stringify({ enabled }) }),

    // Settings
    /** The local activity log (server/activityLog.js). Metadata only — it holds
     *  no topic titles, prompts, notes or model output, which is what makes the
     *  export safe to hand to someone. */
    getActivity: (opts: { limit?: number; level?: string; area?: string; before?: number } = {}) => {
        const q = new URLSearchParams();
        if (opts.limit) q.set('limit', String(opts.limit));
        if (opts.level) q.set('level', opts.level);
        if (opts.area) q.set('area', opts.area);
        if (opts.before) q.set('before', String(opts.before));
        const qs = q.toString();
        return request<{ stats: ActivityStats; events: ActivityEvent[] }>(`/activity${qs ? `?${qs}` : ''}`);
    },
    clearActivity: () => request<{ success: boolean }>('/activity', { method: 'DELETE' }),
    /** Not a fetch: the browser downloads it, so the file never passes through JS. */
    activityExportUrl: () => `${BASE}/activity/export`,

    getSettings: () => request<Record<string, string>>('/settings'),
    setSetting: (key: string, value: string) => request<{ success: boolean }>(`/settings/${key}`, { method: 'PUT', body: JSON.stringify({ value }) }),

    // Auth (single-user gate)
    // VISUAL FEEDBACK — the learner's own record of a drawing that came out
    // wrong. Written to a local JSONL file and never sent anywhere; the point
    // of keeping it is that they can choose to attach it to an issue later.
    reportVisual: (body: {
        kind: string; language?: string; spec: string; feedback: string;
        surface?: string; nodeId?: number | null; messageId?: number | null; theme?: string;
    }) => request<{ id: string }>('/visual-feedback', { method: 'POST', body: JSON.stringify(body) }),
    visualFeedbackSummary: () =>
        request<{ count: number; bytes: number; path: string; lastAt: string | null }>('/visual-feedback'),
    clearVisualFeedback: () =>
        request<{ success: boolean; path: string }>('/visual-feedback', { method: 'DELETE' }),

    // The one request the FIRST PAINT waits on (App.tsx renders nothing until it
    // settles, so as not to flash the app at someone who needs a password), which
    // makes the 30 s default a blank white window for half a minute whenever the
    // server cannot be reached — measured at 31.6 s against an unreachable API on
    // 2026-09-10, and the reported "loads for minutes" on a phone whose service
    // worker serves the shell from cache while the desktop is asleep or Tailscale
    // is renegotiating. A forty-byte answer from a machine on the same tailnet is
    // never four seconds away, and failing this probe is already designed to fail
    // OPEN (see loadAuth), so waiting longer cannot change the outcome — it only
    // delays it. Any real error still surfaces on the requests behind it.
    getAuthStatus: () => request<{ enabled: boolean; authenticated: boolean }>('/auth/status', { timeout: 4000 }),
    login: (password: string) => request<{ ok: boolean }>('/auth/login', { method: 'POST', body: JSON.stringify({ password }) }),
    logout: () => request<{ ok: boolean }>('/auth/logout', { method: 'POST' }),
    setupPassword: (password: string) => request<{ ok: boolean }>('/auth/setup', { method: 'POST', body: JSON.stringify({ password }) }),
    changePassword: (currentPassword: string, newPassword: string) =>
        request<{ ok: boolean }>('/auth/change', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) }),
    disableAuth: (password: string) => request<{ ok: boolean }>('/auth/disable', { method: 'POST', body: JSON.stringify({ password }) }),
    getApiKey: () => request<{ apiKey: string | null }>('/auth/apikey'),
    regenerateApiKey: () => request<{ apiKey: string }>('/auth/apikey/regenerate', { method: 'POST' }),
    // Withdraw the key. Regenerating answers "it leaked"; this answers "nothing
    // uses one any more" — which previously had no answer short of removing the
    // password gate from the whole app.
    deleteApiKey: () => request<{ apiKey: null }>('/auth/apikey', { method: 'DELETE' }),

    // Import/Export
    exportProject: (projectId: number, options: { includeNotes: boolean; includeResources: boolean; includeProgress: boolean }) => {
        const params = new URLSearchParams({
            includeNotes: String(options.includeNotes),
            includeResources: String(options.includeResources),
            includeProgress: String(options.includeProgress),
        });
        return request<ExportData>(`/export/${projectId}?${params}`);
    },
    importProject: (exportData: ExportData) => request<ImportResult>('/import', { method: 'POST', body: JSON.stringify(exportData) }),

    // Authoring with an external chat model. Nothing here calls a model: the
    // server only assembles the prompt text and, later, merges the reply the
    // learner brings back.
    outlineBrief: (fields: OutlineBriefFields) =>
        request<{ prompt: string }>('/authoring/outline-brief', { method: 'POST', body: JSON.stringify(fields) }),
    authoringPhases: (projectId: number) =>
        request<AuthoringPhases>(`/projects/${projectId}/authoring/phases`),
    materialBrief: (projectId: number, phaseId?: number) =>
        request<MaterialBrief>(`/projects/${projectId}/authoring/material-brief${phaseId ? `?phaseId=${phaseId}` : ''}`),
    // A big phase of material is a large body and a slow parse on the server, so
    // this one does not run on the default 30s request timeout.
    mergeMaterial: (projectId: number, payload: unknown, replace = false) =>
        request<MaterialMergeResult>(`/projects/${projectId}/authoring/material`, {
            method: 'POST',
            body: JSON.stringify({ ...(payload as object), replace }),
            timeout: 120000,
        }),

    // Vault-aware bundle (.studyvault zip = manifest + original files).
    // Private notes and progress are opt-in here exactly as they are for the
    // plain JSON export — a bundle is the shape a shared course ships in.
    exportBundle: async (projectId: number, options?: { includeNotes?: boolean; includeProgress?: boolean }): Promise<{ blob: Blob; filename: string }> => {
        const params = new URLSearchParams({
            includeNotes: String(options?.includeNotes ?? false),
            includeProgress: String(options?.includeProgress ?? false),
        });
        const res = await fetch(`${BASE}/export/${projectId}/bundle?${params}`);
        if (!res.ok) {
            let msg = `Export failed: ${res.status}`;
            try { const d = await res.json(); if (d.error) msg = d.error; } catch { /* binary */ }
            throw new Error(msg);
        }
        const cd = res.headers.get('Content-Disposition') || '';
        const m = /filename="?([^"]+)"?/.exec(cd);
        return { blob: await res.blob(), filename: m ? m[1] : `project-${projectId}.studyvault` };
    },

    /**
     * Export a project's flashcards as an Anki .apkg.
     *
     * The exit door: cards, their media and the intervals they have earned leave
     * in the format the rest of the world reads. Mastery, placement and the
     * curriculum's prose do not travel this way — `exportBundle` is for those.
     */
    exportAnki: async (projectId: number): Promise<{ blob: Blob; filename: string; stats: AnkiExportStats | null }> => {
        const res = await fetch(`${BASE}/export/${projectId}/anki`);
        if (!res.ok) {
            let msg = `Export failed: ${res.status}`;
            try { const d = await res.json(); if (d.error) msg = d.error; } catch { /* binary */ }
            throw new Error(msg);
        }
        const cd = res.headers.get('Content-Disposition') || '';
        const m = /filename="?([^";]+)"?/.exec(cd);
        let stats: AnkiExportStats | null = null;
        try { stats = JSON.parse(res.headers.get('X-Export-Stats') || 'null'); } catch { /* header is advisory */ }
        return { blob: await res.blob(), filename: m ? m[1] : `project-${projectId}.apkg`, stats };
    },

    importBundle: async (file: File): Promise<ImportResult> => {
        const form = new FormData();
        form.append('bundle', file);
        const res = await fetch(`${BASE}/import/bundle`, { method: 'POST', body: form });
        if (!res.ok) {
            let msg = `Import failed: ${res.status}`;
            try { const d = await res.json(); if (d.error) msg = d.error; } catch { /* non-JSON */ }
            throw new Error(msg);
        }
        return res.json();
    },

    // SCHEDULING

    scheduleProject: (projectId: number, config: ScheduleConfig) =>
        request<ScheduleResult>(`/projects/${projectId}/schedule`, {
            method: 'POST',
            body: JSON.stringify({
                startDate: config.startDate,
                deadline: config.deadline,
                studyDays: config.studyDays,
            }),
        }),

    recalibrateSchedule: (projectId: number) =>
        request<ScheduleResult>(`/projects/${projectId}/recalibrate`, { method: 'POST' }),

    getProjectPace: (projectId: number) =>
        request<PaceData>(`/projects/${projectId}/pace`),

    removeSchedule: (projectId: number) =>
        request<{ success: boolean }>(`/projects/${projectId}/schedule`, { method: 'DELETE' }),

    updateNodeWeight: (nodeId: number, weight: number) =>
        request<Node>(`/nodes/${nodeId}/weight`, {
            method: 'PUT',
            body: JSON.stringify({ estimated_weight: weight }),
        }),

    // STUDY DASHBOARD

    getStudyDashboard: (projectId: number) =>
        request<DashboardData>(`/projects/${projectId}/study-dashboard`),

    /** Is this project finished, and what did finishing it take? */
    getProjectCompletion: (projectId: number) =>
        request<ProjectCompletion>(`/projects/${projectId}/completion`),

    /** "I have seen the summary." Does NOT change the project's status — moving
     *  it to Completed is a separate decision, made with a separate button. */
    markCompletionSeen: (projectId: number) =>
        request<{ success: boolean }>(`/projects/${projectId}/completion/seen`, { method: 'POST' }),

    getProjectFlashcards: (projectId: number) =>
        request<ProjectFlashcard[]>(`/projects/${projectId}/flashcards`),

    getProjectQuizzes: (projectId: number) =>
        request<ProjectQuiz[]>(`/projects/${projectId}/quizzes`),

    getDueFlashcards: (projectId: number) =>
        request<ProjectFlashcard[]>(`/projects/${projectId}/flashcards/due`),

    // ---- deck projects ------------------------------------------------------
    //
    // `getDeck` backs the deck dashboard; `getDeckQueue` is the session queue
    // and is deliberately NOT `/flashcards/due` — that endpoint counts every
    // never-reviewed card as due, which on a 1,500-card import means the whole
    // deck (see server/decks.js).

    getDeck: (projectId: number, days?: number) =>
        request<DeckData>(`/projects/${projectId}/deck${days ? `?days=${days}` : ''}`),

    getDeckQueue: (projectId: number, opts: { stage?: number; newLimit?: number; ahead?: number } = {}) => {
        const q = new URLSearchParams();
        if (opts.stage != null) q.set('stage', String(opts.stage));
        if (opts.newLimit != null) q.set('newLimit', String(opts.newLimit));
        // `ahead` (days) refills the new-card allowance AND pulls not-yet-due
        // reviews forward — the learner overruling the day's rationing.
        if (opts.ahead != null) q.set('ahead', String(opts.ahead));
        const qs = q.toString();
        return request<{ cards: ProjectFlashcard[]; counts: DeckData; reviews: number; fresh: number }>(
            `/projects/${projectId}/deck/queue${qs ? `?${qs}` : ''}`);
    },

    setDeckNewPerDay: (projectId: number, newPerDay: number) =>
        request<{ newPerDay: number }>(`/projects/${projectId}/deck/settings`, {
            method: 'PUT',
            body: JSON.stringify({ newPerDay }),
        }),

    /** Whether this project's topics may be taught (lessons, checkpoints). Off
     *  by default for an import — see server/nodeRole.js. */
    setProjectTeaching: (projectId: number, teaches: boolean) =>
        request<{ teaches: boolean }>(`/projects/${projectId}/teaching`, {
            method: 'PUT',
            body: JSON.stringify({ teaches }),
        }),

    getInsights: (projectId: number) =>
        request<LearningInsights>('/ai/insights', {
            method: 'POST',
            body: JSON.stringify({ projectId })
        }),

    // Streaming variant of getInsights: reports the model's reasoning character
    // count (`onThinking`) and running output length (`onProgress`) over SSE
    // (mirrors streamGenerateQuiz), so the dashboard can show a live
    // "Thinking… / Generating…" count instead of a static spinner.
    streamGetInsights: async (
        projectId: number,
        onProgress?: (chars: number) => void,
        onThinking?: (chars: number) => void,
        signal?: AbortSignal,
    ): Promise<LearningInsights> => {
        const response = await fetch(`${SSE_BASE}/ai/insights/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectId }),
            signal,
        });

        const body = response.body;
        if (!body) throw new Error('No response body');

        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    const data = line.slice(6);
                    try {
                        const json = JSON.parse(data);
                        if (typeof json.progress === 'number') onProgress?.(json.progress);
                        if (typeof json.thinking === 'number') onThinking?.(json.thinking);
                        if (json.cancelled) {
                            throw Object.assign(new Error('Generation was cancelled.'), { cancelled: true });
                        }
                        if (json.error) {
                            throw Object.assign(new Error(json.error), { rawResponse: json.rawResponse ?? null });
                        }
                        if (json.done) return { stats: json.stats, insights: json.insights };
                    } catch (e) {
                        if (e instanceof SyntaxError) continue;
                        throw e;
                    }
                }
            }
        } finally {
            try { reader.cancel(); } catch { }
        }
        throw new Error('Insights stream ended without a result');
    },

    getCachedInsights: (projectId: number) =>
        request<{ insights: any; generatedAt: string | null }>(`/projects/${projectId}/insights`),

    // AI
    getAIStatus: () => request<AIStatus>('/ai/status'),
    // The provider key is write-only: /api/ai/status says whether one is saved,
    // the key itself is never sent back to any client.
    setAIKey: (apiKey: string) =>
        request<{ success: boolean; hasApiKey: boolean }>('/ai/key', { method: 'PUT', body: JSON.stringify({ apiKey }) }),
    clearAIKey: () =>
        request<{ success: boolean; hasApiKey: boolean }>('/ai/key', { method: 'DELETE' }),

    testSearxng: (url: string) =>
        request<{ ok: boolean; error?: string }>('/searxng/test', {
            method: 'POST',
            body: JSON.stringify({ url }),
        }),
    getModels: () => request<ModelsResponse>('/ai/models'),

    getServingEndpoints: (model?: string) =>
        request<EndpointsResponse>(`/ai/endpoints${model ? `?model=${encodeURIComponent(model)}` : ''}`),

    pullModel: async function* (modelName: string): AsyncGenerator<PullProgress> {
        const response = await fetch(`${SSE_BASE}/ai/models/pull`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: modelName })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to pull model');
        }

        const body = response.body;
        if (!body) throw new Error('No response body');

        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                for (const line of lines) {
                    try {
                        const json = JSON.parse(line) as PullProgress;
                        yield json;
                        if (json.done || json.error) return;
                    } catch (e) {
                        if (e instanceof SyntaxError) continue;
                        throw e;
                    }
                }
            }
        } finally {
            try { reader.cancel(); } catch { }
        }
    },

    deleteModel: (modelName: string) =>
        request<{ success: boolean }>(`/ai/models/${encodeURIComponent(modelName)}`, { method: 'DELETE' }),

    chat: (nodeId: number, message: string, useRag: boolean = true) =>
        request<{ response: string }>('/ai/chat', {
            method: 'POST',
            body: JSON.stringify({ nodeId, message, useRag })
        }),

    // `opts` rather than two more positional parameters: this signature is
    // already at the length where an argument gets passed in the wrong slot.
    streamChat: async function* (nodeId: number, message: string, useRag: boolean = true, signal?: AbortSignal, onDone?: ChatStreamHandlers['onDone'], onThinking?: (chars: number) => void, onThinkingChunk?: (text: string) => void, onTask?: (taskId: string) => void, opts?: { useWeb?: boolean; onNote?: ChatStreamHandlers['onNote']; onActions?: ChatStreamHandlers['onActions'] }) {
        yield* streamChatSse(
            `${SSE_BASE}/ai/chat/stream`,
            { nodeId, message, useRag, useWeb: opts?.useWeb ?? false },
            { signal, onDone, onThinking, onThinkingChunk, onTask, onNote: opts?.onNote, onActions: opts?.onActions },
        );
    },

    /**
     * The GLOBAL assistant's chat turn — same SSE contract as `streamChat`, but
     * one conversation for the whole app (node_id and project_id both NULL).
     * `context` says only WHERE the learner is; the server turns those ids into
     * prose from its own database (see buildPageContext in server/index.js).
     */
    streamGlobalChat: async function* (message: string, context: { view?: string; projectId?: number | null; nodeId?: number | null; feedItemId?: number | null }, signal?: AbortSignal, onDone?: ChatStreamHandlers['onDone'], onThinking?: (chars: number) => void, onThinkingChunk?: (text: string) => void, onTask?: (taskId: string) => void, opts?: { useWeb?: boolean; onNote?: ChatStreamHandlers['onNote']; onActions?: ChatStreamHandlers['onActions'] }) {
        yield* streamChatSse(
            `${SSE_BASE}/ai/today-chat/stream`,
            { message, context, useWeb: opts?.useWeb ?? false },
            { signal, onDone, onThinking, onThinkingChunk, onTask, onNote: opts?.onNote, onActions: opts?.onActions },
        );
    },

    getGlobalChatHistory: () => request<ChatMessage[]>('/ai/today-chat'),
    clearGlobalChatHistory: () => request<{ success: boolean }>('/ai/today-chat', { method: 'DELETE' }),

    getChatHistory: (nodeId: number) => request<ChatMessage[]>(`/ai/chat/${nodeId}`),
    clearChatHistory: (nodeId: number) => request<{ success: boolean }>(`/ai/chat/${nodeId}`, { method: 'DELETE' }),

    // Overwrite a stored message's content — persists an in-session visual
    // repair so a reopened chat renders the fixed spec (see AIPanel.onRepaired).
    updateChatMessage: (id: number, content: string) =>
        request<{ success: boolean }>(`/ai/chat/message/${id}`, { method: 'PUT', body: JSON.stringify({ content }) }),

    // Persist a user turn + partial assistant reply after the user Stops a
    // stream (the stream endpoint only saves on natural completion). Keeps the
    // stopped turn in server-side context so it can be continued.
    persistChatMessages: (nodeId: number, messages: { role: string; content: string }[]) =>
        request<{ success: boolean; messages: { id: number; role: string; content: string }[] }>(
            `/ai/chat/${nodeId}/messages`,
            { method: 'POST', body: JSON.stringify({ messages }) }
        ),

    generateQuiz: (nodeId: number, questionCount: number = 5, questionType: string = 'both', timeout?: number, includeGhosts: boolean = false) =>
        request<{ id: number; questions: Quiz['questions'] }>('/ai/quiz', {
            method: 'POST',
            body: JSON.stringify({ nodeId, questionCount, questionType, includeGhosts }),
            timeout: timeout ?? 120000,  // AI generation can take 2+ minutes
        }),

    // Streaming variant of generateQuiz: same saved result, but reports the
    // model's running output length via `onProgress` (and, for a thinking-capable
    // model, its reasoning character count via `onThinking`) so the caller can
    // show a live "Reasoning… / Generating…" count (as the Tutor chat does).
    // Resolves with the parsed { id, questions }. On failure the thrown Error
    // carries `rawResponse` so the Boss Fight modal can still surface the
    // model's raw text.
    streamGenerateQuiz: async (
        nodeId: number,
        questionCount: number = 5,
        questionType: string = 'both',
        includeGhosts: boolean = false,
        onProgress?: (chars: number) => void,
        signal?: AbortSignal,
        onThinking?: (chars: number) => void,
        // Fires while the model server is loading the model (cold swap), before
        // the first token — lets the UI show a "warming up" state instead of a
        // dead-looking 0-char spinner. `waitedMs` is time elapsed since request.
        // `detail` carries the verification pass's progress ({verified, verifyTotal}) —
        // that pass runs AFTER the last token, so the character counter has stopped
        // and without it the modal would sit on a frozen number for a minute.
        onPhase?: (phase: string, waitedMs: number, detail?: { verified?: number; verifyTotal?: number }) => void,
        opts?: {
            /** Labels the background task "Boss Fight" in the dock. */
            bossFight?: boolean;
            /** Receives the background task id (for cancel / reattach). */
            onTask?: (taskId: string) => void;
        },
    ): Promise<{ id: number; questions: Quiz['questions'] }> => {
        const response = await fetch(`${SSE_BASE}/ai/quiz/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nodeId, questionCount, questionType, includeGhosts, bossFight: !!opts?.bossFight }),
            signal,
        });

        // A non-2xx never carries an SSE stream (the endpoint only reaches 200 once
        // it starts streaming). Reading such a body for `data:` lines would find
        // none and fall through to the opaque "stream ended without a result" with
        // no raw output — so surface the server's JSON error (and its rawResponse).
        if (!response.ok) {
            let message = `Quiz generation failed (HTTP ${response.status})`;
            let raw: string | null = null;
            try {
                const errData: any = await response.json();
                if (errData?.error) message = errData.error;
                raw = errData?.rawResponse ?? errData?.raw_response ?? null;
            } catch { /* body wasn't JSON — keep the status-based message */ }
            throw Object.assign(new Error(message), { rawResponse: raw });
        }

        const body = response.body;
        if (!body) throw new Error('No response body');

        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        // Handle one SSE `data:` line: updates progress, or returns the parsed
        // result / throws on an error event. Returns undefined for progress-only
        // lines so the caller keeps reading. Shared by the streaming loop and the
        // final-buffer flush below (so a terminal `done`/`error` event that lands
        // in the very last read — without a trailing newline — is never dropped,
        // which used to surface as a bogus "stream ended without a result").
        const handleLine = (line: string): { id: number; questions: Quiz['questions'] } | undefined => {
            if (!line.startsWith('data: ')) return undefined;
            const data = line.slice(6);
            let json: any;
            try { json = JSON.parse(data); } catch { return undefined; } // partial/keepalive line
            if (typeof json.taskId === 'string') opts?.onTask?.(json.taskId);
            if (typeof json.progress === 'number') onProgress?.(json.progress);
            if (typeof json.thinking === 'number') onThinking?.(json.thinking);
            if (typeof json.phase === 'string') {
                onPhase?.(json.phase, json.waitedMs ?? 0, { verified: json.verified, verifyTotal: json.verifyTotal });
            }
            if (json.cancelled) {
                // Explicit cancel (task dock ✕) — distinguishable from a failure.
                throw Object.assign(new Error('Generation was cancelled.'), { cancelled: true });
            }
            if (json.error) {
                throw Object.assign(new Error(json.error), { rawResponse: json.rawResponse ?? null });
            }
            if (json.done) return { id: json.id, questions: json.questions };
            return undefined;
        };

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    const result = handleLine(line);
                    if (result) return result;
                }
            }
            // Stream closed: flush a trailing event still sitting in the buffer.
            const result = handleLine(buffer);
            if (result) return result;
        } finally {
            try { reader.cancel(); } catch { }
        }
        // Clean EOF with no terminal `done`/`error` frame: the connection to the AI
        // server was cut before generation finished (e.g. the model server dropped
        // the request mid-stream, or a proxy closed it). Make that legible instead
        // of a bare "ended without a result".
        throw new Error('The connection to the AI server closed before the quiz finished generating. Check that your model server is running and try again.');
    },

    getQuizzes: (nodeId: number) => request<Quiz[]>(`/ai/quizzes/${nodeId}`),

    submitQuizAttempt: (quizId: number, answers: Record<number, string>, score: number, total: number, ghostResults?: GhostResult[]) =>
        request<QuizAttempt>(`/ai/quizzes/${quizId}/attempt`, {
            method: 'POST',
            body: JSON.stringify({ answers, score, total, ghostResults })
        }),

    deleteQuiz: (quizId: number) => request<{ success: boolean }>(`/ai/quizzes/${quizId}`, { method: 'DELETE' }),

    /**
     * Grade an open answer. `format` tells the checker what it is reading —
     * code is judged on behaviour, prose on meaning — and `language` names the
     * code's language for the grader.
     */
    checkAnswer: (question: string, correctAnswer: string, userAnswer: string, opts: { format?: string; language?: string } = {}) =>
        request<AnswerCheckResult>('/ai/check-answer', {
            method: 'POST',
            body: JSON.stringify({ question, correctAnswer, userAnswer, format: opts.format, language: opts.language })
        }),

    /**
     * Teach one question the learner just got wrong, in place. Deliberately not
     * `streamChat`: this must not be written into the node's tutor history, and
     * it is only ever called AFTER an answer is submitted — never during, which
     * would turn the Boss Fight into an open-book exam.
     */
    explainQuestion: (nodeId: number, question: string, correctAnswer: string, userAnswer?: string) =>
        request<{ explanation: string }>('/ai/explain-question', {
            method: 'POST',
            body: JSON.stringify({ nodeId, question, correctAnswer, userAnswer })
        }),

    /** First-run checklist state — every step derived from real data, server-side. */
    getOnboarding: () => request<{ dismissed: boolean; steps: Record<string, boolean> }>('/onboarding'),
    dismissOnboarding: () =>
        request<{ success: boolean }>('/onboarding/dismiss', { method: 'POST', body: JSON.stringify({ dismissed: true }) }),

    /**
     * Save something the learner just read into the Inbox project.
     *
     * Returns as soon as the node exists — enrichment (title, overview,
     * flashcards, questions) runs as the background task identified by
     * `taskId`, so a slow or absent model never blocks "keep this".
     */
    capture: (payload: { text?: string; url?: string; title?: string; hasFiles?: boolean }) =>
        request<{ nodeId: number; projectId: number; taskId: string | null; node: Node }>('/capture', {
            method: 'POST',
            body: JSON.stringify(payload),
        }),

    // Second half of a file/photo capture: `capture()` is called with
    // `hasFiles: true` first (which skips starting enrichment, since there is
    // nothing to read yet), the files are attached via `uploadDocumentFiles`,
    // and only then is enrichment started — otherwise the background task
    // could run before the upload request lands and see an empty node.
    enrichCapture: (nodeId: number, url?: string) =>
        request<{ taskId: string | null }>(`/capture/${nodeId}/enrich`, {
            method: 'POST',
            body: JSON.stringify({ url }),
        }),

    /**
     * Resolve node ids to real titles. The global planner may point at a topic
     * with an `[[open:projectId:nodeId]]` marker; the LABEL always comes from
     * here, never from the model, so a hallucinated id renders no button at all
     * instead of a plausible-looking lie (same contract as tutorActions.ts).
     */
    resolveNodeLabels: (ids: number[]) =>
        request<{ id: number; title: string; projectId: number; projectName: string }[]>('/nodes/labels', {
            method: 'POST',
            body: JSON.stringify({ ids }),
        }),

    /**
     * Curate resources for ONE topic on demand — the counterpart to turning off
     * per-leaf curation during project creation (Settings → AI & Models).
     */
    findNodeResources: (nodeId: number) =>
        request<{ added: number; resources: Resource[] }>(`/ai/nodes/${nodeId}/find-resources`, {
            method: 'POST',
        }),

    // Record a completed practice-drill round as mastery evidence for the node.
    // Tagged `drill` server-side: feeds the BKT retention estimate + decay timer
    // but never the completion gate's raw-assessment clause (practice ≠ proof).
    recordDrillResult: (nodeId: number, score: number, total: number) =>
        request<{ mastery_score: number }>(`/nodes/${nodeId}/mastery/drill`, {
            method: 'POST',
            body: JSON.stringify({ score, total }),
        }),

    // Ask the model to fix a visual spec (```mermaid/vega-lite/plot/smiles/math)
    // that failed to render, given the renderer's parse error. Used by the
    // render-validate-repair loop in VisualBlock. Streams over SSE so the UI can
    // show live repair progress; `onProgress` receives the running character
    // count of the model's output. Resolves with the final corrected spec.
    /** A drafted title + caption for a visual being saved as a file. */
    captionVisual: async (kind: string, spec: string, context?: string): Promise<{ title: string; caption: string }> => {
        const response = await fetch(`${SSE_BASE}/ai/visual/caption`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kind, spec, context }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data?.error || `caption request failed (${response.status})`);
        return { title: String(data?.title || ''), caption: String(data?.caption || '') };
    },

    repairVisual: async (
        kind: string,
        code: string,
        error: string,
        signal?: AbortSignal,
        // One frame of the server's progress stream: which of the (up to two)
        // model calls is running, how much answer and reasoning it has produced
        // so far, and how long this call is expected to run. Scaling all of
        // that against one length is what pinned the bar at 99% for the whole
        // of the drawing pass — see repairProgress.ts.
        onProgress?: (p: RepairProgress) => void,
        // A REVISION rather than a repair: `feedback` is what a person said was
        // wrong with a drawing that rendered perfectly well. The server takes a
        // different prompt for it (reviseVisualPrompt) — a working spec told it
        // "failed with error: the arrow points the wrong way" sends the model
        // hunting for a syntax fault that is not there. `brief` says the block
        // holds a scene brief rather than a finished spec; `feedbackId` ties the
        // model's answer back onto the learner's report.
        // `theme` is the page the reader was looking at: the app remaps colours
        // per theme, so "make it white" means something different on a dark
        // page, and the model cannot see the page.
        revise?: { feedback: string; brief?: boolean; feedbackId?: string | null; theme?: string },
        // The background task the rebuild runs as (first frame). Cancel goes
        // through it: closing this socket only detaches, the task runs on.
        onTask?: (taskId: string) => void,
    ): Promise<{ code: string; redrawn: boolean }> => {
        const response = await fetch(`${SSE_BASE}/ai/repair-visual`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                kind, code, error,
                feedback: revise?.feedback,
                brief: revise?.brief,
                feedbackId: revise?.feedbackId ?? undefined,
                theme: revise?.theme,
            }),
            signal,
        });

        // A non-2xx never carries an SSE stream — reading it as one would find no
        // `data:` lines and silently resolve with an empty fix, masking the real
        // failure reason behind the stale original render error.
        if (!response.ok) {
            let msg = `Visual repair failed (HTTP ${response.status})`;
            try { const d: any = await response.json(); if (d?.error) msg = d.error; } catch { /* non-JSON */ }
            throw new Error(msg);
        }

        const body = response.body;
        if (!body) throw new Error('No response body');

        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let fixed = '';

        try {
            while (true) {
                // Task-backed (keepalives every 15s), so a quiet socket is dead.
                const { done, value } = await readOrStale(reader);
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    const data = line.slice(6);
                    try {
                        const json = JSON.parse(data);
                        if (typeof json.taskId === 'string') onTask?.(json.taskId);
                        // A replayed frame carries the task's running length as
                        // `progress` (tasks.js keeps that, not `chars`); a live
                        // frame carries both. Either moves the bar.
                        if (typeof json.chars === 'number' || typeof json.thinking === 'number' || typeof json.progress === 'number') {
                            onProgress?.({
                                phase: json.phase, chars: json.chars ?? json.progress ?? 0,
                                thinking: json.thinking || 0, est: json.est || 0,
                            });
                        }
                        if (json.cancelled) throw Object.assign(new Error('the rebuild was cancelled.'), { cancelled: true });
                        if (json.error) throw new Error(json.error);
                        if (json.done) { fixed = json.code || ''; return { code: fixed, redrawn: !!json.redrawn }; }
                    } catch (e) {
                        if (e instanceof SyntaxError) continue;
                        throw e;
                    }
                }
            }
        } finally {
            try { reader.cancel(); } catch { }
        }
        return { code: fixed, redrawn: false };
    },

    // Compile a ```widget functional spec into one self-contained sandbox HTML
    // document. Server-side this runs as a queued background task (FIFO behind
    // any in-flight chat generation — on a single-threaded local model the
    // reply always finishes streaming before widget builds start), so the call
    // may sit "queued" for a while; `onEvent` receives lifecycle updates the
    // block UI shows live. A cached build resolves immediately. On a repair
    // pass, `error` (+ optional `previousHtml`) bypasses the cache and asks the
    // builder to fix the broken build. `cacheOnly` never starts a build: a
    // miss resolves with empty html (history blocks use it so re-rendering old
    // chats can't silently enqueue expensive LLM work).
    compileWidget: async (
        spec: string,
        opts: { error?: string; previousHtml?: string; force?: boolean; cacheOnly?: boolean } = {},
        onEvent?: (evt: { status?: string; queuePosition?: number | null; thinking?: number; progress?: number }) => void,
        signal?: AbortSignal,
    ): Promise<{ html: string; cached: boolean }> => {
        const response = await fetch(`${SSE_BASE}/ai/widget/compile`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ spec, ...opts }),
            signal,
        });
        if (!response.ok) {
            let msg = `widget build request failed (${response.status})`;
            try {
                const j = await response.json();
                if (j?.error) msg = j.error;
            } catch { /* non-JSON error body */ }
            throw new Error(msg);
        }
        const body = response.body;
        if (!body) throw new Error('No response body');

        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    const data = line.slice(6);
                    try {
                        const json = JSON.parse(data);
                        if (typeof json.status === 'string') {
                            onEvent?.({ status: json.status, queuePosition: json.queuePosition ?? null });
                        }
                        if (typeof json.thinking === 'number') onEvent?.({ thinking: json.thinking });
                        if (typeof json.progress === 'number') onEvent?.({ progress: json.progress });
                        if (json.cancelled) {
                            throw Object.assign(new Error('the widget build was cancelled.'), { cancelled: true });
                        }
                        if (json.error) throw new Error(json.error);
                        if (json.miss) return { html: '', cached: false };
                        if (json.done) {
                            if (!json.html) throw new Error('the build produced no HTML.');
                            return { html: json.html as string, cached: !!json.cached };
                        }
                    } catch (e) {
                        if (e instanceof SyntaxError) continue;
                        throw e;
                    }
                }
            }
        } finally {
            try { reader.cancel(); } catch { }
        }
        throw new Error('the widget build stream ended without a result.');
    },

    // The specialist authoring pass for ```animation and ```p5 (server/
    // visualAuthor.js). Same protocol as compileWidget above, deliberately —
    // same queue, same cache-first answer, same `cacheOnly` consent gate — so
    // the two hard visual kinds behave exactly like the widget the split was
    // first built for.
    authorVisual: async (
        kind: string,
        brief: string,
        opts: { error?: string; previousSpec?: string; force?: boolean; cacheOnly?: boolean } = {},
        onEvent?: (evt: { status?: string; queuePosition?: number | null; thinking?: number; progress?: number }) => void,
        signal?: AbortSignal,
    ): Promise<{ spec: string; cached: boolean }> => {
        const response = await fetch(`${SSE_BASE}/ai/visual/author`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kind, brief, ...opts }),
            signal,
        });
        if (!response.ok) {
            let msg = `visual authoring request failed (${response.status})`;
            try {
                const j = await response.json();
                if (j?.error) msg = j.error;
            } catch { /* non-JSON error body */ }
            throw new Error(msg);
        }
        const body = response.body;
        if (!body) throw new Error('No response body');

        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        try {
            while (true) {
                // Task-backed, so the server keeps it alive with comments; a
                // silent socket here is the phone having been put down.
                const { done, value } = await readOrStale(reader);
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    try {
                        const json = JSON.parse(line.slice(6));
                        if (typeof json.status === 'string') {
                            onEvent?.({ status: json.status, queuePosition: json.queuePosition ?? null });
                        }
                        if (typeof json.thinking === 'number') onEvent?.({ thinking: json.thinking });
                        if (typeof json.progress === 'number') onEvent?.({ progress: json.progress });
                        if (json.cancelled) {
                            throw Object.assign(new Error('the drawing was cancelled.'), { cancelled: true });
                        }
                        if (json.error) throw new Error(json.error);
                        if (json.miss) return { spec: '', cached: false };
                        if (json.done) {
                            if (!json.spec) throw new Error('the specialist produced nothing.');
                            return { spec: json.spec as string, cached: !!json.cached };
                        }
                    } catch (e) {
                        if (e instanceof SyntaxError) continue;
                        throw e;
                    }
                }
            }
        } finally {
            try { reader.cancel(); } catch { }
        }
        throw new Error('the visual authoring stream ended without a result.');
    },

    // Bulk study material. Not SSE: the job runs on the server's own chain and
    // outlives the dialog, so the client polls and may close/reload freely.
    getBulkCandidates: (projectId: number) =>
        request<{ candidates: BulkCandidate[]; max: number; estimates: BulkEstimates }>(
            `/projects/${projectId}/bulk-candidates`),

    startBulkGeneration: (body: {
        projectId: number;
        nodeIds: number[];
        kinds: BulkKind[];
        questionCount?: number;
        cardCount?: number;
        skipExisting?: boolean;
    }) => request<BulkJobStatus>('/ai/bulk', { method: 'POST', body: JSON.stringify(body) }),

    getBulkStatus: () => request<BulkJobStatus | null>('/ai/bulk'),

    cancelBulkGeneration: () => request<{ cancelled: boolean }>('/ai/bulk', { method: 'DELETE' }),

    generateFlashcards: (nodeId: number, count: number = 10) =>
        request<{ count: number; ids: number[] }>('/ai/flashcards', {
            method: 'POST',
            body: JSON.stringify({ nodeId, count })
        }),

    // Streaming variant of generateFlashcards: reports the model's reasoning
    // character count (`onThinking`) and running output length (`onProgress`)
    // over SSE (mirrors streamGenerateQuiz), so the UI can show a live
    // "Thinking… / Generating…" count instead of a static spinner.
    streamGenerateFlashcards: async (
        nodeId: number,
        count: number = 10,
        onProgress?: (chars: number) => void,
        onThinking?: (chars: number) => void,
        signal?: AbortSignal,
    ): Promise<{ count: number; ids: number[] }> => {
        const response = await fetch(`${SSE_BASE}/ai/flashcards/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nodeId, count }),
            signal,
        });

        const body = response.body;
        if (!body) throw new Error('No response body');

        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    const data = line.slice(6);
                    try {
                        const json = JSON.parse(data);
                        if (typeof json.progress === 'number') onProgress?.(json.progress);
                        if (typeof json.thinking === 'number') onThinking?.(json.thinking);
                        if (json.cancelled) {
                            throw Object.assign(new Error('Generation was cancelled.'), { cancelled: true });
                        }
                        if (json.error) {
                            throw Object.assign(new Error(json.error), { rawResponse: json.rawResponse ?? null });
                        }
                        if (json.done) return { count: json.count, ids: json.ids };
                    } catch (e) {
                        if (e instanceof SyntaxError) continue;
                        throw e;
                    }
                }
            }
        } finally {
            try { reader.cancel(); } catch { }
        }
        throw new Error('Flashcard stream ended without a result');
    },

    getFlashcards: (nodeId: number) => request<Flashcard[]>(`/ai/flashcards/${nodeId}`),

    // `rating` and `undo_review` are not card columns: they tell the endpoint
    // to append to, or take back from, the review log (see src/utils/srs.ts).
    updateFlashcard: (id: number, data: Partial<Flashcard> & { rating?: number; undo_review?: boolean }) =>
        request<Flashcard>(`/ai/flashcards/${id}`, {
            method: 'PUT',
            body: JSON.stringify(data)
        }),

    // Spaced-repetition tuning: the review log and the FSRS parameter fit.
    getSrsStatus: () => request<SrsStatus>('/srs/status'),
    // A fit is seconds of arithmetic in a worker thread; well past the
    // default request timeout on a big log.
    optimizeSrs: () => request<SrsFitResult>('/srs/optimize', { method: 'POST', timeout: 10 * 60 * 1000 }),
    resetSrsParams: () => request<{ ok: boolean }>('/srs/params', { method: 'DELETE' }),

    // Mastery-model tuning: the learner's own BKT rates.
    getMasteryModel: () => request<MasteryModelStatus>('/mastery/model'),
    optimizeMastery: () => request<BktFitResult>('/mastery/optimize', { method: 'POST', timeout: 120_000 }),
    resetMasteryParams: () => request<{ ok: boolean }>('/mastery/params', { method: 'DELETE' }),

    deleteFlashcard: (id: number) => request<{ success: boolean }>(`/ai/flashcards/${id}`, { method: 'DELETE' }),

    // Documents
    uploadDocument: (data: { nodeId?: number; projectId?: number; title: string; content: string; fileType?: string }) =>
        request<{ id: number; chunks: number }>('/documents', {
            method: 'POST',
            body: JSON.stringify(data)
        }),

    getDocuments: (nodeId?: number, projectId?: number) => {
        const params = new URLSearchParams();
        if (nodeId) params.set('nodeId', String(nodeId));
        if (projectId) params.set('projectId', String(projectId));
        return request<Document[]>(`/documents?${params}`);
    },

    // Upload original files (pdf/docx/xlsx/txt/md). The browser sets the
    // multipart Content-Type/boundary, so this bypasses the JSON `request` helper.
    uploadDocumentFiles: async (
        files: File[],
        opts: { projectId?: number; nodeId?: number }
    ): Promise<{ documents: UploadedDocument[] }> => {
        const form = new FormData();
        files.forEach(f => form.append('files', f));
        if (opts.projectId) form.append('projectId', String(opts.projectId));
        if (opts.nodeId) form.append('nodeId', String(opts.nodeId));
        const res = await fetch(`${BASE}/documents/upload`, { method: 'POST', body: form });
        if (!res.ok) {
            let msg = `Upload failed: ${res.status}`;
            try { const d = await res.json(); if (d.error) msg = d.error; } catch { /* non-JSON */ }
            throw new Error(msg);
        }
        return res.json();
    },

    // Full extracted text of one document, for the "view extracted text" preview.
    getDocumentText: (id: number) =>
        request<{ title: string; status?: string; error?: string | null; char_count: number; content: string }>(
            `/documents/${id}/text`
        ),

    // URL to view/download a stored original (open in a new tab).
    documentOriginalUrl: (id: number) => `${BASE}/documents/${id}/original`,

    deleteDocument: (id: number) => request<{ success: boolean }>(`/documents/${id}`, { method: 'DELETE' }),

    // Re-run PDF math recovery (e.g. after connecting a vision model). Forces a
    // fresh re-read of the original even if the doc already recovered via OCR.
    recoverDocument: (id: number) =>
        request<{ ok: boolean; recovery_status: string }>(`/documents/${id}/recover`, { method: 'POST' }),

    searchDocuments: (query: string, nodeId?: number, projectId?: number, limit: number = 5) =>
        request<{ content: string; doc_title: string; chunk_index: number }[]>('/documents/search', {
            method: 'POST',
            body: JSON.stringify({ query, nodeId, projectId, limit })
        }),

    // Semantic search (Vault embeddings) — config, index stats, and a live probe
    // of whether an embedding model is reachable.
    getEmbeddingStatus: (opts: { probe?: boolean; force?: boolean } = {}) => {
        const p = new URLSearchParams();
        if (opts.probe === false) p.set('probe', 'false');
        if (opts.force) p.set('force', 'true');
        return request<EmbeddingStatus>(`/embeddings/status?${p}`);
    },
    setEmbeddingSettings: (body: { enabled?: boolean; model?: string; provider?: import('./types').EmbeddingProvider }) =>
        request<{ config: EmbeddingConfig }>('/embeddings/settings', {
            method: 'POST',
            body: JSON.stringify(body),
        }),
    reindexEmbeddings: () =>
        request<{ queued: number }>('/embeddings/reindex', { method: 'POST' }),

    // Learning Sessions
    logSession: (projectId: number, activityType: string, nodeId?: number, durationSeconds?: number, metadata?: any) =>
        request<{ id: number }>('/sessions', {
            method: 'POST',
            body: JSON.stringify({ projectId, nodeId, activityType, durationSeconds, metadata })
        }),

    // AI Project Creation (SSE)
    createProjectWithAI: async function* (
        name: string,
        description: string,
        color: string,
        icon: string,
        signal?: AbortSignal,
        contentLanguage = ''
    ): AsyncGenerator<AIProjectProgress> {
        let response: Response;
        let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

        try {
            try {
                response = await fetch(`${SSE_BASE}/ai/create-project`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    signal,
                    body: JSON.stringify({ name, description, color, icon, content_language: contentLanguage })
                });
            } catch (fetchError: any) {
                const errorMessage = fetchError.message || 'Unknown fetch error';
                if (fetchError.name === 'TypeError' && fetchError.message.includes('fetch')) {
                    throw new Error('Cannot reach the API server. Is the backend running?');
                } else if (fetchError.name === 'AbortError') {
                    throw new Error('Request cancelled.');
                }
                throw new Error(errorMessage);
            }

            if (!response.ok) {
                let errorMessage = `API error: ${response.status} ${response.statusText}`;
                try {
                    const errorData = await response.json();
                    if (errorData.error) {
                        errorMessage = errorData.error;
                    }
                    if (response.status === 500) errorMessage = `Server error: ${errorMessage}`;
                    else if (response.status === 400) errorMessage = `Request error: ${errorMessage}`;
                    else if (response.status === 503) errorMessage = `Service unavailable. Is Ollama running?`;
                } catch {
                    errorMessage = `Server returned ${response.status}: ${response.statusText}`;
                }
                throw new Error(errorMessage);
            }

            const body = response.body;
            if (!body) throw new Error('No response body received from server');

            reader = body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            let abortReason: string | null = null;
            const onAbort = () => {
                abortReason = 'Aborted by user';
                try { reader?.cancel(); } catch { }
            };
            signal?.addEventListener('abort', onAbort, { once: true });

            try {
                while (true) {
                    let done: boolean;
                    let value: Uint8Array | undefined;

                    try {
                        const result = await reader.read();
                        done = result.done;
                        value = result.value;
                    } catch (readError: any) {
                        if (abortReason || signal?.aborted) {
                            return;
                        }
                        const errorMsg = readError.name === 'AbortError'
                            ? 'Stream was cancelled'
                            : `Failed to read server response: ${readError.message}`;
                        yield {
                            phase: 'error',
                            message: errorMsg,
                            task: 'Connection to the server was interrupted',
                            error: readError.message || 'Stream read error'
                        };
                        return;
                    }

                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';

                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            const data = line.slice(6);
                            try {
                                const json = JSON.parse(data) as AIProjectProgress;
                                yield json;
                                if (json.done || json.error) return;
                            } catch (e) {
                                if (e instanceof SyntaxError) continue;
                                throw e;
                            }
                        }
                    }
                }
            } finally {
                signal?.removeEventListener('abort', onAbort);
                try { reader.cancel(); } catch { }
            }
        } catch (error: any) {
            if (error.message === 'Request cancelled.' || error.name === 'AbortError') {
                throw error;
            }
            yield {
                phase: 'error',
                message: error.message || 'Unknown error',
                task: 'AI project creation failed',
                error: error.message || 'Unknown error'
            };
        }
    },

    cancelProjectWithAI: (projectId?: number) =>
        request<{ success: boolean; projectId?: number | null; message: string }>(
            '/ai/cancel-creation',
            {
                method: 'POST',
                body: JSON.stringify(projectId ? { projectId } : {}),
            }
        ),

    downloadDebugLog: (logData: any, filename: string = 'ai-creation-debug') => {
        const blob = new Blob([JSON.stringify(logData, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${filename}-${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    },

    // Unified Search
    search: (query: string, options?: { projectId?: number; limit?: number }) => {
        const params = new URLSearchParams({ q: query });
        if (options?.projectId) params.set('projectId', String(options.projectId));
        if (options?.limit) params.set('limit', String(options.limit));
        return request<SearchResults>(`/search?${params}`);
    },

    searchSuggest: (query: string, options?: { projectId?: number; limit?: number }) => {
        const params = new URLSearchParams({ q: query });
        if (options?.projectId) params.set('projectId', String(options.projectId));
        if (options?.limit) params.set('limit', String(options.limit));
        return request<SearchSuggestion[]>(`/search/suggest?${params}`);
    },

    // MASTERY
    getNodeMastery: (nodeId: number) =>
        request<any>(`/nodes/${nodeId}/mastery`),

    getProjectMastery: (projectId: number) =>
        request<any[]>(`/projects/${projectId}/mastery`),

    submitBossFight: (projectId: number, nodeId: number, score: number, total: number, questions?: any[]) =>
        request<any>(`/projects/${projectId}/mastery/boss-fight`, {
            method: 'POST',
            body: JSON.stringify({ nodeId, score, total, questions }),
        }),

    // DAILY PLAN
    getDailyPlan: (projectId: number) =>
        request<DailyPlan>(`/projects/${projectId}/daily-plan`),

    getGhostQuestions: (projectId: number, max?: number) =>
        request<any[]>(`/projects/${projectId}/ghost-questions${max ? `?max=${max}` : ''}`),

    // ATLAS — the library as one space (server/atlas.js). Never rejects on a
    // missing topic space: `available:false` + `reason` is the answer.
    getAtlas: (opts: { refresh?: boolean; archived?: boolean } = {}) => {
        const params = new URLSearchParams();
        if (opts.refresh) params.set('refresh', 'true');
        if (opts.archived) params.set('archived', 'true');
        const qs = params.toString();
        return request<AtlasData>(`/atlas${qs ? `?${qs}` : ''}`);
    },

    // Name a region by hand, or hand it back to the map. Addressed by the
    // region's member-set signature, because a region has no id that survives a
    // rebuild. Both invalidate the atlas server-side, so the next load draws it.
    renameAtlasRegion: (signature: string, label: string, size?: number) =>
        request<{ label: string; labelSource: 'user' }>(`/atlas/regions/${signature}/name`, {
            method: 'PUT',
            body: JSON.stringify({ label, size }),
        }),

    resetAtlasRegionName: (signature: string) =>
        request<{ ok: boolean }>(`/atlas/regions/${signature}/name`, { method: 'DELETE' }),

    // LEARNING FEED (home page)
    getFeed: (exclude?: string[], limit = 15, nodeId?: number | null) => {
        const params = new URLSearchParams({ limit: String(limit) });
        if (exclude && exclude.length) params.set('exclude', exclude.join(','));
        // Scoped to one topic (or a section's leaves): the "Study this" page.
        if (nodeId != null) params.set('nodeId', String(nodeId));
        return request<FeedResponse>(`/feed?${params.toString()}`);
    },

    // Persist an in-session visual repair into the cached card it was read in,
    // so the next load renders the fixed spec instead of repairing again (see
    // store.repairFeedVisual; mirrors updateChatMessage for the tutor). The two
    // SPECS go over the wire, not the card: a question or practice card is a
    // JSON payload server-side and the client never holds its stored form.
    // `replaced: false` means the card was regenerated in the meantime.
    repairFeedVisual: (id: number, original: string, repaired: string) =>
        request<{ success: boolean; replaced: boolean }>(`/feed/items/${id}`, {
            method: 'PUT',
            body: JSON.stringify({ original, repaired }),
        }),

    consumeFeedCard: (payload: {
        key: string;
        kind: 'lesson' | 'question' | 'recall';
        feedItemId?: number | null;
        nodeId?: number;
        result?: FeedConsumeResult;
    }) => request<{ ok: boolean; stats: FeedStats }>('/feed/consume', {
        method: 'POST',
        body: JSON.stringify(payload),
    }),

    // PAPER PRACTICE (work by hand, photograph, get marked — server/paper.js)

    // Whether a vision model the server actually trusts is available. Asked
    // before offering the camera, so a learner is never invited to photograph
    // work that cannot be marked — they get the self-marking flow up front.
    getPaperCapability: () => request<{ vision: boolean; model: string | null }>('/paper/capability'),

    // The worked solution. Fetched only after submitting or on an explicit
    // "mark it myself" — never bundled with the exercise card.
    getPaperSolution: (feedItemId: number) =>
        request<{ referenceSolution: string; rubric: PaperRubricPoint[] }>(`/paper/${feedItemId}/solution`),

    // Multipart, so it bypasses the JSON `request` helper (the browser must set
    // its own boundary). The timeout is generous because this is two model calls
    // back to back — a vision transcription then a grading pass — and on a local
    // stack that is minutes, not seconds.
    gradePaperAttempt: async (feedItemId: number, image: Blob): Promise<PaperGradeResponse> => {
        const form = new FormData();
        form.append('image', image, 'scan.jpg');
        const res = await fetch(`${BASE}/paper/${feedItemId}/grade`, { method: 'POST', body: form });
        if (!res.ok) {
            let msg = `Grading failed: ${res.status}`;
            try { const d = await res.json(); if (d.error) msg = d.error; } catch { /* non-JSON */ }
            throw new Error(msg);
        }
        return res.json();
    },

    selfGradePaperAttempt: (feedItemId: number, metCount: number) =>
        request<{ status: 'graded'; attemptId: number; score: number; total: number; selfGraded: true }>(
            `/paper/${feedItemId}/self-grade`,
            { method: 'POST', body: JSON.stringify({ metCount }) },
        ),

    getAllDueFlashcards: () => request<GlobalDueFlashcard[]>('/flashcards/due'),

    /** The ledger behind the feed header's chips — see server/today.js. */
    getTodayActivity: (date?: string) =>
        request<TodayActivity>(`/today/activity${date ? `?date=${date}` : ''}`),

    getCalendarRange: (from: string, to: string) =>
        request<GlobalCalendarData>(`/calendar?from=${from}&to=${to}`),

    /** Cross-project schedule board rows (one per non-archived project). */
    getScheduleOverview: () => request<ScheduleOverview>('/schedule/overview'),

    // ANKI IMPORT (server/ankiImport.js)

    /**
     * Upload a deck and get back a preview. Writes nothing.
     *
     * Uses XHR rather than fetch for one reason: a real Anki collection with
     * media can be hundreds of megabytes, and fetch cannot report upload
     * progress. A silent two-minute wait on a big file reads as a hang, which is
     * the point at which people close the tab.
     */
    inspectAnkiDeck: (file: File, onProgress?: (pct: number) => void) =>
        new Promise<AnkiPreview>((resolve, reject) => {
            const form = new FormData();
            form.append('deck', file);
            const xhr = new XMLHttpRequest();
            xhr.open('POST', `${BASE}/import/anki/inspect`);
            xhr.upload.onprogress = (e) => {
                if (e.lengthComputable) onProgress?.(Math.round((e.loaded / e.total) * 100));
            };
            xhr.onload = () => {
                let body: any = null;
                try { body = JSON.parse(xhr.responseText); } catch { /* handled below */ }
                if (xhr.status >= 200 && xhr.status < 300 && body) resolve(body as AnkiPreview);
                else reject(new Error(body?.error || `Import failed (${xhr.status})`));
            };
            xhr.onerror = () => reject(new Error('The upload failed before it reached the server.'));
            xhr.send(form);
        }),

    commitAnkiImport: (body: {
        stagingId: string; projectName: string; swapFrontBack: boolean; keepSchedule: boolean;
        includeMedia?: boolean;
    }) => request<AnkiImportResult>('/import/anki/commit', {
        method: 'POST',
        body: JSON.stringify(body),
        // Writing a few thousand cards is one transaction, but a very large deck
        // can outlast the default timeout.
        timeout: 120000,
    }),

    // Card media. Descriptions serve the tutor and a screen reader from one
    // string; the sweep is a background chain, so progress is polled.
    getMediaDescriptionStatus: (projectId?: number) =>
        request<import('./types').MediaDescriptionStatus>(
            `/media-descriptions/status${projectId ? `?projectId=${projectId}` : ''}`),

    runMediaDescriptions: (projectId?: number) =>
        request<{ started: boolean; total?: number; reason?: string }>('/media-descriptions/run', {
            method: 'POST', body: JSON.stringify({ projectId }),
        }),

    cancelMediaDescriptions: () =>
        request<{ ok: boolean }>('/media-descriptions/cancel', { method: 'POST' }),

    describeMedia: (hash: string, force = false) =>
        request<{ ok: boolean; description: string }>(`/media/${hash}/describe`, {
            method: 'POST', body: JSON.stringify({ force }),
        }),

    cancelAnkiImport: (stagingId: string) =>
        request<{ success: boolean }>(`/import/anki/${stagingId}`, { method: 'DELETE' }),

    // PLACEMENT PROBE (server/placement.js)
    //
    // Note what is NOT here: nothing that returns an answer key alongside a
    // question. The key comes back from `answerPlacement`, after the learner
    // has committed — same contract as the paper loop's reference solution.

    getPlacement: (projectId: number) => request<PlacementStatus>(`/placement/${projectId}`),

    /**
     * Author the probe. Runs as a background task, so this streams progress and
     * survives the modal being closed — reopening reattaches to the same run
     * rather than paying for a second one.
     */
    startPlacement: async (
        projectId: number,
        onProgress?: (written: number, total: number) => void,
        signal?: AbortSignal,
    ): Promise<PlacementProbe> => {
        const response = await fetch(`${SSE_BASE}/placement/${projectId}/start`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
            signal,
        });
        // An already-generated probe short-circuits to plain JSON rather than a
        // stream — resuming must not look like a fresh minute of authoring.
        const contentType = response.headers.get('content-type') || '';
        if (!contentType.includes('text/event-stream')) {
            const json = await response.json();
            if (json.error) throw new Error(json.error);
            return json.probe as PlacementProbe;
        }

        const body = response.body;
        if (!body) throw new Error('No response body');
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    let json: any;
                    try { json = JSON.parse(line.slice(6)); } catch { continue; }
                    if (typeof json.written === 'number') onProgress?.(json.written, json.total ?? 0);
                    if (json.cancelled) throw Object.assign(new Error('Placement was cancelled.'), { cancelled: true });
                    if (json.error) throw new Error(json.error);
                    if (json.done) return json as PlacementProbe;
                }
            }
        } finally {
            try { reader.cancel(); } catch { }
        }
        throw new Error('The placement stream ended without finishing.');
    },

    answerPlacement: (probeId: number, questionIndex: number, answer: string) =>
        request<PlacementAnswerResult>(`/placement/probe/${probeId}/answer`, {
            method: 'POST',
            body: JSON.stringify({ questionIndex, answer }),
            // An open answer is graded by the model, which on a cold local model
            // can outlast the default timeout.
            timeout: 120000,
        }),

    finishPlacement: (probeId: number) =>
        request<{ probe: PlacementProbe; summary: PlacementSummary }>(
            `/placement/probe/${probeId}/finish`, { method: 'POST' },
        ),

    /** Undo a probe and every head start it produced. */
    discardPlacement: (projectId: number) =>
        request<{ cleared: number }>(`/placement/${projectId}`, { method: 'DELETE' }),

    // BACKGROUND AI TASKS (server/tasks.js registry)

    getTasks: () => request<AITaskSummary[]>('/tasks'),

    cancelTask: (id: string) => request<{ success: boolean }>(`/tasks/${id}/cancel`, { method: 'POST' }),

    dismissTask: (id: string) => request<{ success: boolean }>(`/tasks/${id}`, { method: 'DELETE' }),

    // Live task-list feed for the global task dock: full snapshot on connect,
    // then coalesced snapshots on every change. Long-lived — the caller keeps
    // it open for the app's lifetime and reconnects on failure.
    streamTaskList: async (onList: (tasks: AITaskSummary[]) => void, signal?: AbortSignal): Promise<void> => {
        const response = await fetch(`${SSE_BASE}/tasks/stream`, { signal });
        const body = response.body;
        if (!body) throw new Error('No response body');

        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        try {
            while (true) {
                const { done, value } = await readOrStale(reader);
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    try {
                        const json = JSON.parse(line.slice(6));
                        if (Array.isArray(json.tasks)) onList(json.tasks);
                    } catch { /* keepalive/partial */ }
                }
            }
        } finally {
            try { reader.cancel(); } catch { }
        }
    },

    // Reattach to a running (or queued/just-finished) task: the server replays
    // everything generated so far, then follows live. Yields the same event
    // vocabulary the original stream endpoints speak ({chunk, thinking,
    // thinkingChunk, progress, phase, done, error, cancelled, …}); the
    // generator ends after a terminal frame.
    attachTask: async function* (taskId: string, signal?: AbortSignal): AsyncGenerator<any> {
        const response = await fetch(`${SSE_BASE}/tasks/${taskId}/stream`, { signal });
        const body = response.body;
        if (!body) throw new Error('No response body');

        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        try {
            while (true) {
                let chunk: ReadableStreamReadResult<Uint8Array>;
                try {
                    chunk = await readOrStale(reader);
                } catch (e) {
                    // Detached (navigation/unmount) — the task itself keeps running.
                    if (signal?.aborted || (e instanceof DOMException && e.name === 'AbortError')) return;
                    throw e;
                }
                const { done, value } = chunk;
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    let json: any;
                    try { json = JSON.parse(line.slice(6)); } catch { continue; }
                    yield json;
                    if (json.done || json.error || json.cancelled) return;
                }
            }
        } finally {
            try { reader.cancel(); } catch { }
        }
    },
};