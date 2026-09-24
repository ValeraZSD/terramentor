// Background AI task registry + queue.
//
// Every long-running AI generation (tutor chat, quiz/mastery check, flashcards,
// insights, briefing, today chat) runs as a *task* that is decoupled from the
// HTTP request that started it: the SSE response is merely a subscription to
// the task's event stream. Closing the tab, navigating away, or reloading the
// page detaches the subscriber but the generation keeps running; reattaching
// (GET /api/tasks/:id/stream, or re-POSTing a deduped endpoint) replays the
// accumulated output and then continues live. Cancellation is always explicit
// (POST /api/tasks/:id/cancel or the task dock's ✕) — never a side effect of a
// dropped connection.
//
// Queueing: tasks run FIFO, at most `concurrencyLimit()` at once — a function
// injected by index.js via setConcurrencyProvider, defaulting to one because a
// local model server realistically serves one generation at a time
// (llama-swap/Ollama would serialize or thrash anyway). Queued tasks report
// their position so the UI
// can show "(2) name (queued)". Project creation is registered as an
// *external* task (registerExternal): it manages its own pipeline and runs
// outside the queue, but still shows up in the list with progress + cancel.
//
// All state is in-memory: this is a local single-user app; a server restart
// legitimately clears the queue (the UI feed simply shows it empty again).

import { randomUUID } from 'node:crypto';

/**
 * How many tasks may run at once, asked on every pump.
 *
 * ONE was right for the local case this queue was written for — llama-swap and
 * Ollama serve a single slot, and a second request only queues behind the
 * first inside the server — and wrong for a hosted API, where a chat reply and
 * the drawing it asked for can run side by side and instead the drawing sat at
 * "queued (#2) — starts when the current AI task finishes". The limit is
 * injected rather than read here because this module is deliberately
 * dependency-free (see describeFailure); index.js supplies a function that
 * reads the live provider settings, so a switch from local to hosted takes
 * effect on the next task without a restart.
 */
let concurrencyLimit = () => 1;

function setConcurrencyProvider(fn) {
    // Throw rather than ignore: silently keeping the default of one turns a
    // typo at the wiring site into a hosted provider that still runs its tasks
    // one at a time, which looks like slowness, not like a bug.
    if (typeof fn !== 'function') throw new TypeError('setConcurrencyProvider expects a function');
    concurrencyLimit = fn;
    pump();
}

/**
 * Somewhere to send "this task started / finished / failed" without this module
 * learning what a log is.
 *
 * Same shape as the concurrency provider above and for the same reason: tasks.js
 * is deliberately dependency-free (see describeFailure), so index.js injects the
 * sink. Absent, nothing is recorded and nothing breaks — which is also what
 * happens in the tools that import this module without a database.
 */
let taskObserver = null;

function setTaskObserver(fn) {
    taskObserver = typeof fn === 'function' ? fn : null;
}

function observe(task, phase, extra = {}) {
    if (!taskObserver) return;
    try {
        taskObserver({
            phase,
            kind: task.kind,
            id: task.id,
            projectId: task.projectId ?? null,
            startedAt: task.startedAt || null,
            ...extra,
        });
    } catch { /* an observer must never affect the queue */ }
}

function currentLimit() {
    let n = 1;
    try { n = Number(concurrencyLimit()); } catch { n = 1; }
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}
// Finished tasks linger so the dock can show "done"/"failed" before the entry
// disappears; the client can also dismiss them immediately.
const FINISHED_TTL_MS = 3 * 60 * 1000;
// Background housekeeping (document indexing) is low-signal — a bulk vault
// upload registers one task per file, so a 3-minute linger piles dozens of
// "done" chips into the dock. These clear fast so the dock shows ~one advancing
// "Indexing" chip instead of a wall of finished ones.
const HOUSEKEEPING_TTL_MS = 5 * 1000;
const HOUSEKEEPING_KINDS = new Set(['embed', 'recover']);
// Caps on the replay accumulators — a runaway generation must not eat the heap.
const CONTENT_CAP = 2_000_000;
const THINKING_CAP = 200_000;

const tasksById = new Map();  // id -> task
const queue = [];             // ids of queued (not yet running) tasks
let runningCount = 0;
const listListeners = new Set();
let notifyTimer = null;

