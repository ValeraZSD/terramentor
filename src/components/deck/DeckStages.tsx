import { useEffect, useMemo, useRef, useState } from 'react';
import { Play, Search, ChevronDown, Check } from 'lucide-react';
import type { DeckStage } from '../../types';
import DeckProgress from './DeckProgress';
import DeckStageStrip from './DeckStageStrip';
import { fmt } from './deckPalette';
import { useTranslation } from 'react-i18next';

interface Props {
    stages: DeckStage[];
    currentStageId: number | null;
    onStudy: (stage: DeckStage) => void;
    onOpen: (stage: DeckStage) => void;
}

const PAGE = 12;

/**
 * Where you are in the deck.
 *
 * The tree used to answer this with one category card reading "No items yet".
 * Now an import cuts the deck into stages in its own order (see
 * server/deckStructure.js), and this is the ladder those stages make: what is in
 * each, how much of it has been met, and one button to work on it.
 *
 * Three rules earned from the project-10 tree, which is the same list done
 * badly:
 *
 *  * **No nested scroll region.** That tree put every category's children in a
 *    `max-h-80 overflow-auto` box: measured at 412x686 on the real Japanese
 *    project, eleven separate 319px scroll areas inside a page that was itself
 *    ten screens long. On a touch screen the browser has to guess which of the
 *    two a drag meant, and near the boundary it guesses wrong. This list grows
 *    the page instead, and pages itself.
 *  * **Show the part that is live, not all of it.** Thirty stages is a wall;
 *    twelve plus "show more" is a list. The stage the learner is actually on is
 *    always in the first page, whatever its index, because "carry on from here"
 *    must never require scrolling or searching.
 *  * **Filter, don't hide.** A search box narrows the list; it does not remove
 *    the counts above it, which stay true of the whole deck.
 */
