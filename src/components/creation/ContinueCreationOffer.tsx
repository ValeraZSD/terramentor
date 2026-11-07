/**
 * "Continue creating" where a learner who reopens a course will see it: the
 * course page, and the "AI generation failed" note. The run screen's own
 * Continue needs the run that stopped, which a reload, a restart or a closed
 * laptop takes away; the server answers from what the run wrote instead
 * (GET /api/ai/continue-creation/:id), and pressing opens that same screen
 * carrying the course on (`continueCreationForProject`).
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleDashed } from 'lucide-react';
import { api } from '../../api';
import { useStore } from '../../store';
import { Button } from '../ui/Button';
import { DashboardSection } from '../dashboard/DashboardSection';
import { continueCreationForProject, isRunLive, useCreationRuns } from './creationRuns';

/** The title the server gives a stopped run's note (routes/createProject.js NOTICE_TITLE). */
export const CREATION_NOTICE_TITLE = 'AI generation failed';

// The runs whose end has already refreshed the open course: the card and the
// note may both be mounted, and one reload is enough.
const refreshedAfter = new Set<string>();

/** Is there something to carry on in `projectId`? Asked again whenever a run
 *  of it starts or ends on this page, so the offer goes once a continuation
 *  finishes and comes back if it stops again. Never while one runs here. */
function useContinueOffer(projectId: number) {
    const runSig = useCreationRuns(s => Object.values(s.runs)
        .filter(r => r.projectId === projectId).map(r => `${r.key}:${r.status}:${r.attempt}`).join());
    const live = useCreationRuns(s => Object.values(s.runs).some(r => r.projectId === projectId && isRunLive(r)));
    const [offer, setOffer] = useState<{ projectId: number; can: boolean } | null>(null);
    const seen = useRef({ projectId, live });
    useEffect(() => {
        // A run of this course just ended: the outline and the page show what it wrote.
        const was = seen.current;
        const ended = `${projectId}|${runSig}`;
        if (was.projectId === projectId && was.live && !live && !refreshedAfter.has(ended)) {
            refreshedAfter.add(ended);
            const store = useStore.getState();
            if (store.currentProjectId === projectId) {
                void store.loadProjectData(projectId);
                void store.loadDashboard(projectId);
            }
        }
        seen.current = { projectId, live };
        // The answer from before the run is stale: never show it again after.
        if (live) { setOffer(null); return; }
        let current = true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const ask = () => api.getContinueCreation(projectId)
            .then(r => {
                if (!current) return;
                setOffer({ projectId, can: r.canContinue });
                // A run still winding down (a Stop just pressed), or one this
                // page did not start: ask again once it is over.
                if (r.running) timer = setTimeout(ask, 3000);
            })
            .catch(() => { if (current) setOffer({ projectId, can: false }); });
        void ask();
        return () => { current = false; clearTimeout(timer); };
    }, [projectId, runSig, live]);
    const can = !live && offer?.projectId === projectId && offer.can;
    const press = () => {
        const project = useStore.getState().projects.find(p => p.id === projectId);
        continueCreationForProject(projectId, project?.name ?? '', project?.color ?? '');
    };
    return { can, press };
}

/** The course page's card, above "Next up": nothing when there is nothing to carry on. */
export default function ContinueCreationCard({ projectId }: { projectId: number }) {
    const { t } = useTranslation();
    const { can, press } = useContinueOffer(projectId);
    if (!can) return null;
    return (
        <DashboardSection icon={CircleDashed} title={t("This course is not finished")}>
            <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
                {t("Creating it stopped before every part was written. Continue creating writes only what is missing, and everything already here stays as it is.")}
            </p>
            <div className="mt-4">
                <Button variant="neutral" size="sm" onClick={press}>
                    {t("Continue creating")}
                </Button>
            </div>
        </DashboardSection>
    );
}

/** The same offer on the stopped run's note, at the top of its detail panel. */
export function ContinueCreationNote({ projectId }: { projectId: number }) {
    const { t } = useTranslation();
    const { can, press } = useContinueOffer(projectId);
    if (!can) return null;
    return (
        <div data-offer="continue-creation" className="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 p-3">
            <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
                {t("Continue creating writes only what is missing, and everything already here stays as it is.")}
            </p>
            <div className="mt-3">
                <Button variant="neutral" size="sm" onClick={press}>
                    {t("Continue creating")}
                </Button>
            </div>
        </div>
    );
}
