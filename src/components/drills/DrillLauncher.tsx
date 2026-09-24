import { useEffect, useMemo, useState } from 'react';
import MathText from '../MathText';
import { api } from '../../api';
import DrillModal from './DrillModal';
import { drillFromFlashcards, drillKeyOf, parseDrillSpec } from './parseDrill';
import type { DrillRoundResult, DrillSpec } from '../../types';
import { Target, AlertCircle, Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * The inline card a ```drill fence renders to: a compact "Practice now" button,
 * NOT the game itself (the drill opens in a modal, so it never shoves the lesson
 * around mid-scroll — the same restraint the feed's widgets use). `nodeId`, when
 * known, threads through so a completed round records mastery for that topic.
 */
export function DrillLauncher({ code, nodeId }: { code: string; nodeId?: number }) {
    const { t } = useTranslation();
    const [state, setState] = useState<{ spec?: DrillSpec; error?: string } | null>(null);
    const [open, setOpen] = useState(false);

    useEffect(() => {
        let live = true;
        parseDrillSpec(code).then(r => { if (live) setState(r); });
        return () => { live = false; };
    }, [code]);

    if (!state) {
        return <div className="my-4 h-16 animate-pulse rounded-xl bg-slate-100 dark:bg-slate-800" />;
    }
    if (state.error || !state.spec) {
        return (
            <div className="my-4 flex items-center gap-2 rounded-xl border border-amber-200 dark:border-amber-800/50 bg-amber-50 dark:bg-amber-900/15 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
                <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                {state.error || t("This practice drill could not be loaded.")}
            </div>
        );
    }

    const keyed = { ...state.spec, key: drillKeyOf(code) };
    const spec = nodeId != null ? { ...keyed, nodeId } : keyed;
    return <LauncherCard spec={spec} open={open} setOpen={setOpen} />;
}

/**
 * Degradation launcher (AI off, or a topic with cards but no authored drill):
 * lazily pulls the node's flashcards and, if there are enough, offers the exact
 * same drill built from them. Renders nothing when the node has too few cards, so
 * a caller can drop it in unconditionally.
 */
export function FlashcardDrillLauncher({ nodeId, nodeTitle }: { nodeId: number; nodeTitle: string }) {
    const [spec, setSpec] = useState<DrillSpec | null>(null);
    const [open, setOpen] = useState(false);

    useEffect(() => {
        let live = true;
        api.getFlashcards(nodeId)
            .then(cards => { if (live) setSpec(drillFromFlashcards(cards, nodeTitle)); })
            .catch(() => { if (live) setSpec(null); });
        return () => { live = false; };
    }, [nodeId, nodeTitle]);

    if (!spec) return null;
    return <LauncherCard spec={{ ...spec, nodeId }} open={open} setOpen={setOpen} />;
}

function LauncherCard({ spec, open, setOpen }: { spec: DrillSpec; open: boolean; setOpen: (v: boolean) => void }) {
    const { t } = useTranslation();
    // WHAT YOU SCORED, ON THE THING YOU SCORED IT ON. Closing the drill used to
    // leave the lesson exactly as it was before it was opened, so a round that
    // had just been recorded as evidence for the topic left no mark anywhere
    // the reader could see. Full rounds only — a missed-only retry is a biased
    // subset and is not recorded as evidence either, so showing it here would
    // put a number on the card that the topic's estimate never saw. It is the
    // LAST full round, never a best: the server keeps each recorded round with
    // the drill's key, so the card shows it again after a reload or on another
    // device. A drill with no topic records nothing, so it shows only the round
    // just played.
    const [last, setLast] = useState<DrillRoundResult | null>(null);
    const [fresh, setFresh] = useState(false);
    useEffect(() => {
        if (spec.nodeId == null || !spec.key) return;
        let live = true;
        api.getDrillScores(spec.nodeId)
            .then(scores => {
                const s = spec.key ? scores[spec.key] : undefined;
                // A round played while the request was out wins over what it returns.
                if (live && s) setLast(prev => prev ?? { correct: s.correct, total: s.total, full: true, seconds: 0 });
            })
            .catch(() => { /* no stored score is the normal case for a new drill */ });
        return () => { live = false; };
    }, [spec.nodeId, spec.key]);
    const subtitle = useMemo(() => {
        const n = Math.min(spec.target?.count || spec.items.length, spec.items.length);
        // Built from t() rather than literals: assembled in code, this line was
        // never a key, so no extractor saw it and every coverage report called
        // the drill card fully translated while it read "6 items · choice or
        // type" in all eleven languages.
        const parts = [t('{{count}} items', { count: n })];
        if (spec.modes.includes('choice') && spec.modes.includes('type')) parts.push(t('choice or type'));
        else if (spec.modes.includes('type')) parts.push(t('type the answer'));
        if (spec.source === 'flashcards') parts.push(t('from your flashcards'));
        return parts.join(' · ');
    }, [spec, t]);

    return (
        <>
            <button
                onClick={() => setOpen(true)}
                className="group my-4 flex w-full items-center gap-3 rounded-xl border border-accent/30 bg-accent/5 px-4 py-3 text-left transition hover:bg-accent/10 hover:border-accent/50"
            >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent text-white">
                    <Target className="h-5 w-5" aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold text-slate-900 dark:text-white">
                        {spec.title ? <MathText content={spec.title} /> : t("Practice now")}
                    </span>
                    <span className="block text-sm text-slate-500 dark:text-slate-400">{subtitle}</span>
                </span>
                {last && (
                    <span
                        title={fresh
                            ? t("You scored {{correct}} of {{total}} just now", { correct: last.correct, total: last.total })
                            : t("Your last full round: {{correct}} of {{total}}", { correct: last.correct, total: last.total })}
                        className="shrink-0 inline-flex items-center gap-1 rounded-lg bg-emerald-100 dark:bg-emerald-900/30 px-2 py-1.5 text-xs font-semibold text-emerald-700 dark:text-emerald-300 tabular-nums"
                    >
                        <Check className="h-3.5 w-3.5" aria-hidden="true" />
                        {last.correct}/{last.total}
                    </span>
                )}
                <span className="shrink-0 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white group-hover:brightness-90 transition">
                    {last ? t("Again") : t("Practice")}
                </span>
            </button>
            {open && (
                <DrillModal
                    spec={spec}
                    onClose={() => setOpen(false)}
                    onRound={r => { if (r.full) { setLast(r); setFresh(true); } }}
                />
            )}
        </>
    );
}
