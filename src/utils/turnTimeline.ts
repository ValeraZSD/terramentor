/**
 * One chat turn as the ORDER it happened in: thinking, lookups, more thinking,
 * answer, lookups, more answer.
 *
 * Three fixed blocks — the reasoning panel, then every lookup the turn ran,
 * then the answer — whatever order they happened in, tell a false story about
 * a model that looks things up mid-thought and mid-answer (native tool calls,
 * several rounds), twice over:
 * two thinking passes read as one run-on paragraph ("…Let me search for it.The
 * learner shared…"), and an answer that said "Let me search the library again
 * for files:", searched, and went on "You're right — here are the actual
 * files" was one line with the searches parked above both halves.
 *
 * So the server records WHERE each lookup happened (`AiAction.at`: how much
 * reasoning and how much answer text the turn had produced when the lookup was
 * announced — server/aiTools.js `runToolCalls`) and this cuts the two texts at
 * those places:
 *
 *   - a lookup made before the answer began belongs to the REASONING, and is
 *     drawn inside the reasoning panel at its place (the panel's header counts
 *     them, so a collapsed panel still says what the turn looked up);
 *   - a lookup made after the answer began belongs to the ANSWER, and is drawn
 *     between its paragraphs at that point.
 *
 * A row with no position — every turn stored before positions existed — is
 * `unplaced` and drawn where rows always were (under the reasoning, above the
 * answer), so old conversations render exactly as they did.
 *
 * Pure: no React, no store, so the gate can drive it with the pre-change
 * record beside the new one (tools/assistant-gates.mjs).
 */
import type { AiAction } from '../types';

export type TimelinePart =
    | { kind: 'text'; text: string; key: string }
    | { kind: 'lookups'; actions: AiAction[]; key: string };

export interface TurnTimeline {
    /** Rows with no recorded place, drawn where rows always were. */
    unplaced: AiAction[];
    /** The reasoning, cut where lookups happened while the model was still thinking. */
    reasoning: TimelinePart[];
    /** The rows drawn inside the reasoning — what the panel's header summarises. */
    reasoningLookups: AiAction[];
    /** The answer, cut where lookups happened after it had begun. */
    answer: TimelinePart[];
}

const hasPlace = (a: AiAction | null | undefined): a is AiAction & { at: { reasoning: number; content: number } } =>
    !!a?.at && Number.isFinite(a.at.reasoning) && Number.isFinite(a.at.content);

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(n)));

/** A fence line: ``` or ~~~ opening or closing a code block. */
const FENCE = /^[ \t]*(?:```|~~~)/;

/**
 * Never cut INSIDE a code block: a fence split across two renders is two
 * broken blocks. A position that falls inside an open fence moves forward to
 * the end of its closing line (or the end of the text while it is still
 * arriving).
 */
export function safeCut(text: string, at: number): number {
    const lines = text.slice(0, at).split('\n');
    const open = lines.filter(l => FENCE.test(l)).length % 2 === 1;
    if (!open) return at;
    const re = /^[ \t]*(?:```|~~~)[^\n]*$/gm;
    re.lastIndex = at;
    const m = re.exec(text);
    return m ? Math.min(text.length, m.index + m[0].length) : text.length;
}

/** A segment without the blank lines that the cut left at either end. */
const tidy = (s: string) => s.replace(/^(?:[ \t]*\n)+/, '').replace(/\s+$/, '');

/**
 * Cut `text` at each group's position. Keys are ordinals — the n-th text
 * segment, the n-th group — so a segment keeps its key while the turn streams
 * and a visual inside it is never remounted by a group appearing after it.
 */
function cut(text: string, groups: { at: number; actions: AiAction[] }[], prefix: string): TimelinePart[] {
    const parts: TimelinePart[] = [];
    let from = 0;
    let texts = 0;
    groups.forEach((g, i) => {
        const seg = tidy(text.slice(from, g.at));
        if (seg) parts.push({ kind: 'text', text: seg, key: `${prefix}t${texts++}` });
        parts.push({ kind: 'lookups', actions: g.actions, key: `${prefix}l${i}` });
        from = Math.max(from, g.at);
    });
    const rest = tidy(text.slice(from));
    if (rest) parts.push({ kind: 'text', text: rest, key: `${prefix}t${texts}` });
    return parts;
}

/** Consecutive rows at the same place are one group, in the order they ran. */
function group(placed: { at: number; action: AiAction }[]): { at: number; actions: AiAction[] }[] {
    const sorted = placed
        .map((p, i) => ({ ...p, i }))
        .sort((a, b) => a.at - b.at || a.i - b.i);
    const out: { at: number; actions: AiAction[] }[] = [];
    for (const p of sorted) {
        const last = out[out.length - 1];
        if (last && last.at === p.at) last.actions.push(p.action);
        else out.push({ at: p.at, actions: [p.action] });
    }
    return out;
}

/**
 * @param reasoning the turn's reasoning trace as the client holds it (streamed so far, or stored)
 * @param content the answer text in the SAME coordinates the rows were measured in — the raw
 *        streamed text while streaming, the stored text after (the terminal frame carries both)
 * @param actions the turn's lookup rows
 */
export function splitTurnTimeline({ reasoning, content, actions }: {
    reasoning?: string | null;
    content?: string | null;
    actions?: AiAction[] | null;
}): TurnTimeline {
    const r = typeof reasoning === 'string' ? reasoning : '';
    const c = typeof content === 'string' ? content : '';
    const unplaced: AiAction[] = [];
    const inReasoning: { at: number; action: AiAction }[] = [];
    const inAnswer: { at: number; action: AiAction }[] = [];

    for (const a of actions ?? []) {
        if (!hasPlace(a)) { unplaced.push(a); continue; }
        if (a.at.content > 0) {
            // The answer had begun. While the stream is catching up (a replay
            // that has not delivered the text yet) the row waits at the end.
            if (c) inAnswer.push({ at: safeCut(c, clamp(a.at.content, 0, c.length)), action: a });
            else unplaced.push(a);
        } else if (r) {
            inReasoning.push({ at: clamp(a.at.reasoning, 0, r.length), action: a });
        } else {
            // Before the answer and with no reasoning to sit in (a model that
            // does not think aloud, or one that has not started yet): the rows
            // stand above the answer, as they always did.
            unplaced.push(a);
        }
    }

    return {
        unplaced,
        reasoning: r ? cut(r, group(inReasoning), 'r') : [],
        reasoningLookups: inReasoning.map(p => p.action),
        answer: c ? cut(c, group(inAnswer), 'a') : [],
    };
}

export interface LookupSummaryPart {
    tool: string;
    /** How many times the tool ran. */
    count: number;
    /** What it looked at, once each, in order — a project's name, a document's title. */
    names: string[];
}

/**
 * What a group of rows did, one entry per tool in the order each first ran —
 * the words the reasoning panel's header is built from ("searched the web 2
 * times · looked up VWO Physics"). The sentence is the component's (it is
 * translated); the counting is here.
 */
export function summarizeLookups(actions: AiAction[] | null | undefined): LookupSummaryPart[] {
    const byTool = new Map<string, LookupSummaryPart>();
    for (const a of actions ?? []) {
        if (!a?.tool) continue;
        let part = byTool.get(a.tool);
        if (!part) { part = { tool: a.tool, count: 0, names: [] }; byTool.set(a.tool, part); }
        part.count += 1;
        const name = String(a.label || a.arg || '').trim();
        if (name && !part.names.includes(name)) part.names.push(name);
    }
    return [...byTool.values()];
}
