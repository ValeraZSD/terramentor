// AI visuals: repair, captions, feedback, widget builds and the specialist author.
import { createHash } from 'node:crypto';
import {
    captionVisual, getAISettings, streamRepairVisualSpec, streamReviseVisualSpec, stripCodeFence,
    VISUAL_BRIEF_KINDS, widgetSpecLabel,
} from '../ai.js';
import {
    clearVisualFeedback, readVisualFeedback, recordVisualFeedback, recordVisualOutcome,
    visualFeedbackPath, visualFeedbackSummary,
} from '../visualFeedback.js';
import { compileWidget, getCachedBuild, specHashOf } from '../widgets.js';
import { authorVisual, getCachedVisual, visualBriefHash, visualBriefLabel } from '../visualAuthor.js';
import { autoBuildVerdict, buildFailure, clearBuildFailure, recordBuildFailure } from '../visualBuilds.js';
import * as tasks from '../tasks.js';
import { appVersion } from '../version.js';
import { attachTaskStream, startSseResponse, visualTaskOrigin } from './taskStream.js';
import { routeTable } from './routeTable.js';

const app = routeTable('visuals');

// Repair a broken visual spec (render-validate-repair loop). The frontend calls
// this when a ```mermaid / ```vega-lite / ```plot / ```smiles / ```math block
// fails to render, passing the raw spec and the renderer's parse error.
//
// A BACKGROUND TASK, like the author endpoint further down, and not a bare SSE
// response that aborts the model call the moment the socket closes: the OS
// drops the socket when a phone's app goes to the background, so a rebuild
// tied to the socket dies whenever the learner switches apps and they come
// back to the same broken drawing. The rebuild runs to the end whatever
// the socket does, is cancelled only through the dock (or the block's Cancel,
// which cancels the task by id), and a client that re-POSTs the identical
// request — which is what the returning phone does — joins the running task
// through `dedupeKey` and has its progress replayed.
async function runVisualRepair({ kindText, code, error, feedback, brief, feedbackId, themeText, emit, signal }) {
    const revising = typeof feedback === 'string' && feedback.trim().length > 0;
    try {
        let full = '';
        // The client draws ONE bar over what can be two model calls, so every
        // frame names its phase, its running length, its reasoning length and
        // the length this phase is expected to reach. Before 2026-09-05 it was
        // a bare running length scaled against the BRIEF, which pinned the bar
        // at the 99% clamp for the whole of the drawing call — the slow one —
        // and reported nothing at all while a reasoning model was thinking.
        // A phase's estimate is a yardstick, never a promise: the client's
        // ramp handles an answer that runs past it (repairProgress.ts).
        // `progress` rides along so the task's replay accumulator (tasks.js
        // keeps `progress`, not `chars`) has a running length for the dock.
        const firstPhase = revising && brief && VISUAL_BRIEF_KINDS.has(kindText) ? 'brief' : 'spec';
        const firstEst = Math.max(1, code.trim().length);
        let firstThinking = 0;
        const emitFirst = () => emit({ phase: firstPhase, chars: full.length, progress: full.length, thinking: firstThinking, est: firstEst });
        const onThinking = (chars) => { firstThinking = chars; emitFirst(); };
        const stream = revising
            ? streamReviseVisualSpec(kindText, code, feedback, { signal, brief: !!brief, theme: themeText, onThinking })
            : streamRepairVisualSpec(kindText, code, error, { signal, onThinking });
        for await (const chunk of stream) {
            full += chunk;
            emitFirst();
        }
        const revised = stripCodeFence(full);
        const briefChanged = revised.trim() !== code.trim();

        // A BRIEF-backed visual: the words were revised above, but the reader
        // was looking at a DRAWING, and until 2026-09-05 their note never
        // reached it — the drawer was called blind from the new words, with no
        // previous drawing, and a brief that already said what they asked for
        // (measured: 4 of 14 brief reports) could not be fixed at all. So the
        // drawing is revised HERE, from the reader's own words plus the cached
        // previous drawing, and cached under the revised brief's hash so the
        // client's cache-first resolve finds it without a second model call.
        let drawing = null;
        if (revising && brief && VISUAL_BRIEF_KINDS.has(kindText)) {
            const nextBrief = briefChanged ? revised : code;
            const previous = getCachedVisual(visualBriefHash(kindText, code.trim()))?.spec || '';
            // The drawing this one replaces is a real yardstick for its length;
            // with no cached previous, a middling animation's worth of markup.
            const drawEst = Math.max(500, previous.trim().length || 4500);
            let drawChars = 0, drawThinking = 0;
            const emitDraw = () => emit({ phase: 'draw', chars: drawChars, progress: drawChars, thinking: drawThinking, est: drawEst });
            emitDraw();   // hand the bar over the moment the second call starts
            const result = await authorVisual({
                kind: kindText,
                brief: nextBrief,
                readerNote: feedback,
                previousSpec: previous,
                theme: themeText,
                signal,
                emit: (evt) => {
                    if (typeof evt?.progress === 'number') { drawChars = evt.progress; emitDraw(); }
                    else if (typeof evt?.thinking === 'number') { drawThinking = evt.thinking; emitDraw(); }
                },
            });
            if (result?.cancelled) return { cancelled: true };
            drawing = { spec: result.spec, changed: result.spec.trim() !== previous.trim() };
        }

        // Close the loop on the learner's report: the record is only a bug
        // report once it carries what the model did about it (visualFeedback.js).
        if (revising && feedbackId) {
            recordVisualOutcome(String(feedbackId), {
                revisedSpec: revised,
                revisedDrawing: drawing?.spec,
                accepted: briefChanged || !!drawing?.changed,
            });
        }
        // `redrawn` tells the client a cached drawing changed even when the
        // words did not, so it re-renders rather than reporting "same drawing".
        return { code: revised, redrawn: !!drawing?.changed };
    } catch (err) {
        if (signal.aborted) return { cancelled: true };
        if (revising && feedbackId) recordVisualOutcome(String(feedbackId), { error: err.message, accepted: false });
        console.error('Visual repair error:', err);
        throw err;
    }
}

