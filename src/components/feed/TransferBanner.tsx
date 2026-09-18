import { useStore } from '../../store';
import { TransferInfo } from '../../types';
import { ArrowUpRight, Sparkles, Trophy } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface Props {
    transfer: TransferInfo;
    nodeId: number;
    nodeTitle: string;
    projectId: number;
    /** Gate mode decides whether the Boss Fight is advisory (see MasteryGateModal). */
    gateMode?: 'off' | 'advisory' | 'enforced';
}

/**
 * "You have studied this before, somewhere else."
 *
 * A learner running several projects meets the same topic twice — Fourier
 * series in a signals course and in a maths course, standing waves in an
 * English curriculum and a Dutch one — and the engine used to treat the second
 * meeting as a stranger: mastery from zero, four lessons, prove it again.
 * Topic embeddings can now recognise the twin (server/masteryTransfer.js), and
 * this is where that recognition becomes something the learner can use.
 *
 * The offer is the point. A banner that only *said* "you've seen this" would be
 * trivia; the two buttons are what turn a recognised repeat into saved time —
 * take the assessment now and close the topic without reading the chapter, or
 * open the twin to remind yourself first. The head start itself is soft by
 * design: it seeds the mastery estimate, is capped below the threshold, and
 * never closes the gate. So this banner offers a shortcut through the
 * *teaching*, and the proving still happens here — which is also why it leads
 * with the Boss Fight rather than a "mark it done" button.
 *
 * Once the learner has answered anything on this topic the head start is
 * `spent`: it still explains why the estimate did not start at zero, but it is
 * no longer an offer, so it collapses to a single quiet line.
 */
export default function TransferBanner({ transfer, nodeId, nodeTitle, projectId, gateMode = 'advisory' }: Props) {
    const { t } = useTranslation();
    const openMasteryGate = useStore(s => s.openMasteryGate);
    const openProjectNode = useStore(s => s.openProjectNode);

    const best = transfer.sources[0];
    if (!best) return null;
    const others = transfer.sources.length - 1;
    const priorPct = Math.round(transfer.prior * 100);

    if (transfer.spent) {
        return (
            <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 px-4 sm:px-6 py-2 text-sm text-slate-500 dark:text-slate-400 border-b border-slate-100 dark:border-slate-700/70">
                <Sparkles className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                <span>
                    {t("Started at {{priorPct}}% because you proved", { priorPct })}{' '}
                    <button
                        onClick={() => openProjectNode(best.project_id, best.node_id)}
                        className="font-medium text-accent-fg hover:underline"
                    >
                        {best.title}
                    </button>{t("in {{project_name}}.", { project_name: best.project_name })}
                </span>
            </p>
        );
    }

    return (
        <div className="px-4 sm:px-6 py-3 border-b border-slate-100 dark:border-slate-700/70 bg-accent/5">
            <p className="flex items-center gap-1.5 mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-accent-fg">
                <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
                {t("You've covered this before")}
            </p>
            <p className="text-sm text-slate-700 dark:text-slate-200">
                {t("You proved")}{' '}
                <button
                    onClick={() => openProjectNode(best.project_id, best.node_id)}
                    className="font-semibold text-accent-fg hover:underline"
                >
                    {best.title}
                </button>{' '}<span className="font-medium">{t("in {{project}}", { project: best.project_name })}</span>
                {others > 0 && <> {t("(and {{count}} other topics)", { count: others })}</>}{t(", which looks like the same material — so this one starts at {{priorPct}}% instead of zero.", { priorPct })}
            </p>
            {/* The head start is on the teaching, never on the proof: this topic
                still has to be passed here, and saying so keeps the estimate
                honest rather than letting a borrowed number look earned. */}
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                {t("You still need to prove it here — skip ahead and take the check if you already know it.")}
            </p>
            <div className="flex flex-wrap items-center gap-2 mt-2.5">
                <button
                    onClick={() => openMasteryGate(nodeId, nodeTitle, gateMode !== 'enforced', projectId)}
                    className="flex items-center gap-1.5 px-3 py-2 min-h-11 rounded-lg text-sm font-medium bg-accent text-white hover:brightness-90 transition"
                >
                    <Trophy className="w-4 h-4" aria-hidden="true" />
                    {t("Prove it now")}
                </button>
                <button
                    onClick={() => openProjectNode(best.project_id, best.node_id)}
                    className="flex items-center gap-1.5 px-3 py-2 min-h-11 rounded-lg text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition"
                >
                    <ArrowUpRight className="w-4 h-4" aria-hidden="true" />
                    {t("Open what you proved")}
                </button>
            </div>
        </div>
    );
}
