import { useCallback, useEffect, useState } from 'react';
import { Compass, ArrowRight } from 'lucide-react';
import { api } from '../api';
import { useStore } from '../store';
import type { PlacementStatus } from '../types';
import { useTranslation } from 'react-i18next';
import { Button } from './ui/Button';
import { DashboardSection, ToolRow } from './dashboard/DashboardSection';

/**
 * What the placement can offer on this project, read once for the whole
 * overview: the card at the top and the tile among the tools answer the same
 * question, and two requests could disagree.
 *
 * The status call is cheap and model-free (`probeAvailability` is pure SQLite),
 * so it can run on every dashboard load without a cache. It re-reads when the
 * modal closes, so finishing or discarding a probe shows without a reload.
 */
export function usePlacementStatus(projectId: number | null) {
    const [status, setStatus] = useState<PlacementStatus | null>(null);
    const placementOpen = useStore(s => s.placement.isOpen);

    useEffect(() => {
        let cancelled = false;
        if (placementOpen || projectId == null) return;
        api.getPlacement(projectId)
            .then(s => { if (!cancelled) setStatus(s); })
            .catch(() => { if (!cancelled) setStatus(null); });
        return () => { cancelled = true; };
    }, [projectId, placementOpen]);

    const setDismissed = useCallback(async (dismissed: boolean) => {
        if (projectId == null) return;
        setStatus(s => (s ? { ...s, dismissed } : s));
        try {
            await api.setPlacementDismissed(projectId, dismissed);
        } catch {
            setStatus(s => (s ? { ...s, dismissed: !dismissed } : s));
        }
    }, [projectId]);

    return { status, setDismissed };
}

type Offer = 'start' | 'resume' | 'finished';

/**
 * Which offer there is, if any. Nothing at all unless there is something to
 * say — no probe is available on a project too small to place, on one already
 * measured, and on one whose probe is finished and unremarkable. A permanent
 * card nagging about a one-time action is the shape of an engagement mechanic,
 * which this app's `CoreIdea.md` is explicitly against.
 */
function offerOf(status: PlacementStatus | null): Offer | null {
    if (!status) return null;
    // A FAILED probe is not resumable — it is a fresh start that happens to have
    // a row behind it, and offering to "Continue" one would promise progress
    // that does not exist.
    if (status.probe && status.probe.state !== 'done' && status.probe.state !== 'failed') return 'resume';
    if (status.probe?.state === 'done' && status.summary) {
        // A finished probe that seeded nothing has nothing to report; saying so
        // every visit would be noise about a decision already made.
        return (status.summary.topicsSeeded ?? 0) > 0 ? 'finished' : null;
    }
    return status.available ? 'start' : null;
}

/**
 * The offer, at the top of a project's overview — until the learner says
 * "Not now". Many never want to be placed, and an offer with no way to put it
 * away sits above the course on every visit; after "Not now" it lives on as
 * `PlacementTool`, one tile among the tools at the foot of the page.
 */
export default function PlacementCard({ projectId, projectName, status, onDismiss }: {
    projectId: number;
    projectName: string;
    status: PlacementStatus | null;
    onDismiss: () => void;
}) {
    const { t } = useTranslation();
    const openPlacement = useStore(s => s.openPlacement);
    const offer = offerOf(status);
    if (!offer || status?.dismissed) return null;

    return (
        <DashboardSection
            icon={Compass}
            title={offer === 'finished' ? t("Placement") : t("Where should we start?")}
        >
            <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
                {offer === 'finished'
                    ? t("{{count}} topics start with a head start.", { count: status!.summary!.topicsSeeded })
                    : offer === 'resume'
                        ? t("You have a placement under way — pick it up where you left off.")
                        : t("{{count}} quick questions across this course, before any of it is taught. Topics you already know start with a head start; the rest get taught from the beginning.", { count: status!.questions })}
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-2">
                <Button
                    variant="neutral"
                    size="sm"
                    onClick={() => openPlacement(projectId, projectName)}
                    trailing={<ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />}
                >
                    {offer === 'finished' ? t("Review or undo") : offer === 'resume' ? t("Continue") : t("Take it")}
                </Button>
                <Button variant="quiet" size="sm" onClick={onDismiss}>
                    {offer === 'finished' ? t("Hide") : t("Not now")}
                </Button>
            </div>
        </DashboardSection>
    );
}

/** The same offer after "Not now": a tool, not a card above the course. */
export function PlacementTool({ projectId, projectName, status }: {
    projectId: number;
    projectName: string;
    status: PlacementStatus | null;
}) {
    const { t } = useTranslation();
    const openPlacement = useStore(s => s.openPlacement);
    const offer = offerOf(status);
    if (!offer || !status?.dismissed) return null;
    return (
        <ToolRow
            icon={Compass}
            title={offer === 'finished' ? t("Placement") : t("Find where to start")}
            hint={offer === 'finished'
                ? t("Review or undo the head start it gave")
                : t("A few questions, so what you already know is not taught again")}
            onClick={() => openPlacement(projectId, projectName)}
        />
    );
}
