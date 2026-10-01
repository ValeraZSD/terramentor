import { useStore } from '../../store';
import { PlacementHeadStart, TransferInfo } from '../../types';
import { Compass, ShieldCheck, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/Button';

interface Props {
    transfer: TransferInfo | null;
    placement: PlacementHeadStart | null;
    nodeId: number;
    nodeTitle: string;
    projectId: number;
    /** Gate mode decides whether the mastery check is advisory (see MasteryGateModal). */
    gateMode?: 'off' | 'advisory' | 'enforced';
    /**
     * The chapter already ends in its checkpoint: the topic has been taught,
     * so there is nothing left to skip, and the checkpoint below carries the
     * same check. Offering it twice, one card above the other, was the first
     * walk's finding.
     */
    taughtOut?: boolean;
}

/**
 * "You know some of this already" — a HEAD START, said where it pays off.
 *
 * Two features hand a topic an estimate it did not earn here
 * (server/headStart.js): a proven twin in another project (transfer), and a
 * correct placement answer, on this topic or one later in its section. Both
 * change the same three things — the lessons are planned as a short review, the
 * mastery check is written early, and the schedule gives the topic less time —
 * so both end in the same offer, and it is the offer that matters. A banner
 * that only SAID "you've seen this" would be trivia; "Prove it now" is what
 * turns it into saved time: pass the check and the topic is done without the
 * review. Fail it and the head start is withdrawn (the learner's own answers
 * outrank a seed); the plan grows back to full length only if nothing of the
 * topic has been read yet (`planIsStale` in feedGen.js), otherwise the review
 * already under way runs to its end.
 *
 * It leads with the check, never with "mark it done": the head start is on the
 * TEACHING, and the estimate it gives is capped below every gate, so proving
 * still happens here.
 *
 * One banner per chapter. With both sources present, the one that set the
 * estimate speaks (they combine by MAX); a tie goes to transfer, which can
 * point at the topic that was proven.
 *
 * Once the learner has answered anything on this topic the head start is
 * `spent`, and once the chapter has reached its checkpoint it is `taughtOut`:
 * either way still worth explaining (it is why the estimate did not start at
 * zero), no longer an offer, so it collapses to one quiet line.
 */
export default function HeadStartBanner({ transfer, placement, nodeId, nodeTitle, projectId, gateMode = 'advisory', taughtOut = false }: Props) {
    const { t } = useTranslation();
    const openMasteryGate = useStore(s => s.openMasteryGate);
    const openProjectNode = useStore(s => s.openProjectNode);

    const best = transfer?.sources[0] ?? null;
    const fromTransfer = !!(transfer && best && (!placement || transfer.prior >= placement.prior));
    const info = fromTransfer ? transfer : placement;
    if (!info) return null;
    const priorPct = Math.round(info.prior * 100);

    // A placement head start on a taught-out chapter nobody has answered on:
    // the checkpoint right below already says "Part of this came from your
    // placement answer" (it always does while the estimate is borrowed), and
    // the same sentence twice, one card apart, was the second walk's finding.
    // A transfer keeps its line — it names the proven topic and links to it.
    if (taughtOut && !info.spent && !fromTransfer) return null;
    if (info.spent || taughtOut) {
        // The icon holds the first line and the text wraps beside it. As a
        // wrapping flex row, a phone put the icon alone on a row of its own and
        // "Open it" on a third (the first walk, 390px).
        return (
            <p className="flex items-start gap-1.5 px-4 sm:px-6 py-2 text-sm text-slate-500 dark:text-slate-400 border-b border-slate-100 dark:border-slate-700/70">
                <Sparkles className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden="true" />
                <span className="min-w-0">
                    {fromTransfer && best
                        ? t("Started at {{priorPct}}% because you proved “{{title}}” in {{project}}.", { priorPct, title: best.title, project: best.project_name })
                        : t("Started at {{priorPct}}% from your placement answer.", { priorPct })}
                    {fromTransfer && best && (
                        <>
                            {' '}
                            <button
                                onClick={() => openProjectNode(best.project_id, best.node_id)}
                                className="font-medium text-accent-fg hover:underline"
                            >
                                {t("Open it")}
                            </button>
                        </>
                    )}
                </span>
            </p>
        );
    }

    // The second line says what the head start DID to this topic. "Short
    // review" only when the plan really was written as one: a sequence written
    // before the head start existed, and already started, keeps its length.
    const consequence = info.review
        ? t("It's taught as a short review, and it still has to be proven: take the check now if you already know it.")
        : fromTransfer
            ? t("You still need to prove it here — skip ahead and take the check if you already know it.")
            : t("It still has to be proven: take the check now if you already know it.");

    return (
        <div className="px-4 sm:px-6 py-3 border-b border-slate-100 dark:border-slate-700/70 bg-accent/5">
            <p className="flex items-center gap-1.5 mb-1.5 text-2xs font-semibold text-accent-fg">
                {fromTransfer
                    ? <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
                    : <Compass className="w-3.5 h-3.5" aria-hidden="true" />}
                {fromTransfer ? t("You've covered this before") : t("Placement head start")}
            </p>
            {/* One key per sentence, the proven topic as plain text: split
                around a link, the sentence reached translators as four
                fragments (i18n-source-gates listed it as a known split). The
                link is the "Open what you proved" button below. */}
            {fromTransfer && best ? (
                <p className="text-sm text-slate-700 dark:text-slate-200">
                    {transfer!.sources.length > 1
                        ? t("You proved “{{title}}” in {{project}} and {{count}} other topics, which look like the same material, so this one starts at {{priorPct}}% instead of zero.", { title: best.title, project: best.project_name, count: transfer!.sources.length - 1, priorPct })
                        : t("You proved “{{title}}” in {{project}}, which looks like the same material, so this one starts at {{priorPct}}% instead of zero.", { title: best.title, project: best.project_name, priorPct })}
                </p>
            ) : (
                <p className="text-sm text-slate-700 dark:text-slate-200">
                    {placement!.kind === 'implied' && placement!.via
                        ? t("Your correct placement answer on “{{title}}”, later in this section, suggests you know this too, so it starts at {{priorPct}}% instead of zero.", { title: placement!.via.title, priorPct })
                        : t("You answered this topic's placement question correctly, so it starts at {{priorPct}}% instead of zero.", { priorPct })}
                </p>
            )}
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{consequence}</p>
            <div className="flex flex-wrap items-center gap-2 mt-2.5">
                <Button
                    variant="primary"
                    icon={<ShieldCheck className="w-4 h-4" aria-hidden="true" />}
                    onClick={() => openMasteryGate(nodeId, nodeTitle, gateMode !== 'enforced', projectId)}
                >
                    {t("Prove it now")}
                </Button>
                {/* No icon: its 22px (16 + the 6px gap) was what pushed this
                    button onto a row of its own on a 390px phone, and the
                    words already say where it goes. */}
                {fromTransfer && best && (
                    <Button
                        variant="quiet"
                        onClick={() => openProjectNode(best.project_id, best.node_id)}
                    >
                        {t("Open what you proved")}
                    </Button>
                )}
            </div>
        </div>
    );
}