function isActive(task) {
    return task.status === 'queued' || task.status === 'running';
}

// `queuePos` is a 1-based position looked up from a precomputed map (avoids an
// O(queue) indexOf per task — which made listTasks O(N·Q) on every snapshot).
/**
 * Everything known about why a task failed, in one record.
 *
 * A failure carries which model, which endpoint, how far it got and whether it
 * is worth retrying: a bare "something went wrong" is unhelpful for the learner
 * and useless for a bug report from someone else's machine, which is the case
 * that matters once this ships.
 *
 * Two layers, deliberately: `message` is the sentence a person reads, and the
 * rest is the technical record they can copy into an issue. `tasks.js` knows
 * the task; the THROWER knows the endpoint, so anything `tagAIError` attached
 * in ai.js is copied across here rather than re-derived (this module has no
 * dependencies beyond crypto and is worth keeping that way).
 *
 * Everything is bounded. A failure record is held in memory for the dock's
 * lifetime and an unbounded model response or stack would pin megabytes.
 */
const CAP = { message: 500, stack: 4000, body: 2000, causes: 5 };

function describeFailure(err, task) {
    const e = err || {};
    const causes = [];
    let cur = e.cause;
    while (cur && causes.length < CAP.causes) {
        causes.push(String(cur.message || cur).slice(0, 200));
        cur = cur.cause;
    }
    const started = task.startedAt ? Date.parse(task.startedAt) : null;
    return {
        // --- the sentence a person reads
        message: String(e.message || 'Generation failed').slice(0, CAP.message),
        name: e.name || 'Error',
        at: new Date().toISOString(),

        // --- what the task was doing
        kind: task.kind,
        label: task.label,
        projectId: task.projectId,
        nodeId: task.nodeId,
        phase: task.progress.phase,
        lastMessage: task.progress.message,
        // How far it got before it died — the difference between "the model
        // never answered" and "it answered for 40 seconds and then broke".
        produced: {
            thinkingChars: task.progress.thinking,
            contentChars: task.progress.content,
            percent: task.progress.percent,
        },
        queuedAt: task.createdAt,
        startedAt: task.startedAt,
        elapsedMs: started ? Date.now() - started : null,

        // --- where it was sent (from tagAIError; absent for a non-AI failure)
        provider: e.provider ?? null,
        model: e.model ?? null,
        endpoint: e.endpoint ?? null,
        httpStatus: e.httpStatus ?? null,
        code: e.code ?? null,
        // How many times the request was actually sent. A 429 that survived
        // three attempts with backoff is a quota that is genuinely spent; the
        // same status on one attempt would mean the retry never ran, which is a
        // different bug entirely.
        attempts: e.attempts ?? null,
        // The model was stopped for going round in circles in its reasoning
        // (streamResponse in ai.js) — a cause the record can name outright.
        looped: e.looped === true ? true : null,
        // The endpoint answered, and the answer was empty (emptyReplyError in
        // ai.js). What it spent getting there is the whole diagnosis, so the
        // two numbers travel with the flag.
        emptyReply: e.emptyReply === true ? true : null,
        reasoningTokens: e.reasoningTokens ?? null,
        finishReason: e.finishReason || null,

        // --- the raw evidence
        responseBody: e.responseBody ? String(e.responseBody).slice(0, CAP.body) : null,
        rawResponse: e.rawResponse ? String(e.rawResponse).slice(0, CAP.body) : null,
        causes,
        stack: e.stack ? String(e.stack).slice(0, CAP.stack) : null,
    };
}

function summarize(task, queuePos = null) {
    return {
        id: task.id,
        kind: task.kind,
        label: task.label,
        projectId: task.projectId,
        nodeId: task.nodeId,
        projectName: task.projectName,
        projectColor: task.projectColor,
        status: task.status,
        createdAt: task.createdAt,
        startedAt: task.startedAt,
        finishedAt: task.finishedAt,
        progress: { ...task.progress },
        queuePosition: task.status === 'queued' ? queuePos : null,
        error: task.status === 'error' ? (task.errorMessage || 'Failed') : null,
        // The full record behind that one line — see describeFailure.
        failure: task.failure ?? null,
        meta: task.publicMeta,
    };
}

