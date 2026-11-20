import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { History, Timer } from 'lucide-react';
import { api } from '../../api';
import { useStore } from '../../store';
import type { FeedLookBackCard } from '../../types';
import { Button } from '../ui/Button';
import FeedCardShell from './FeedCardShell';
import StreamRoundHeader from './StreamRoundHeader';

/**
 * The look back the stream offers at its head now and then
 * (server/lookBack.js): ten questions from across the course, answered on the
 * course mock's own screen; the same look back left open, with Continue; or,
 * in the weeks before a real exam, the full mock. Two buttons in every state,
 * and "Not now" clears it until the next one is due. Nothing below waits on it.
 */
export default function LookBackCard({ card, done, onDone, onOpen }: {
    card: FeedLookBackCard;
    done: boolean;
    onDone: (key: string) => void;
    /** Open the sitting in place of the stream. */
    onOpen: (sittingId: number, projectId: number) => void;
}) {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const addToast = useStore(s => s.addToast);
    const [busy, setBusy] = useState<'start' | 'skip' | null>(null);
    const { offer } = card;

    // Cleared by "Not now", or answered: the stream carries on without it.
    if (done) return null;

    const start = async () => {
        if (offer.kind === 'mock') { navigate(`/project/${card.projectId}/exam`); return; }
        if (offer.kind === 'resume') { onOpen(offer.sittingId, card.projectId); return; }
        setBusy('start');
        try {
            const { sitting } = await api.startLookBack(card.projectId);
            onOpen(sitting.id, card.projectId);
        } catch (e) {
            addToast('error', e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(null);
        }
    };

    const skip = async () => {
        setBusy('skip');
        try {
            await api.skipLookBack(card.projectId);
            onDone(card.key);
        } catch (e) {
            addToast('error', e instanceof Error ? e.message : String(e));
            setBusy(null);
        }
    };

    const mock = offer.kind === 'mock';
    const title = mock ? t("Mock exam") : t("Look back");
    const subtitle = offer.kind === 'mock'
        ? t("Your exam is in {{count}} days", { count: offer.daysLeft })
        : offer.kind === 'resume'
            ? t("{{answered}} of {{total}} answered", { answered: offer.answered, total: offer.questions })
            : t("{{count}} questions from across this course", { count: offer.questions });
    const body = mock
        ? t("Sit a mock from this course's questions, then go over what you missed before the exam.")
        : t("A short mix of earlier topics. Anything you miss comes back as a question the next day you study.");
    const startLabel = mock ? t("Set up the mock") : offer.kind === 'resume' ? t("Continue") : t("Start");
    const Icon = mock ? Timer : History;

    // A round of questions like the recall round below it, so it wears the
    // same header above its card (StreamRoundHeader), not a title inside it.
    return (
        <section className="space-y-2 pb-2">
            <StreamRoundHeader icon={Icon} title={title} detail={subtitle} />
            <FeedCardShell projectColor={card.projectColor} projectName={card.projectName}>
                <p className="text-sm text-slate-700 dark:text-slate-300 max-w-prose">{body}</p>
                <div className="mt-4 flex flex-wrap gap-2">
                    <Button variant="primary" busy={busy === 'start'} disabled={busy != null} onClick={() => void start()}>
                        {startLabel}
                    </Button>
                    <Button variant="quiet" busy={busy === 'skip'} disabled={busy != null} onClick={() => void skip()}>
                        {t("Not now")}
                    </Button>
                </div>
            </FeedCardShell>
        </section>
    );
}
