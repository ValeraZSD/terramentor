import { FeedNoticeCard } from '../../types';
import { Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { k } from '../../i18n';

/**
 * The sentences `composeFeed` can send, mirrored so the extractor sees
 * them.
 *
 * A notice is written by the SERVER, in English, and arrives as `card.message`
 * — so the one card on the home page that explains itself was the one card that
 * stayed English in every language. The set is closed and short, so the English
 * is the key and `t()` resolves it here; `feed-gates.mjs` asserts the server's
 * own set against these, so a new notice fails a gate instead of shipping
 * untranslated — which is exactly what the course scope's all-clear did.
 */
export const NOTICE_MESSAGES = [
    k("Personalized lessons are being prepared in the background — meanwhile the feed serves each topic's overview and saved questions."),
    k("AI is off, so the feed is built from your notes, saved questions and reviews. Enable an AI model in Settings for generated lessons."),
    k("You're all caught up — nothing scheduled, no reviews due. Open a project to get ahead."),
    k("You're all caught up in this course — every topic is finished and no review is due."),
    k("Choose a model in Settings → AI & Models."),
    k("This course has no topics yet — add some from its Tree tab."),
    k("None of your courses has any topics yet — open one and add some from its Tree tab."),
    k("That's today's cards done — more come back tomorrow."),
    k("That's everything this course has ready right now."),
    k("That's everything for now — come back later or open a project to go deeper."),
];

/** Quiet system card: AI-off notice, all-caught-up, catch-up explainer. */
export default function NoticeCard({ card }: { card: FeedNoticeCard }) {
    const { t } = useTranslation();
    return (
        <section
            aria-label={t("Notice")}
            className="flex items-start gap-3 p-4 rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 scroll-mt-20"
        >
            <Info className="w-4 h-4 text-slate-400 dark:text-slate-500 shrink-0 mt-0.5" aria-hidden="true" />
            <p className="text-sm text-slate-600 dark:text-slate-300">{t(card.message)}</p>
        </section>
    );
}
