import { useStore } from '../../store';
import Markdown from '../Markdown';
import { FlashcardDrillLauncher } from '../drills/DrillLauncher';
import { FeedLessonCard } from '../../types';
import { ArrowDown, CheckCircle2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface Props {
    card: FeedLessonCard;
    done: boolean;
    onDone: (key: string) => void;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * Split the lesson's own leading heading off its body.
 *
 * The generator emits the part title as an H1/H2 at the top of the markdown AND
 * reports it as `partTitle`, so the old card printed it twice ("Part 3 of 4 ·
 * Frequency and Period Explained" directly above a "Frequency and Period
 * Explained" heading). One heading per part: the leading heading is dropped when
 * it restates `partTitle`, and promoted to the section heading when there is no
 * `partTitle` to begin with. A heading that says something *different* is real
 * content and stays in the body.
 */
export function splitLessonHeading(markdown: string, partTitle: string | null): {
    heading: string | null;
    body: string;
} {
    const match = markdown.match(/^\s*#{1,3}[ \t]+(.+?)[ \t]*(?:\n|$)/);
    const leading = match?.[1]?.trim();
    if (!leading) return { heading: partTitle, body: markdown };
    if (!partTitle) return { heading: leading, body: markdown.slice(match![0].length) };
    if (norm(leading) === norm(partTitle)) return { heading: partTitle, body: markdown.slice(match![0].length) };
    return { heading: partTitle, body: markdown };
}

/**
 * A lesson part inside a chapter: generated teaching markdown (visual fences +
 * KaTeX render through the shared Markdown pipeline) or, degraded, the node's
 * own notes. The topic and project live in the chapter header above — this only
 * says which part it is.
 */
export default function LessonCard({ card, done, onDone }: Props) {
    const { t } = useTranslation();
    const consumeFeedCard = useStore(s => s.consumeFeedCard);
    const repairFeedVisual = useStore(s => s.repairFeedVisual);

    const { heading, body } = splitLessonHeading(card.markdown, card.partTitle);
    // Assembled in code, so neither of these was ever a key: the card printed
    // "PART 1 OF 3" and "FROM YOUR NOTES" above Russian chrome, and no
    // coverage report could see it.
    const label = card.partCount > 1
        ? t("Part {{n}} of {{total}}", { n: card.partIndex, total: card.partCount })
        : card.degraded ? t("From your notes") : null;

    const handleContinue = () => {
        if (done) return;
        void consumeFeedCard(card.key, {
            kind: 'lesson',
            feedItemId: card.feedItemId,
            nodeId: card.nodeId,
            result: { read: true },
        });
        onDone(card.key);
    };

    return (
        <article>
            {(label || heading) && (
                <div className="mb-3">
                    {label && (
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-accent-fg">{label}</p>
                    )}
                    {heading && (
                        <h3 className="text-lg sm:text-xl font-semibold text-slate-900 dark:text-white leading-snug">
                            {heading}
                        </h3>
                    )}
                </div>
            )}

            <Markdown
                content={body}
                nodeId={card.nodeId}
                className="text-[15px] sm:text-base leading-7 text-slate-700 dark:text-slate-200"
                autoRepair={card.source === 'generated' && !done}
                // Widgets in the feed are pre-compiled by feedGen, so a cached
                // build renders instantly. Never start one on view: that would
                // block the learner mid-scroll on an LLM call. A spec that
                // missed its pre-build shows a "Build widget" button instead.
                autoBuild={false}
                surface="feed-lesson"
                onRepaired={(original, repaired) => repairFeedVisual(card.key, original, repaired)}
            />

            {/* Degradation path: with no AI-authored drill in the markdown, offer a
                practice drill synthesised from the node's own flashcards (renders
                nothing if there are too few). Once per topic, on the last part. */}
            {card.degraded && card.partIndex >= card.partCount && (
                <FlashcardDrillLauncher nodeId={card.nodeId} nodeTitle={card.nodeTitle} />
            )}

            {done ? (
                <p className="mt-4 flex items-center gap-1.5 text-sm font-medium text-emerald-600 dark:text-emerald-400">
                    <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
                    {t("Read")}
                </p>
            ) : (
                <div className="mt-5 flex justify-end">
                    <button
                        onClick={handleContinue}
                        className="flex items-center gap-2 px-4 py-2 min-h-11 bg-accent text-white rounded-xl text-sm font-medium hover:brightness-90 transition"
                    >
                        {t("Got it, continue")}
                        <ArrowDown className="w-4 h-4" />
                    </button>
                </div>
            )}
        </article>
    );
}
