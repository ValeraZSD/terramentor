import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Gauge, History, ListChecks } from 'lucide-react';
import { api, EVIDENCE_CHANGED } from '../../api';
import type { EstimateLevel, EvidenceRow, EvidenceTrail } from '../../types';
import { uiLocale } from '../../utils/locale';
import { k } from '../../i18n';
import Modal from '../Modal';
import { Button } from '../ui/Button';
import ProgressBar, { type ProgressTone } from '../ui/ProgressBar';
import ReportItem from '../ui/ReportItem';
import SittingReviewView from '../feed/SittingReviewView';
import EstimateChart, { chartPoints } from './EstimateChart';

/**
 * What the app thinks the learner knows about one topic, and the evidence
 * that says so (GET /api/nodes/:nodeId/evidence, server/evidenceTrail.js).
 *
 * The topic panel shows the estimate in one word with the number it rests
 * on; the dialog lists every answer that moved it, newest first, with the
 * step it gave. Disputing a mark is the item report, never a new mechanic:
 * a single feed answer carries the "this is wrong" flag beside its question,
 * and a check or quiz opens its answers, each with the same flag. A reported
 * question comes out of the score and the topic is re-scored without it.
 */

const LEVEL_WORD: Record<EstimateLevel, string> = {
    none: k("No evidence yet"),
    borrowed: k("Head start"),
    proven: k("Proven"),
    fading: k("Proven, fading"),
    practice: k("Known from practice"),
    few: k("Too early to tell"),
    close: k("Getting there"),
    early: k("Not yet"),
};

// A deck's only evidence is the learner's own card presses: its practice word
// claims memory, not knowledge.
const DECK_PRACTICE_WORD = k("Remembered in practice");
// A skipped topic is closed: what its answers say is beside the point.
const SKIPPED_WORD = k("Skipped");

const LEVEL_TONE:Record<EstimateLevel, ProgressTone> = {
    none: 'neutral',
    borrowed: 'neutral',
    proven: 'success',
    fading: 'warning',
    practice: 'accent',
    few: 'neutral',
    close: 'accent',
    early: 'accent',
};

const KIND_LABEL: Record<string, string> = {
    quiz: k("Quiz"),
    mastery_check: k("Mastery check"),
    flashcard: k("Card ratings"),
    drill: k("Drill"),
    paper: k("Paper practice"),
    placement: k("Placement question"),
};

const pct = (x: number) => Math.round(x * 100);

