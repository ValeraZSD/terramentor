import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../../store';
import { api, SrsStatus, SrsFitResult } from '../../api';
import { configureSrs, retentionVerdict, REQUEST_RETENTION } from '../../utils/srs';
import { Button } from '../ui/Button';
import { Explain } from '../ui/Disclosure';
import { useNumberFormat } from '../../hooks/useNumberFormat';
import { uiLocale } from '../../utils/locale';
import { TuningBlock, Fact, FactStrip } from './tuningParts';

/**
 * Spaced-repetition tuning: how much review history exists, whether the
 * scheduler runs fitted or default parameters, and the one action that changes
 * it. Kept as its own component so its state lives with it — the Settings page
 * is already a long list of sections sharing one component's hooks.
 *
 * The fit is only ever APPLIED when it beat the defaults on held-out reviews
 * (server/fsrsOptimizer.js); this panel says so in words either way, because
 * "Optimise" that visibly does nothing reads as broken, and "Optimise" that
 * silently makes the schedule worse is worse than broken.
 */

/**
 * How many reviews a prediction band needs before its row is drawn — and the
 * number the panel quotes when it explains why it is showing three rows and not
 * ten. `retentionReport` always cuts predictions into ten fixed bands; a band of
 * three reviews recalled 100% says nothing, so it is left out rather than drawn
 * as a full bar. One constant, because the sentence and the filter disagreeing
 * is how a caption becomes a lie.
 */
const BIN_MIN_REVIEWS = 10;

