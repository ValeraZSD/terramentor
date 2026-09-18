import type { VisualContext } from './registry';
import { api } from '../../api';
import i18n from '../../i18n';
import { num } from '../../utils/numberFormat';

/**
 * Turn a SCENE BRIEF into a finished spec, or pass a finished spec straight
 * through.
 *
 * The client half of the specialist pass (server/visualAuthor.js). ```animation
 * and ```p5 are the two kinds a conversational model gets wrong while it is
 * also writing a teaching reply, so the model may now describe the scene in
 * plain words and a second call — carrying the full rendering rules for that
 * one kind — draws it.
 *
 * WHICH ONE IT IS, IS DECIDED BY LOOKING. There is no flag and no version
 * marker: an `<svg` or a `function setup(` is unambiguous, so every animation
 * already sitting in `feed_items` or in an old chat message still renders
 * directly and costs nothing. The mirror of this test lives in
 * `isVisualBrief` (server/visualAuthor.js) — the pre-generator has to agree
 * with the renderer about what needs building, or the feed would pre-build
 * nothing and every card would ask the learner to press a button.
 *
 * The ambiguous case is treated as a brief on purpose: a wrong call that way
 * costs one model call, while the other way would send a finished scene to be
 * rewritten from scratch.
 */

/** Kinds the specialist pass authors. Mirrors VISUAL_BRIEF_KINDS on the server. */
const BRIEF_KINDS: ReadonlySet<string> = new Set(['animation', 'p5']);

export function isVisualBrief(kind: string, code: string): boolean {
    const text = code.trim();
    if (!text || !BRIEF_KINDS.has(kind)) return false;
    if (kind === 'animation') return !/<svg[\s>]/i.test(text);
    if (kind === 'p5') return !/\bfunction\s+(setup|draw)\s*\(/.test(text);
    return false;
}

/** Map authoring-task lifecycle events onto the shell's one-line status footer. */
function progressReporter(onProgress?: (message: string) => void) {
    return (evt: { status?: string; queuePosition?: number | null; thinking?: number; progress?: number }) => {
        if (!onProgress) return;
        if (evt.status === 'queued') {
            onProgress(evt.queuePosition
                ? i18n.t("Drawing queued (#{{position}}) — starts when the current AI task finishes…", { position: evt.queuePosition + 1 })
                : i18n.t("Drawing queued — starts when the current AI task finishes…"));
        } else if (evt.status === 'running') {
            onProgress(i18n.t("Drawing…"));
        }
        if (typeof evt.thinking === 'number') onProgress(i18n.t("Planning the scene… {{chars}} chars of reasoning", { chars: num(evt.thinking) }));
        if (typeof evt.progress === 'number') onProgress(i18n.t("Drawing… {{chars}} chars", { chars: num(evt.progress) }));
    };
}

/**
 * A brief that has NOT been drawn and may not be drawn without asking.
 *
 * Not a failure: nothing is wrong with the block, it is simply a description
 * waiting for its one model call. Thrown as an ordinary Error it draws as an
 * amber "Couldn't render this animation" — an error card over the most normal
 * state a brief can be in (every brief passes through it while the reply is
 * still streaming) — so the shell tells this apart from a real render failure
 * by the class, and shows an offer instead of a warning.
 */
export class VisualUndrawnError extends Error {
    readonly undrawn = true;
    constructor(kind: string) {
        super(`this ${kind === 'p5' ? 'simulation' : 'animation'} is described in words and has not been drawn yet.`);
        this.name = 'VisualUndrawnError';
    }
}

export function isUndrawnError(e: unknown): e is VisualUndrawnError {
    return e instanceof Error && (e as { undrawn?: boolean }).undrawn === true;
}

/**
 * The spec to render for this block.
 *
 * A finished spec is returned unchanged. A brief is looked up in the cache
 * first — free, and what makes a re-opened message render instantly — and only
 * then authored, and only when `ctx.autoBuild` says an expensive call is
 * allowed without asking. Where it is not (a message re-read from history, or a
 * feed card whose pre-build never ran), this throws `VisualUndrawnError`, which
 * the shell shows as a "Draw it" offer rather than silently spending a model
 * call behind the learner's back. That is the same consent rule the widget
 * uses; it is the whole reason a re-opened chat is free.
 */
export async function resolveVisualSpec(kind: string, code: string, ctx: VisualContext): Promise<string> {
    const text = code.trim();
    if (!isVisualBrief(kind, text)) return text;

    const cached = await api.authorVisual(kind, text, { cacheOnly: true }, undefined, ctx.signal);
    if (cached.spec) return cached.spec;

    if (!ctx.autoBuild) throw new VisualUndrawnError(kind);

    ctx.onProgress?.(i18n.t("Drawing…"));
    const { spec } = await api.authorVisual(kind, text, {}, progressReporter(ctx.onProgress), ctx.signal);
    return spec;
}
