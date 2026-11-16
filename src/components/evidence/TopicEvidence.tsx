import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDownRight, ArrowRight, ArrowUpRight, Gauge, History, ListChecks } from 'lucide-react';
import { api } from '../../api';
import type { EstimateLevel, EvidenceRow, EvidenceTrail } from '../../types';
import { uiLocale } from '../../utils/locale';
import { k } from '../../i18n';
import Modal from '../Modal';
import { Button } from '../ui/Button';
import ProgressBar, { type ProgressTone } from '../ui/ProgressBar';
import ReportItem from '../ui/ReportItem';
import SittingReviewView from '../feed/SittingReviewView';

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
    close: k("Getting there"),
    early: k("Not yet"),
};

const LEVEL_TONE: Record<EstimateLevel, ProgressTone> = {
    none: 'neutral',
    borrowed: 'neutral',
    proven: 'success',
    fading: 'warning',
    practice: 'accent',
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
            ? t("Your card ratings say you know it.")
            : t("Your cards and drills say you know it. A quiz or the mastery check proves it.");
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
    return (
        <div className="space-y-1.5">
            <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
                <span className="flex items-center gap-1.5 font-medium text-slate-700 dark:text-slate-300">
                    <Gauge className="h-4 w-4 shrink-0 text-accent-fg" aria-hidden="true" />
                    {t("What the app thinks you know")}
                </span>
                <span className="font-semibold text-slate-900 dark:text-white">{t(LEVEL_WORD[estimate.level])}</span>
            </p>
            {estimate.score != null && (
                <div className="space-y-1">
                    <ProgressBar
                        value={pct(estimate.score)}
                        tone={LEVEL_TONE[estimate.level]}
                        size="sm"
                        label={t("What the app thinks you know")}
                    />
                    <p className="text-xs tabular-nums text-slate-600 dark:text-slate-300">
                        {t("{{pct}}% sure you know it", { pct: pct(estimate.score) })}
                        {trail.projectKind !== 'deck' && <> · {t("proven at {{bar}}%", { bar: pct(trail.threshold) })}</>}
                    </p>
                </div>
            )}
            <p className="text-xs text-slate-500 dark:text-slate-400">{levelLine(t, trail, day)}</p>
            {trail.status === 'skipped' && (
                <p className="text-xs text-slate-500 dark:text-slate-400">{t("You skipped it: closed without proof.")}</p>
            )}
        </div>
    );
}

/**
 * What one row did to the estimate, as a step in points, or the head start it
 * set. A step, not "from → to": the number above is the one the gate reads
 * (practice taken out), so an absolute end here could disagree with it.
 */
function Moved({ row }: { row: EvidenceRow }) {
    const { t } = useTranslation();
    if (row.type === 'placement') {
        return <span className="text-xs text-slate-500 dark:text-slate-400">{t("Set the head start")}</span>;
    }
    if (row.before == null || row.after == null) return null;
    const step = pct(row.after) - pct(row.before);
    const Icon = step > 0 ? ArrowUpRight : step < 0 ? ArrowDownRight : ArrowRight;
    const tone = step > 0
        ? 'text-emerald-700 dark:text-emerald-400'
        : step < 0 ? 'text-red-700 dark:text-red-400' : 'text-slate-500 dark:text-slate-400';
    return (
        <span className={`inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium tabular-nums ${tone}`}>
            <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {step > 0
                ? t("Raised it {{count}} points", { count: step })
                : step < 0 ? t("Lowered it {{count}} points", { count: -step }) : t("Did not move it")}
        </span>
    );
}

/** "Right", "Wrong" (one graded answer), or "4 of 5 right" / "4 of 5 remembered". */
function resultText(t: (s: string, o?: Record<string, unknown>) => string, row: EvidenceRow): string {
    if (row.type === 'quiz' && row.total === 1) return row.score >= 1 ? t("Right") : t("Wrong");
    return row.type === 'flashcard'
        ? t("{{score}} of {{total}} remembered", { score: row.score, total: row.total })
        : t("{{score}} of {{total}} right", { score: row.score, total: row.total });
}

function EvidenceRowItem({ row, onOpen }: { row: EvidenceRow; onOpen: (id: number) => void }) {
    const { t } = useTranslation();
    const day = useDay();
    const single = row.type === 'quiz' && row.total === 1;
    const kind = single
        ? (row.recall ? t("Recall question") : t("Feed question"))
        : t(KIND_LABEL[row.type] ?? "Quiz");
    const practice = row.type === 'flashcard' || row.type === 'drill';
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
                    {practice && <span className="text-xs text-slate-500 dark:text-slate-400">{t("Practice, not proof")}</span>}
                </p>
                {row.question && (
                    <p className="mt-0.5 line-clamp-2 break-words text-sm text-slate-600 dark:text-slate-300">{row.question}</p>
                )}
                {row.voided > 0 && (
                    <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                        {t("{{count}} reported question taken out", { count: row.voided })}
                    </p>
                )}
                <div className="mt-1">
                    <Moved row={row} />
                </div>
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
    const held = trail.count;
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
                    <h3 className="mt-5 flex items-center gap-1.5 text-sm font-semibold text-slate-800 dark:text-slate-100">
                        <History className="h-4 w-4 shrink-0 text-slate-500 dark:text-slate-400" aria-hidden="true" />
                        {t("Evidence, newest first")}
                    </h3>
                    {trail.rows.length === 0 ? (
                        <p className="py-6 text-sm text-slate-500 dark:text-slate-400">{t("Nothing answered on this topic yet.")}</p>
                    ) : (
                        <ul className="divide-y divide-slate-200 dark:divide-slate-700">
                            {trail.rows.map(row => <EvidenceRowItem key={row.id} row={row} onOpen={setReviewing} />)}
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