export default function SrsTuningPanel({ active }: { active: boolean }) {
    const { t: tr } = useTranslation();
    const num = useNumberFormat();
    const addToast = useStore(s => s.addToast);
    const [status, setStatus] = useState<SrsStatus | null>(null);
    const [busy, setBusy] = useState(false);
    const [last, setLast] = useState<SrsFitResult | null>(null);

    const load = useCallback(async () => {
        try { setStatus(await api.getSrsStatus()); } catch { /* the panel just shows nothing */ }
    }, []);
    useEffect(() => { if (active) load(); }, [active, load]);

    const optimise = async () => {
        if (busy) return;
        setBusy(true);
        try {
            const r = await api.optimizeSrs();
            setLast(r);
            if (r.accepted) {
                configureSrs({ w: r.w });
                addToast('success', tr("Spaced repetition tuned"), tr("Your reviews are now scheduled with parameters fitted to your own history."));
            } else {
                addToast('success', tr("Defaults kept"), r.reason || tr("The fit did not beat the defaults."));
            }
            await load();
        } catch (e: any) {
            addToast('error', tr("Could not tune spaced repetition"), e.message);
        } finally {
            setBusy(false);
        }
    };
    const reset = async () => {
        try {
            await api.resetSrsParams();
            configureSrs({ w: null });
            setLast(null);
            await load();
            addToast('success', tr("Back to the published defaults"));
        } catch (e: any) {
            addToast('error', tr("Could not reset"), e.message);
        }
    };

    const enough = !!status && status.predicted >= status.minReviews;
    const fitted = !!status?.params;
    const fmt = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? '—' : n.toFixed(3));
    // `uiLocale()`, not the bare call: with no argument this follows the
    // operating system's regional settings, so the one date on this panel
    // disagreed with every other date in the app for anyone whose interface
    // language is not their machine's.
    const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString(uiLocale()) : '—');

    // One block of the "Fit the engine" card, built like the activity log's:
    // name, what it is, the measured facts in a hairline frame, then the action
    // with its precondition beside it. It was a caption, a paragraph and a
    // white card rendered as a FRAGMENT into the parent's `space-y-5`, so each
    // piece took 20px of top margin and the caption drifted off its own
    // paragraph — on a white card that was already the section.
    return (
        <TuningBlock
            title={tr("Spaced repetition")}
            note={tr("Flashcards are scheduled by FSRS-6. It ships with parameters fitted on a large public dataset; once you have a few hundred reviews of your own, they can be fitted to you instead. Every rating is kept in a review log on this machine, and an imported Anki deck brings its history with it.")}
            actions={<>
                {fitted && (
                    <Button onClick={reset} disabled={busy}>{tr("Reset to defaults")}</Button>
                )}
                <Button variant="primary" onClick={optimise} disabled={!enough} busy={busy}>
                    {tr("Fit to my reviews")}
                </Button>
            </>}
            hint={<span data-testid="srs-hint">
                {status
                    ? enough
                        ? tr("{{predicted}} day-level reviews available to fit on.", { predicted: num(status.predicted) })
                        : tr("Needs {{minReviews}} day-level reviews to fit on — you have {{predicted}}. Keep reviewing.", { minReviews: status.minReviews, predicted: num(status.predicted) })
                    : ''}
            </span>}
            result={last && (
                <p data-testid="srs-last-result">
                    {last.accepted
                        ? tr("Accepted: held-out log-loss {{fmt}} → {{fmt2}} over {{valReviews}} reviews ({{steps}} steps, {{value}} s).", { count: last.stats.valReviews, fmt: fmt(last.stats.valDefault), fmt2: fmt(last.stats.valFitted), valReviews: last.stats.valReviews, steps: last.stats.steps, value: (last.stats.ms / 1000).toFixed(1) })
                        : tr("Not applied: {{reason}} (held-out log-loss {{fmt}} vs {{fmt2}}).", { reason: last.reason, fmt: fmt(last.stats.valDefault), fmt2: fmt(last.stats.valFitted) })}
                </p>
            )}
        >
            <FactStrip>
                <Fact
                    label={tr("Reviews logged")}
                    testId="srs-log-count"
                    value={status ? tr("{{rows}} on {{cards}} cards", { count: status.log.cards, rows: num(status.log.rows), cards: num(status.log.cards) }) : '…'}
                    sub={status && status.log.anki > 0
                        ? tr("{{anki}} of them came from Anki", { anki: num(status.log.anki) })
                        : undefined}
                />
                {/* "Published defaults" is the accurate name and tells a
                    learner nothing. What they need to know is whose history
                    the numbers came from — everyone's, or theirs. */}
                <Fact
                    label={tr("Scheduling settings")}
                    testId="srs-params-state"
                    value={fitted ? tr("Fitted to you") : tr("Standard settings")}
                    sub={fitted
                        ? (status?.meta?.stats
                            ? tr("fitted on {{when}} · held-out log-loss {{fmt}} → {{fmt2}}", { when: when(status?.meta?.at), fmt: fmt(status.meta.stats.valDefault), fmt2: fmt(status.meta.stats.valFitted) })
                            : tr("fitted on {{when}}", { when: when(status?.meta?.at) }))
                        : tr("the defaults everyone starts on")}
                />
            </FactStrip>
            {status && status.retention.reviews > 0 && (
                <div className="px-4 py-2.5" data-testid="srs-retention">
                    {/* Three percentages side by side make the reader work
                        out which way is good. The verdict says it in words
                        and keeps both numbers inside the sentence that uses
                        them. */}
                    <Fact
                        label={tr("How much you are remembering")}
                        value={tr("{{round}}% recalled over {{reviews}} reviews", { count: status.retention.reviews, round: Math.round((status.retention.observed ?? 0) * 100), reviews: num(status.retention.reviews) })}
                        sub={(() => {
                            const target = Math.round(REQUEST_RETENTION * 100);
                            const expected = Math.round((status.retention.expected ?? 0) * 100);
                            switch (retentionVerdict(status.retention.observed, status.retention.reviews)) {
                                case 'ahead':
                                    return tr("Better than the {{target}}% the schedule aims for, so your cards are probably coming back sooner than you need them. It expected {{expected}}% here.", { target, expected });
                                case 'behind':
                                    return tr("Below the {{target}}% the schedule aims for, so the gaps between reviews may be too long. It expected {{expected}}% here.", { target, expected });
                                case 'on-track':
                                    return tr("Close to the {{target}}% the schedule aims for. It expected {{expected}}% here.", { target, expected });
                                default:
                                    return tr("Too few reviews to tell yet whether that is high or low. The schedule aims for {{target}}%, and expected {{expected}}% here.", { target, expected });
                            }
                        })()}
                    />
                    {/* The band chart is for someone checking the fit, not for
                        someone tuning it: the verdict above already says whether
                        memory is ahead of or behind the schedule. So the chart
                        closes until asked for. */}
                    {status.retention.bins.filter(b => b.n >= BIN_MIN_REVIEWS).length >= 2 && (
                        <Explain summary={tr("The bands, prediction by prediction")} className="mt-3">
                        <div>
                        {/* Why there are three rows and not ten: the bands are
                            fixed (`retentionReport` cuts predictions into ten),
                            and how many get drawn is a fact about the reader's
                            history, not a choice. Without this sentence the
                            count looks arbitrary — which is exactly how it
                            read. */}
                        <p className="max-w-prose text-sm text-slate-500 dark:text-slate-400">
                            {tr("Each row is a band the schedule was equally sure about, drawn once it has {{min}} reviews behind it. The bar is what you recalled; the notch is what it predicted.", { count: BIN_MIN_REVIEWS, min: num(BIN_MIN_REVIEWS) })}
                        </p>
                        <div className="mt-2 grid grid-cols-[auto_1fr_auto] gap-x-3 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
                            {/* The three columns are named once, at the top: without a
                                header every row had to carry the words "predicted" and
                                "recalled", and the bare count still read as "· 18".
                                The track takes the card's full width: a shorter one
                                stops at no edge the reader can see, so it reads as cut
                                off — and the longer the track, the further apart the
                                fill and the tick can be drawn, which is the point. */}
                            <div className="contents">
                                <span className="text-right">{tr("predicted")}</span>
                                <span />
                                <span>{tr("recalled · reviews")}</span>
                            </div>
                            {status.retention.bins.filter(b => b.n >= BIN_MIN_REVIEWS).map(b => {
                                const predicted = Math.round(b.predicted * 100);
                                const observed = Math.round(b.observed * 100);
                                return (
                                    <div key={b.lo} className="contents">
                                        {/* The BAND, not the mean inside it: "68%" read as a
                                            threshold the schedule had picked, when it is the
                                            average of the 60–70% group. The notch still sits
                                            at the mean — that is what it predicted. */}
                                        <span className="tabular-nums text-right whitespace-nowrap">
                                            {Math.round(b.lo * 100)}–{Math.round(b.hi * 100)}%
                                        </span>
                                        {/* The bar is what the learner actually recalled; the tick is
                                            what the scheduler expected, drawn on the same scale so the
                                            gap is the picture rather than a subtraction. The tick is
                                            held a hair inside the track so a 0% or 100% bin still
                                            draws one. */}
                                        <span
                                            className="relative h-2.5 self-center rounded bg-slate-100 dark:bg-slate-700 overflow-hidden"
                                            role="img"
                                            aria-label={tr("Predicted {{p}}%, recalled {{o}}% over {{n}} reviews", { count: b.n, p: predicted, o: observed, n: b.n })}
                                        >
                                            <span className="absolute inset-y-0 left-0 bg-accent/60" style={{ width: `${observed}%` }} />
                                            <span
                                                className="absolute inset-y-0 w-0.5 -translate-x-1/2 rounded-full bg-white ring-1 ring-slate-400/60 dark:bg-slate-300 dark:ring-0"
                                                style={{ left: `${Math.min(99, Math.max(1, predicted))}%` }}
                                            />
                                        </span>
                                        <span className="tabular-nums">{observed}% · {num(b.n)}</span>
                                    </div>
                                );
                            })}
                        </div>
                        </div>
                        </Explain>
                    )}
                </div>
            )}
        </TuningBlock>
    );
}
