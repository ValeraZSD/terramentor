import { useState } from 'react';
import { api } from '../../api';
import QuestionStem from '../QuestionStem';
import AnswerInput from '../answer/AnswerInput';
import { answerIsComplete } from '../answer/formats';
import { Button } from '../ui/Button';
import { Explain } from '../ui/Disclosure';
import { TextArea } from '../ui/Field';
import ReportItem, { ReportLink, ReportScope, reportedLine } from '../ui/ReportItem';
import { gradeLocally } from '../../utils/grading';
import { feedRowRef, questionRef } from '../../utils/itemReports';
import { useItemReports, useReportOn } from '../../utils/itemReportStore';
import { FeedLessonCard, QuizQuestion } from '../../types';
import { ArrowDown, ArrowUp, Check, CircleDashed, HelpCircle, Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';

type PreQuestion = NonNullable<FeedLessonCard['preQuestions']>[number];

/** One question asked before the part: no verdict and no key, the part is the answer. */
function PreQuestionItem({ item, nodeId, value, onChange, disabled }: {
    item: PreQuestion;
    nodeId: number;
    value: string;
    onChange: (v: string) => void;
    disabled: boolean;
}) {
    const { t } = useTranslation();
    const ref = refOf(item);
    const reported = useReportOn(ref);
    return (
        // A scope of its own: the lesson's flag and this question's are two items.
        <ReportScope>
            <div className="py-4 first:pt-0 border-t border-slate-200 dark:border-slate-700 first:border-t-0">
                <div className="flex items-start gap-2 mb-3">
                    <div className="min-w-0 flex-1 text-base font-medium text-slate-800 dark:text-slate-100">
                        <QuestionStem content={item.question.question} nodeId={nodeId} surface="feed-question" media={item.question.media} />
                    </div>
                    {ref && <div className="-mt-1 -mr-1"><ReportItem itemRef={ref} surface="feed" inStream /></div>}
                </div>
                {reported
                    ? <p className="text-sm text-slate-600 dark:text-slate-400">{reportedLine(t, reported)}</p>
                    : <AnswerInput question={item.question} value={value} onChange={onChange} disabled={disabled} result={null} />}
            </div>
        </ReportScope>
    );
}

// The feed row first, as QuestionCard does: a flag filed before the part and
// one filed on the same question after it land on one item.
const refOf = (p: PreQuestion) => feedRowRef(p.feedItemId) ?? questionRef(p.question);

const answered = (q: QuizQuestion, draft: string) => !!draft.trim() && answerIsComplete(q, draft);

/**
 * A topic met for the first time opens on two or three of its own questions,
 * asked BEFORE the part (the pretesting effect: a guess first makes the
 * reading stick). No verdict and no key here: the part answers them, and the
 * same questions come back after it, where they count. The answers are
 * recorded once and are never evidence (`server/lessonPrompts.js`).
 *
 * One button: with nothing answered it skips, with answers it goes on. Either
 * way the part opens, a failed save included: these answers count for nothing,
 * so losing one never holds the learner back.
 */
export function PreQuestions({ card, onDone }: { card: FeedLessonCard; onDone: () => void }) {
    const { t } = useTranslation();
    const items = card.preQuestions ?? [];
    const [drafts, setDrafts] = useState<string[]>(() => items.map(() => ''));
    const [busy, setBusy] = useState(false);
    // A question flagged as wrong is not an answer, whatever was typed into it.
    const flagged = useItemReports(s => s.byRef);
    const counts = (p: PreQuestion, i: number) => {
        const ref = refOf(p);
        return !(ref && flagged[ref]) && answered(p.question, drafts[i]);
    };
    const given = items.filter(counts).length;

    const finish = async () => {
        setBusy(true);
        const record = items.flatMap((p, i) => {
            const ref = refOf(p);
            if (!ref) return [];
            return [{ ref, correct: counts(p, i) ? gradeLocally(p.question, drafts[i]) : null }];
        });
        try {
            await api.recordPreQuestions(card.nodeId, { outcome: given > 0 ? 'answered' : 'skipped', items: record });
        } catch { /* not evidence: the part opens regardless */ }
        onDone();
    };

    return (
        <section aria-label={t("Before you read")}>
            <p className="flex items-center gap-1.5 text-2xs font-semibold text-accent-fg">
                <HelpCircle className="w-3.5 h-3.5" aria-hidden="true" />
                {t("Before you read")}
            </p>
            <p className="mt-1 mb-4 text-sm text-slate-600 dark:text-slate-400">
                {t("Guess if you are not sure. These do not count; the part below answers them.")}
            </p>
            {items.map((p, i) => (
                <PreQuestionItem
                    key={p.feedItemId ?? p.question.uuid ?? i}
                    item={p}
                    nodeId={card.nodeId}
                    value={drafts[i]}
                    onChange={v => setDrafts(d => d.map((x, j) => (j === i ? v : x)))}
                    disabled={busy}
                />
            ))}
            <div className="mt-4 flex justify-end">
                <Button variant="primary" busy={busy} onClick={() => void finish()} trailing={<ArrowDown className="w-4 h-4" aria-hidden="true" />}>
                    {given > 0 ? t("Read the part") : t("Skip to the part")}
                </Button>
            </div>
        </section>
    );
}

type Verdict = { verdict: 'good' | 'weak' | 'unsure'; reason: string };

/**
 * After a part, the learner may put it in their own words; the model marks
 * that against the part's text and says why. A weak one points back to the
 * part. Never evidence: written with the part a scroll away, against no
 * vetted key, by whoever chose to open it. Rendered only when a model is set
 * up (`card.explainBack`); with none there is nothing to mark with.
 */
export function ExplainBack({ feedItemId, onReread }: { feedItemId: number; onReread: () => void }) {
    const { t } = useTranslation();
    const [text, setText] = useState('');
    const [busy, setBusy] = useState(false);
    const [failed, setFailed] = useState(false);
    const [verdict, setVerdict] = useState<Verdict | null>(null);

    const submit = async () => {
        if (!text.trim() || busy) return;
        setBusy(true);
        setFailed(false);
        try {
            setVerdict(await api.explainBack(feedItemId, text.trim()));
        } catch {
            setFailed(true);
        } finally {
            setBusy(false);
        }
    };

    const look = verdict?.verdict === 'good'
        ? { icon: Check, label: t("You have the main idea"), tone: 'text-emerald-700 dark:text-emerald-300' }
        : verdict?.verdict === 'weak'
            ? { icon: CircleDashed, label: t("Not there yet"), tone: 'text-amber-700 dark:text-amber-300' }
            : { icon: Info, label: t("Not marked"), tone: 'text-slate-700 dark:text-slate-200' };
    const Icon = look.icon;

    return (
        <Explain className="mt-4" summary={t("Explain it back in your own words")}>
            <p className="mb-2">{t("Say what this part is about and why it works, as you would to a friend. It is marked against the part and never counts toward mastery.")}</p>
            <TextArea
                rows={3}
                value={text}
                maxLength={2000}
                onChange={e => setText(e.target.value)}
                aria-label={t("Your explanation")}
                disabled={busy}
            />
            <div className="mt-2 flex flex-wrap items-center justify-end gap-3">
                {failed && (
                    <p role="alert" className="mr-auto text-sm text-red-700 dark:text-red-300">
                        {t("It could not be marked just now. Your text is kept; try again.")}
                    </p>
                )}
                <Button size="md" busy={busy} disabled={!text.trim()} onClick={() => void submit()}>
                    {verdict ? t("Check again") : t("Check my explanation")}
                </Button>
            </div>
            {verdict && (
                <div className="mt-3" aria-live="polite">
                    <p className={`flex items-center gap-1.5 text-sm font-semibold ${look.tone}`}>
                        <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
                        {look.label}
                    </p>
                    {verdict.reason && <p className="mt-1 text-sm leading-6">{verdict.reason}</p>}
                    {verdict.verdict === 'weak' && (
                        <>
                            <div className="mt-2">
                                <Button size="sm" onClick={onReread} icon={<ArrowUp className="w-4 h-4" aria-hidden="true" />}>
                                    {t("Read the part again")}
                                </Button>
                            </div>
                            {/* Marked weak, the part itself may be what is wrong. */}
                            <ReportLink className="mt-2" />
                        </>
                    )}
                </div>
            )}
        </Explain>
    );
}
