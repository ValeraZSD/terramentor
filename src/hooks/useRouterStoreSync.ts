import { useEffect } from 'react';
import { useLocation, matchPath } from 'react-router-dom';
import { useAppNavigate } from './useAppNavigate';
import { useStore, RouteState, WorkspaceView } from '../store';
import { dialogHistoryRouteChanged } from './dialogHistory';

/** Decode the current pathname into the navigation state the store mirrors.
 *  Unknown paths fall back to the Today hub (the home page). */
function decodeRoute(pathname: string): RouteState {
    if (matchPath('/settings', pathname)) return { view: 'settings' };
    if (matchPath('/projects', pathname)) return { view: 'projects' };
    // The Schedule screen and the library Calendar are gone (App.tsx redirects the path).
    if (matchPath('/schedule', pathname) || matchPath('/calendar', pathname)) return { view: 'projects' };
    if (matchPath('/atlas', pathname)) return { view: 'atlas' };

    const m =
        matchPath('/project/:projectId/:view/:nodeId', pathname) ||
        matchPath('/project/:projectId/:view', pathname) ||
        matchPath('/project/:projectId', pathname);

    if (m) {
        // The `||` fallback chain yields a union of param shapes; widen it so the
        // optional :view / :nodeId segments are readable regardless of which
        // pattern matched.
        const params = m.params as { projectId?: string; view?: string; nodeId?: string };
        const projectId = Number(params.projectId);
        const nodeId = params.nodeId ? Number(params.nodeId) : null;
        return {
            view: 'workspace',
            projectId: Number.isNaN(projectId) ? null : projectId,
            workspaceView: (params.view as WorkspaceView) || 'dashboard',
            nodeId: nodeId != null && Number.isNaN(nodeId) ? null : nodeId,
        };
    }

    return { view: 'today' };
}

/** Bridges react-router and the Zustand store: injects `navigate` so store
 *  actions can drive the URL, and reconciles the store to the URL on every
 *  location change. Mount once, high in the tree (inside the Router). */
export function useRouterStoreSync() {
    // The store's moves (the header's tabs and gear, opening a course) keep
    // one entry per place, as every screen's do.
    const navigate = useAppNavigate();
    const { pathname, key } = useLocation();
    const setNavigate = useStore(s => s.setNavigate);
    const applyRoute = useStore(s => s.applyRoute);
    // The same test App.tsx uses to decide between the lock screen and the app.
    const throughGate = useStore(s => s.authChecked && (!s.authEnabled || s.authenticated));

    // Give store actions access to navigate (declared before the sync effect so
    // `_navigate` is set before the first reconciliation runs).
    useEffect(() => { setNavigate(navigate); }, [navigate, setNavigate]);

    // URL → store: the single reconciliation point. Not before the password
    // gate is open: the route's data loads would be refused (401) and leave the
    // store pointing at a course with no topics, and nothing re-applies the
    // route after a login because the pathname has not changed. So it waits,
    // and runs again the moment `throughGate` turns true.
    useEffect(() => {
        if (throughGate) applyRoute(decodeRoute(pathname));
    }, [pathname, applyRoute, throughGate]);

    // Every move, the same address included: an open dialog's Back entry
    // belongs on top of whatever page is current (`dialogHistory.ts`).
    useEffect(() => { dialogHistoryRouteChanged(); }, [key]);
}