function useDay() {
    const { i18n } = useTranslation();
    return useMemo(() => {
        const locale = uiLocale();
        const year = new Date().getFullYear();
        return (iso: string) => {
            const d = new Date(iso);
            return d.toLocaleDateString(locale, {
                day: 'numeric', month: 'short', ...(d.getFullYear() !== year ? { year: 'numeric' } : {}),
            });
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [i18n.language]);
}

/** The line under the word: what the estimate rests on and what moves it. */
function levelLine(t: (s: string, o?: Record<string, unknown>) => string, trail: EvidenceTrail, day: (iso: string) => string): string {
    const deck = trail.projectKind === 'deck';
    const { estimate } = trail;
    switch (estimate.level) {
        case 'none': return deck
            ? t("Rate its cards and the app starts an estimate.")
            : t("Answer a question on this topic and the app starts an estimate.");
        case 'borrowed': return estimate.seed === 'transfer'
            ? t("Borrowed from a course where you proved it. Your own answers here will replace it.")
            : t("From your placement answers. Your own answers here will replace it.");
        case 'proven': return estimate.byCheck
            ? t("A passed mastery check proved it.")
            : t("Your answers here cleared the bar.");
        case 'fading': return estimate.lastEvidenceAt
            ? t("Last answered {{date}}. A recall question will bring it back to your feed.", { date: day(estimate.lastEvidenceAt) })
            : t("A recall question will bring it back to your feed.");
        case 'practice': return deck
            ? t("These are your own ratings of its cards, not a test.")
            : t("Your cards and drills say you know it. A quiz or the mastery check proves it.");
        case 'few': return t("A few more answers and the app can tell.");
        case 'close': return deck
            ? t("Keep rating its cards.")
            : t("More right answers, or the mastery check, will prove it.");
        case 'early': return t("Your answers so far say you are still learning it.");
    }
}

/** The word, the number and the line: the same block on the panel and atop the dialog. */
function EstimateSummary({ trail }: { trail: EvidenceTrail }) {
    const { t } = useTranslation();
    const day = useDay();
    const { estimate } = trail;
    // A deck has no proof, only card ratings, and its estimate stops at the
    // practice ceiling (60%) however well the cards go: it shows the ratings.
    const deck = trail.projectKind === 'deck';
    const value = deck
        ? (estimate.practiceTotal > 0 && estimate.level !== 'none' ? estimate.practiceRight / estimate.practiceTotal : null)
        : estimate.score;
    // Too few answers say nothing yet, and a fading topic's number is the one
    // it had when last answered (it does not decay): neither gets a bar that
    // reads as "now".
    // A skipped topic is closed: its heading says so, and no number beside it.
    const shown = value != null && estimate.level !== 'few' && trail.status !== 'skipped';
    const bar = shown && estimate.level !== 'fading';
    // Cards and drills lifted the number over what the answers give, and the
    // trail's steps end at the answers' number: say so, or the two disagree.
    const lifted = !deck && estimate.level !== 'practice' && estimate.score != null && estimate.answersScore != null
        && pct(estimate.score) > pct(estimate.answersScore);
    // The other way round: the steps (the chart's line) end higher than the
    // number, because missed practice lowered it (the gate keeps the lower).
    const steps = chartPoints(trail.rows);
    const lastStep = steps.length ? steps[steps.length - 1].value : null;
    // Only with practice to blame: without it the gap is the rates drifting
    // since the score was stored, and "missed practice" would be untrue.
    const lowered = shown && !deck && !lifted && estimate.level !== 'fading' && estimate.score != null
        && (estimate.practiceTotal ?? 0) > 0 && lastStep != null && pct(estimate.score) < pct(lastStep);
    return (
        <div className="space-y-1.5">
            {/* The label and the answer on lines of their own: run together
                they read as one odd sentence ("...you know Proven"). */}
            <div>
                <p className="flex items-center gap-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">
                    <Gauge className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    {t("What the app thinks you know")}
                </p>
                <p className="mt-0.5 text-base font-semibold text-slate-900 dark:text-white">
                    {t(trail.status === 'skipped'
                        ? SKIPPED_WORD
                        : deck && estimate.level === 'practice' ? DECK_PRACTICE_WORD : LEVEL_WORD[estimate.level])}
                </p>
            </div>
            {shown && value != null && (
                <div className="space-y-1">
                    {bar && (
                        // The proof line is drawn on the bar (a deck has none):
                        // a tick that stands out above and below the track, so
                        // it reads against the fill and the empty part alike.
                        <div className="relative py-0.5">
                            <ProgressBar
                                value={pct(value)}
                                tone={LEVEL_TONE[estimate.level]}
                                size="sm"
                                label={t("What the app thinks you know")}
                            />
                            {!deck && (
                                <span
                                    aria-hidden="true"
                                    className="absolute inset-y-0 w-0.5 -translate-x-1/2 rounded-sm bg-slate-800 dark:bg-slate-100"
                                    style={{ left: `${pct(trail.threshold)}%` }}
                                />
                            )}
                        </div>
                    )}
                    <p className="text-xs tabular-nums text-slate-600 dark:text-slate-300">
                        {deck
                            ? t("Reviews remembered: {{right}} of {{total}}",{ right: estimate.practiceRight, total: estimate.practiceTotal })
                            : estimate.level === 'fading'
                                ? t("The app was {{pct}}% sure when you last answered it", { pct: pct(value) })
                                : t("The app is {{pct}}% sure you know it", { pct: pct(value) })}
                        {/* The line goes with the bar: a fading topic has none and is already proven. */}
                        {bar && !deck && <> · {t("{{bar}}% counts as proven", { bar: pct(trail.threshold) })}</>}
                    </p>
                    {lifted && estimate.answersScore != null && (
                        <p className="text-xs tabular-nums text-slate-600 dark:text-slate-300">
                            {t("Your answers alone give {{pct}}%; cards and drills lifted it.", { pct: pct(estimate.answersScore) })}
                        </p>
                    )}
                    {lowered && lastStep != null && (
                        <p className="text-xs tabular-nums text-slate-600 dark:text-slate-300">
                            {t("Your answers here reached {{pct}}%; missed practice lowered it.", { pct: pct(lastStep) })}
                        </p>
                    )}
                </div>
            )}
            {/* One line: a skipped topic says so instead of what the answers
                say. "Still learning it" would contradict the lowered line
                (the answers did well); every other level's line still holds. */}
            {!(lowered && estimate.level === 'early') && (
                <p className="text-xs text-slate-500 dark:text-slate-400">
                    {trail.status === 'skipped' ? t("You skipped it: closed without proof.") : levelLine(t, trail, day)}
                </p>
            )}
        </div>
    );
}

/** "Feed question", "Recall question", "Mastery check", ... */
function kindText(t: (s: string, o?: Record<string, unknown>) => string, row: EvidenceRow): string {
    if (row.type === 'quiz' && row.total === 1) return row.recall ? t("Recall question") : t("Feed question");
    return t(KIND_LABEL[row.type] ?? "Quiz");
}

/** "Right", "Wrong" (one graded answer), or "4 of 5 right" / "4 of 5 remembered". */
function resultText(t: (s: string, o?: Record<string, unknown>) => string, row: EvidenceRow): string {
    if (row.type === 'quiz' && row.total === 1) return row.score >= 1 ? t("Right") : t("Wrong");
    return row.type === 'flashcard'
        ? t("{{score}} of {{total}} remembered", { score: row.score, total: row.total })
        : t("{{score}} of {{total}} right", { score: row.score, total: row.total });
}

/**
 * One answer or sitting. On a deck the step and the "practice" tag are left
 * out: the card above shows ratings, not the estimate they would step, and a
 * deck has nothing but practice.
 */
function EvidenceRowItem({ row, deck, onOpen }: { row: EvidenceRow; deck: boolean; onOpen: (id: number) => void }) {
    const { t } = useTranslation();
    const day = useDay();
    const single = row.type === 'quiz' && row.total === 1;
    const kind = kindText(t, row);
    const practice = !deck && (row.type === 'flashcard' || row.type === 'drill');
    // Right or wrong only for one graded answer; a card is the learner's press.
    const right = single ? row.score >= 1 : null;
    return (
        // No wrap: the flag stays at the row's top right on a phone too.
        <li className="flex items-start gap-3 py-3">
            <span className="w-14 shrink-0 pt-0.5 text-xs tabular-nums text-slate-500 dark:text-slate-400">{day(row.at)}</span>
            <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
                    <span className="font-medium text-slate-800 dark:text-slate-100">{kind}</span>
                    <span className={right === true
                        ? 'text-emerald-700 dark:text-emerald-400'
                        : right === false ? 'text-red-700 dark:text-red-400' : 'text-slate-600 dark:text-slate-300'}
                    >
                        {resultText(t, row)}
                    </span>
                </p>
                {row.question && (
                    <p className="mt-0.5 break-words text-sm text-slate-600 dark:text-slate-300">{row.question}</p>
                )}
                {row.voided > 0 && (
                    <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                        {t("{{count}} question you reported was left out of the score", { count: row.voided })}
                    </p>
                )}
                {/* What each answer did to the number is the chart's to show;
                    a row only says when it is not on the chart, and why. */}
                {(practice || row.type === 'placement') && (
                    <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                        {practice ? t("Practice: not counted as proof") : t("Set the head start")}
                    </p>
                )}
                {row.reviewable && (
                    // Its own line, pulled left by its padding so its icon
                    // lines up with the text above at every width.
                    <Button
                        variant="quiet"
                        size="sm"
                        className="-ml-2.5 mt-0.5"
                        onClick={() => onOpen(row.id)}
                        icon={<ListChecks className="h-4 w-4" aria-hidden="true" />}
                    >
                        {t("See the answers")}
                    </Button>
                )}
            </div>
            {row.ref && (
                <ReportItem
                    itemRef={row.ref}
                    surface="topic"
                    shown={{ correct: right ?? undefined }}
                    listed
                    // No reload on a report: a one-answer row with its answer
                    // taken out is deleted, and its Undo would go with it. The
                    // panel reads the trail again when the dialog closes.
                    className="-mt-1"
                />
            )}
        </li>
    );
}

function EvidenceDialog({ trail, onClose, onChanged }: { trail: EvidenceTrail; onClose: () => void; onChanged: () => void }) {
    const { t } = useTranslation();
    const [reviewing, setReviewing] = useState<number | null>(null);
    const day = useDay();
    const held = trail.count;
    const points = useMemo(() => chartPoints(trail.rows), [trail.rows]);
    // A line needs two answers, and a deck has no steps. Under "too early to
    // tell" the card hides the number, so the chart does not show it either.
    // A fading topic has no bar for the same reason it gets no line: the
    // estimate does not decay, so a line ending high would read as "now".
    const chart = trail.projectKind !== 'deck' && points.length >= 2
        && trail.estimate.level !== 'few' && trail.estimate.level !== 'none'
        && trail.estimate.level !== 'fading' && trail.status !== 'skipped';
    return (
        <Modal isOpen onClose={onClose} title={trail.title} maxWidth="max-w-2xl">
            {reviewing != null ? (
                <SittingReviewView
                    evidenceId={reviewing}
                    // A question reported in there changed the score: read it again.
                    onBack={() => { setReviewing(null); onChanged(); }}
                    onLeave={onClose}
                    backLabel={t("Back to the evidence")}
                />
            ) : (
                <div>
                    <EstimateSummary trail={trail} />
                    {chart && (
                        <div className="mt-5">
                            <EstimateChart
                                points={points}
                                threshold={trail.threshold}
                                day={day}
                                describe={row => `${kindText(t, row)} · ${resultText(t, row)}`}
                            />
                        </div>
                    )}
                    <h3 className="mt-5 flex items-center gap-1.5 text-sm font-semibold text-slate-800 dark:text-slate-100">
                        <History className="h-4 w-4 shrink-0 text-slate-500 dark:text-slate-400" aria-hidden="true" />
                        {t("Evidence, newest first")}
                    </h3>
                    {trail.rows.length === 0 ? (
                        <p className="py-6 text-sm text-slate-500 dark:text-slate-400">{t("Nothing answered on this topic yet.")}</p>
                    ) : (
                        <ul className="divide-y divide-slate-200 dark:divide-slate-700">
                            {trail.rows.map(row => <EvidenceRowItem key={row.id} row={row} deck={trail.projectKind === 'deck'} onOpen={setReviewing} />)}
                        </ul>
                    )}
                    {held > trail.rows.length && (
                        <p className="pt-2 text-xs text-slate-500 dark:text-slate-400">
                            {t("The newest {{shown}} of {{total}}.", { shown: trail.rows.length, total: held })}
                        </p>
                    )}
                </div>
            )}
        </Modal>
    );
}

/**
 * The topic panel's block. `refreshKey` changes when the topic's status does,
 * so a check passed elsewhere shows here without reopening the topic.
 */
export default function TopicEvidence({ nodeId, refreshKey }: { nodeId: number; refreshKey?: string }) {
    const { t } = useTranslation();
    const [trail, setTrail] = useState<EvidenceTrail | null>(null);
    const [open, setOpen] = useState(false);

    // Only the newest read lands: two reloads (a closed dialog, then another
    // topic) can answer out of order, and the older one must not win.
    const latest = useRef(0);
    const load = useCallback(() => {
        const ask = ++latest.current;
        api.getEvidenceTrail(nodeId)
            .then(d => { if (ask === latest.current) setTrail(d); })
            .catch(() => { /* a panel block, not worth a toast */ });
    }, [nodeId]);

    useEffect(() => { setTrail(null); }, [nodeId]);
    useEffect(() => {
        load();
        return () => { latest.current++; };
    }, [load, refreshKey]);
    // An answer, a card rating or a report anywhere (the study tools under
    // this card, the feed beside it) may have moved this topic: read it again,
    // once per burst, since a card session writes once per card.
    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const changed = () => { clearTimeout(timer); timer = setTimeout(load, 400); };
        window.addEventListener(EVIDENCE_CHANGED, changed);
        return () => { clearTimeout(timer); window.removeEventListener(EVIDENCE_CHANGED, changed); };
    }, [load]);

    if (!trail || trail.nodeId !== nodeId) return null;
    const held = trail.count;
    return (
        <div className="space-y-2 rounded-lg border border-slate-200/60 bg-slate-50 p-3 dark:border-slate-700/60 dark:bg-slate-900/40">
            <EstimateSummary trail={trail} />
            {held > 0 && (
                <Button
                    variant="neutral"
                    size="sm"
                    onClick={() => setOpen(true)}
                    icon={<History className="h-4 w-4" aria-hidden="true" />}
                >
                    {t("See the evidence ({{n}})", { n: held })}
                </Button>
            )}
            {open && (
                <EvidenceDialog
                    trail={trail}
                    onClose={() => { setOpen(false); load(); }}
                    onChanged={load}
                />
            )}
        </div>
    );
}