function listTasks() {
    // One pass over `queue` to map id -> 1-based position, shared by every
    // queued task's summary.
    const queuePos = new Map();
    for (let i = 0; i < queue.length; i++) queuePos.set(queue[i], i + 1);
    return [...tasksById.values()]
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
        .map((t) => summarize(t, queuePos.get(t.id) ?? null));
}

/**
 * Is the learner waiting on the model right now?
 *
 * The one contended resource in this app is the single model server, and every
 * background producer (the feed generator, bulk study-material generation) has
 * the same duty: get out of the way when a person is waiting. They differ only
 * in which kinds are "themselves", so that is the parameter.
 *
 * Never throws — a producer must not die because the task list hiccuped; the
 * worst outcome of a false `false` is one queued reply arriving late.
 */
function interactiveActive(ownKinds = []) {
    const own = new Set(ownKinds);
    try {
        return [...tasksById.values()].some(t =>
            (t.status === 'running' || t.status === 'queued') && !own.has(t.kind));
    } catch {
        return false;
    }
}

// Progress events arrive per token; pushing a full-list snapshot to every
// dock subscriber at that rate would be wasteful. Coalesce to ~4/s.
function scheduleNotify() {
    if (notifyTimer || listListeners.size === 0) return;
    notifyTimer = setTimeout(() => {
        notifyTimer = null;
        const list = listTasks();
        for (const fn of listListeners) {
            try { fn(list); } catch { /* subscriber gone */ }
        }
    }, 250);
}

function onListChange(fn) {
    listListeners.add(fn);
    return () => listListeners.delete(fn);
}

// Fold a stream event into the task's replay accumulators + progress counters.
// The event vocabulary is the one the SSE endpoints already speak
// ({chunk, thinking, thinkingChunk, progress, phase, message, percent, …}),
// so subscribers get byte-compatible frames whether live or replayed.
function absorb(task, evt) {
    if (typeof evt.thinking === 'number') task.progress.thinking = evt.thinking;
    if (typeof evt.progress === 'number') task.progress.content = evt.progress;
    if (typeof evt.percent === 'number') task.progress.percent = Math.max(0, Math.min(100, evt.percent));
    // How long the JOB says it has left, where the job is the only thing
    // that can know: bulk generation times its own calls on this machine's
    // own model. Everything else leaves it null and the dock derives an
    // estimate from percent and elapsed, which is the best that can be done
    // from outside. A number is milliseconds; an explicit null withdraws a
    // previous estimate rather than freezing it at the last one sent.
    if (typeof evt.etaMs === 'number') task.progress.etaMs = Math.max(0, Math.round(evt.etaMs));
    else if (evt.etaMs === null) task.progress.etaMs = null;
    if (typeof evt.phase === 'string') task.progress.phase = evt.phase;
    if (typeof evt.message === 'string') task.progress.message = evt.message;
    if (typeof evt.chunk === 'string' && evt.chunk) {
        if (task.content.length < CONTENT_CAP) task.content += evt.chunk;
        task.progress.content = task.content.length;
    }
    if (typeof evt.thinkingChunk === 'string' && evt.thinkingChunk) {
        if (task.thinkingText.length < THINKING_CAP) task.thinkingText += evt.thinkingChunk;
    }
    // A chat turn's lookups arrive as the WHOLE list each time, so the latest
    // frame is the state. Kept for the replay: a second device attaching after
    // the searches ran saw the reasoning and the answer, and no sign the web
    // had been searched until the turn settled and history was re-read.
    if (Array.isArray(evt.actions)) task.actions = evt.actions;
}

function emit(task, evt) {
    absorb(task, evt);
    for (const fn of task.subscribers) {
        try { fn(evt); } catch { /* subscriber gone */ }
    }
    scheduleNotify();
}

function scheduleCleanup(task) {
    const ttl = HOUSEKEEPING_KINDS.has(task.kind) ? HOUSEKEEPING_TTL_MS : FINISHED_TTL_MS;
    task.cleanupTimer = setTimeout(() => {
        tasksById.delete(task.id);
        scheduleNotify();
    }, ttl);
    // Never keep the process alive just to forget a finished task.
    task.cleanupTimer.unref?.();
}

