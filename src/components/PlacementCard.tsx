import { useEffect, useState } from 'react';
import { Compass, ArrowRight } from 'lucide-react';
import { api } from '../api';
import { useStore } from '../store';
import type { PlacementStatus } from '../types';
import { useTranslation } from 'react-i18next';

/**
 * The offer, on the project's own dashboard.
 *
 * It renders nothing at all unless there is something to say — no probe is
 * available on a project too small to place, on one already measured, and on one
 * whose probe is finished and unremarkable. A permanent card nagging about a
 * one-time action is the shape of an engagement mechanic, which this app's
 * `CoreIdea.md` is explicitly against.
 *
 * The status call is cheap and model-free (`probeAvailability` is pure SQLite),
 * so it can run on every dashboard load without a cache.
 */
export default function PlacementCard({ projectId, projectName }: { projectId: number; projectName: string }) {
    const { t } = useTranslation();
    const [status, setStatus] = useState<PlacementStatus | null>(null);
    const openPlacement = useStore(s => s.openPlacement);
    const placementOpen = useStore(s => s.placement.isOpen);

    useEffect(() => {
        let cancelled = false;
        // Re-reads when the modal closes, so finishing or discarding a probe is
        // reflected here without a page reload.
        if (placementOpen) return;
        api.getPlacement(projectId)
            .then(s => { if (!cancelled) setStatus(s); })
            .catch(() => { if (!cancelled) setStatus(null); });
        return () => { cancelled = true; };
    }, [projectId, placementOpen]);

    if (!status) return null;

    // A FAILED probe is not resumable — it is a fresh start that happens to have
    // a row behind it, and offering to "Continue" one would promise progress
    // that does not exist.
    const resumable = status.probe && status.probe.state !== 'done' && status.probe.state !== 'failed';
    const finished = status.probe?.state === 'done' && status.summary;
    if (!status.available && !resumable && !finished) return null;
    // A finished probe that seeded nothing has nothing to report; saying so
    // every visit would be noise about a decision already made.
    if (finished && (status.summary?.topicsSeeded ?? 0) === 0) return null;

    return (
        <section className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 shadow-sm">
            <div className="flex items-start gap-3">
                <span className="shrink-0 w-9 h-9 rounded-lg bg-accent/10 text-accent-fg flex items-center justify-center">
                    <Compass className="w-5 h-5" />
                </span>
                <div className="min-w-0 flex-1">
                    <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
                        {finished ? t("Placement") : t("Where should we start?")}
                    </h3>
                    <p className="text-sm text-slate-600 dark:text-slate-300 mt-1.5 leading-relaxed">
                        {finished
                            ? status.summary!.headline
                            : resumable
                                ? t("You have a placement under way — pick it up where you left off.")
                                : t("{{count}} quick questions across this course, before any of it is taught. Topics you already know start with a head start; the rest get taught from the beginning.", { count: status.questions })}
                    </p>
                    <button
                        onClick={() => openPlacement(projectId, projectName)}
                        className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-accent rounded-lg hover:opacity-90 transition"
                    >
                        {finished ? t("Review or undo") : resumable ? t("Continue") : t("Take it")}
                        <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                </div>
            </div>
        </section>
    );
}
