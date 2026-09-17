import { useState } from 'react';
import { api } from '../../api';
import { useStore } from '../../store';
import { FeedCheckpointCard } from '../../types';
import { Award, CheckCircle2, Loader2, ShieldAlert, SkipForward, Trophy } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface Props {
    card: FeedCheckpointCard;
    done: boolean;
    onDone: (key: string) => void;
}

/**
 * The chapter's closing section: the feed has served everything it has for this
 * node. Shows the learner's feed accuracy + BKT mastery and offers one-tap
 * completion through the EXISTING mastery gate (PUT /api/nodes/:id): the
 * advisory 400 is rendered inline with a "mark done anyway" override.
 *
 * "Take the Boss Fight" opens the gate modal RIGHT HERE. It used to navigate
 * into the workspace and leave the learner staring at a node detail panel,
 * having to find the Boss Fight themselves — three taps and a lost scroll
 * position to reach the thing they just asked for. The modal is mounted in
 * Layout precisely so the feed can open it (see store.masteryGate).
 */
export default function CheckpointCard({ card, done, onDone }: Props) {
    const { t } = useTranslation();
    const addToast = useStore(s => s.addToast);
    const openMasteryGate = useStore(s => s.openMasteryGate);
    const skipNode = useStore(s => s.skipNode);
    const [saving, setSaving] = useState(false);
    const [gateMsg, setGateMsg] = useState<{ advisory: boolean; masteryScore: number; threshold: number } | null>(null);

    const startBossFight = () => {
        if (saving || done) return;
        openMasteryGate(
            card.nodeId,
            card.nodeTitle,
            card.gateMode !== 'enforced',
            card.projectId,
            () => onDone(card.key),
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
            onDone(card.key);
        } catch (e: any) {
            const data = e?.data;
            if (data?.mastery_gate) {
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
    // workspace's Boss Fight modal.
    const skip = async () => {
        if (saving || done) return;
        setSaving(true);
        try {
            const ok = await skipNode(card.nodeId);
            if (ok) onDone(card.key);
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="rounded-xl border border-accent/30 bg-accent/5 p-4">
            <p className="flex items-center gap-1.5 mb-3 text-[11px] font-semibold uppercase tracking-wide text-accent-fg">
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
                    <div className="h-2 rounded-full bg-slate-100 dark:bg-slate-700 overflow-hidden">
                        <div className="h-full bg-accent transition-all" style={{ width: `${masteryPct}%` }} />
                    </div>
                    {/* Otherwise a healthy-looking bar sits next to a refusal to
                        complete and reads as a bug. Part of it was borrowed from
                        a topic proven in another project, and a borrowed
                        estimate can't close a gate — only answers here can. */}
                    {card.borrowedEstimate && (
                        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                            {t("Part of this was carried over from a topic you proved elsewhere — answer a few here to make it count.")}
                        </p>
                    )}
                </div>
            </div>

            {card.deadline && (
                <p className={`text-xs mb-3 ${card.isOverdue
                    ? 'text-red-700 dark:text-red-400'
                    : 'text-slate-500 dark:text-slate-400'}`}
                >
                    {card.isOverdue ? t("This topic is behind schedule ·") : ''}
                    {t("{{count}} days to the project deadline", { count: card.deadline.daysLeft })}
                </p>
            )}

            {done ? (
                <p className="flex items-center gap-1.5 text-sm font-medium text-emerald-700 dark:text-emerald-300">
                    <CheckCircle2 className="w-4 h-4" />
                    {t("Topic completed")}
                </p>
            ) : gateMsg ? (
                <div className="p-3 rounded-xl bg-amber-50 dark:bg-amber-900/15 border border-amber-200 dark:border-amber-800/50">
                    <p className="flex items-center gap-1.5 text-sm font-medium text-amber-700 dark:text-amber-300">
                        <ShieldAlert className="w-4 h-4" />
                        {t("Not proven yet ({{round}}% of {{round2}}% needed)", { round: Math.round(gateMsg.masteryScore * 100), round2: Math.round(gateMsg.threshold * 100) })}
                    </p>
                    {gateMsg.advisory ? (
                        <div className="flex flex-wrap gap-2 mt-2">
                            <button
                                onClick={() => complete(true)}
                                disabled={saving}
                                className="px-3 py-2 min-h-11 rounded-lg text-sm font-medium bg-amber-100 text-amber-700 hover:bg-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:hover:bg-amber-900/50 transition"
                            >
                                {t("Mark done anyway")}
                            </button>
                            <button
                                onClick={skip}
                                disabled={saving}
                                className="flex items-center gap-1.5 px-3 py-2 min-h-11 rounded-lg text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition"
                            >
                                <SkipForward className="w-3.5 h-3.5" />
                                {t("Skip")}
                            </button>
                            <button
                                onClick={() => setGateMsg(null)}
                                className="px-3 py-2 min-h-11 rounded-lg text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition"
                            >
                                {t("Not yet")}
                            </button>
                        </div>
                    ) : (
                        <div className="flex flex-wrap gap-2 mt-2">
                            <button
                                onClick={startBossFight}
                                className="flex items-center gap-1.5 px-3 py-2 min-h-11 rounded-lg text-sm font-medium bg-amber-100 text-amber-700 hover:bg-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:hover:bg-amber-900/50 transition"
                            >
                                <Trophy className="w-3.5 h-3.5" />
                                {t("Take the Boss Fight")}
                            </button>
                            <button
                                onClick={skip}
                                disabled={saving}
                                className="flex items-center gap-1.5 px-3 py-2 min-h-11 rounded-lg text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition"
                            >
                                <SkipForward className="w-3.5 h-3.5" />
                                {t("Skip")}
                            </button>
                        </div>
                    )}
                </div>
            ) : (
                <div className="flex flex-wrap items-center gap-2">
                    {/* Not proven yet → proving it is the real next step, so the
                        Boss Fight leads. Already proven → completing is, and the
                        Boss Fight stays available for anyone who wants the rep. */}
                    {!card.eligible && card.gateMode !== 'off' ? (
                        <>
                            <button
                                onClick={startBossFight}
                                disabled={saving}
                                className="flex items-center gap-2 px-4 py-2 min-h-11 bg-accent text-white rounded-xl text-sm font-medium hover:brightness-90 disabled:opacity-50 transition"
                            >
                                <Trophy className="w-4 h-4" />
                                {t("Take the Boss Fight")}
                            </button>
                            <button
                                onClick={() => complete(false)}
                                disabled={saving}
                                className="flex items-center gap-2 px-3 py-2 min-h-11 rounded-lg text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-50 transition"
                            >
                                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                                {t("Complete topic")}
                            </button>
                        </>
                    ) : (
                        <>
                            <button
                                onClick={() => complete(false)}
                                disabled={saving}
                                className="flex items-center gap-2 px-4 py-2 min-h-11 bg-accent text-white rounded-xl text-sm font-medium hover:brightness-90 disabled:opacity-50 transition"
                            >
                                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                                {t("Complete topic")}
                            </button>
                            <button
                                onClick={startBossFight}
                                disabled={saving}
                                className="flex items-center gap-2 px-3 py-2 min-h-11 rounded-lg text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-50 transition"
                            >
                                <Trophy className="w-4 h-4" />
                                {t("Take the Boss Fight")}
                            </button>
                        </>
                    )}
                </div>
            )}
        </div>
    );
}