function settle(task, status, terminalEvent) {
    if (!isActive(task)) return; // already settled (e.g. cancel raced completion)
    const startedMs = task.startedAt ? Date.parse(task.startedAt) : null;
    task.status = status;
    task.finishedAt = new Date().toISOString();
    observe(task, status, {
        ms: startedMs ? Date.now() - startedMs : null,
        error: status === 'error' ? (terminalEvent?.error || null) : null,
    });
    if (status === 'done') task.progress.percent = 100;
    // A settled task has no time left, and an estimate left lying on the
    // record would be read as one.
    task.progress.etaMs = null;
    task.terminalEvent = terminalEvent;
    emit(task, terminalEvent);
    task.subscribers.clear();
    scheduleCleanup(task);
    scheduleNotify();
}

function pump() {
    while (runningCount < currentLimit() && queue.length > 0) {
        const task = tasksById.get(queue.shift());
        if (!task || task.status !== 'queued') continue;
        runningCount += 1;
        task.status = 'running';
        task.startedAt = new Date().toISOString();
        emit(task, { status: 'running' });

        Promise.resolve()
            .then(() => task.run({
                emit: (evt) => emit(task, evt),
                signal: task.abort.signal,
            }))
            .then((result) => {
                if (result && result.cancelled) {
                    // The run() observed the abort and did its partial-save
                    // housekeeping — whatever it returned rides on the terminal
                    // frame (e.g. the saved partial message's id).
                    settle(task, 'cancelled', { cancelled: true, ...result });
                } else {
                    settle(task, 'done', { done: true, ...(result || {}) });
                }
            })
            .catch((err) => {
                if (task.abort.signal.aborted) {
                    settle(task, 'cancelled', { cancelled: true });
                } else {
                    task.errorMessage = err?.message || 'Generation failed';
                    task.failure = describeFailure(err, task);
                    settle(task, 'error', {
                        error: task.errorMessage,
                        failure: task.failure,
                        rawResponse: err?.rawResponse ?? null,
                    });
                }
            })
            .finally(() => {
                runningCount -= 1;
                pump();
            });
    }
}

/**
 * Enqueue a background AI task.
 * `run({emit, signal})` must resolve with the result payload for the terminal
 * `done` frame, resolve with `{cancelled:true, ...}` after observing an abort,
 * or reject (err.rawResponse rides along on the error frame).
 * `dedupeKey`: if an active task carries the same key, that task is returned
 * with `existing: true` instead of enqueueing a duplicate.
 */
function createTask({ kind, label, projectId = null, nodeId = null, projectName = null, projectColor = null, meta = null, dedupeKey = null, run }) {
    if (dedupeKey) {
        for (const t of tasksById.values()) {
            if (t.dedupeKey === dedupeKey && isActive(t)) {
                return { task: t, existing: true };
            }
        }
    }
    const task = {
        id: randomUUID(),
        kind, label, projectId, nodeId, projectName, projectColor,
        publicMeta: meta,
        dedupeKey,
        status: 'queued',
        createdAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
        progress: { thinking: 0, content: 0, percent: null, phase: null, message: null, etaMs: null },
        content: '',
        thinkingText: '',
        terminalEvent: null,
        errorMessage: null,
        failure: null,
        subscribers: new Set(),
        abort: new AbortController(),
        run,
        external: false,
        cancelHook: null,
    };
    tasksById.set(task.id, task);
    queue.push(task.id);
    scheduleNotify();
    pump();
    return { task, existing: false };
}

/**
 * Register a self-managing generation (AI project creation) so it appears in
 * the task list with progress + cancel, without going through the queue.
 * Returns handles the owner drives: update / setProject / finish / fail /
 * cancelled. The owner's `cancel` hook is invoked by cancelTask().
 */
