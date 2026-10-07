/**
 * Mounted once in the app frame (Layout): picks up the creation runs the server
 * is still working on after a reload, and draws the screen of whichever run is
 * open. At the root, not in the projects grid, because a run is reached from
 * the task dock on any page and must survive leaving the grid.
 *
 * The screen itself is lazy: it carries the tree, the log and their icons, and
 * the app frame is in the entry chunk. But Create swaps the New course form for
 * this screen IN PLACE (one box, `COURSE_DIALOG_SIZE`), and a first open that
 * suspends drew a frame or two with no dialog at all between them — the page
 * flashing through. So the form fetches the chunk while it is open
 * (`preloadCreationRunView`), and once it is here it is rendered directly,
 * never through a suspending `lazy`.
 */
import { lazy, Suspense, useEffect, type ComponentType } from 'react';
import { reattachCreationRuns, useCreationRuns } from './creationRuns';

let loaded: ComponentType | null = null;
const load = () => import('./CreationRunView').then(m => { loaded = m.default; return m; });
export const preloadCreationRunView = () => { if (!loaded) void load().catch(() => { }); };
const LazyCreationRunView = lazy(load);

export default function CreationRunHost() {
    const viewing = useCreationRuns(s => s.viewing);
    useEffect(() => { void reattachCreationRuns(); }, []);
    if (!viewing) return null;
    const Loaded = loaded;
    if (Loaded) return <Loaded />;
    return (
        <Suspense fallback={null}>
            <LazyCreationRunView />
        </Suspense>
    );
}
