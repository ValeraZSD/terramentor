/**
 * What the app knows about a model from its NAME alone — size class, tier,
 * ordering, filtering.
 *
 * Lifted out of `Settings.tsx` when the four separate model pickers became one
 * `ModelPicker`: the tier badge, the size sort and the "qwen 32" filter were
 * written for the chat-model list and were unreachable from the three other
 * places a model is chosen (vision, region naming, embeddings), which is why
 * those three were a bare `<input>` or a `<select>` with nothing to say about
 * what you were choosing.
 */
import { k } from '../i18n';
import type { OllamaModel } from '../api';

export type TierTone = 'poor' | 'workable' | 'good';

export interface ModelTier {
    id: string;
    label: string;
    range: string;
    /** Inclusive lower bound, billions of TOTAL parameters (MoE counts the total). */
    minB: number;
    detail: string;
    tone: TierTone;
}

export const MODEL_TIERS: ModelTier[] = [
    {
        id: 'small',
        label: k("Below the floor"),
        range: 'under 9B',
        minB: 0,
        detail: 'Small models do not teach well. Lessons and questions are rejected by the quality gates often enough that topics arrive without a question, and the advanced visual kinds stay switched off. Fine for answer-checking and summaries; not for authoring.',
        tone: 'poor',
    },
    {
        id: 'floor',
        label: k("Workable floor"),
        range: '9B – 24B',
        minB: 9,
        detail: 'Everything runs. Expect some rejected drafts and the occasional weak question. This is the smallest size worth teaching from.',
        tone: 'workable',
    },
    {
        id: 'good',
        label: k("Recommended"),
        range: '25B and up',
        minB: 25,
        detail: "Around 30B is where this app's jobs stop being a stretch: curriculum generation, multi-part lessons and the answer-key verifier are reliably correct. Whether that model runs on your machine or an endpoint you pay for makes no difference to this list — only its size class does.",
        tone: 'good',
    },
];

/** The tier's colour as a 6px dot — a legend on an otherwise neutral row. */
export const TIER_DOT: Record<TierTone, string> = {
    poor: 'bg-amber-500',
    workable: 'bg-slate-400 dark:bg-slate-500',
    good: 'bg-emerald-500',
};

/** The tier as a small tinted pill, for the badge beside a model's name. */
export const TIER_TONE: Record<TierTone, string> = {
    poor: 'bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-300 border-amber-200 dark:border-amber-800/60',
    workable: 'bg-slate-100 dark:bg-slate-700/40 text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-600',
    good: 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-800 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800/60',
};

/**
 * Parameter count in billions parsed out of a model's own name — the mirror of
 * `modelParamsB` in `server/ai.js`, and it fails the same way on purpose:
 * a hosted or aliased id ("...:cloud", an llama-swap alias, any OpenAI-compatible
 * endpoint) carries no number, so this returns null and NO tier is claimed.
 * Guessing a size from a name we cannot read is how the visual gate used to
 * deny capable models, and a wrong badge is worse than no badge.
 */
export function modelParamsB(name: string): number | null {
    const s = String(name || '').toLowerCase();
    const moe = s.match(/(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)\s*b/);
    if (moe) return parseFloat(moe[1]) * parseFloat(moe[2]);
    const m = s.match(/(\d+(?:\.\d+)?)\s*b(?![a-z])/);
    return m ? parseFloat(m[1]) : null;
}

/** The tier a model falls in, or null when its size cannot be read from its name. */
export function tierForModel(name: string): ModelTier | null {
    const b = modelParamsB(name);
    if (b === null) return null;
    let hit = MODEL_TIERS[0];
    for (const t of MODEL_TIERS) if (b >= t.minB) hit = t;
    return hit;
}

/**
 * How the model list is ordered.
 *
 * `size` and `date` are only meaningful for a provider that reports them:
 * Ollama gives both, while an OpenAI-compatible `/v1/models` gives no size at
 * all and often no creation date either. Rather than offer a sort that silently
 * does nothing, the control hides the orders the current list cannot honour —
 * an inert control is worse than a missing one, because the user concludes the
 * list is wrong rather than that the data is absent.
 */
export type ModelSort = 'name' | 'size' | 'date';

export const MODEL_SORTS: { id: ModelSort; label: string }[] = [
    { id: 'name', label: k("Name") },
    { id: 'size', label: k("Size") },
    { id: 'date', label: k("Newest") },
];

export function sortModels(list: OllamaModel[], by: ModelSort): OllamaModel[] {
    const out = [...list];
    if (by === 'size') return out.sort((a, b) => (b.size || 0) - (a.size || 0));
    if (by === 'date') return out.sort((a, b) =>
        String(b.modified_at || '').localeCompare(String(a.modified_at || '')));
    // `numeric` so qwen3-8b sorts before qwen3-32b rather than after it.
    return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/** Every whitespace-separated term must appear somewhere in the name, so
 *  "qwen 32" finds `qwen3-32b-instruct` without demanding the exact string. */
export function filterModels(list: OllamaModel[], query: string): OllamaModel[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return list;
    return list.filter(m => terms.every(t => m.name.toLowerCase().includes(t)));
}

/** Human size for a model blob. Two decimals is noise above a gigabyte. */
export function formatModelSize(bytes: number): string {
    if (!bytes) return '';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    const n = bytes / Math.pow(1024, i);
    return `${n >= 100 || i < 2 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}
