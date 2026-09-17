import db from './database.js';
import { sha256 } from './vaultStorage.js';
import {
    streamResponse,
    getAISettings,
    widgetCompilePrompt,
    finalizeWidgetHtml,
} from './ai.js';

/**
 * The "construction crew" half of the two-agent visual split (D-022).
 *
 * The tutor (or a feed lesson) emits only a short functional SPEC in a
 * ```widget fence; turning that spec into a runnable, sandboxed HTML app is a
 * SEPARATE LLM pass with its own prompt and its own context. This module owns
 * that pass, so both callers share one implementation:
 *   - server/index.js  — POST /api/ai/widget/compile, queued through tasks.js,
 *     compiling on demand while the learner waits (the chat path).
 *   - server/feedGen.js — pre-compiling a feed lesson's widget in the background,
 *     hours before the card is ever served (the feed path).
 *
 * Builds are cached in `widget_builds` by spec hash, so the second caller to ask
 * for the same spec pays nothing. That cache is what makes pre-compilation work:
 * feedGen warms it, and the client's cacheOnly probe then renders instantly with
 * zero LLM calls.
 */

/** Cached build for a spec, or null. */
export function getCachedBuild(specHash) {
    return db.prepare('SELECT html FROM widget_builds WHERE spec_hash = ?').get(specHash) || null;
}

/**
 * Bump when a change to the COMPILER CONTRACT should reach builds already in
 * the cache — i.e. when the same spec ought to compile into a different widget.
 *
 * `widget_builds` is a cache keyed by spec, and a cache does not know that the
 * rules changed underneath it: improve the builder prompt and every widget the
 * library already holds keeps the build made under the old rules, forever, with
 * no surface anywhere that says so. That is the same trap `feed_items` has (see
 * docs/ARCHITECTURE.md), and it bit for real — the rule that a widget's axes must stay
 * fixed across its controls' range was added because a projectile widget looked
 * identical at every slider setting, and without a key change not one existing
 * widget would ever have been rebuilt.
 *
 * Cheap by construction: a bump costs one recompile per widget the learner
 * actually opens, and only for the visual kind that already knows how to be
 * built on demand (the feed pre-builds in the background; a miss elsewhere
 * offers a "Build widget" button rather than blocking anyone).
 *
 *   1 — the original contract.
 *   2 — fixed axes across the input range; theme variables re-read per frame.
 */
const WIDGET_CONTRACT_VERSION = 2;

export function specHashOf(spec) {
    return sha256(`v${WIDGET_CONTRACT_VERSION}\n${String(spec).trim()}`);
}

/**
 * Every ```widget spec in a markdown document, in order. Used by feedGen to find
 * what to pre-build; the fence must be the model's, not ours, so we tolerate the
 * lazy variants (extra spaces, uppercase) a local model emits.
 */
export function extractWidgetSpecs(markdown) {
    const specs = [];
    const re = /^[ \t]*```[ \t]*widget[ \t]*\r?\n([\s\S]*?)^[ \t]*```[ \t]*$/gim;
    for (const m of String(markdown || '').matchAll(re)) {
        const spec = m[1].trim();
        if (spec) specs.push(spec);
    }
    return specs;
}

/**
 * Compile a spec into a self-contained HTML document and cache it.
 *
 * `error`/`previousHtml` drive the fix pass (the client's probe iframe executes
 * the build and sends back a runtime error). The cache is overwritten on a fix,
 * so a broken cached build heals rather than sticking around.
 *
 * `emit` is optional — the chat path streams progress to the TaskDock; the feed
 * path passes nothing and just waits.
 */
export async function compileWidget({ spec, specHash, error = '', previousHtml = '', emit = () => { }, signal }) {
    const hash = specHash || specHashOf(spec);
    let raw = '';
    let thinkingChars = 0;
    try {
        const { system, user } = widgetCompilePrompt(spec, { error, previousHtml });
        for await (const part of streamResponse(user, system, [], { signal, temperature: 0.2, think: true })) {
            if (part && part.type === 'content' && part.content) {
                raw += part.content;
                emit({ progress: raw.length });
            } else if (part && part.type === 'thinking' && part.content) {
                thinkingChars += part.content.length;
                emit({ thinking: thinkingChars });
            }
        }
        if (signal?.aborted) return { cancelled: true };
        const html = finalizeWidgetHtml(raw);
        db.prepare(`
            INSERT INTO widget_builds (spec_hash, spec, html, model)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(spec_hash) DO UPDATE SET
                html = excluded.html, model = excluded.model, created_at = CURRENT_TIMESTAMP
        `).run(hash, spec, html, getAISettings().model);
        return { html, specHash: hash };
    } catch (err) {
        if (signal?.aborted) return { cancelled: true };
        console.error('Widget compile error:', err.message);
        if (err.rawResponse === undefined) err.rawResponse = raw || null;
        throw err;
    }
}
