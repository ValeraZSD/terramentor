import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../../store';
import { api, MasteryModelStatus, BktFitResult } from '../../api';
import { Button } from '../ui/Button';
import { useNumberFormat } from '../../hooks/useNumberFormat';
import { TuningBlock, Fact, FactStrip } from './tuningParts';

/**
 * The learner's own BKT rates (how much one attempt teaches, how often a known
 * thing is still missed). Same contract as the spaced-repetition fit: applied
 * only when it beats the defaults on attempts it never saw.
 */
export default function MasteryTuningPanel({ active }: { active: boolean }) {
    const { t: tr } = useTranslation();
    const num = useNumberFormat();
    const addToast = useStore(s => s.addToast);
    const [status, setStatus] = useState<MasteryModelStatus | null>(null);
    const [busy, setBusy] = useState(false);
    const [last, setLast] = useState<BktFitResult | null>(null);
    const load = useCallback(async () => {
        try { setStatus(await api.getMasteryModel()); } catch { /* quiet */ }
    }, []);
    useEffect(() => { if (active) load(); }, [active, load]);

    const optimise = async () => {
        if (busy) return;
        setBusy(true);
        try {
            const r = await api.optimizeMastery();
            setLast(r);
            addToast('success', r.accepted ? tr("Topic progress tuned") : tr("Defaults kept"), r.accepted
                ? tr("Learning rate {{p_T}}, slip {{p_S}} — fitted to your own attempts.", { p_T: r.params.p_T.toFixed(2), p_S: r.params.p_S.toFixed(2) })
                : (r.reason || ''));
            await load();
        } catch (e: any) {
            addToast('error', tr("Could not update topic progress"), e.message);
        } finally {
            setBusy(false);
        }
    };
    const reset = async () => {
        try {
            await api.resetMasteryParams();
            setLast(null);
            await load();
            addToast('success', tr("Back to the default rates"));
        } catch (e: any) {
            addToast('error', tr("Could not reset"), e.message);
        }
    };
    const enough = !!status && status.attempts >= status.minAttempts;
    const fitted = !!status?.params;
    const pct = (n: number) => `${Math.round(n * 100)}%`;
    const fmt = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? '—' : n.toFixed(3));

    return (
        <TuningBlock
            title={tr("Topic progress")}
            note={tr("Every answer updates a per-topic estimate of whether you know the topic. Two rates drive it: how much one attempt teaches, and how often you miss something you do know. They start as sensible defaults and can be fitted to your own record of attempts.")}
            actions={<>
                {fitted && (
                    <Button onClick={reset} disabled={busy}>{tr("Reset to defaults")}</Button>
                )}
                <Button variant="primary" onClick={optimise} disabled={!enough} busy={busy}>
                    {tr("Fit to my attempts")}
                </Button>
            </>}
            hint={<span data-testid="bkt-hint">
                {status
                    ? enough
                        ? tr("{{attempts}} attempts available to fit on.", { count: status.attempts, attempts: num(status.attempts) })
                        : tr("Needs {{minAttempts}} recorded attempts — you have {{attempts}}. Keep answering.", { minAttempts: status.minAttempts, attempts: num(status.attempts) })
                    : ''}
            </span>}
            result={last && (
                <p data-testid="bkt-last-result">
                    {last.accepted
                        ? tr("Accepted: held-out loss {{fmt}} → {{fmt2}} over {{valAttempts}} attempts.", { count: last.stats.valAttempts, fmt: fmt(last.stats.valDefault), fmt2: fmt(last.stats.valFitted), valAttempts: last.stats.valAttempts })
                        : tr("Not applied: {{reason}} (held-out loss {{fmt}} vs {{fmt2}}).", { reason: last.reason, fmt: fmt(last.stats.valDefault), fmt2: fmt(last.stats.valFitted) })}
                </p>
            )}
        >
            {/* Shaped exactly like the spaced-repetition card above it: the
                same two questions in the same order, answered the same way —
                what is on record, and whose numbers are running. */}
            <FactStrip>
                <Fact
                    label={tr("Attempts recorded")}
                    testId="bkt-attempts"
                    value={status ? tr("{{attempts}} on {{topics}} topics", { attempts: num(status.attempts), topics: num(status.topics) }) : '…'}
                />
                {/* "learn 10% per attempt, slip 10%" names the two BKT rates
                    and says nothing about what they DO. Spelled out, they are
                    two sentences a learner can check against their own
                    experience. */}
                <Fact
                    label={tr("Rates in use")}
                    testId="bkt-params-state"
                    value={status ? (fitted ? tr("Fitted to you") : tr("Standard rates")) : "…"}
                    sub={status
                        ? tr("one answer moves a topic about {{pct}} of the way, and {{pct2}} of answers go wrong on a topic you do know", {
                            pct: pct(fitted ? status.params!.p_T : status.defaults.p_T),
                            pct2: pct(fitted ? status.params!.p_S : status.defaults.p_S),
                        })
                        : undefined}
                />
            </FactStrip>
        </TuningBlock>
    );
}