app.post('/api/ai/repair-visual', (req, res) => {
    // Two jobs, one endpoint, because the client shows one progress bar for
    // both: `error` is a renderer exception (the spec is broken), `feedback` is
    // a PERSON saying the drawing is wrong (the spec renders fine). They take
    // different prompts — see reviseVisualPrompt in ai.js — and telling a model
    // that a working spec "failed with error: the axes do not move" sends it
    // looking for a syntax fault that is not there.
    const { kind, code, error, feedback, brief, feedbackId, theme } = req.body || {};
    if (!kind || !code) return res.status(400).json({ error: 'Missing required fields: kind, code' });
    const kindText = String(kind);
    const codeText = String(code);
    const errorText = error ? String(error) : '';
    const feedbackText = typeof feedback === 'string' ? feedback : '';
    const revising = feedbackText.trim().length > 0;
    const themeText = typeof theme === 'string' ? theme : '';
    // The same spec with the same complaint is the same rebuild: a second
    // request joins the first rather than starting a second model call. The
    // theme is part of it because "make it white" is a different instruction
    // on a dark page (readerColourNote).
    const dedupeKey = 'visual-repair:' + createHash('sha1')
        .update([kindText, codeText.trim(), revising ? `f:${feedbackText.trim()}` : `e:${errorText}`, brief ? 'brief' : '', themeText].join('\0'))
        .digest('hex');
    const repairFrom = visualTaskOrigin(req);
    const { task } = tasks.createTask({
        kind: 'visual',
        label: `${revising ? 'Rebuilding' : 'Repairing'} ${kindText === 'vega' ? 'chart' : kindText === 'p5' ? 'simulation' : kindText}`,
        labelKey: revising ? 'Rebuilding a visual' : 'Repairing a visual',
        origin: repairFrom.origin,
        ...repairFrom.fields,
        dedupeKey,
        run: ({ emit, signal }) => runVisualRepair({
            kindText, code: codeText, error: errorText, feedback: feedbackText,
            brief: !!brief, feedbackId, themeText, emit, signal,
        }),
    });
    attachTaskStream(req, res, task.id);
});

// A title and caption for a visual leaving the app as an image or GIF. The
// picture goes without the lesson around it, so the export can carry one line
// of context; the learner edits the words before saving, this only drafts them.
app.post('/api/ai/visual/caption', async (req, res) => {
    const { kind, spec, context } = req.body || {};
    if (typeof kind !== 'string' || !kind.trim()) return res.status(400).json({ error: 'kind required' });
    if (typeof spec !== 'string' || !spec.trim()) return res.status(400).json({ error: 'spec required' });
    try {
        res.json(await captionVisual(kind.trim(), spec, typeof context === 'string' ? context : ''));
    } catch (err) {
        console.error('Visual caption error:', err.message);
        res.status(502).json({ error: err.message });
    }
});

// VISUAL FEEDBACK — what a person said was wrong with a drawing.
//
// A visual that renders and is WRONG throws nothing: the repair loop cannot see
// it, the coherence gate cannot see it, and the only detector is a learner who
// knows what they were meant to be looking at. These endpoints are that
// detector's memory. Nothing is sent anywhere — the app appends to a local file
// and hands it back when asked, so a learner who wants to open an issue has the
// spec, their own words and the model's answer already in one place.

