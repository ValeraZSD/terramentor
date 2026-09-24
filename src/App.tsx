import { useEffect, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useStore } from './store';
import { setAuthRequiredHandler } from './api';
import { useRouterStoreSync } from './hooks/useRouterStoreSync';
import AuthGate from './components/AuthGate';
import Layout from './components/Layout';
import { ErrorBoundary, workspaceFallback } from './components/ErrorBoundary';
import RouteChunk from './components/RouteChunk';
import FeedView from './components/feed/FeedView';
import UpdatePrompt from './components/UpdatePrompt';
import { useDesktop } from './hooks/useDesktop';
import type { CalendarScope } from './components/calendar/CalendarView';
import { k } from './i18n';

// Every route except the feed is loaded when it is first opened.
//
// They were all imported up front, which is how the entry chunk reached 962 kB:
// the projects grid, the whole workspace, the settings screen, two date views
// and the atlas were downloaded, parsed and evaluated before the home page
// could paint, on every launch, on a phone included. The feed stays eager
// because it IS the home page — making it lazy would only add a round trip in
// front of the most common launch.
//
// A route that is already cached resolves in the same tick, so this shows no
// fallback on a second visit.
//
// Each one goes through `RouteChunk` rather than a bare `lazy()` inside a bare
// boundary, because a chunk that does not arrive — which here usually means a
// rebuild under an open page — used to leave the reader alternating between two
// error screens whose buttons could not work. That story is written down in
// `components/RouteChunk.tsx`.
const importProjectsGrid = () => import('./components/ProjectsGrid');
const importWorkspace = () => import('./components/Workspace');
const importSettings = () => import('./components/Settings');
const importCalendar = () => import('./components/calendar/CalendarView');
const importScheduleBoard = () => import('./components/schedule/ScheduleBoard');
const importAtlas = () => import('./components/AtlasView');

/** Deliberately blank rather than a spinner: a chunk off the local disk arrives
 *  in a few milliseconds, and a spinner that flashes for one frame reads as the
 *  app stuttering. The header and rail are already painted around it. */
const RouteFallback = () => <div className="h-full" aria-busy="true" />;

export default function App() {
    const loadProjects = useStore(s => s.loadProjects);
    const loadSettings = useStore(s => s.loadSettings);
    const loadAuth = useStore(s => s.loadAuth);
    const lockApp = useStore(s => s.lockApp);
    const authChecked = useStore(s => s.authChecked);
    const authEnabled = useStore(s => s.authEnabled);
    const authenticated = useStore(s => s.authenticated);

    // Keep the store's nav state (view / project / workspaceView / selectedNode)
    // in lockstep with the URL — the URL is the source of truth.
    useRouterStoreSync();

    // A desktop install stops itself when its last window closes; this is the
    // window saying it is still here. A no-op everywhere else.
    useDesktop();

    useEffect(() => {
        // A 401 on any protected request flips us to the locked screen.
        setAuthRequiredHandler(lockApp);
        (async () => {
            await loadAuth();
            const s = useStore.getState();
            // Only fetch app data if we're already through the gate (or there is none);
            // otherwise the login action loads it after a successful unlock.
            if (!s.authEnabled || s.authenticated) {
                loadSettings();
                loadProjects();
                useStore.getState().loadSearchProviders();
                // Identity + the last update verdict. Both are local reads; the
                // daily poll that produces the verdict runs on the server and
                // only when the learner turned it on.
                useStore.getState().loadVersion();
            }
        })();
        return () => setAuthRequiredHandler(null);
    }, []);

    // Avoid flashing the app before we know whether a login is required.
    if (!authChecked) return null;
    if (authEnabled && !authenticated) return <AuthGate />;

    const workspace = (
        <RouteChunk name={k("Workspace")} load={importWorkspace} fallback={workspaceFallback} />
    );

    return (
        <ErrorBoundary componentName={k("Application")}>
            <UpdatePrompt />
            <Layout>
                <Suspense fallback={<RouteFallback />}>
                    <Routes>
                        <Route path="/" element={
                            <ErrorBoundary componentName={k("Feed")}>
                                <FeedView />
                            </ErrorBoundary>
                        } />
                        <Route path="/projects" element={
                            <RouteChunk name={k("Projects Grid")} load={importProjectsGrid} />
                        } />
                        <Route path="/calendar" element={
                            <RouteChunk<{ scope: CalendarScope }>
                                name={k("Calendar")} load={importCalendar} props={{ scope: { kind: 'global' } }}
                            />
                        } />
                        <Route path="/schedule" element={
                            <RouteChunk name={k("Schedule Board")} load={importScheduleBoard} />
                        } />
                        <Route path="/atlas" element={
                            <RouteChunk name={k("Atlas")} load={importAtlas} />
                        } />
                        <Route path="/settings" element={
                            <RouteChunk name={k("Settings")} load={importSettings} />
                        } />
                        <Route path="/project/:projectId" element={workspace} />
                        <Route path="/project/:projectId/:view" element={workspace} />
                        <Route path="/project/:projectId/:view/:nodeId" element={workspace} />
                        <Route path="*" element={<Navigate to="/" replace />} />
                    </Routes>
                </Suspense>
            </Layout>
        </ErrorBoundary>
    );
}