export default function DeckStages({ stages, currentStageId, onStudy, onOpen }: Props) {
    const { t: tr } = useTranslation();
    const [query, setQuery] = useState('');
    const [expanded, setExpanded] = useState(false);
    const [jumpTo, setJumpTo] = useState<number | null>(null);
    const listRef = useRef<HTMLUListElement>(null);

    // Picking a block on the strip has to reach a row that may be on page three
    // and may not be rendered yet, so the expand and the scroll are two steps:
    // expand now, scroll once the row exists. `block: 'center'` rather than
    // 'nearest' for the reason the atlas region list learned — the row is about
    // to be highlighted, and 'nearest' parks a row below the fold at the very
    // bottom edge, where the thing you asked to see is the thing half off it.
    useEffect(() => {
        if (jumpTo == null) return;
        const el = listRef.current?.querySelector<HTMLElement>(`[data-stage-id="${jumpTo}"]`);
        // Instant, not smooth: measured in the preview browser, a smooth
        // scroll inside this container is a silent no-op (an instant one on the
        // same element moves it 2,766px), so the jump would land nowhere and
        // look like a dead control. The ring below says where you arrived.
        el?.scrollIntoView({ block: 'center' });
        const t = setTimeout(() => setJumpTo(null), 2000);
        return () => clearTimeout(t);
    }, [jumpTo, expanded]);

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return stages;
        return stages.filter(s =>
            s.title.toLowerCase().includes(q) ||
            (s.parentTitle ?? '').toLowerCase().includes(q) ||
            s.description.toLowerCase().includes(q));
    }, [stages, query]);

    const visible = useMemo(() => {
        if (expanded || query.trim() || filtered.length <= PAGE) return filtered;
        const head = filtered.slice(0, PAGE);
        // The current stage is pulled into view rather than being left on page
        // three: it is the one row this list exists to show.
        if (currentStageId != null && !head.some(s => s.nodeId === currentStageId)) {
            const cur = filtered.find(s => s.nodeId === currentStageId);
            if (cur) return [...head.slice(0, PAGE - 1), cur];
        }
        return head;
    }, [filtered, expanded, query, currentStageId]);

    const hidden = filtered.length - visible.length;

    return (
        <div>
            <DeckStageStrip
                stages={stages}
                currentStageId={currentStageId}
                onSelect={stage => { setQuery(''); setExpanded(true); setJumpTo(stage.nodeId); }}
            />

            {stages.length > PAGE && (
                <div className="relative mb-3">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
                    <input
                        value={query}
                        onChange={e => setQuery(e.target.value)}
                        placeholder={tr("Find a section in {{fmt}}…", { fmt: fmt(stages.length) })}
                        aria-label={tr("Filter sections")}
                        className="w-full rounded-xl border border-slate-300 bg-white py-2 pl-9 pr-3 text-sm text-slate-900 placeholder:text-slate-400 focus:ring-2 focus:ring-accent dark:border-slate-600 dark:bg-slate-700 dark:text-white"
                    />
                </div>
            )}

            <ul ref={listRef} className="space-y-2">
                {visible.map(stage => {
                    const done = stage.newCards === 0 && stage.due === 0;
                    const isCurrent = stage.nodeId === currentStageId;
                    const jumped = stage.nodeId === jumpTo;
                    return (
                        <li key={stage.nodeId} data-stage-id={stage.nodeId}>
                            <div className={`flex items-center gap-3 rounded-xl border p-3 transition-colors ${isCurrent
                                ? 'border-accent/50 bg-accent/5'
                                : 'border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-800'} ${jumped ? 'ring-2 ring-accent/70' : ''}`}>
                                <button
                                    onClick={() => onOpen(stage)}
                                    className="min-w-0 flex-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent/70 rounded-lg"
                                >
                                    <div className="flex items-center gap-2">
                                        <span className="truncate font-medium text-slate-900 dark:text-white">
                                            {stage.title}
                                        </span>
                                        {stage.parentTitle && (
                                            <span className="hidden truncate text-xs text-slate-500 dark:text-slate-400 sm:inline">
                                                {stage.parentTitle}
                                            </span>
                                        )}
                                        {isCurrent && (
                                            <span className="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-[11px] font-semibold text-accent-fg">
                                                {tr("You are here")}
                                            </span>
                                        )}
                                        {done && !isCurrent && (
                                            <Check className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-label={tr("Nothing outstanding")} />
                                        )}
                                    </div>

                                    {/* One tick per card where the stage is small
                                        enough for that to be readable, the four
                                        states stacked where it is not. The old
                                        two-layer green track said how far along
                                        the stage was and nothing about what kind
                                        of work is left: "50 met" with none of
                                        them holding is a very different stage
                                        from one where forty are, and on a deck
                                        of "Stage 1..30" that difference is the
                                        only thing distinguishing the rows. */}
                                    <div className="mt-2">
                                        <DeckProgress
                                            map={stage.map}
                                            states={stage.states}
                                            height="h-2"
                                            label={tr("{{title}}: {{fmt}} of {{fmt2}} cards met", { count: stage.cards, title: stage.title, fmt: fmt(stage.seen), fmt2: fmt(stage.cards) })}
                                        />
                                    </div>

                                    <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                                        {tr("{{fmt}}/{{fmt2}} met", { fmt: fmt(stage.seen), fmt2: fmt(stage.cards) })}
                                        {stage.mature > 0 && tr("· {{fmt}} mature", { fmt: fmt(stage.mature) })}
                                        {stage.due > 0 && <span className="text-accent-fg font-medium"> {tr("· {{fmt}} due", { fmt: fmt(stage.due) })}</span>}
                                        {stage.newCards > 0 && tr("· {{fmt}} new", { fmt: fmt(stage.newCards) })}
                                    </p>
                                </button>

                                <button
                                    onClick={() => onStudy(stage)}
                                    disabled={stage.cards === 0}
                                    aria-label={tr("Study {{title}}", { title: stage.title })}
                                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent text-white transition hover:bg-accent/90 disabled:opacity-40"
                                >
                                    <Play className="h-4 w-4" />
                                </button>
                            </div>
                        </li>
                    );
                })}
            </ul>

            {hidden > 0 && (
                <button
                    onClick={() => setExpanded(true)}
                    className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-xl border border-slate-200 py-2.5 text-sm font-medium text-slate-600 transition hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-700/50"
                >
                    <ChevronDown className="h-4 w-4" />
                    {tr("Show {{fmt}} more sections", { count: hidden, fmt: fmt(hidden) })}
                </button>
            )}

            {filtered.length === 0 && (
                <p className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">
                    {tr("No section matches “{{query}}”.", { query })}
                </p>
            )}
        </div>
    );
}