app.post('/api/visual-feedback', (req, res) => {
    const { kind, language, spec, feedback, surface, nodeId, messageId, theme } = req.body || {};
    if (typeof feedback !== 'string' || !feedback.trim()) {
        return res.status(400).json({ error: 'feedback (non-empty string) required' });
    }
    if (typeof spec !== 'string' || !spec.trim()) {
        return res.status(400).json({ error: 'spec (non-empty string) required' });
    }
    // The model that drew it is part of the report: a lesson authored by a 4B
    // and one authored by a 30B are not the same artifact (the provenance rule).
    const ai = getAISettings();
    const id = recordVisualFeedback({
        kind, language, spec, feedback, surface, nodeId, messageId, theme,
        provider: ai?.provider, model: ai?.model, appVersion: appVersion()?.version,
    });
    res.json({ id });
});

app.get('/api/visual-feedback', (req, res) => {
    res.json(visualFeedbackSummary());
});

// The whole file, as a download. `.jsonl` and not `.json` on purpose: it is one
// record per line so it can be appended to safely and read with grep, and a
// half-written last line never invalidates the rest.
app.get('/api/visual-feedback/export', (req, res) => {
    const body = readVisualFeedback();
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="visual-feedback.jsonl"');
    res.send(body);
});

app.delete('/api/visual-feedback', (req, res) => {
    const ok = clearVisualFeedback();
    res.json({ success: ok, path: visualFeedbackPath() });
});

// INTERACTIVE WIDGETS (```widget spec → compiled sandbox HTML)
//
// The tutor's reply carries only a small functional spec; compiling it into a
// runnable widget is a separate, queued LLM pass (the "construction crew" of
// the two-agent split — see widgetCompilePrompt in ai.js). Running it through
// tasks.js means a compile requested mid-reply starts only AFTER the chat
// generation that emitted the spec finishes — on a single-threaded local model
// the reply always streams to completion first, then queued widgets build one
// by one. Verified builds are cached in widget_builds by spec hash, so
// reopening an old chat renders instantly with zero LLM calls.
//
// The compile itself lives in server/widgets.js because feedGen shares it: the
// feed PRE-builds a lesson's widget in the background, so by the time the card
// is served the cache is already warm and this endpoint answers from it.

/**
 * The cache-first front of both build endpoints (widget compile, visual
 * author), which differ only in what they build. Answers the request itself and
 * returns true when no NEW task should be started:
 *   - a cached build answers at once, off the queue and out of the dock;
 *   - a build already RUNNING is joined — for a `cacheOnly` lookup too, so a
 *     re-opened message or a second device shows the build in progress rather
 *     than "not built yet" beside a build the server is halfway through;
 *   - `cacheOnly` otherwise answers a miss (with the last recorded failure, so
 *     the offer can say what happened last time);
 *   - `auto` (a build nobody pressed for — a finished answer's widget) is
 *     declined when the kind is switched off, the model gate does not offer it,
 *     or this model already failed this build (visualBuilds.js). That includes
 *     an unasked HEAL of a broken cached build (`auto` with `error`), which is
 *     otherwise the one path that could rebuild on every render.
 * An explicit rebuild (`force`) or a fix pass nobody-else started goes to the queue.
 */
function declineUnasked(req, res, kind, hash) {
    const verdict = autoBuildVerdict({ kind, hash });
    if (verdict.build) return false;
    const { write, end } = startSseResponse(req, res);
    write({ miss: true, declined: verdict.reason, ...(verdict.error != null ? { lastError: verdict.error } : {}) });
    end();
    return true;
}

function answerBuildRequest(req, res, { kind, hash, dedupeKey, cached, cachedFrame }) {
    const { error, force, cacheOnly, auto } = req.body || {};
    if (force) return false;
    if (error) return auto ? declineUnasked(req, res, kind, hash) : false;
    if (cached) {
        const { write, end } = startSseResponse(req, res);
        write({ done: true, ...cachedFrame, cached: true });
        end();
        return true;
    }
    const running = tasks.findByDedupeKey(dedupeKey);
    if (running) {
        attachTaskStream(req, res, running.id);
        return true;
    }
    if (cacheOnly) {
        const failed = buildFailure(hash);
        const { write, end } = startSseResponse(req, res);
        write({ miss: true, ...(failed ? { lastError: failed.reason || '' } : {}) });
        end();
        return true;
    }
    return auto ? declineUnasked(req, res, kind, hash) : false;
}

/**
 * Run one build, and keep the failure record honest either way: a build the
 * MODEL failed is recorded (an unreachable endpoint is not — recordBuildFailure
 * decides), and one that succeeds clears whatever was recorded before.
 */
