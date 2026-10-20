import { useStore } from '../../store';
import CardsPanel from './CardsPanel';

/**
 * What Study opens for a project measured in CARDS (`countsInCards`): the card
 * review session, the one "Study N cards" on the Deck tab opens.
 *
 * Every other project studies through the scoped card stream (the feed). A deck
 * has nothing to teach, so the stream would have nothing to interleave its cards
 * WITH, and they would arrive one at a time among the feed's own chrome,
 * without the rating footer, the Space / 1–4 / z keys, the session count or
 * undo. The session is the surface built for exactly this, and Study means it on
 * the Projects grid card, the schedule card, the dashboard and the workspace tab
 * alike, since all four arrive here through `/project/:id/study`.
 *
 * Arriving starts the session at once when anything is owed. When nothing is,
 * this is the Deck tab's own "today" block — "Done for today" and its "Study
 * ahead anyway" — which is also what is left on screen after a session closes.
 * `nodeId` narrows the first session to one section, as that section's Play
 * button does; anything that is not a section studies the whole deck.
 */
export default function DeckStudy({ projectId, nodeId = null }: { projectId: number; nodeId?: number | null }) {
    const loadPaceData = useStore(s => s.loadPaceData);
    const loadProjects = useStore(s => s.loadProjects);
    const loadDueFlashcardCount = useStore(s => s.loadDueFlashcardCount);

    // A session moved the numbers every other surface reads: the pace chip in
    // this workspace's header, the grid's ring and the Deck tab's badge.
    const refresh = () => {
        void loadPaceData(projectId);
        void loadProjects({ silent: true });
        void loadDueFlashcardCount(projectId);
    };

    return (
        <div className="flex-1 overflow-auto bg-slate-100 dark:bg-slate-900">
            <div className="mx-auto max-w-2xl space-y-4 p-4 sm:p-6">
                {/* Keyed: a new project or section is a new arrival, and
                    arriving is what starts a session. */}
                <CardsPanel
                    key={`${projectId}:${nodeId ?? ''}`}
                    projectId={projectId}
                    studyNow
                    todayOnly
                    stageNodeId={nodeId}
                    onSessionEnd={refresh}
                />
            </div>
        </div>
    );
}
