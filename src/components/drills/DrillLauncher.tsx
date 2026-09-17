import { useEffect, useMemo, useState } from 'react';
import MathText from '../MathText';
import { api } from '../../api';
import DrillModal from './DrillModal';
import { drillFromFlashcards, parseDrillSpec } from './parseDrill';
import type { DrillSpec } from '../../types';
import { Target, AlertCircle } from 'lucide-react';
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

    const spec = nodeId != null ? { ...state.spec, nodeId } : state.spec;
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
                <span className="shrink-0 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white group-hover:brightness-90 transition">
                    {t("Practice")}
                </span>
            </button>
            {open && <DrillModal spec={spec} onClose={() => setOpen(false)} />}
        </>
    );
}
