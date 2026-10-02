import { useState } from 'react';
import { useStore } from '../../store';
import { api, newAttemptId } from '../../api';
import Markdown from '../Markdown';
import { FlashcardDrillLauncher } from '../drills/DrillLauncher';
import { Explain } from '../ui/Disclosure';
import { Button } from '../ui/Button';
import { FeedLessonCard, FeedReadPart } from '../../types';
import { uiLocale } from '../../utils/locale';
import { ArrowDown, CheckCircle2, Info, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface Props {
    card: FeedLessonCard;
    done: boolean;
    onDone: (key: string) => void;
    /** False in a "continued" chapter: the parts before this one are further
     *  up the same stream, so offering them again would be a second copy. */
    offerEarlier?: boolean;
}

/**
 * The parts of this topic read on an earlier visit, behind one line above the
 * part that picks it up again.
 *
 * The stream serves what is unread, so a topic left on part 2 came back as
 * "Part 3 of 3" — a part that says "the wavefront picture from Part 1 still
 * holds" with no way on the screen to see Part 1. The text is fetched when the
 * line is opened, never with the feed: most readers never need it.
 */
function EarlierParts({ card }: { card: FeedLessonCard }) {
    const { t } = useTranslation();
    const known = card.readBefore ?? [];
    const [parts, setParts] = useState<FeedReadPart[] | null>(null);
    const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');
    if (known.length === 0) return null;

    const from = known[0].partIndex;
    const to = known[known.length - 1].partIndex;
    const lastRead = known[known.length - 1].readAt;
    const date = lastRead
        ? new Intl.DateTimeFormat(uiLocale(), { day: 'numeric', month: 'short' }).format(new Date(lastRead))
        : null;
    const titles = known
        .filter(p => p.partTitle)
        .map(p => `${p.partIndex}. ${p.partTitle}`)
        .join(' · ');

    const load = async () => {
        setState('loading');
        try {
            const res = await api.getReadLessonParts(card.nodeId, card.partIndex);
            setParts(res.parts);
            setState('idle');
        } catch {
            setState('error');
        }
    };

    return (
        <Explain
            className="mb-3"
            onToggle={e => { if (e.currentTarget.open && !parts && state !== 'loading') void load(); }}
            summary={
                <>
                    {/* The line says what pressing it does NOW: open, "show
                        again" above parts already on the screen reads as a
                        second copy waiting somewhere. */}
                    <span className="group-open:hidden">
                        {from === to
                            ? t("Show part {{n}} again", { n: from })
                            : t("Show parts {{from}}–{{to}} again", { from, to })}
                    </span>
                    <span className="hidden group-open:inline">
                        {from === to
                            ? t("Hide part {{n}}", { n: from })
                            : t("Hide parts {{from}}–{{to}}", { from, to })}
                    </span>
                    {/* A space, not a margin: when the date wraps under the
                        line on a phone, a margin indents it. */}
                    {date && ' '}
                    {date && (
                        <span className="inline-block whitespace-nowrap font-normal text-slate-500 dark:text-slate-400">
                            {t("read {{date}}", { date })}
                        </span>
                    )}
                    {/* What those parts WERE, while closed: both outside
                        reviewers (2 Oct) still met Part 3 "cold" behind a line
                        that only counted the parts. The titles are already in
                        the payload; no model, no fetch. */}
                    {titles && (
                        <span className="block group-open:hidden font-normal text-slate-500 dark:text-slate-400 line-clamp-2">
                            {titles}
                        </span>
                    )}
                </>
            }
        >
            {state === 'loading' && (
                <p className="flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                    {t("Loading…")}
                </p>
            )}
            {state === 'error' && (
                <div className="flex flex-wrap items-center gap-3">
                    <p>{t("These parts could not be loaded.")}</p>
                    <Button size="sm" onClick={() => void load()}>{t("Try again")}</Button>
                </div>
            )}
            {parts && parts.length === 0 && (
                <p>{t("These parts are no longer kept.")}</p>
            )}
            {parts?.map(p => {
                const { heading, body } = splitLessonHeading(p.markdown ?? '', p.partTitle);
                return (
                    <section key={p.partIndex} className="py-3 first:pt-1 border-t border-slate-200 dark:border-slate-700 first:border-t-0">
                        <p className="text-2xs font-semibold text-accent-fg">
                            {t("Part {{n}} of {{total}}", { n: p.partIndex, total: p.partCount ?? card.partCount })}
                        </p>
                        {heading && (
                            <h4 className="text-base sm:text-lg font-semibold text-slate-900 dark:text-white leading-snug mb-2">
                                {heading}
                            </h4>
                        )}
                        <Markdown
                            content={body}
                            nodeId={card.nodeId}
                            className="text-[0.9375rem] sm:text-base leading-7 text-slate-700 dark:text-slate-200"
                            autoBuild={false}
                            surface="feed-lesson-read"
                        />
                    </section>
                );
            })}
        </Explain>
    );
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
export default function LessonCard({ card, done, onDone, offerEarlier = true }: Props) {
    const { t } = useTranslation();
    const consumeFeedCard = useStore(s => s.consumeFeedCard);
    const repairFeedVisual = useStore(s => s.repairFeedVisual);

    const { heading, body } = splitLessonHeading(card.markdown, card.partTitle);
    // Assembled in code, so neither of these was ever a key: the card printed
    // "PART 1 OF 3" and "FROM YOUR NOTES" above Russian chrome, and no
    // coverage report could see it.
    const label = card.partCount > 1
        ? t("Part {{n}} of {{total}}", { n: card.partIndex, total: card.partCount })
        : card.degraded ? t("Topic overview") : null;

    // A save that fails opens the card again (the store takes `done` back), so
    // this same button is the retry, with the same attempt id. The stream moves
    // on only once the save landed, as a question card's does: advancing first
    // scrolled the reader past a lesson that then reopened out of sight.
    const [attemptId] = useState(newAttemptId);
    const handleContinue = async () => {
        if (done) return;
        const saved = await consumeFeedCard(card.key, {
            kind: 'lesson',
            feedItemId: card.feedItemId,
            nodeId: card.nodeId,
            result: { read: true },
            attemptId,
        });
        if (saved) onDone(card.key);
    };

    return (
        <article>
            {offerEarlier && <EarlierParts card={card} />}
            {(label || heading) && (
                <div className="mb-3">
                    {label && (
                        <p className="text-2xs font-semibold text-accent-fg">{label}</p>
                    )}
                    {heading && (
                        <h3 className="text-lg sm:text-xl font-semibold text-slate-900 dark:text-white leading-snug">
                            {heading}
                        </h3>
                    )}
                </div>
            )}

            {/* Said before the lesson, not after it: a learner who has already
                copied a step down does not re-read it for a footnote. */}
            {card.checkFault && (
                <p className="mb-3 flex items-start gap-2 text-sm text-slate-600 dark:text-slate-300">
                    <Info className="w-4 h-4 mt-0.5 shrink-0 text-slate-400 dark:text-slate-500" aria-hidden="true" />
                    {card.checkFault === 'math'
                        ? t("A second check could not confirm every calculation in this part. Work the steps through yourself.")
                        : card.checkFault === 'fact'
                            ? t("A second check could not confirm every statement in this part. Check anything you rely on against another source.")
                            : t("A second check found the text disagreeing with its diagram here. Where they differ, go by the diagram.")}
                </p>
            )}

            <Markdown
                content={body}
                nodeId={card.nodeId}
                className="text-[0.9375rem] sm:text-base leading-7 text-slate-700 dark:text-slate-200"
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
