import { useState } from 'react';
import { api } from '../../api';
import { useStore } from '../../store';
import { onActivateKey } from '../../utils/a11y';
import FeedCardShell from './FeedCardShell';
import { parseCardMedia } from '../CardMedia';
import CardFace from '../CardFace';
import { FeedFlashcardCard } from '../../types';
import { computeSrsUpdate, computeNextInterval, formatInterval, requeueAt, ReviewRating } from '../../utils/srs';
import { RotateCcw, ThumbsDown, ThumbsUp, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { k } from '../../i18n';

interface Props {
    card: FeedFlashcardCard;
    done: boolean;
    onDone: (key: string) => void;
}

// Same palette discipline as GlobalFlashcardReview's DIFFICULTY_CONFIG
// (700-grade text on 100-grade tint for AA).
const RATINGS: { rating: ReviewRating; label: string; cls: string; icon: typeof RotateCcw }[] = [
    { rating: 'again', label: k("Again"), icon: RotateCcw, cls: 'bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-300 dark:hover:bg-red-900/50' },
    { rating: 'hard', label: k("Hard"), icon: ThumbsDown, cls: 'bg-orange-100 text-orange-700 hover:bg-orange-200 dark:bg-orange-900/30 dark:text-orange-300 dark:hover:bg-orange-900/50' },
    { rating: 'good', label: k("Good"), icon: ThumbsUp, cls: 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:hover:bg-emerald-900/50' },
    { rating: 'easy', label: k("Easy"), icon: Sparkles, cls: 'bg-blue-100 text-blue-700 hover:bg-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:hover:bg-blue-900/50' },
];

/**
 * One SRS flashcard inline in the feed — flip, rate, move on. Persists through
 * `computeSrsUpdate` → `PUT /api/ai/flashcards/:id`; the feed's daily caps count
 * it via last_reviewed/review_count, no consume call.
 *
 * **"Again" puts the card back into the stream** (`requeueFeedCard`), because a
 * (re)learning step schedules it minutes out and a stream that only re-serves on
 * the next load would drop the repetition on the floor. The copy above stays
 * where it is, marked done — the feed never moves a card the reader has passed.
 */
export default function FlashcardFeedCard({ card, done, onDone }: Props) {
    const { t } = useTranslation();
    const addToast = useStore(s => s.addToast);
    const feedHeader = useStore(s => s.feedHeader);
    const updateFeedStats = useStore(s => s.updateFeedStats);
    const requeueFeedCard = useStore(s => s.requeueFeedCard);
    const [flipped, setFlipped] = useState(false);
    const [saving, setSaving] = useState(false);
    const [ratedWith, setRatedWith] = useState<ReviewRating | null>(null);

    const fc = card.card;
    const media = parseCardMedia(fc.media);

    const handleRate = async (rating: ReviewRating) => {
        if (done || saving) return;
        setSaving(true);
        try {
            const update = computeSrsUpdate(fc, rating);
            const saved = await api.updateFlashcard(fc.id, update);
            setRatedWith(rating);
            // A rating that leaves the card on a (re)learning ladder schedules it
            // minutes away, so it belongs later in THIS scroll rather than in
            // whenever-the-feed-next-loads. The saved row travels with it, or the
            // next rating would be computed from the state before this one.
            const back = requeueAt(update);
            if (back !== null) requeueFeedCard(card.key, { ...fc, ...saved }, back);
            // Optimistic header tick — the server recounts on the next consume.
            if (feedHeader) {
                updateFeedStats({
                    ...feedHeader.stats,
                    itemsDoneToday: feedHeader.stats.itemsDoneToday + 1,
                    cardsReviewedToday: feedHeader.stats.cardsReviewedToday + 1,
                    newCardsIntroducedToday: feedHeader.stats.newCardsIntroducedToday + (card.isNew ? 1 : 0),
                });
            }
            onDone(card.key);
        } catch (e: any) {
            addToast('error', t("Failed to save review"), e.message);
        } finally {
            setSaving(false);
        }
    };

    return (
        <FeedCardShell
            projectColor={fc.project_color}
            projectName={fc.project_name}
            nodeTitle={fc.node_title || 'Flashcard'}
            // A card met twice in one scroll needs to say WHY, or the second
            // copy reads as a duplicate the feed failed to dedupe rather than as
            // the repetition that was just asked for.
            subtitle={card.requeuedAt
                ? t("Again — second look")
                : card.isNew ? t("New card — first look") : t("Review")}
            badge={card.requeuedAt ? (
                <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300">
                    {t("Relearning")}
                </span>
            ) : card.isNew ? (
                <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-accent/10 text-accent-fg">{t("New")}</span>
            ) : undefined}
            done={done}
        >
            <div
                onClick={() => !done && setFlipped(f => !f)}
                onKeyDown={onActivateKey(() => !done && setFlipped(f => !f))}
                role="button"
                tabIndex={0}
                aria-label={flipped ? t("Show question") : t("Reveal answer")}
                className={`min-h-[120px] p-5 rounded-xl border-2 outline-none transition-colors duration-300 focus-visible:ring-2 focus-visible:ring-accent/70 bg-slate-50 dark:bg-slate-900/40 ${done ? '' : 'cursor-pointer'} ${flipped
                    ? 'border-accent/40'
                    : 'border-slate-200 dark:border-slate-600'}`}
            >
                <div className="flex flex-col items-center justify-center text-center min-h-[80px]">
                    <span className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-2">
                        {flipped ? t("Answer") : t("Question")}
                    </span>
                    {/* autoPlay only once the learner has flipped: in the feed a
                        card arrives by SCROLLING, and a page that starts talking
                        because something drifted into view is hostile. The front's
                        clip has a button and waits to be pressed. */}
                    <CardFace
                        front={fc.front}
                        back={fc.back}
                        extra={fc.extra}
                        extraFront={fc.extra_front}
                        flipped={flipped}
                        media={media}
                        autoPlay={flipped}
                        size="feed"
                    />
                    {!flipped && !done && (
                        <p className="text-sm text-slate-500 dark:text-slate-400 mt-3">{t("Tap to reveal")}</p>
                    )}
                </div>
            </div>

            {flipped && !done && (
                <div className="mt-3 grid grid-cols-4 gap-2">
                    {/* The sub-label is a MINUTE COUNT only where a minute count
                        means something, and in a feed it doesn't. A rating that
                        leaves the card on the (re)learning ladder schedules it
                        1, 6 or 10 minutes out, but the feed doesn't run a clock:
                        `requeueFeedCard` appends the copy a few cards down and
                        it comes back when the reader scrolls to it. Printing
                        "<1m" against "<10m" offers a choice between two waits
                        that will both be "however long the next three cards
                        take" — so the ladder rungs say "soon" and only a
                        day-scale interval, which really is a date, keeps its
                        number. A review SESSION is the opposite case and still
                        shows the minutes: there the timer is real. */}
                    {RATINGS.map(({ rating, label, cls, icon: Icon }) => {
                        const next = computeNextInterval(fc, rating);
                        const exact = formatInterval(next.intervalDays);
                        return (
                            <button
                                key={rating}
                                onClick={() => handleRate(rating)}
                                disabled={saving}
                                title={next.learning
                                    ? t("{{label}} — comes back further down this feed (scheduled {{exact}})", { label: t(label), exact })
                                    : t("{{label}} — next review in {{exact}}", { label: t(label), exact })}
                                className={`py-2.5 min-h-11 rounded-xl flex flex-col items-center gap-0.5 transition disabled:opacity-50 ${cls}`}
                            >
                                <Icon className="w-4 h-4" aria-hidden="true" />
                                <span className="text-xs font-medium">{t(label)}</span>
                                <span className="text-[10px] opacity-70">
                                    {next.learning ? t("soon") : exact}
                                </span>
                            </button>
                        );
                    })}
                </div>
            )}
            {done && ratedWith && (
                <p className="mt-2 text-sm text-slate-500 dark:text-slate-400 text-center">
                    {requeueAt(computeSrsUpdate(fc, ratedWith)) !== null
                        // "Next review in 10m" is true and useless here: it reads
                        // as a date, and what the learner needs to know is that
                        // the card is coming back before they finish scrolling.
                        // The exact step was in brackets and is gone with the
                        // minute counts on the buttons, for the same reason.
                        ? t("Coming back later in this feed")
                        : t("Next review in {{interval}}", { interval: formatInterval(computeNextInterval(fc, ratedWith).intervalDays) })}
                </p>
            )}
        </FeedCardShell>
    );
}
