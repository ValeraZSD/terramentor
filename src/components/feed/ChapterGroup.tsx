import { CSSProperties, ReactNode } from 'react';
import { useAccentVars } from '../../hooks/useAccentVars';
import { ArrowUpRight } from 'lucide-react';
import ExternalSearchButton from '../ExternalSearchButton';
import TransferBanner from './TransferBanner';
import { TransferInfo } from '../../types';
import { useTranslation } from 'react-i18next';

interface Props {
    /** Project colour — re-points the accent vars for the whole chapter. */
    projectColor?: string | null;
    projectName?: string | null;
    /** Which project this chapter belongs to — the feed spans all of them, so
     *  the store's "current project" is null here and can't supply it. */
    projectId?: number | null;
    nodeTitle: string;
    /** True when an earlier chapter in this feed already covered the same topic. */
    continued?: boolean;
    onOpenNode?: () => void;
    /**
     * "You proved this elsewhere" — belongs to the chapter, not to a card,
     * because the topic is the thing that was already covered. Rendered under
     * the header so it is the first thing read, before the lesson it offers to
     * skip.
     */
    transfer?: TransferInfo | null;
    nodeId?: number;
    gateMode?: 'off' | 'advisory' | 'enforced';
    children: ReactNode;
}

/**
 * A chapter: every consecutive feed card for the same topic, under ONE header.
 *
 * The feed used to render each part, question and checkpoint as a standalone
 * card, so a four-part topic repeated the project name and the topic title five
 * times — the reader had to re-establish "am I still in the same thing?" at
 * every scroll. A chapter states the topic once, at the top, and the parts
 * inside flow as continuous prose separated by hairlines.
 *
 * The header is deliberately NOT sticky. A running header sounds right for a
 * book but reads as a glitch here: it parks itself in the middle of the prose,
 * translucent, with the part heading sliding underneath. The topic is one scroll
 * up if you need it.
 */
export default function ChapterGroup({
    projectColor, projectName, projectId, nodeTitle, continued = false, onOpenNode,
    transfer = null, nodeId, gateMode, children,
}: Props) {
    const { t } = useTranslation();
    const accentStyle = useAccentVars(projectColor);

    // The project rail is ONE device in the feed and has to be drawn one way:
    // the card's own LEFT BORDER, 4px against the other three at 1px. A border
    // follows `rounded-2xl`, so the colour sweeps around the top-left and
    // bottom-left arcs and thins out where it meets the hairline — the rail
    // turns the corner instead of being cut off by it. Defined here and in
    // `FeedCardShell`, nowhere else. Two things it must not become, both tried:
    // an absolute `inset-y-0 w-1` strip clipped by `overflow-hidden` (full
    // height, but the radius CUTS it — a flat end, no wrap), and a strip held
    // clear of the corners with `top-4 bottom-4` (square ends and short).
    // The colour is set INLINE because the class form loses the cascade:
    // `dark:border-slate-700` sets `border-color` for all four sides at
    // specificity (0,2,0) and beats a plain `border-l-accent`, which turned the
    // rail grey in dark mode.
    const railStyle = { ...(accentStyle ?? {}), borderLeftColor: 'rgb(var(--accent-rgb))' } as CSSProperties;

    return (
        <section
            style={railStyle}
            aria-label={nodeTitle}
            className="relative overflow-hidden rounded-2xl border border-l-4 border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 shadow-sm"
        >
            <header className="flex items-center justify-between gap-3 px-4 sm:px-6 py-3 rounded-t-2xl border-b border-slate-100 dark:border-slate-700/70">
                {/* `truncate` on a card's own title assumes one line is always
                    enough. At a large UI scale it is not: measured at 160% this
                    column got 165px for a title needing 406, i.e. "Doppler
                    Eff…" — the reader is told which project and nothing about
                    which topic. A heading in a card has vertical room it does
                    not have horizontal room, so the title wraps (capped at two
                    lines) and only the project line above it still truncates. */}
                <div className="min-w-0 flex-1">
                    {projectName && (
                        <p className="text-[11px] font-medium text-slate-500 dark:text-slate-400 truncate">
                            {projectName}
                        </p>
                    )}
                    <h2 className="text-base sm:text-lg font-semibold text-slate-900 dark:text-white line-clamp-2 break-words">
                        {nodeTitle}
                        {continued && (
                            <span className="ml-2 text-xs font-normal text-slate-500 dark:text-slate-400">{t("continued")}</span>
                        )}
                    </h2>
                </div>
                <div className="flex items-center shrink-0 -mr-1">
                    {/* Video explanations of the same topic, one tap away — the
                        detour the reader was making by hand (copy title → switch
                        app → paste into YouTube), which ended the session. */}
                    <ExternalSearchButton title={nodeTitle} context={projectName} projectId={projectId} variant="icon" />
                    {onOpenNode && (
                        <button
                            onClick={onOpenNode}
                            title={t("Open this topic")}
                            aria-label={t("Open {{nodeTitle}}", { nodeTitle })}
                            className="shrink-0 p-2 rounded-lg text-slate-500 dark:text-slate-400 hover:text-accent-fg hover:bg-accent/10 transition"
                        >
                            <ArrowUpRight className="w-4 h-4" />
                        </button>
                    )}
                </div>
            </header>
            {/* Only on the chapter that opens the topic — a "continued" chapter
                is the same head start a scroll further down, and repeating the
                offer there would read as a second, different one. */}
            {transfer && nodeId != null && projectId != null && !continued && (
                <TransferBanner
                    transfer={transfer}
                    nodeId={nodeId}
                    nodeTitle={nodeTitle}
                    projectId={projectId}
                    gateMode={gateMode}
                />
            )}
            <div className="px-4 sm:px-6">{children}</div>
        </section>
    );
}

/**
 * One item inside a chapter (a lesson part, a question, the checkpoint). Keeps
 * the focus target + scroll anchor that FeedView's advance-to-next needs, and
 * separates itself from the previous item with a hairline instead of a whole
 * new card. The scroll margin clears the feed's sticky strip (`--feed-top`,
 * measured by FeedView) so an advanced-to section never lands under it.
 */
export function ChapterSection({ innerRef, children }: {
    innerRef: (el: HTMLElement | null) => void;
    children: ReactNode;
}) {
    return (
        <div
            ref={innerRef}
            tabIndex={-1}
            style={{ scrollMarginTop: 'calc(var(--feed-top, 0px) + 1rem)' }}
            className="outline-none py-5 border-t border-slate-100 dark:border-slate-700/60 first:border-t-0 first:pt-4"
        >
            {children}
        </div>
    );
}
