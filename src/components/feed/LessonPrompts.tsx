import { type MouseEvent, useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import QuestionStem from '../QuestionStem';
import AnswerInput from '../answer/AnswerInput';
import { answerIsComplete } from '../answer/formats';
import { Button } from '../ui/Button';
import { Explain } from '../ui/Disclosure';
import { TextArea } from '../ui/Field';
import { cx } from '../ui/vocabulary';
import ReportItem, { ReportLink, ReportScope, reportedLine } from '../ui/ReportItem';
import { gradeLocally } from '../../utils/grading';
import { feedRowRef, questionRef } from '../../utils/itemReports';
import { useItemReports, useReportOn } from '../../utils/itemReportStore';
import { FeedLessonCard, QuizQuestion } from '../../types';
import { ArrowDown, ArrowUp, Check, CircleDashed, History, HelpCircle, Info } from 'lucide-react';
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
 * A topic the app thinks the learner may partly know (a head start) opens on
 * ONE quick-tap question of its own, asked BEFORE the part (the pretesting
 * effect: a guess first makes the reading stick). A plainly new topic gets
 * none: a quiz before the text there only discourages. No verdict and no key
 * here: the part answers it, and the same question comes back after it, where
 * it counts. Recorded once and never evidence (`server/lessonPrompts.js`).
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
                {t("You may know some of this already. Guess first: trying before you read makes the part stick.")}
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
export function ExplainBack({ feedItemId, onReread, onVerdict }: {
    feedItemId: number;
    onReread: () => void;
    /** The part's own "continue" stops shouting while the verdict is weak.
     *  `null` whenever this block unmounts: its verdict goes with it. */
    onVerdict?: (verdict: Verdict['verdict'] | null) => void;
}) {
    const { t } = useTranslation();
    const [text, setText] = useState('');
    const [busy, setBusy] = useState(false);
    // 'model': no model is set up any more, so trying again cannot help.
    const [failed, setFailed] = useState<null | 'retry' | 'model'>(null);
    const [verdict, setVerdict] = useState<Verdict | null>(null);
    // The text the verdict is about. Once marked, the check button shows only
    // when the text changes: "Check again" on the same words offered the same
    // verdict twice. "Not marked" is the exception, where the same words may
    // well be marked on a second try.
    const [checked, setChecked] = useState('');
    const edited = text.trim() !== checked;
    const canCheck = !verdict || verdict.verdict === 'unsure' || edited;
    const weak = verdict?.verdict === 'weak';
    // Each verdict is a new node in the live region below, so the same words
    // marked the same way twice are still read out.
    const [round, setRound] = useState(0);
    // A check pressed from the KEYBOARD (a click with `detail` 0) leaves that
    // keyboard on nothing: the button is disabled while it marks and gone
    // after most verdicts. Focus then goes back to the text, once the box is
    // enabled again, and only if it is still lost: a learner who moved on
    // while it marked keeps their place. A tap never moves it, or a phone
    // would raise its keyboard over the verdict.
    const textRef = useRef<HTMLTextAreaElement>(null);
    const [refocus, setRefocus] = useState(false);
    useEffect(() => {
        if (busy || !refocus) return;
        setRefocus(false);
        const at = document.activeElement as HTMLButtonElement | null;
        if (!at || at === document.body || !at.isConnected || at.disabled) textRef.current?.focus({ preventScroll: true });
    }, [busy, refocus]);
    // A verdict that lands after this block is gone (the part reported) is
    // dropped, and going reports `null`: its verdict went with it.
    const alive = useRef(true);
    const report = useRef(onVerdict);
    useEffect(() => { report.current = onVerdict; });
    useEffect(() => {
        alive.current = true;
        return () => { alive.current = false; report.current?.(null); };
    }, []);

    const submit = async (fromKeyboard: boolean) => {
        const mine = text.trim();
        if (!mine || busy) return;
        setBusy(true);
        setFailed(null);
        try {
            const v = await api.explainBack(feedItemId, mine);
            if (!alive.current) return;
            setVerdict(v);
            setChecked(mine);
            setRound(r => r + 1);
            report.current?.(v.verdict);
        } catch (err) {
            if (!alive.current) return;
            setFailed((err as { status?: number })?.status === 409 ? 'model' : 'retry');
        } finally {
            if (alive.current) { setBusy(false); setRefocus(fromKeyboard); }
        }
    };
    const check = (e: MouseEvent) => void submit(e.detail === 0);

    const look = verdict?.verdict === 'good'
        ? { icon: Check, label: t("You have the main idea"), tone: 'text-emerald-700 dark:text-emerald-300' }
        : verdict?.verdict === 'weak'
            ? { icon: CircleDashed, label: t("Not there yet"), tone: 'text-amber-700 dark:text-amber-300' }
            : { icon: Info, label: t("Not marked"), tone: 'text-slate-700 dark:text-slate-200' };
    const Icon = look.icon;

    return (
        <Explain className="mt-4" summary={t("Explain it back in your own words")}>
            <p className="mb-2">{t("Say what this part is about and why it works, as you would to a friend. Putting it in your own words is what makes it stay.")}</p>
            <TextArea
                ref={textRef}
                rows={3}
                value={text}
                maxLength={2000}
                onChange={e => { setText(e.target.value); setFailed(null); }}
                aria-label={t("Your explanation")}
                // The empty box says what to do; the check button waits for
                // the first word rather than standing there switched off.
                placeholder={t("Type your explanation, then check it")}
                disabled={busy}
            />
            {/* The verdict sits straight under the words it judges, and every
                button below it shares ONE row on the right, the side the
                part's own "continue" is on. Mounted from the start: a live
                region that arrives already holding its text is not reliably
                announced. */}
            <div aria-live="polite">
                {verdict && !edited && (
                    <div key={round} className="mt-4">
                        <p className={cx('flex items-center gap-1.5 text-sm font-semibold', look.tone)}>
                            <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
                            {look.label}
                        </p>
                        {verdict.reason
                            ? <p className="mt-1">{verdict.reason}</p>
                            : verdict.verdict === 'unsure' && (
                                <p className="mt-1">{t("The marker gave no clear verdict on this one. Compare it with the part yourself.")}</p>
                            )}
                    </div>
                )}
            </div>
            {/* Rewritten, the verdict is about words no longer in the box: it
                folds to one grey line that says so. A reason left in full
                under new words read as the mark of THEM, greyed or not (and
                greyed, it was hard to read). The folded line sits OUTSIDE the
                live region, so the first keystroke of a rewrite is not read
                out, and is not aria-hidden, so a screen reader can still find
                what the earlier words were marked. Its clock-back mark: the
                dashed circle read as something still being marked. */}
            {verdict && edited && (
                <p className="mt-4 flex items-center gap-1.5 text-sm font-semibold text-slate-500 dark:text-slate-400">
                    <History className="w-4 h-4 shrink-0" aria-hidden="true" />
                    {t("Before your edit: {{verdict}}", { verdict: look.label })}
                </p>
            )}
            {/* Weak, the next step is to rewrite: "Check again" appears,
                filled, only once the words change. Before the first check
                the button shows, off, from the start: hidden, the box
                promised a check with no control in sight, and the part's
                filled "Got it, continue" was the only thing to press. */}
            {/* Weak on unchanged words, what to do next is the instruction,
                on its own line, not a caption beside a button. Regular
                weight: bold, it outweighed the verdict and its reason. */}
            {weak && (!canCheck || !text.trim()) && (
                <p className="mt-3 text-sm text-slate-700 dark:text-slate-200">{t("Change your words to check them again.")}</p>
            )}
            {(weak || (canCheck && (!!text.trim() || !verdict))) && (
                // "Read the part again" sits left, under the line it belongs
                // to: on the right it stacked on the part's own outlined
                // "Continue anyway", two equal buttons for opposite moves.
                <div className={cx('flex flex-wrap items-center gap-2', weak && (!canCheck || !text.trim()) ? 'mt-3 justify-start' : 'mt-4 justify-end')}>
                    {failed && (
                        <p role="alert" className="mr-auto text-sm text-red-700 dark:text-red-300">
                            {failed === 'model'
                                ? t("No model is set up to mark this. Your text is kept.")
                                : t("It could not be marked just now. Your text is kept; try again.")}
                        </p>
                    )}
                    {/* Keyed, so each button keeps its own DOM node as the
                        row changes: unkeyed, a keyboard "Check again" whose
                        verdict came back weak left focus on the node React
                        reused for "Read the part again". */}
                    {weak && (!canCheck || !text.trim()) ? (
                        // The step is the rewrite (the line above says so); a
                        // filled "Read the part again" pulled the thumb to a
                        // scroll instead. It stays, outlined, as the way back.
                        <Button key="reread" size="md" onClick={onReread} icon={<ArrowUp className="w-4 h-4" aria-hidden="true" />}>
                            {t("Read the part again")}
                        </Button>
                    ) : weak ? (
                        // Rewritten, checking is the one step left: "Read the
                        // part again" beside it, over "Continue anyway", made
                        // a stack of three. The part is still one scroll up.
                        <Button key="check" size="md" variant="primary" busy={busy} onClick={check}>
                            {t("Check again")}
                        </Button>
                    ) : (
                        <Button size="md" busy={busy} disabled={!text.trim()} onClick={check}>
                            {verdict ? t("Check again") : t("Check my explanation")}
                        </Button>
                    )}
                </div>
            )}
            {/* Marked weak, the part itself may be what is wrong. Last, under
                the buttons: a rare side road, never between the reason and
                the next step. */}
            {/* Not under a folded verdict: it would report a mark no longer
                shown. The item's own flag stays at its top-right. */}
            {weak && !edited && <ReportLink className="mt-3" />}
        </Explain>
    );
}
