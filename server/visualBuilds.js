import db from './database.js';
import { getAISettings, disabledVisualKinds, visualKindAllowed } from './ai.js';
import { isUnavailable } from './embeddings.js';

/**
 * When may a widget, an animation or a simulation be BUILT without anyone
 * pressing a button — and what stops it being built again after it failed.
 *
 * The three hard visual kinds cost a model call to draw (widgets.js compiles a
 * spec into an app, visualAuthor.js draws a scene brief), so the renderer needs
 * consent before it spends one. A reply the learner has just watched arrive
 * gives it: the tutor said "try the slider below", and a button between the
 * learner and the slider is a chore. Everything else — a message re-read from
 * history, a second device, a feed card — asks.
 *
 * That consent is not a blank cheque, and this module is the rest of it:
 *   - a kind switched off in Settings (`visual_kinds_off`), or one the model
 *     tier gate does not trust this model with (`visual_tier`), is never built
 *     unasked. The gate decides what the model is TOLD about, and a model that
 *     wrote the fence anyway has not changed what the learner chose;
 *   - a build the MODEL failed is recorded, so the unattended path offers a
 *     button next time instead of spending the same failure again on every
 *     re-render, reload and device. An endpoint that was down, busy or aborted
 *     says nothing about the spec and records nothing — one outage must not
 *     become a permanent verdict (the rule feedGen's pre-build already keeps).
 *     A failure is keyed by model too: switching models clears the way.
 *
 * A person pressing Build is never refused by any of this.
 */

const BUILD_KINDS = new Set(['widget', 'animation', 'p5']);

/** The recorded failure for this build, whatever model it was recorded under. */
export function buildFailure(hash) {
    if (!hash) return null;
    try {
        return db.prepare('SELECT hash, kind, model, attempts, reason, last_attempt_at FROM visual_build_failures WHERE hash = ?').get(hash) || null;
    } catch {
        return null;
    }
}

/**
 * Record that the model failed this build. Returns whether anything was
 * written: an unreachable, busy or cancelled endpoint writes nothing.
 *
 * `fromRenderer`: the failure was found by EXECUTING the build (the page's
 * probe), not by calling the model — its message is a runtime error from the
 * build's own code, and the endpoint-outage heuristic must not read "…not
 * found" in a stack message as a dead endpoint.
 */
export function recordBuildFailure({ hash, kind, error, model = null, fromRenderer = false }) {
    if (!hash || !BUILD_KINDS.has(kind)) return false;
    if (!fromRenderer && isUnavailable(error)) return false;
    const reason = String(error?.message || error || 'the build failed').replace(/\s+/g, ' ').slice(0, 300);
    const who = model ?? safeModel();
    try {
        db.prepare(`
            INSERT INTO visual_build_failures (hash, kind, model, attempts, reason, last_attempt_at)
            VALUES (?, ?, ?, 1, ?, ?)
            ON CONFLICT(hash) DO UPDATE SET
                kind = excluded.kind,
                attempts = CASE WHEN visual_build_failures.model IS excluded.model
                                THEN visual_build_failures.attempts + 1 ELSE 1 END,
                model = excluded.model,
                reason = excluded.reason,
                last_attempt_at = excluded.last_attempt_at
        `).run(hash, kind, who, reason, new Date().toISOString());
        return true;
    } catch {
        return false;
    }
}

/** A build that succeeded is no longer a failure. */
export function clearBuildFailure(hash) {
    if (!hash) return;
    try { db.prepare('DELETE FROM visual_build_failures WHERE hash = ?').run(hash); } catch { /* best effort */ }
}

function safeModel() {
    try { return getAISettings().model || null; } catch { return null; }
}

/**
 * May this build start with nobody asking?
 *
 *   { build: true }
 *   { build: false, reason: 'off' }      the kind is switched off in Settings
 *   { build: false, reason: 'tier' }     the model gate does not offer it to this model
 *   { build: false, reason: 'failed', error }   this model already failed this build
 *
 * The reason travels to the client as a code, and the client says it in the
 * reader's language; `error` is the recorded message, shown beside the offer so
 * the learner can judge whether pressing again is worth a model call.
 */
export function autoBuildVerdict({ kind, hash, model = safeModel() }) {
    if (!BUILD_KINDS.has(kind)) return { build: false, reason: 'off' };
    if (disabledVisualKinds().has(kind)) return { build: false, reason: 'off' };
    if (!visualKindAllowed(kind, model)) return { build: false, reason: 'tier' };
    const failed = buildFailure(hash);
    if (failed && (failed.model ?? null) === (model ?? null)) {
        return { build: false, reason: 'failed', error: failed.reason || '' };
    }
    return { build: true };
}
