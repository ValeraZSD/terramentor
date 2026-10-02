/**
 * Mounted once in the app frame (Layout): picks up the creation runs the server
 * is still working on after a reload, and draws the screen of whichever run is
 * open. At the root, not in the projects grid, because a run is reached from
 * the task dock on any page and must survive leaving the grid.
 *
 * The screen itself is lazy: it carries the tree, the log and their icons, and
 * the app frame is in the entry chunk.
 */
import { lazy, Suspense, useEffect } from 'react';
import { reattachCreationRuns, useCreationRuns } from './creationRuns';

const CreationRunView = lazy(() => import('./CreationRunView'));

export default function CreationRunHost() {
    const viewing = useCreationRuns(s => s.viewing);
    useEffect(() => { void reattachCreationRuns(); }, []);
    if (!viewing) return null;
    return (
        <Suspense fallback={null}>
            <CreationRunView />
        </Suspense>
    );
}
