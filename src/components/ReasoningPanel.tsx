import { useEffect, useRef } from 'react';
import { ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNumberFormat } from '../hooks/useNumberFormat';
import { FOCUS_RING, cx } from './ui/vocabulary';
import type { AiAction } from '../types';
import type { TimelinePart } from '../utils/turnTimeline';
import AiActions, { describeLookups } from './AiActions';

interface Props {
    /** The raw reasoning text accumulated for one assistant turn. */
    text: string;
    /**
     * The same text cut where the model looked something up while it was still
     * thinking (utils/turnTimeline.ts), with those lookups between the pieces.
     * Absent — or holding no lookups — the text is drawn whole, as it always was.
     */
    parts?: TimelinePart[];
    /** The lookups drawn inside, which the header names even when it is folded shut. */
    lookups?: AiAction[];
    /** Whether the body is expanded. Missing state means collapsed. */
    open: boolean;
    /**
     * Keep the tail in view as the text grows.
     *
     * Only for a turn that is still being generated: an open panel showing the
     * first screenful, frozen, while a counter climbs above it is the picture
     * of something stuck — which is the complaint this panel exists to answer.
     * It follows only while the reader is already AT the bottom, so scrolling
     * back to re-read a line is not undone by the next delta.
     */
    follow?: boolean;
    /**
     * True while this turn is still reasoning and has produced no answer yet:
     * the label reads "Reasoning…" with its climbing character count; once the
     * answer has begun it is plain "Reasoning", because a count that has
     * stopped climbing reads as stuck, and on a finished turn as jargon.
     */
    live?: boolean;
    onToggle: () => void;
}

/** Blank lines off both ends; an indented first line keeps its indent. */
const trimLines = (s: string) => s.replace(/^\s*\n/, '').trimEnd();

/**
 * The collapsible "Reasoning" panel above an assistant turn.
 *
 * A thinking model spends most of a long turn's wall clock before its first
 * answer token, and a character count alone tells the reader only that
 * *something* is happening — the trace is the one thing that says WHAT, and on
 * a turn that ends badly it is often the only thing worth reading. Both chat
 * surfaces stream the same `thinkingChunk` frames and the server persists the
 * text with the message, so this is the same panel in both places rather than
 * two that drift.
 *
 * What the model LOOKED UP while it was thinking is part of the thinking: the
 * rows sit between the passes they separate, and the header says in words
 * what they did ("Reasoning · searched the web 2 times · looked up
 * “Wave physics”"), because the panel folds itself shut once the answer starts
 * and a closed panel must not hide that the turn went and looked.
 *
 * The body is capped and scrolls: a 40,000-character trace is not something to
 * push the conversation off the screen with.
 */
export default function ReasoningPanel({ text, parts, lookups, open, live = false, follow = false, onToggle }: Props) {
    const { t } = useTranslation();
    const num = useNumberFormat();
    const bodyRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const el = bodyRef.current;
        if (!el || !follow) return;
        // "Already at the bottom" with a tolerance, because the box is only
        // ever a few hundred pixels and a delta can land mid-scroll.
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        if (atBottom) el.scrollTop = el.scrollHeight;
    }, [text, parts, follow, open]);

    if (!text) return null;
    const phrases = describeLookups(lookups, t);
    const timeline = parts && parts.some(p => p.kind === 'lookups') ? parts : null;
    // A plain line, the way prose behind a name is everywhere else
    // (`Explain`, ui/Disclosure.tsx): no box around the turn's thinking; the
    // chevron turns, and the opened text hangs off a hairline under it.
    return (
        <div className="mb-2">
            <button
                type="button"
                data-disclosure="reasoning"
                onClick={onToggle}
                aria-expanded={open}
                className={cx(
                    // A finger's 44px on a touch screen, as `Explain` has.
                    'flex w-full items-start touch:items-center touch:min-h-11 gap-1.5 rounded -mx-2 px-2 py-1.5 text-left text-xs',
                    'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors',
                    FOCUS_RING,
                )}
            >
                <ChevronRight
                    className={cx('w-3.5 h-3.5 mt-px shrink-0 transition-transform duration-200 ease-out motion-reduce:transition-none', open && 'rotate-90')}
                    aria-hidden="true"
                />
                <span className="min-w-0">
                    {/* The count only while it climbs: then it says the turn is
                        alive; on a finished turn it is a number nobody reads. */}
                    {live ? `${t("Reasoning…")} ${t("({{length}} chars)", { count: text.length, length: num(text.length) })}` : t("Reasoning")}
                    {phrases.map(p => (
                        <span key={p}>{' · '}{p}</span>
                    ))}
                </span>
            </button>
            {open && (
                <div ref={bodyRef} className="list-scroll mt-0.5 ml-1.5 border-l-2 border-slate-300 dark:border-slate-600 pl-3 pr-1 py-1 text-xs text-slate-500 dark:text-slate-400 max-h-64 overflow-y-auto overscroll-contain">
                    {/* Trimmed for display: a trace usually ends in blank
                        lines, which pre-wrap draws, and the hairline then
                        runs on past the words. */}
                    {timeline ? (
                        <div className="space-y-2 pt-1.5">
                            {timeline.map(p => p.kind === 'lookups'
                                ? <AiActions key={p.key} actions={p.actions} compact />
                                : <p key={p.key} className="whitespace-pre-wrap">{trimLines(p.text)}</p>)}
                        </div>
                    ) : (
                        <div className="whitespace-pre-wrap">{trimLines(text)}</div>
                    )}
                </div>
            )}
        </div>
    );
}
