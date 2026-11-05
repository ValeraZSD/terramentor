import { useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import { useStore } from '../../store';
import { FeedCheckpointCard } from '../../types';
import { Award, CheckCircle2, ShieldAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/Button';
import ProgressBar from '../ui/ProgressBar';
import { isReadyToProve } from '../../utils/tree';
import { useElementWidth } from '../../hooks/useElementWidth';
import { useRootFontSize } from '../../hooks/useRootFontSize';

/**
 * Under this width (in rem) the two actions stack, each the card's width, the
 * primary on top: side by side they need about 27rem, and wrapped at their own
 * widths the primary landed alone on a second line at the far edge.
 */
const STACK_BELOW_REM = 28;

interface Props {
    card: FeedCheckpointCard;
    done: boolean;
    onDone: (key: string) => void;
}

/**
 * The chapter's closing section: the feed has served everything it has for this
 * node. Shows the learner's feed accuracy + BKT mastery and how the topic ends.
 *
 * While the gate is on and the topic is not proven, the mastery check IS how it
 * ends: the one primary, with one sentence saying what it is. Closing it
 * without the check stays one press away (Skip is always allowed; advisory may
 * also mark it done), as a quiet button that says it goes without the check.
 * Two outlined buttons of one size read as two equal ways out, and the test
 * looked skippable. Proven, or with the gate off, completing is the finish and
 * leads. Guard: `tools/finish-topic-gates.mjs`.
 *
 * "Take the mastery check" opens the gate modal RIGHT HERE. Navigating into the
 * workspace instead would leave the learner staring at a node detail panel,
 * having to find the mastery check themselves — three taps and a lost scroll
 * position to reach the thing they just asked for. The modal is mounted in
 * Layout precisely so the feed can open it (see store.masteryGate).
 */
export default function CheckpointCard({ card: composed, done, onDone }: Props) {
    const { t } = useTranslation();
    // The card stands at the END of its topic from the moment every part is
    // written, so it is often composed before the parts above it are read and
    // its numbers are the topic's as it was then. Each SAVED answer in the
    // topic (`feedSavedByNode`, bumped after the write resolved) asks again.
    const savedHere = useStore(s => s.feedSavedByNode[composed.nodeId] ?? 0);
    const [live, setLive] = useState<Awaited<ReturnType<typeof api.getCheckpointFacts>> | null>(null);
    // The check modal closing on THIS topic asks again too: a pass, or a
    // retake of a topic marked done without it, is closed with the modal's own
    // buttons, which tell this card nothing.
    const gateOnHere = useStore(s => s.masteryGate.isOpen && s.masteryGate.nodeId === composed.nodeId);
    const [gateClosedHere, setGateClosedHere] = useState(0);
    const gateWasOnHere = useRef(false);
    useEffect(() => {
        if (gateOnHere) gateWasOnHere.current = true;
        else if (gateWasOnHere.current) { gateWasOnHere.current = false; setGateClosedHere(n => n + 1); }
    }, [gateOnHere]);
    // Refusals so far: facts asked for before a refusal must not clear it.
    const refusals = useRef(0);
    useEffect(() => {
        if (gateClosedHere === 0 && (savedHere === 0 || done)) return;
        let stale = false;
        const seen = refusals.current;
        // Fresh facts supersede a refusal: the answers since may have proven it.
        api.getCheckpointFacts(composed.nodeId).then(f => {
            if (stale) return;
            setLive(f);
            if (refusals.current === seen) setGateMsg(null);
            // Proven since it was marked done (a retake passed): it reads as passed.
            if (f.eligible) setOverrodeHere(false);
        }).catch(() => { });
        return () => { stale = true; };
    }, [savedHere, gateClosedHere, done, composed.nodeId]);
    const card: FeedCheckpointCard = live ? { ...composed, ...live } : composed;
    const ready = card.isOverdue && isReadyToProve({ scheduled_end: card.scheduledEnd, provable: card.eligible });
    const addToast = useStore(s => s.addToast);
    const openMasteryGate = useStore(s => s.openMasteryGate);
    const skipNode = useStore(s => s.skipNode);
    const [saving, setSaving] = useState(false);
    const [gateMsg, setGateMsg] = useState<{ advisory: boolean; masteryScore: number; threshold: number } | null>(null);
    // Skipped from this card: `done` alone would print "Topic completed".
    const [skippedHere, setSkippedHere] = useState(false);
    // Marked done from this card without the check: it must not read as passed.
    const [overrodeHere, setOverrodeHere] = useState(false);

    // A refusal names the mode the server is in, which beats the one this card
    // was composed under (the setting may have changed since).
    const gateMode = gateMsg ? (gateMsg.advisory ? 'advisory' : 'enforced') : card.gateMode;

    const startMasteryCheck = () => {
        // A topic closed without proof may still take it (the modal runs a retake).
        if (saving || (done && !unproven)) return;
        openMasteryGate(
            card.nodeId,
            card.nodeTitle,
            gateMode !== 'enforced',
            card.projectId,
            // The modal closes the topic three ways; only a pass reads as one.
            ({ outcome, proven }) => {
                if (outcome === 'skipped') setSkippedHere(true);
                else if (!proven) setOverrodeHere(true);
                onDone(card.key);
            },
        );
    };

    const masteryPct = Math.round(card.masteryScore * 100);
    const accuracyPct = card.feedTotal > 0 ? Math.round((card.feedCorrect / card.feedTotal) * 100) : null;

    const complete = async (override = false) => {
        if (saving || done) return;
        setSaving(true);
        try {
            await api.updateNode(card.nodeId, override
                ? { status: 'completed', override: true }
                : { status: 'completed' });
            addToast('success', t("\"{{nodeTitle}}\" completed", { nodeTitle: card.nodeTitle }));
            if (override) setOverrodeHere(true);
            onDone(card.key);
        } catch (e: any) {
            const data = e?.data;
            if (data?.mastery_gate) {
                refusals.current += 1;
                setGateMsg({
                    advisory: !!data.advisory,
                    masteryScore: data.mastery_score ?? card.masteryScore,
                    threshold: data.threshold ?? 0.85,
                });
            } else {
                addToast('error', t("Failed to complete topic"), e.message);
            }
        } finally {
            setSaving(false);
        }
    };

    // Skip bypasses the gate entirely (server-side) — always allowed, in every
    // gate mode, so it must stay reachable from this surface too, not just the
    // workspace's mastery check modal.
    const skip = async () => {
        if (saving || done) return;
        setSaving(true);
        try {
            const ok = await skipNode(card.nodeId);
            if (ok) { setSkippedHere(true); onDone(card.key); }
        } finally {
            setSaving(false);
        }
    };

    const rootRef = useRef<HTMLDivElement>(null);
    const width = useElementWidth(rootRef);
    const rootPx = useRootFontSize();
    // 0 = not measured yet: side by side, which is what a wide card draws.
    const stack = width > 0 && width < STACK_BELOW_REM * rootPx;

    const skipped = skippedHere || (!done && card.nodeStatus === 'skipped');
    const completed = !skippedHere && (done || card.nodeStatus === 'completed');
    // Closed without proof: marked done here, or found completed while the
    // gate is on and the evidence does not pass. Not when `done` came from
    // elsewhere (a passed check closes it too, and these facts predate it).
    const unproven = overrodeHere
        || (!done && card.nodeStatus === 'completed' && gateMode !== 'off' && !card.eligible);
    // The server refused a completion the card thought proven: it is not.
    const proven = card.eligible && !gateMsg;
    const checkLeads = gateMode !== 'off' && !proven;

    // One row, primary LAST; stacked on a narrow card the primary comes FIRST,
    // in the DOM too, so the tab order is the order on screen.
    const row = `flex gap-2 ${stack ? 'flex-col' : 'flex-wrap items-center justify-end'}`;
    const inOrder = (...buttons: React.ReactNode[]) => (stack ? buttons.reverse() : buttons);
    const checkButton = (variant: 'primary' | 'neutral') => (
        <Button key="check" variant={variant} block={stack} wrap={stack} onClick={startMasteryCheck} disabled={saving}>
            {t("Take the mastery check")}
        </Button>
    );

    return (
        <div ref={rootRef} className="rounded-xl border border-accent/30 bg-accent/5 p-4">
            <p className="flex items-center gap-1.5 mb-3 text-2xs font-semibold text-accent-fg">
                <Award className="w-3.5 h-3.5" aria-hidden="true" />
                {t("End of chapter")}
            </p>

            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 mb-3">
                {accuracyPct != null && (
                    <div>
                        <p className="text-2xl font-bold text-slate-900 dark:text-white tabular-nums">
                            {card.feedCorrect}/{card.feedTotal}
                        </p>
                        <p className="text-sm text-slate-500 dark:text-slate-400">{t("questions here ({{accuracyPct}}%)", { accuracyPct })}</p>
                    </div>
                )}
                <div className="flex-1 min-w-[140px]">
                    <div className="flex items-baseline justify-between mb-1">
                        <span className="text-xs text-slate-500 dark:text-slate-400">{t("Estimated mastery")}</span>
                        <span className="text-sm font-semibold text-slate-800 dark:text-slate-100 tabular-nums">{masteryPct}%</span>
                    </div>
                    <ProgressBar value={masteryPct} decorative />
                    {/* Otherwise a healthy-looking bar sits next to a refusal to
                        complete and reads as a bug. Part of it was borrowed —
                        from a topic proven in another project or from a
                        placement answer — and a borrowed estimate can't close a
                        gate; only answers here can. Named by source, because
                        "a topic you proved elsewhere" is false of a placement. */}
                    {card.borrowedEstimate && (
                        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                            {card.borrowedFrom === 'placement'
                                ? t("Part of this came from your placement answer — answer a few here to make it count.")
                                : t("Part of this was carried over from a topic you proved elsewhere — answer a few here to make it count.")}
                        </p>
                    )}
                </div>
            </div>

            {/* Late and already known well enough to pass: this card IS the
                check that closes it, so it says that, not "behind schedule"
                in red (`isReadyToProve`, src/utils/tree.ts). */}
            {card.deadline && (
                <p className={`text-xs mb-3 ${card.isOverdue && !ready
                    ? 'text-red-700 dark:text-red-400'
                    : 'text-slate-500 dark:text-slate-400'}`}
                >
                    {ready ? t("Ready to prove ·") : card.isOverdue ? t("This topic is behind schedule ·") : ''}
                    {t("{{count}} days to the project deadline", { count: card.deadline.daysLeft })}
                </p>
            )}

            {completed && unproven ? (
                // Closed without proof (here, or earlier: how it was closed is
                // not stored, so the line says only what is true now). The
                // check stays on offer: passing it later proves the topic.
                <>
                    <p role="status" className="mb-3 text-sm text-slate-600 dark:text-slate-300">{t("Completed, not proven yet")}</p>
                    <div className={row}>{checkButton('neutral')}</div>
                </>
            ) : completed ? (
                <p role="status" className="flex items-center gap-1.5 text-sm font-medium text-emerald-700 dark:text-emerald-300">
                    <CheckCircle2 className="w-4 h-4" aria-hidden="true" />
                    {t("Topic completed")}
                </p>
            ) : skippedHere ? (
                <p role="status" className="text-sm text-slate-600 dark:text-slate-300">{t("Skipped — moved on without proving it")}</p>
            ) : checkLeads ? (
                <>
                    {gateMsg && (
                        <p role="alert" className="flex items-center gap-1.5 mb-1 text-sm font-medium text-amber-700 dark:text-amber-300">
                            <ShieldAlert className="w-4 h-4 shrink-0" aria-hidden="true" />
                            {t("Not proven yet ({{round}}% of {{round2}}% needed)", { round: Math.round(gateMsg.masteryScore * 100), round2: Math.round(gateMsg.threshold * 100) })}
                        </p>
                    )}
                    <p className="mb-3 text-sm text-slate-600 dark:text-slate-300">
                        {/* Advisory may close it without the check, so "pass it
                            to finish" would contradict the button beside it. */}
                        {skipped
                            ? t("Skipped — moved on without proving it")
                            : gateMode === 'advisory'
                                ? t("The mastery check is a short test on this topic. Pass it to show you know it.")
                                : t("The mastery check is a short test on this topic. Pass it to finish the topic.")}
                    </p>
                    {/* The ways out without the check: quiet, and named for what
                        they do. Advisory may mark it done; enforced may only
                        skip it, and a topic already skipped has neither. */}
                    <div className={row}>
                        {inOrder(
                            skipped ? null : gateMode === 'advisory' ? (
                                <Button key="out" variant="quiet" block={stack} wrap={stack} onClick={() => complete(true)} busy={saving}>
                                    {t("Mark done without the check")}
                                </Button>
                            ) : (
                                <Button key="out" variant="quiet" block={stack} wrap={stack} onClick={skip} busy={saving}>
                                    {t("Skip topic")}
                                </Button>
                            ),
                            checkButton('primary'),
                        )}
                    </div>
                </>
            ) : (
                // Proven, or the gate is off: completing is the finish. Proven,
                // the check stays beside it for anyone who wants the rep; with
                // the test switched off it is not offered (two strangers read a
                // test button there as a test they had to take, twice).
                <>
                    {skipped && (
                        <p className="mb-3 text-sm text-slate-600 dark:text-slate-300">{t("Skipped — moved on without proving it")}</p>
                    )}
                    <div className={row}>
                        {inOrder(
                            gateMode !== 'off' && checkButton('neutral'),
                            <Button key="complete" variant="primary" block={stack} wrap={stack} onClick={() => complete(false)} busy={saving}>
                                {t("Complete topic")}
                            </Button>,
                        )}
                    </div>
                </>
            )}
        </div>
    );
}
