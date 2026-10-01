import { useRef } from 'react';
import { AtlasBridge } from '../../types';
import { useStore } from '../../store';
import { ArrowRight, CheckCircle2, Layers } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useElementWidth } from '../../hooks/useElementWidth';

/**
 * The width at which a pair may be drawn side by side — measured on the LIST's
 * own box, never on the viewport. This list's usual home on a desktop is the
 * atlas's 23rem column, where a `sm:` breakpoint says "desktop" and drew both
 * titles at 110px: "Keigo (Polite …" beside "Teineigo (丁…".
 *
 * The number is what each title box is worth: across costs a title the other
 * title's width plus the arrow's column, and below 14rem — the same floor the
 * option tiles keep — a curriculum title is cut before it has said which
 * chapter it is. Measured at 560px on this component (`temp/bridge-shot.mjs`,
 * 2026-09-16): 225px a title, against 530px stacked at the same width.
 * Stacking costs height, and a title nobody can read costs the row.
 */
const ROW_MIN = 560;

/**
 * Cross-project pairs that mean the same thing — the actionable half of the
 * atlas, and the only part of it that asks the learner to do something.
 *
 * Two readings, and the split is what makes the list worth having:
 *
 *  • **One side already proven** → a head start is waiting on the other. This
 *    is mastery transfer's offer, surfaced where the learner can see all of
 *    them at once instead of meeting them one chapter at a time.
 *  • **Neither side proven** → the same material is scheduled twice, and
 *    knowing that before studying it twice is the saving.
 *
 * Both sides are always openable. The map can tell you two things are alike;
 * only the learner can decide which of them to go and read.
 */
export default function BridgeList({ bridges }: { bridges: AtlasBridge[] }) {
    const { t } = useTranslation();
    const openProjectNode = useStore(s => s.openProjectNode);
    const rootRef = useRef<HTMLElement>(null);
    // 0 until measured, which is the stacked layout — the one that needs no
    // measurement to be right.
    const wide = useElementWidth(rootRef) >= ROW_MIN;

    if (bridges.length === 0) return null;

    const waiting = bridges.filter(b => b.proven);
    const ahead = bridges.filter(b => !b.proven);

    const row = (b: AtlasBridge, i: number) => (
        <li
            key={`${b.a.id}-${b.b.id}-${i}`}
            className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-3"
        >
            <div className={`flex gap-2 ${wide ? 'flex-row items-center' : 'flex-col'}`}>
                <button
                    onClick={() => openProjectNode(b.a.projectId, b.a.id)}
                    className="flex-1 min-w-0 text-left rounded-lg px-2 py-2 min-h-11 hover:bg-slate-50 dark:hover:bg-slate-700/50 transition"
                >
                    <span className="flex items-center gap-1.5 text-sm font-medium text-slate-900 dark:text-white">
                        <span className="truncate">{b.a.title}</span>
                        {b.proven && (
                            <CheckCircle2 className="w-3.5 h-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-label={t("proven")} />
                        )}
                    </span>
                    <span className="block text-xs text-slate-500 dark:text-slate-400 truncate">{b.a.projectName}</span>
                </button>

                {/* The arrow and the number are ONE mark, because the number is
                    a fact about the PAIRING and not about either topic: at the
                    end of the row it read as a third column, and stacked it
                    fell to the bottom corner under the second title, where it
                    looks like that topic's own figure. It rotates with the
                    layout — sideways at a stacked pair is an arrow pointing at
                    nothing — and the number sits beside the arrow when the pair
                    reads downward, under it when the pair reads across. */}
                <span className={`shrink-0 flex items-center justify-center ${wide ? 'flex-col self-center gap-0.5' : 'flex-row self-stretch gap-1.5'}`}>
                    <ArrowRight
                        className={`w-4 h-4 shrink-0 text-slate-400 dark:text-slate-500 ${wide ? '' : 'rotate-90'}`}
                        aria-hidden="true"
                    />
                    <span className="text-xs tabular-nums whitespace-nowrap text-slate-500 dark:text-slate-400">
                        {t("{{round}}% alike", { round: Math.round(b.similarity * 100) })}
                    </span>
                </span>

                <button
                    onClick={() => openProjectNode(b.b.projectId, b.b.id)}
                    className="flex-1 min-w-0 text-left rounded-lg px-2 py-2 min-h-11 hover:bg-slate-50 dark:hover:bg-slate-700/50 transition"
                >
                    <span className="block text-sm font-medium text-slate-900 dark:text-white truncate">{b.b.title}</span>
                    <span className="block text-xs text-slate-500 dark:text-slate-400 truncate">{b.b.projectName}</span>
                </button>
            </div>
        </li>
    );

    return (
        <section aria-labelledby="atlas-bridges" className="space-y-4" ref={rootRef}>
            <div>
                <h2 id="atlas-bridges" className="flex items-center gap-2 text-base font-semibold text-slate-900 dark:text-white">
                    <Layers className="w-4 h-4 text-accent-fg" aria-hidden="true" />
                    {t("The same topic, twice")}
                </h2>
                <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
                    {t("Pairs of topics from different projects that cover the same material.")}
                </p>
            </div>

            {waiting.length > 0 && (
                <div>
                    <h3 className="text-xs font-semibold text-slate-500 dark:text-slate-400 mb-2">
                        {t("Already proven once ({{length}})", { length: waiting.length })}
                    </h3>
                    <ul className="space-y-2">{waiting.map(row)}</ul>
                </div>
            )}

            {ahead.length > 0 && (
                <div>
                    <h3 className="text-xs font-semibold text-slate-500 dark:text-slate-400 mb-2">
                        {t("Both still ahead of you ({{length}})", { length: ahead.length })}
                    </h3>
                    <ul className="space-y-2">{ahead.map(row)}</ul>
                </div>
            )}
        </section>
    );
}
