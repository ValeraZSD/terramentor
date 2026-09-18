import db from './database.js';
import { sha256 } from './vaultStorage.js';
import {
    streamResponse,
    getAISettings,
    visualAuthorPrompt,
    finalizeAuthoredSpec,
    VISUAL_BRIEF_KINDS,
} from './ai.js';

/**
 * The specialist pass, generalised from the widget compiler.
 *
 * WHAT THIS IS FOR. Of the visual kinds this app renders, two are hard in a way
 * the others are not. ```mermaid and ```vega-lite and ```plot are declarative:
 * the model names a relationship or a formula and a library draws it, so the
 * worst it can do is a spec that fails to parse — loud, catchable, repairable.
 * ```animation and ```p5 are the opposite. The model has to hold a coordinate
 * system, a clock and a rendering engine's semantics in its head WHILE it is
 * also writing a teaching reply, and when it gets one of those wrong nothing
 * throws: an `<animate attributeName="transform">` renders a perfectly still
 * scene, an undefined `class=` renders an invisible line, a vector scaled by a
 * physical magnitude flies off-canvas. Every mechanical gate and repair hint in
 * this repo about those failures is evidence of the same thing — that the two
 * jobs interfere.
 *
 * So they are split, exactly as ```widget already is (D-022): the
 * conversational model writes a short SCENE BRIEF in plain words — what is being
 * shown, what moves, what the learner should notice — and THIS pass compiles it,
 * with a system prompt carrying the full rules for that one kind. Those rules
 * are several hundred words each and could never be paid on every chat turn;
 * here they are paid once, when a drawing is actually being made.
 *
 * BACKWARDS COMPATIBLE BY CONSTRUCTION. Whether a fence holds a brief or a
 * finished spec is decided by looking at it (`isVisualBrief`), never by a flag
 * or a version, so every animation already cached in `feed_items` and every one
 * in an old chat message still renders directly and costs nothing.
 */

/** Cached spec for a brief, or null. */
export function getCachedVisual(briefHash) {
    return db.prepare('SELECT spec, kind FROM visual_builds WHERE brief_hash = ?').get(briefHash) || null;
}

/**
 * Bump when a change to a specialist prompt should reach briefs already
 * compiled. Same reasoning as WIDGET_CONTRACT_VERSION in widgets.js: a cache
 * does not know the rules changed underneath it.
 *
 *   1 — the original contract.
 */
const VISUAL_CONTRACT_VERSION = 1;

export function visualBriefHash(kind, brief) {
    return sha256(`v${VISUAL_CONTRACT_VERSION}\n${kind}\n${String(brief).trim()}`);
}

/**
 * Does this fence hold a brief (plain words) rather than a finished spec?
 *
 * Deliberately a POSITIVE test for the finished form, not a guess about prose:
 * an `<svg` or a `function setup(` is unambiguous, and anything ambiguous is
 * treated as a brief and compiled — the failure mode of a wrong call in that
 * direction is one model call, while the other direction would send a finished
 * scene to be rewritten. Mirrored on the client (src/components/visuals/resolveBrief.ts) so
 * the renderer and the pre-generator agree about what needs building.
 */
export function isVisualBrief(kind, code) {
    const text = String(code || '').trim();
    if (!text) return false;
    if (!VISUAL_BRIEF_KINDS.has(kind)) return false;
    if (kind === 'animation') return !/<svg[\s>]/i.test(text);
    if (kind === 'p5') return !/\bfunction\s+(setup|draw)\s*\(/.test(text);
    return false;
}

/**
 * Compile a brief into a finished spec and cache it.
 *
 * `error`/`previousSpec` drive the fix pass (the client's renderer reports what
 * failed to render or, worse, what rendered wrongly). The cache is overwritten
 * on a fix, so a broken cached spec heals rather than sticking around — the same
 * contract compileWidget keeps.
 */
export async function authorVisual({ kind, brief, briefHash, error = '', previousSpec = '', readerNote = '', theme = '', emit = () => { }, signal }) {
    if (!VISUAL_BRIEF_KINDS.has(kind)) {
        throw new Error(`"${kind}" is not authored by the specialist pass.`);
    }
    const hash = briefHash || visualBriefHash(kind, brief);
    let raw = '';
    let thinkingChars = 0;
    try {
        // `readerNote` is a person's words about the previous drawing of this
        // brief (the "Fix this" path); `error` is a renderer's. They take
        // different prompts, and the note wins when both are present.
        const { system, user } = visualAuthorPrompt(kind, brief, { error, previousSpec, readerNote, theme });
        for await (const part of streamResponse(user, system, [], { signal, temperature: 0.3, think: true })) {
            if (part && part.type === 'content' && part.content) {
                raw += part.content;
                emit({ progress: raw.length });
            } else if (part && part.type === 'thinking' && part.content) {
                thinkingChars += part.content.length;
                emit({ thinking: thinkingChars });
            }
        }
        if (signal?.aborted) return { cancelled: true };
        const spec = finalizeAuthoredSpec(kind, raw);
        db.prepare(`
            INSERT INTO visual_builds (brief_hash, kind, brief, spec, model)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(brief_hash) DO UPDATE SET
                spec = excluded.spec, model = excluded.model, created_at = CURRENT_TIMESTAMP
        `).run(hash, kind, String(brief).trim(), spec, getAISettings().model);
        return { spec, briefHash: hash, kind };
    } catch (err) {
        if (signal?.aborted) return { cancelled: true };
        console.error(`Visual author error (${kind}):`, err.message);
        if (err.rawResponse === undefined) err.rawResponse = raw || null;
        throw err;
    }
}

/** Short human label for the task dock, from the brief's Title/Shows line. */
export function visualBriefLabel(kind, brief) {
    const s = String(brief);
    const m = s.match(/^\s*(?:title|shows|scene)\s*:\s*(.+)$/im);
    const t = (m ? m[1] : s).trim().replace(/\s+/g, ' ');
    const label = t || (kind === 'p5' ? 'Simulation' : 'Animation');
    return label.length > 60 ? `${label.slice(0, 57)}…` : label;
}