async function trackedBuild({ hash, kind, signal }, build) {
    try {
        const out = await build();
        if (out && !out.cancelled) clearBuildFailure(hash);
        return out;
    } catch (err) {
        if (!signal?.aborted) recordBuildFailure({ hash, kind, error: err });
        throw err;
    }
}

app.post('/api/ai/widget/compile', (req, res) => {
    const { spec, error, previousHtml } = req.body || {};
    const specText = typeof spec === 'string' ? spec.trim() : '';
    if (!specText) return res.status(400).json({ error: 'Missing required field: spec' });
    const specHash = specHashOf(specText);
    const dedupeKey = `widget:${specHash}`;

    const cached = (!error && !req.body?.force) ? getCachedBuild(specHash) : null;
    if (answerBuildRequest(req, res, {
        kind: 'widget', hash: specHash, dedupeKey, cached,
        cachedFrame: cached ? { html: cached.html, specHash } : null,
    })) return;

    // dedupeKey folds concurrent requests for the same spec (a re-mounted chat
    // while a build is in flight) into one task; the SSE below replays it.
    const widgetFrom = visualTaskOrigin(req);
    const { task } = tasks.createTask({
        kind: 'widget',
        label: widgetSpecLabel(specText),
        origin: widgetFrom.origin,
        ...widgetFrom.fields,
        dedupeKey,
        run: ({ emit, signal }) => trackedBuild({ hash: specHash, kind: 'widget', signal }, () => compileWidget({
            spec: specText,
            specHash,
            error: error ? String(error) : '',
            previousHtml: typeof previousHtml === 'string' ? previousHtml : '',
            emit,
            signal,
        })),
    });
    attachTaskStream(req, res, task.id);
});

// The client's half of the failure record. A widget build can come back from
// the model and still not RUN — the page executes it in a hidden probe first,
// and a runtime error there is invisible to the server. Reported here so the
// unattended path does not rebuild it on every re-render. The hash is computed
// from the spec, never taken from the request.
app.post('/api/ai/visual/build-failed', (req, res) => {
    const { kind, spec, error } = req.body || {};
    const text = typeof spec === 'string' ? spec.trim() : '';
    const kindText = typeof kind === 'string' ? kind.trim() : '';
    if (!text || !['widget', 'animation', 'p5'].includes(kindText)) {
        return res.status(400).json({ error: 'kind (widget | animation | p5) and spec are required' });
    }
    const hash = kindText === 'widget' ? specHashOf(text) : visualBriefHash(kindText, text);
    const message = typeof error === 'string' && error.trim() ? error : 'the build did not run';
    res.json({ recorded: recordBuildFailure({ hash, kind: kindText, error: new Error(message), fromRenderer: true }) });
});

// The specialist authoring pass for the two hard visual kinds (```animation
// and ```p5). Same shape as the widget compiler above and for the same reason
// — see server/visualAuthor.js — so it shares the queue, the cache-first
// answer and the dedupe: a brief the conversational model wrote is compiled by
// a second call carrying the full rendering rules for that one kind.
app.post('/api/ai/visual/author', (req, res) => {
    const { kind, brief, error, previousSpec } = req.body || {};
    const kindText = typeof kind === 'string' ? kind.trim() : '';
    const briefText = typeof brief === 'string' ? brief.trim() : '';
    if (!briefText) return res.status(400).json({ error: 'Missing required field: brief' });
    if (!VISUAL_BRIEF_KINDS.has(kindText)) {
        return res.status(400).json({ error: `"${kindText}" is not authored by the specialist pass` });
    }
    const briefHash = visualBriefHash(kindText, briefText);
    const dedupeKey = `visual:${briefHash}`;

    const cached = (!error && !req.body?.force) ? getCachedVisual(briefHash) : null;
    if (answerBuildRequest(req, res, {
        kind: kindText, hash: briefHash, dedupeKey, cached,
        cachedFrame: cached ? { spec: cached.spec, briefHash } : null,
    })) return;

    const authorFrom = visualTaskOrigin(req);
    const { task } = tasks.createTask({
        kind: 'visual',
        label: visualBriefLabel(kindText, briefText),
        origin: authorFrom.origin,
        ...authorFrom.fields,
        dedupeKey,
        run: ({ emit, signal }) => trackedBuild({ hash: briefHash, kind: kindText, signal }, () => authorVisual({
            kind: kindText,
            brief: briefText,
            briefHash,
            error: error ? String(error) : '',
            previousSpec: typeof previousSpec === 'string' ? previousSpec : '',
            emit,
            signal,
        })),
    });
    attachTaskStream(req, res, task.id);
});

export const routes = app.takeRoutes();