function registerExternal({ kind, label, projectId = null, projectName = null, projectColor = null, cancel }) {
    const task = {
        id: randomUUID(),
        kind, label, projectId, nodeId: null, projectName, projectColor,
        publicMeta: null,
        dedupeKey: null,
        status: 'running',
        createdAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        finishedAt: null,
        progress: { thinking: 0, content: 0, percent: 0, phase: null, message: null, etaMs: null },
        content: '',
        thinkingText: '',
        terminalEvent: null,
        errorMessage: null,
        failure: null,
        subscribers: new Set(),
        abort: new AbortController(),
        run: null,
        external: true,
        cancelHook: cancel,
    };
    tasksById.set(task.id, task);
    scheduleNotify();
    return {
        id: task.id,
        update(patch) {
            if (!isActive(task)) return;
            absorb(task, patch);
            scheduleNotify();
        },
        setProject(projectId, projectName, projectColor) {
            task.projectId = projectId;
            if (projectName) task.projectName = projectName;
            if (projectColor) task.projectColor = projectColor;
            scheduleNotify();
        },
        finish() { settle(task, 'done', { done: true }); },
        // `detail` lets an external task (embeddings, feedGen, pdf recovery)
        // hand over the same shape an exception would have produced.
        fail(message, detail = null) {
            task.errorMessage = message || 'Failed';
            task.failure = describeFailure(detail instanceof Error ? detail
                : { message: task.errorMessage, ...(detail || {}) }, task);
            settle(task, 'error', { error: task.errorMessage, failure: task.failure });
        },
        cancelled() { settle(task, 'cancelled', { cancelled: true }); },
    };
}

function findActive({ kind, nodeId = undefined, projectId = undefined }) {
    for (const t of tasksById.values()) {
        if (!isActive(t)) continue;
        if (kind && t.kind !== kind) continue;
        if (nodeId !== undefined && t.nodeId !== nodeId) continue;
        if (projectId !== undefined && t.projectId !== projectId) continue;
        return t;
    }
    return null;
}

/**
 * Subscribe to a task's event stream. Replays the task's accumulated state
 * first (status frame, reasoning, content, terminal frame if finished), then
 * live events. Returns an unsubscribe function.
 */
function subscribe(id, fn) {
    const task = tasksById.get(id);
    if (!task) return null;

    // --- Replay ---
    try {
        fn({
            taskId: task.id,
            kind: task.kind,
            status: task.status,
            queuePosition: task.status === 'queued' ? queue.indexOf(task.id) + 1 : null,
            replay: true,
        });
        if (task.thinkingText) {
            fn({ thinking: task.progress.thinking, thinkingChunk: task.thinkingText });
        } else if (task.progress.thinking > 0) {
            fn({ thinking: task.progress.thinking });
        }
        if (task.actions?.length) fn({ actions: task.actions });
        if (task.content) {
            fn({ chunk: task.content });
        } else if (task.progress.content > 0) {
            fn({ progress: task.progress.content });
        }
        if (task.progress.phase) fn({ phase: task.progress.phase, waitedMs: 0 });
        if (task.terminalEvent) {
            fn(task.terminalEvent);
            return () => { };
        }
    } catch {
        return () => { };
    }

    task.subscribers.add(fn);
    return () => task.subscribers.delete(fn);
}

function cancelTask(id) {
    const task = tasksById.get(id);
    if (!task) return { ok: false, error: 'Task not found' };
    if (!isActive(task)) return { ok: false, error: 'Task already finished' };

    if (task.external) {
        // Owner drives its own teardown (and will call handle.cancelled()).
        // An external task registered WITHOUT a cancel hook has no owner-side
        // teardown at all — settle it here, or cancel is a silent no-op and the
        // chip stays "running" forever.
        try { task.cancelHook?.(); } catch { }
        if (!task.cancelHook) settle(task, 'cancelled', { cancelled: true });
        return { ok: true };
    }
    if (task.status === 'queued') {
        const qi = queue.indexOf(task.id);
        if (qi >= 0) queue.splice(qi, 1);
        settle(task, 'cancelled', { cancelled: true });
        return { ok: true };
    }
    // Running: signal the run(); it settles through the promise chain.
    task.abort.abort();
    return { ok: true };
}

function dismissTask(id) {
    const task = tasksById.get(id);
    if (!task) return { ok: true }; // already gone — dismissing is idempotent
    if (isActive(task)) return { ok: false, error: 'Task is still active — cancel it first' };
    if (task.cleanupTimer) clearTimeout(task.cleanupTimer);
    tasksById.delete(id);
    scheduleNotify();
    return { ok: true };
}

export {
    createTask,
    setConcurrencyProvider,
    setTaskObserver,
    registerExternal,
    interactiveActive,
    findActive,
    subscribe,
    listTasks,
    onListChange,
    cancelTask,
    dismissTask,
};
