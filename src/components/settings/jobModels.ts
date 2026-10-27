import type { AIJobEntry } from '../../api';

/**
 * The decisions behind Settings → "Which model does each job", kept out of the
 * component so `tools/ai-jobs-gates.mjs` can run them: which jobs exist, when a
 * list may be saved, what a new place starts as, and which server answer is
 * allowed to land on the screen.
 */

/** Mirrors `AI_JOBS` in server/aiJobs.js; the gate holds the two equal. */
export const JOB_IDS = ['conversation', 'courses', 'questions', 'checks', 'vision', 'small'] as const;

/** What the client knows of a connection: its id and its saved model. */
export interface ConnLike { id: number; model: string }
type ById = Map<number, ConnLike>;

/** A place's connection and the model it really runs: '' is the connection's
 *  saved model, so "its saved model" and that model typed out are one model. */
export const entryKey = (e: AIJobEntry, byId: ById) =>
    `${e.connectionId}\u0000${e.model.trim() || (e.connectionId != null ? byId.get(e.connectionId)?.model ?? '' : '')}`;

/** Why a list cannot be saved yet: a removed connection on it, or one model twice. */
export function listProblem(list: AIJobEntry[], byId: ById): '' | 'removed' | 'duplicate' {
    if (list.some(e => e.connectionId == null)) return 'removed';
    if (new Set(list.map(e => entryKey(e, byId))).size !== list.length) return 'duplicate';
    return '';
}

/**
 * A new place: a connection whose saved model is not on the list yet, else the
 * first connection's saved model. That second case is a copy, which the screen
 * asks the learner to change before it saves: picking some other model from
 * the provider's list would be choosing one for them, and it may cost more.
 */
export function freshEntry(list: AIJobEntry[], conns: ConnLike[], byId: ById): AIJobEntry {
    const used = new Set(list.map(e => entryKey(e, byId)));
    const free = conns.find(c => !used.has(`${c.id}\u0000${c.model}`));
    return { connectionId: (free ?? conns[0])?.id ?? null, model: '', effort: '' };
}

/** The same list, place for place. */
export const sameList = (a: AIJobEntry[] = [], b: AIJobEntry[] = []) =>
    a.length === b.length && a.every((e, i) => e.connectionId === b[i].connectionId
        && e.model === b[i].model && e.effort === b[i].effort);

/**
 * Fresh routes from the server, merged into what is on screen: a list the
 * learner is mid-way through (it differs from what was saved) is kept.
 */
export function mergeLoaded(
    savedBefore: Record<string, AIJobEntry[]>,
    drafts: Record<string, AIJobEntry[]>,
    loaded: Record<string, AIJobEntry[]>,
): Record<string, AIJobEntry[]> {
    const out: Record<string, AIJobEntry[]> = { ...loaded };
    for (const [job, d] of Object.entries(drafts)) {
        if (!sameList(d, savedBefore[job])) out[job] = d;
    }
    return out;
}

/**
 * A save's answer, applied to what is on screen: the job's list takes the
 * server's form only while the screen still shows what was sent. A slow answer
 * to an earlier save never puts back a list the learner has since changed.
 */
export function acceptSaved(
    drafts: Record<string, AIJobEntry[]>,
    job: string,
    sent: AIJobEntry[],
    routes: Record<string, AIJobEntry[]>,
): Record<string, AIJobEntry[]> {
    const shown = (drafts[job] ?? []).map(e => ({ ...e, model: e.model.trim() }));
    return sameList(shown, sent) ? { ...drafts, [job]: routes[job] ?? [] } : drafts;
}
