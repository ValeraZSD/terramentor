import { useState } from 'react';
import { useStore } from '../../store';
import FeedCardShell from './FeedCardShell';
import InlineQuestion, { GradedAnswer } from './InlineQuestion';
import { FeedQuestionCard, FeedRecallCard } from '../../types';
import { ArrowDown, CheckCircle2, HelpCircle, History } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface Props {
    card: FeedQuestionCard | FeedRecallCard;
    done: boolean;
    onDone: (key: string) => void;
    /**
     * True for a topic question rendered inside its chapter (no card chrome —
     * the chapter header already names the topic). Recall questions come from a
     * *different*, decaying topic, so they stay standalone cards: the visual
     * break is the point.
     */
    inChapter?: boolean;
}

/**
 * An inline check-understanding question (kind 'question') or a spaced-recall
 * question from a decaying topic (kind 'recall' — the Remember loop, served
 * inline instead of waiting for a practice quiz). Grading records mastery
 * evidence immediately; the reader advances when they've read the explanation.
 */
export default function QuestionCard({ card, done, onDone, inChapter = false }: Props) {
    const { t } = useTranslation();
    const consumeFeedCard = useStore(s => s.consumeFeedCard);
    const openProjectNode = useStore(s => s.openProjectNode);
    const repairFeedVisual = useStore(s => s.repairFeedVisual);
    const [graded, setGraded] = useState<GradedAnswer | null>(null);

    const isRecall = card.kind === 'recall';

    const handleGraded = (result: GradedAnswer) => {
        setGraded(result);
        void consumeFeedCard(card.key, {
            kind: card.kind,
            feedItemId: card.kind === 'question' ? card.feedItemId : null,
            nodeId: card.nodeId,
            result: { correct: result.correct, answer: result.answer, gradedBy: result.gradedBy },
        });
    };

    const continueButton = graded && !done && (
        <div className="mt-4 flex justify-end">
            <button
                onClick={() => onDone(card.key)}
                className="flex items-center gap-2 px-4 py-2 min-h-11 bg-accent text-white rounded-xl text-sm font-medium hover:brightness-90 transition"
            >
                {t("Continue")}
                <ArrowDown className="w-4 h-4" />
            </button>
        </div>
    );

    if (inChapter) {
        // No panel: the chapter's hairline already separates this from the part
        // above it, and the answer inputs are boxes of their own. A frame here
        // would be a box inside a box inside a box. The eyebrow carries the
        // "stop and think" signal, matching the lesson part's own label.
        return (
            <div>
                <p className="flex items-center gap-1.5 mb-3 text-[11px] font-semibold uppercase tracking-wide text-accent-fg">
                    {done
                        ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" aria-hidden="true" />
                        : <HelpCircle className="w-3.5 h-3.5" aria-hidden="true" />}
                    {t("Check your understanding")}
                </p>
                <InlineQuestion question={card.question} graded={graded} onGraded={handleGraded} nodeId={card.nodeId} nodeTitle={card.nodeTitle} projectName={card.projectName}
                    surface={isRecall ? 'feed-recall' : 'feed-question'}
                    onRepaired={(original, repaired) => repairFeedVisual(card.key, original, repaired)} />
                {continueButton}
            </div>
        );
    }

    return (
        <FeedCardShell
            projectColor={card.projectColor}
            projectName={card.projectName}
            nodeTitle={card.nodeTitle}
            subtitle={isRecall
                ? (card.daysSince != null ? t("You proved this {{count}} days ago — still got it?", { count: card.daysSince }) : t("You proved this a while ago — still got it?"))
                : t("Check your understanding")}
            badge={isRecall ? (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300">
                    <History className="w-3 h-3" />
                    {t("Recall")}
                </span>
            ) : undefined}
            done={done}
            onOpenNode={() => openProjectNode(card.projectId, card.nodeId)}
        >
            <InlineQuestion question={card.question} graded={graded} onGraded={handleGraded} nodeId={card.nodeId} nodeTitle={card.nodeTitle} projectName={card.projectName}
                surface={isRecall ? 'feed-recall' : 'feed-question'}
                onRepaired={(original, repaired) => repairFeedVisual(card.key, original, repaired)} />
            {continueButton}
        </FeedCardShell>
    );
}
