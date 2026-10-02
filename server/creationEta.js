/**
 * Where an AI project creation run is, and how long it has left.
 *
 * Pure: no database, no clock of its own (every method takes `now`), so the
 * arithmetic is gated by `tools/generation-eta-gates.mjs` without a server.
 *
 * WHY THE TIME IS COUNTED IN CALLS. A creation run is a fixed recipe of model
 * calls whose COUNTS become known as it goes and whose DURATIONS differ by an
 * order of magnitude: the phase list is one call, each phase's sections one
 * call, each section's topics one call (or one batched call for the whole
 * phase), and each topic's link hunt a web search plus two more calls. So the
 * time left is Σ (calls of each kind still to make) × (how long that kind takes
 * here) — measured in THIS run once it has timed one, seeded from earlier runs
 * (`creation_avg_ms_*`, `durationAverages.js`) until then.
 *
 * The run never PREDICTS before it starts (memory: no wall-clock predictions):
 * `snapshot().etaMs` is null until the shape is known — the phase count, one
 * phase's sections and one section's topics, so the ratios used for the parts
 * not yet planned are this run's own — and every kind still to run has an
 * average. The client says "estimating" for a null.
 *
 * Vocabulary, the app's own: a PHASE is a top-level section, a
 * SECTION is a node with children, a TOPIC is a leaf — what the learner studies.
 * The server's older names are category / element / sub-element.
 */

/** Every kind of timed call, in pipeline order. */
export const CREATION_OPS = ['thinking', 'summary', 'phases', 'sections', 'topics_batch', 'topics', 'links'];

/** The settings key a kind's rolling average lives under. */
export const avgSettingKey = (kind) => `creation_avg_ms_${kind}`;

/**
 * The stages a person sees, in order. `queued` exists only while the run waits
 * for a free model slot; `done` is the finish line.
 */
export const CREATION_STAGES = ['queued', 'think', 'prepare', 'outline', 'build', 'done'];

/** The batched topics call covers a phase of this many sections (server/routes/createProject.js). */
export const BATCH_MIN = 2;
export const BATCH_MAX = 10;
const batches = (sections) => sections >= BATCH_MIN && sections <= BATCH_MAX;

/**
 * Which stage a pipeline phase belongs to. An UNKNOWN phase keeps the stage the
 * run is already in — a new step added early in the run (a name check, say)
 * must not throw the stepper back to the start or forward to the build.
 */
export function stageOf(phase, prev = 'think') {
    switch (phase) {
        case 'queued': return 'queued';
        case 'thinking':
        case 'thinking_done': return 'think';
        case 'init':
        case 'summary': return 'prepare';
        case 'generating_categories':
        case 'categories_generated': return 'outline';
        case 'generating_elements':
        case 'elements_generated':
        case 'generating_sub_elements':
        case 'sub_elements_batched':
        case 'sub_elements_generated':
        case 'finding_resources':
        case 'resources_saved': return 'build';
        case 'complete': return 'done';
        default: return prev;
    }
}

/**
 * The timed call a frame ANNOUNCES, or null. The route sends "starting X"
 * before it makes the call, so without this the frame's snapshot would have no
 * call in flight — its floor would equal its estimate, and the client's
 * countdown (which may not go under the floor) would stand still for the whole
 * of the call it is waiting on.
 */
