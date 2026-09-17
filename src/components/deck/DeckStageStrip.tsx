import { useRef } from 'react';
import type { DeckStage } from '../../types';
import { useElementWidth } from '../../hooks/useElementWidth';
import { StateBar } from './DeckProgress';
import { MIN_SEGMENT, blockFloor, stripGap } from './deckFigure';
import { fmt } from './deckPalette';
import { useTranslation } from 'react-i18next';

/**
 * The whole ladder as one bar, each stage as wide as it is big.
 *
 * The stage list answers "what is in stage 12". Nothing answered the question
 * you ask first, which is *what shape am I in* — and on a deck whose stages are
 * called "Stage 1" through "Stage 30" the list cannot, because thirty rows of
 * identical grey with identical titles is a table of contents, not a picture.
 *
 * Two decisions carry it:
 *
 *  * **Width is card count, not one slot per stage.** An imported deck rarely
 *    cuts evenly — one real frequency deck's six sections run from 103
 *    cards to 2,004 — so equal slots would draw a deck that is 4% studied as
 *    one-third green. Sized by cards, the bar and the deck agree.
 *  * **Each block is filled by its OWN four states**, on the same palette as
 *    the totals bar above it, so the same colour means the same thing in both
 *    and the eye can carry one reading down the page.
 *
 * Blocks are real buttons that jump to the stage's row, but they are a *second*
 * route to it and often narrower than a finger: the list underneath is the
 * accessible, hit-target-sized twin, the same arrangement the atlas canvas has
 * with its region list.
 */
export default function DeckStageStrip({ stages, currentStageId, onSelect }: {
    stages: DeckStage[];
    currentStageId: number | null;
    onSelect: (stage: DeckStage) => void;
}) {
    const { t } = useTranslation();
    const ref = useRef<HTMLDivElement>(null);
    const width = useElementWidth(ref);
    if (stages.length < 2) return null;

    const gap = stripGap(width, stages.length);
    // A stage worth 2 cards of 521 is 4px of the strip and half of that is its
    // green — a 2px sliver with a 2px corner radius eaten off each end, i.e.
    // nothing. Measured on a real maths deck, which is exactly the case
    // this has to answer: "2 met" must be visible or the strip is lying about
    // the one thing it is for. So a block gets a floor and a state segment
    // inside it gets a floor, and both are clamped against the real width so
    // sixty stages on a phone still fit instead of overflowing the card.
    const minBlock = blockFloor(width, stages.length, gap);

    return (
        <div className="mb-4">
            <div ref={ref} className="flex h-6 w-full" style={{ gap }}>
                {stages.map(stage => {
                    const isCurrent = stage.nodeId === currentStageId;
                    const label = `${stage.title}: ${fmt(stage.seen)} of ${fmt(stage.cards)} cards met`
                        + (stage.due > 0 ? `, ${fmt(stage.due)} due` : '');
                    return (
                        <button
                            key={stage.nodeId}
                            type="button"
                            onClick={() => onSelect(stage)}
                            title={label}
                            aria-label={isCurrent ? t("{{label}} — you are here", { label }) : label}
                            aria-current={isCurrent ? 'true' : undefined}
                            style={{ flex: `${stage.cards} 1 0`, minWidth: minBlock }}
                            className="group flex h-full min-w-0 flex-col gap-1 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-accent"
                        >
                            {/* Where you are, marked ABOVE the block rather than
                                as a ring around it: a 2px inset ring on a block
                                fourteen pixels wide is most of the block, so it
                                reads as a colour change in the thing it is
                                supposed to be pointing at. */}
                            <span
                                className={`h-1 w-full shrink-0 rounded-full ${isCurrent ? 'bg-accent' : 'bg-transparent'}`}
                                aria-hidden="true"
                            />
                            <span className="min-h-0 flex-1 overflow-hidden rounded-sm ring-inset group-hover:ring-2 group-hover:ring-slate-500 dark:group-hover:ring-white/70">
                                <StateBar
                                    states={stage.states}
                                    height="h-full"
                                    rounded="rounded-none"
                                    minSegment={Math.min(MIN_SEGMENT, minBlock)}
                                    bare
                                />
                            </span>
                        </button>
                    );
                })}
            </div>
            <p className="mt-1.5 text-[11px] text-slate-500 dark:text-slate-400">
                {t("Every section of the deck, each as wide as the number of cards it holds. Pick one to jump to it.")}
            </p>
        </div>
    );
}
