import { useEffect, useRef } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNumberFormat } from '../hooks/useNumberFormat';

interface Props {
    /** The raw reasoning text accumulated for one assistant turn. */
    text: string;
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
     * True while this turn is still reasoning and has produced no answer yet —
     * the only difference is the label ("Reasoning…" vs "Reasoning"), because a
     * count that has stopped climbing next to a spinner reads as stuck.
     */
    live?: boolean;
    onToggle: () => void;
}

/**
 * The collapsible "Reasoning" panel above an assistant turn.
 *
 * A thinking model spends most of a long turn's wall clock before its first
 * answer token, and a character count alone tells the reader only that
 * *something* is happening — the trace is the one thing that says WHAT, and on
 * a turn that ends badly it is often the only thing worth reading. Both chat
 * surfaces stream the same `thinkingChunk` frames and the server persists the
 * text with the message, so this is the same panel in both places rather than
 * two that drift: the node tutor had it from the day the repair loop shipped,
 * and the global assistant printed the count and threw the text away.
 *
 * The body is capped and scrolls: a 40,000-character trace is not something to
 * push the conversation off the screen with.
 */
export default function ReasoningPanel({ text, open, live = false, follow = false, onToggle }: Props) {
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
    }, [text, follow, open]);

    if (!text) return null;
    return (
        <div className="mb-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-900/40">
            <button
                type="button"
                onClick={onToggle}
                aria-expanded={open}
                className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition"
            >
                {open ? <ChevronDown className="w-3.5 h-3.5 flex-shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 flex-shrink-0" />}
                <span>
                    {live ? t("Reasoning…") : t("Reasoning")} {t("({{length}} chars)", { length: num(text.length) })}
                </span>
            </button>
            {open && (
                <div ref={bodyRef} className="px-3 pb-2.5 pt-0.5 text-xs text-slate-500 dark:text-slate-400 whitespace-pre-wrap max-h-64 overflow-y-auto overscroll-contain border-t border-slate-200/70 dark:border-slate-700/70">
                    {text}
                </div>
            )}
        </div>
    );
}