export function callAnnouncedBy(frame) {
    switch (frame?.phase) {
        case 'summary': return typeof frame.summary === 'string' ? null : 'summary';
        case 'generating_categories': return 'phases';
        case 'generating_elements': return 'sections';
        case 'generating_sub_elements': return frame.currentElement ? 'topics' : 'topics_batch';
        case 'finding_resources': return 'links';
        default: return null;
    }
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/**
 * The calls still to make, per kind, and the topics still to write.
 *
 * `shape.phases` is null before the phase list exists, else one entry per
 * phase: `{ sections: null | [{ topics: null | number, done: number }], batchTried }`.
 * `ratios` are the means this run has observed; a null ratio means that part
 * of the shape cannot be estimated yet, and `complete` says so.
 */
export function remainingOps(shape, { curate }) {
    const ops = Object.fromEntries(CREATION_OPS.map(k => [k, 0]));
    if (!shape.phases) return { ops, topicsLeft: null, topicsKnown: 0, complete: false };

    const knownSections = shape.phases.filter(p => p.sections).map(p => p.sections.length);
    const knownTopics = shape.phases.flatMap(p => (p.sections || []).filter(s => s.topics != null).map(s => s.topics));
    const sectionsPerPhase = mean(knownSections);
    const topicsPerSection = mean(knownTopics);

    let topicsLeft = 0;
    let topicsKnown = 0;
    let complete = true;
    for (const phase of shape.phases) {
        if (!phase.sections) {
            ops.sections += 1;
            if (sectionsPerPhase == null || topicsPerSection == null) { complete = false; continue; }
            const s = Math.max(1, Math.round(sectionsPerPhase));
            if (batches(s)) ops.topics_batch += 1; else ops.topics += s;
            topicsLeft += sectionsPerPhase * topicsPerSection;
            continue;
        }
        const n = phase.sections.length;
        const batchPending = !phase.batchTried && batches(n);
        if (batchPending) ops.topics_batch += 1;
        for (const section of phase.sections) {
            if (section.topics == null) {
                if (!batchPending) ops.topics += 1;
                if (topicsPerSection == null) { complete = false; continue; }
                topicsLeft += topicsPerSection;
            } else {
                topicsKnown += section.topics;
                topicsLeft += Math.max(0, section.topics - section.done);
            }
        }
    }
    topicsLeft = Math.round(topicsLeft);
    if (curate) ops.links = topicsLeft;
    return { ops, topicsLeft: complete ? topicsLeft : null, topicsKnown, complete };
}

/**
 * Milliseconds for a set of remaining calls, or null when any kind that still
 * has calls to make has no average — never a guess filled in with zero.
 */
export function etaForOps(ops, averages) {
    let total = 0;
    for (const kind of CREATION_OPS) {
        const n = ops[kind] || 0;
        if (n <= 0) continue;
        const avg = averages[kind];
        if (!(avg > 0)) return null;
        total += n * avg;
    }
    return Math.round(total);
}

/**
 * One run's tracker. The create route drives it (`begin`/`end` around each
 * timed call, `*Planned` as the shape arrives, `topicDone` per leaf) and folds
 * `snapshot(now)` into every frame it sends.
 */
export function createCreationTracker({ seeds = {}, curate = true } = {}) {
    const durations = Object.fromEntries(CREATION_OPS.map(k => [k, []]));
    const shape = { phases: null };
    let current = null;            // { kind, startedAt }
    let stage = null;
    const stageTimes = {};         // stage → { start, end }
    let phaseIndex = null;
    let topicsDone = 0;
    let activeMs = 0;              // time spent working (not waiting for a slot)
    let activeSince = null;

    const averages = () => {
        const out = {};
        for (const kind of CREATION_OPS) {
            const mine = mean(durations[kind].slice(-8));
            out[kind] = mine ?? (seeds[kind] > 0 ? seeds[kind] : null);
        }
        return out;
    };

    const tracker = {
        /** Move to the stage this phase belongs to; stamps the stage clock. */
        phase(phaseName, at) {
            const next = stageOf(phaseName, stage ?? 'think');
            if (next === stage) return stage;
            if (stage && stageTimes[stage] && stageTimes[stage].end == null) stageTimes[stage].end = at;
            // A queued run's clock starts when it gets its slot, not when it was asked for.
            if (stage === 'queued' || stage == null) {
                if (next !== 'queued' && activeSince == null) activeSince = at;
            }
            if (next === 'queued') {
                if (activeSince != null) { activeMs += at - activeSince; activeSince = null; }
            }
            stage = next;
            if (!stageTimes[next]) stageTimes[next] = { start: at, end: next === 'done' ? at : null };
            return stage;
        },
        begin(kind, at) {
            current = { kind, startedAt: at };
        },
        /** Close the current call; returns its duration (ms) or null when it did not match. */
        end(kind, at) {
            if (!current || current.kind !== kind) return null;
            const ms = Math.max(0, at - current.startedAt);
            durations[kind].push(ms);
            current = null;
            return ms;
        },
        /** Drop the current call without timing it (an abort, a failure). */
        abandon() { current = null; },
        phasesPlanned(n) {
            shape.phases = Array.from({ length: Math.max(0, n) }, () => ({ sections: null, batchTried: false }));
        },
        phaseStarted(i) { phaseIndex = i; },
        sectionsPlanned(i, n) {
            const p = shape.phases?.[i];
            if (p) p.sections = Array.from({ length: Math.max(0, n) }, () => ({ topics: null, done: 0 }));
        },
        batchTried(i) {
            const p = shape.phases?.[i];
            if (p) p.batchTried = true;
        },
        topicsPlanned(i, j, n) {
            const s = shape.phases?.[i]?.sections?.[j];
            if (s) s.topics = Math.max(0, n);
        },
        topicDone(i, j) {
            const s = shape.phases?.[i]?.sections?.[j];
            if (s) s.done = Math.min(s.topics ?? Infinity, s.done + 1);
            topicsDone += 1;
        },
        /** Everything a frame carries about where the run is and what is left. */
        snapshot(at) {
            const { ops, topicsLeft, topicsKnown, complete } = remainingOps(shape, { curate });
            const avg = averages();
            let etaMs = null;
            let etaFloorMs = null;
            if (shape.phases && complete && stage !== 'done') {
                const total = etaForOps(ops, avg);
                if (total != null) {
                    // The call in flight is one of the remaining ones: what is
                    // left of it is its average minus the time it has already
                    // run, never less than nothing — and the floor is the rest,
                    // which the client's countdown may not dip under.
                    const curAvg = current ? (avg[current.kind] ?? 0) : 0;
                    const inCurrent = current ? Math.min(curAvg, Math.max(0, at - current.startedAt)) : 0;
                    etaMs = Math.max(0, Math.round(total - inCurrent));
                    etaFloorMs = Math.max(0, Math.round(total - curAvg));
                }
            }
            const active = activeMs + (activeSince != null ? at - activeSince : 0);
            // Time-weighted progress: how much of the whole (spent + left) is
            // spent. A count of calls would give a one-second call the same
            // weight as a ten-minute link hunt.
            const fraction = etaMs != null && active > 0 ? Math.min(0.99, active / (active + etaMs)) : null;
            return {
                stage,
                stageTimes: JSON.parse(JSON.stringify(stageTimes)),
                phases: shape.phases ? shape.phases.length : null,
                phaseIndex,
                topicsDone,
                topicsKnown,
                // Written + still to write; an estimate while any part is unplanned.
                topicsTotal: topicsLeft == null ? null : topicsDone + topicsLeft,
                topicsExact: !!shape.phases && shape.phases.every(p => p.sections && p.sections.every(s => s.topics != null)),
                linksOn: !!curate,
                etaMs,
                etaFloorMs,
                // Whether every average behind the estimate is this run's own.
                etaMeasured: etaMs != null && CREATION_OPS.every(k => (ops[k] || 0) === 0 || durations[k].length > 0),
                fraction,
                activeMs: Math.round(active),
                at,
            };
        },
    };
    return tracker;
}
